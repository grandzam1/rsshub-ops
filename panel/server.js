import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = __dirname;
const RSSHUB_DIR = '/opt/rsshub';
const ENV_FILE = path.join(RSSHUB_DIR, '.env');
const BACKUP_DIR = path.join(PANEL_DIR, 'backups');
const PORT = 3100;

// ---- load panel env ----
const panelEnv = {};
for (const line of fs.readFileSync(path.join(PANEL_DIR, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) panelEnv[m[1]] = m[2].trim();
}
const PANEL_PASSWORD = panelEnv.PANEL_PASSWORD;
const SESSION_SECRET = panelEnv.SESSION_SECRET;

// ---- managed env keys ----
const SETTING_KEYS = ['CACHE_EXPIRE', 'CACHE_CONTENT_EXPIRE', 'MEMORY_MAX', 'LOGGER_LEVEL',
    'NO_LOGFILES', 'DEBUG_INFO', 'FORMAT', 'TITLE_LENGTH_LIMIT', 'REQUEST_TIMEOUT', 'REQUEST_RETRY',
    'PROXY_PROTOCOL', 'PROXY_HOST', 'PROXY_PORT', 'PROXY_URL_REGEX'];
const SECRET_KEYS = ['TWITTER_AUTH_TOKEN', 'ACCESS_KEY'];
const BLOCKED_KEYS = new Set(['PORT', 'LISTEN_INADDR_ANY', 'ALLOW_USER_SUPPLY_UNSAFE_DOMAIN',
    'ENABLE_REMOTE_DEBUGGING', 'PAC_SCRIPT', 'REMOTE_CONFIG', 'CHROMIUM_EXECUTABLE_PATH',
    'PUPPETEER_WS_ENDPOINT', 'PLAYWRIGHT_WS_ENDPOINT', 'PLAYWRIGHT_CDP_ENDPOINT',
    'NODE_ENV', 'REDIS_URL', 'CACHE_TYPE']);

// ---- sessions ----
function sign(v) { return crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex'); }
function makeCookie() {
    const exp = Date.now() + 12 * 3600 * 1000;
    return `panel_session=${exp}.${sign('s' + exp)}; HttpOnly; Path=/panel; SameSite=Strict`;
}
function checkCookie(req) {
    const c = (req.headers.cookie || '').match(/panel_session=([\w.]+)/);
    if (!c) return false;
    const [exp, sig] = c[1].split('.');
    return Number(exp) > Date.now() && sig === sign('s' + exp);
}

// ---- login rate limit ----
const attempts = new Map();
function rateOK(ip) {
    const now = Date.now();
    const a = (attempts.get(ip) || []).filter(t => now - t < 60000);
    if (a.length >= 5) { attempts.set(ip, a); return false; }
    a.push(now); attempts.set(ip, a); return true;
}

// ---- env file helpers ----
function readEnvLines() {
    try { return fs.readFileSync(ENV_FILE, 'utf8').split('\n'); }
    catch { return []; }
}
function envGet(key) {
    for (const l of readEnvLines()) {
        const m = l.match(/^([A-Za-z0-9_]+)=(.*)$/);
        if (m && m[1] === key) return m[2].trim();
    }
    return undefined;
}
function writeEnv(updates, removals) {
    const lines = readEnvLines();
    const seen = new Set();
    const out = lines.map(l => {
        const m = l.match(/^([A-Za-z0-9_]+)=/);
        if (!m) return l;
        const k = m[1];
        if (removals.has(k)) { seen.add(k); return null; }
        if (k in updates) { seen.add(k); return `${k}=${updates[k]}`; }
        return l;
    }).filter(l => l !== null);
    for (const [k, v] of Object.entries(updates)) {
        if (!seen.has(k)) out.push(`${k}=${v}`);
    }
    const tmp = ENV_FILE + '.paneltmp';
    fs.writeFileSync(tmp, out.join('\n'));
    fs.renameSync(tmp, ENV_FILE);
    try { fs.chownSync(ENV_FILE, fs.statSync(RSSHUB_DIR).uid, fs.statSync(RSSHUB_DIR).gid); } catch {}
}
function backupEnv() {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = `env-${Date.now()}`;
    try { fs.copyFileSync(ENV_FILE, path.join(BACKUP_DIR, name)); } catch { fs.writeFileSync(path.join(BACKUP_DIR, name), ''); }
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('env-')).sort();
    while (files.length > 20) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    return name;
}

// ---- sudo helpers ----
function sudo(args, timeout = 15000) {
    return execFileSync('sudo', ['-n', ...args], { timeout, encoding: 'utf8' });
}
const restartRsshub = () => sudo(['/bin/systemctl', 'restart', 'rsshub'], 20000);

async function healthz() {
    const key = envGet('ACCESS_KEY');
    const url = 'http://127.0.0.1:1200/healthz' + (key ? `?key=${encodeURIComponent(key)}` : '');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    try {
        const r = await fetch(url, { signal: ctl.signal });
        return r.ok;
    } catch { return false; } finally { clearTimeout(t); }
}
async function waitHealthy(ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await healthz()) return true;
        await new Promise(r => setTimeout(r, 2000));
    }
    return false;
}
function maskSecrets(text) {
    return text
        .replace(/([A-Za-z0-9_]*(TOKEN|KEY|SECRET|PASSWORD|COOKIE)[A-Za-z0-9_]*)=([^\s"']+)/gi, '$1=•••')
        .replace(/\b[0-9a-f]{24,}\b/gi, '•••')
        .replace(/ghp_\w+/g, '•••');
}

// ---- managed operations ----
const DATA_DIR = path.join(PANEL_DIR, 'data');
const OP_FILE = path.join(DATA_DIR, 'operation.json');
let lastOp = null;
try { lastOp = JSON.parse(fs.readFileSync(OP_FILE, 'utf8')); } catch {}
function finishOperation(name, ok, message) {
    lastOp = { name, origin: 'panel', ok, at: new Date().toISOString(), message: String(message || '').slice(0, 300) };
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = OP_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(lastOp));
        fs.renameSync(tmp, OP_FILE);
    } catch {}
}
let runningOp = null;
// fn returns {code?, ...json}. Errors are masked + capped before reaching the client/record.
async function runManaged(name, res, fn) {
    if (runningOp) return res.status(409).json({ error: `Another operation is in progress (${runningOp})` });
    runningOp = name;
    try {
        const { code = 200, ...json } = await fn();
        finishOperation(name, code < 400 && json.ok !== false, json.message || json.error || '');
        return res.status(code).json(json);
    } catch (e) {
        const message = maskSecrets(String((e && e.message) || e)).slice(0, 300);
        finishOperation(name, false, message);
        return res.status(500).json({ error: message });
    } finally { runningOp = null; }
}

// ---- validation ----
const validators = {
    CACHE_EXPIRE: v => /^\d+$/.test(v) && +v >= 0 && +v <= 86400,
    CACHE_CONTENT_EXPIRE: v => /^\d+$/.test(v) && +v >= 0 && +v <= 604800,
    MEMORY_MAX: v => /^\d+(\.\d+)?$/.test(v),
    LOGGER_LEVEL: v => ['debug', 'info', 'warn', 'error', 'silent'].includes(v),
    NO_LOGFILES: v => ['true', 'false'].includes(v),
    DEBUG_INFO: v => ['true', 'false'].includes(v),
    FORMAT: v => v === '' || ['rss', 'atom', 'json', 'rss3'].includes(v),
    TITLE_LENGTH_LIMIT: v => /^\d+$/.test(v) && +v > 0 && +v <= 2000,
    REQUEST_TIMEOUT: v => /^\d+$/.test(v) && +v >= 1000 && +v <= 120000,
    REQUEST_RETRY: v => /^\d+$/.test(v) && +v >= 0 && +v <= 10,
    PROXY_PROTOCOL: v => ['', 'http', 'https', 'socks', 'socks5', 'socks5h', 'socks4'].includes(v),
    PROXY_HOST: v => /^$|^[\w.-]+$/.test(v),
    PROXY_PORT: v => v === '' || (/^\d+$/.test(v) && +v > 0 && +v <= 65535),
    PROXY_URL_REGEX: v => v.length < 500,
};

const app = express();
app.use(express.json());
app.disable('x-powered-by');

// strip /panel prefix (Traefik PathPrefix)
app.use((req, res, next) => {
    if (req.url === '/panel') req.url = '/';
    else if (req.url.startsWith('/panel/')) req.url = req.url.slice(6);
    next();
});

// auth gate
app.use((req, res, next) => {
    if (req.path === '/api/login' || req.path === '/login') return next();
    if (!checkCookie(req)) {
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
        return res.redirect('/panel/login');
    }
    next();
});

app.use(express.static(path.join(PANEL_DIR, 'public'), { index: 'index.html' }));
app.get('/login', (req, res) => res.sendFile(path.join(PANEL_DIR, 'public', 'login.html')));

// ---- API ----
app.post('/api/login', (req, res) => {
    const ip = req.socket.remoteAddress;
    if (!rateOK(ip)) return res.status(429).json({ error: 'Too many tries, wait a minute' });
    const { password } = req.body || {};
    if (typeof password !== 'string' ||
        !crypto.timingSafeEqual(Buffer.from(password.padEnd(64)), Buffer.from(String(PANEL_PASSWORD).padEnd(64)))) {
        return res.status(401).json({ error: 'Wrong password' });
    }
    res.setHeader('Set-Cookie', makeCookie());
    res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'panel_session=; HttpOnly; Path=/panel; Max-Age=0');
    res.json({ ok: true });
});

app.get('/api/status', async (req, res) => {
    let redis = false;
    try { redis = execFileSync('redis-cli', ['ping'], { timeout: 5000, encoding: 'utf8' }).trim() === 'PONG'; } catch {}
    let up = '', restarts = '';
    try {
        const st = sudo(['/bin/systemctl', 'show', 'rsshub', '-p', 'ActiveEnterTimestamp'], 8000);
        up = (st.match(/ActiveEnterTimestamp=(.+)/) || [])[1] || '';
    } catch {}
    try { restarts = String(restartsSinceBoot()); } catch {}
    let lastDeploy = '';
    try { lastDeploy = fs.statSync(path.join(RSSHUB_DIR, 'dist', 'index.mjs')).mtime.toISOString(); } catch {}
    res.json({
        rsshub: await healthz(),
        redis,
        activeSince: up,
        restarts,
        lastDeploy,
        accessKeySet: !!envGet('ACCESS_KEY'),
    });
});

// ---- /api/state: banner state (cached + rate-limited) ----
const stateHits = new Map();
function stateRateOK(key) {
    const now = Date.now();
    const a = (stateHits.get(key) || []).filter(t => now - t < 60000);
    if (a.length >= 30) { stateHits.set(key, a); return false; }
    a.push(now); stateHits.set(key, a); return true;
}
let restartsCache = { t: 0, v: null };
function restartsSinceBoot() {
    if (restartsCache.v !== null && Date.now() - restartsCache.t < 120000) return restartsCache.v;
    const out = sudo(['/bin/journalctl', '-u', 'rsshub', '-b', '--no-pager', '-o', 'cat'], 15000);
    const v = (out.match(/Scheduled restart job/g) || []).length;
    restartsCache = { t: Date.now(), v };
    return v;
}
let stateCache = { t: 0, json: null };
let healthFailStreak = 0;
let currentState = 'UNKNOWN';
let stateSince = Date.now();
const DEPLOY_STEPS = ['pull', 'install', 'build', 'restart', 'health'];
const STEP_FILE = path.join(DATA_DIR, 'deploy-step.txt');
function deployStep() {
    try {
        const name = fs.readFileSync(STEP_FILE, 'utf8').trim();
        const n = DEPLOY_STEPS.indexOf(name) + 1;
        return n ? { n, of: DEPLOY_STEPS.length, name } : null;
    } catch { return null; }
}
function deploying() { // panel deploy in progress, or GitHub Actions running the script over SSH
    if (runningOp === 'deploy') return true;
    try { execFileSync('pgrep', ['-f', 'rsshub-depl[o]y'], { timeout: 5000, encoding: 'utf8' }); return true; }
    catch { return false; }
}
function setState(s) {
    if (s !== currentState) { currentState = s; stateSince = Date.now(); }
}
app.get('/api/state', async (req, res) => {
    const sess = ((req.headers.cookie || '').match(/panel_session=([\w.]+)/) || [])[1] || 'anon';
    if (!stateRateOK(sess)) return res.status(429).json({ error: 'Too many requests' });
    if (stateCache.json && Date.now() - stateCache.t < 2000) return res.json(stateCache.json);
    const healthy = await healthz();
    healthFailStreak = healthy ? 0 : healthFailStreak + 1;
    let redis = false;
    try { redis = execFileSync('redis-cli', ['ping'], { timeout: 5000, encoding: 'utf8' }).trim() === 'PONG'; } catch {}
    let since = '', activeState = '';
    try {
        const st = sudo(['/bin/systemctl', 'show', 'rsshub', '-p', 'ActiveEnterTimestamp,ActiveState'], 8000);
        since = (st.match(/ActiveEnterTimestamp=(.+)/) || [])[1] || '';
        activeState = (st.match(/ActiveState=(\w+)/) || [])[1] || '';
    } catch {}
    let restarts = null;
    try { restarts = restartsSinceBoot(); } catch {}
    let lastDeploy = '';
    try { lastDeploy = fs.statSync(path.join(RSSHUB_DIR, 'dist', 'index.mjs')).mtime.toISOString(); } catch {}
    // deploys pushed via GitHub Actions run rsshub-deploy.sh directly, outside the panel
    let operation = lastOp;
    if (lastDeploy && (!lastOp || new Date(lastOp.at) < new Date(lastDeploy))) {
        operation = { name: 'deploy', origin: 'github', ok: true, at: lastDeploy, message: '' };
    }
    // a failed op only counts if nothing newer (e.g. a GitHub deploy) superseded it
    const recentFailedOp = lastOp && lastOp.ok === false
        && (!lastDeploy || new Date(lastOp.at) >= new Date(lastDeploy))
        && Date.now() - new Date(lastOp.at) < 3600e3;
    // priority: DEPLOYING > RESTARTING > ERROR > STOPPED > RUNNING > UNKNOWN
    let state = 'UNKNOWN', reason = '';
    if (deploying()) {
        state = 'DEPLOYING';
        reason = `Deploy in progress${runningOp === 'deploy' ? ' (started from the panel)' : ' (from GitHub)'}`;
    } else if (runningOp || activeState === 'activating') {
        state = 'RESTARTING';
        reason = runningOp ? `Operation in progress: ${runningOp}` : 'Service is starting up';
    } else if (activeState === 'failed') {
        state = 'ERROR';
        reason = 'Service failed — check the logs below';
    } else if (activeState === 'active' && healthFailStreak >= 2) {
        state = 'ERROR';
        reason = 'Service is up but not answering health checks';
    } else if (recentFailedOp) {
        state = 'ERROR';
        reason = `Last operation failed: ${lastOp.name}`;
    } else if (activeState === 'inactive') {
        state = 'STOPPED';
        reason = 'Service is stopped';
    } else if (activeState === 'active' && healthy) {
        state = 'RUNNING';
        reason = 'Up and healthy';
    }
    setState(state);
    const json = {
        state, reason, since, step: state === 'DEPLOYING' ? deployStep() : null,
        elapsedSeconds: Math.floor((Date.now() - stateSince) / 1000),
        rsshub: healthy, redis, restarts, lastDeploy, operation,
    };
    if (state === 'ERROR') {
        try {
            json.logTail = maskSecrets(sudo(['/bin/journalctl', '-u', 'rsshub', '-n', '20', '--no-pager'], 15000));
        } catch { json.logTail = ''; }
    }
    stateCache = { t: Date.now(), json };
    res.json(json);
});

// settings read (non-secret values OK to return)
app.get('/api/settings', (req, res) => {
    const out = {};
    for (const k of SETTING_KEYS) out[k] = envGet(k) ?? '';
    res.json(out);
});

// keys list — masked
app.get('/api/keys', (req, res) => {
    const list = [];
    for (const l of readEnvLines()) {
        const m = l.match(/^([A-Za-z0-9_]+)=(.*)$/);
        if (!m) continue;
        const [, k, v] = m;
        if (BLOCKED_KEYS.has(k) || SETTING_KEYS.includes(k)) continue;
        if (!SECRET_KEYS.includes(k) && !/TOKEN|KEY|SECRET|COOKIE|PASSWORD|AUTH|_URI$/.test(k)) continue;
        const val = v.trim();
        list.push({ name: k, configured: val.length > 0, last4: val ? val.slice(-4) : '' });
    }
    res.json(list);
});

function badVal(k, v) { return validators[k] && !validators[k](v); }

// save settings and/or keys
app.post('/api/save', async (req, res) => {
    const { settings = {}, keys = {}, removeKeys = [] } = req.body || {};
    const updates = {}, removals = new Set();
    for (const [k, v] of Object.entries(settings)) {
        if (!SETTING_KEYS.includes(k)) return res.status(400).json({ error: `Unknown setting ${k}` });
        if (badVal(k, String(v))) return res.status(400).json({ error: `Invalid value for ${k}` });
        if (String(v) === '') removals.add(k); else updates[k] = String(v);
    }
    for (const [k, v] of Object.entries(keys)) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(k) || BLOCKED_KEYS.has(k) || SETTING_KEYS.includes(k))
            return res.status(400).json({ error: `Key ${k} not allowed` });
        let val = String(v);
        if (k === 'TWITTER_AUTH_TOKEN') {
            val = val.split(/[;\s]+/).map(s => s.replace(/^auth_token=/i, '')).filter(Boolean).join(',');
            if (val && !/^[0-9a-f,]+$/i.test(val)) return res.status(400).json({ error: 'auth_token looks wrong' });
        }
        if (val === '') removals.add(k); else updates[k] = val;
    }
    for (const k of removeKeys) {
        if (BLOCKED_KEYS.has(k)) return res.status(400).json({ error: `Cannot remove ${k}` });
        removals.add(k);
    }
    return runManaged('save', res, async () => {
        const backup = backupEnv();
        try {
            writeEnv(updates, removals);
            restartRsshub();
            if (await waitHealthy()) return { ok: true, backup, message: 'Settings saved, restarted and healthy' };
            // rollback
            fs.copyFileSync(path.join(BACKUP_DIR, backup), ENV_FILE);
            restartRsshub();
            await waitHealthy(15000);
            return { code: 500, error: `RSSHub didn't come back healthy. Rolled back to ${backup}.`, rolledBack: true };
        } catch (e) {
            try { fs.copyFileSync(path.join(BACKUP_DIR, backup), ENV_FILE); restartRsshub(); } catch {}
            e.message = 'Save failed and was rolled back: ' + e.message;
            throw e;
        }
    });
});

app.get('/api/backups', (req, res) => {
    const files = fs.existsSync(BACKUP_DIR)
        ? fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('env-')).sort().reverse() : [];
    res.json(files.map(f => ({ name: f, date: new Date(+f.slice(4)).toISOString() })));
});

app.post('/api/backups/restore', async (req, res) => {
    const { name } = req.body || {};
    if (!/^env-\d+$/.test(name || '')) return res.status(400).json({ error: 'Bad name' });
    const p = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
    return runManaged('restore', res, async () => {
        const backup = backupEnv();
        fs.copyFileSync(p, ENV_FILE);
        restartRsshub();
        if (await waitHealthy()) return { ok: true, message: `Restored ${name}` };
        fs.copyFileSync(path.join(BACKUP_DIR, backup), ENV_FILE);
        restartRsshub();
        return { code: 500, error: 'Restored version failed health check; reverted.', rolledBack: true };
    });
});

app.post('/api/actions/restart', (req, res) => runManaged('restart', res, async () => {
    restartRsshub();
    const ok = await waitHealthy();
    return { ok, message: ok ? 'Restarted and healthy' : 'Restarted but health check still failing' };
}));

app.post('/api/actions/clear-cache', (req, res) => runManaged('clear-cache', res, async () => {
    const out = sudo(['/usr/bin/redis-cli', 'FLUSHALL'], 10000).trim();
    return { ok: true, message: out };
}));

app.post('/api/actions/deploy', (req, res) => runManaged('deploy', res, () => new Promise((resolve) => {
    execFile('sudo', ['-n', '/usr/local/bin/rsshub-deploy.sh'], { timeout: 600000, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
        (err, stdout, stderr) => {
            let out = maskSecrets((stdout || '') + (stderr || ''));
            if (out.length > 40000) out = '…(earlier output trimmed)\n' + out.slice(-40000);
            resolve({ ok: !err, output: out, message: err ? 'Deploy failed' : 'Deploy finished' });
        });
})));

app.get('/api/logs', (req, res) => {
    try {
        const out = sudo(['/bin/journalctl', '-u', 'rsshub', '-n', '200', '--no-pager'], 15000);
        res.json({ ok: true, logs: maskSecrets(out) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/test-proxy', async (req, res) => {
    let proxy = envGet('PROXY_URI');
    if (!proxy) {
        const proto = envGet('PROXY_PROTOCOL'), host = envGet('PROXY_HOST'), port = envGet('PROXY_PORT');
        if (!proto || !host || !port) return res.json({ ok: false, message: 'Proxy not configured' });
        proxy = `${proto}://${host}:${port}`;
    }
    try {
        const out = execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '15',
            '--proxy', proxy, 'https://api.ipify.org'], { encoding: 'utf8' });
        res.json({ ok: out === '200', message: `Proxy returned HTTP ${out}` });
    } catch (e) { res.json({ ok: false, message: 'Proxy test failed' }); }
});

app.post('/api/test-x', async (req, res) => {
    const key = envGet('ACCESS_KEY');
    const url = 'http://127.0.0.1:1200/twitter/user/X' + (key ? `?key=${encodeURIComponent(key)}` : '');
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
        res.json({ ok: r.ok, message: `Route returned HTTP ${r.status}` });
    } catch (e) { res.json({ ok: false, message: e.message }); }
});

// ---- Webshare usage (read-only, via the webshare CLI) ----
const WEBSHARE_KEY = panelEnv.WEBSHARE_API_KEY;
function webshare(args) {
    return new Promise((resolve, reject) => {
        execFile('/usr/local/bin/webshare', [...args, '--json'], {
            timeout: 30000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8',
            env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', NO_COLOR: '1', WEBSHARE_API_KEY: WEBSHARE_KEY },
        }, (err, stdout, stderr) => {
            if (err) return reject(new Error(String(stderr || err.message).trim()));
            try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Unexpected output from webshare CLI')); }
        });
    });
}
function monthsBefore(iso, n) {
    const d = new Date(iso), day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - n);
    d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
    return d;
}
let wsCache = { t: 0, json: null };
app.get('/api/webshare', async (req, res) => {
    if (!WEBSHARE_KEY) return res.json({ ok: false, configured: false, message: 'WEBSHARE_API_KEY is not set in the panel .env' });
    if (wsCache.json && Date.now() - wsCache.t < 60000 && req.query.refresh !== '1') return res.json(wsCache.json);
    try {
        const { plan, subscription: sub } = await webshare(['account']);
        // bandwidth resets monthly: step back from the renewal date to the current cycle start
        let n = 0, start = new Date(sub.end_date);
        while (start > Date.now()) start = monthsBefore(sub.end_date, ++n);
        if (sub.start_date && start < new Date(sub.start_date)) start = new Date(sub.start_date);
        const hours = Math.max(1, Math.ceil((Date.now() - start) / 3600e3));
        const id = String(plan.id);
        const [cycle, hourly, proxies] = await Promise.all([
            webshare(['stats', '--plan', id, '--since', `${hours}h`]),
            webshare(['stats', '--hourly', '--plan', id, '--since', '30d']),
            webshare(['proxies', 'list', '--plan', id, '--limit', '0']),
        ]);
        const daily = {};
        for (const h of hourly || []) {
            if (h.is_projected) continue;
            const d = daily[h.timestamp.slice(0, 10)] ||= { bytes: 0, requests: 0, failed: 0 };
            d.bytes += h.bandwidth_total; d.requests += h.requests_total; d.failed += h.requests_failed;
        }
        const countries = {};
        for (const p of proxies || []) countries[p.country_code] = (countries[p.country_code] || 0) + 1;
        const limitBytes = plan.bandwidth_limit * 1e9;
        const json = {
            ok: true, configured: true, keyLast4: WEBSHARE_KEY.slice(-4), fetchedAt: new Date().toISOString(),
            plan: { id: plan.id, type: plan.proxy_type, proxyCount: plan.proxy_count, bandwidthLimitGB: plan.bandwidth_limit },
            cycle: { start: start.toISOString(), renews: sub.end_date, willRenew: sub.will_renew, throttled: sub.throttled },
            usage: {
                usedBytes: cycle.bandwidth_total, limitBytes, remainingBytes: Math.max(0, limitBytes - cycle.bandwidth_total),
                requests: cycle.requests_total, failed: cycle.requests_failed, lastRequestAt: cycle.last_request_sent_at,
            },
            proxies: { total: (proxies || []).length, valid: (proxies || []).filter((p) => p.valid).length, countries },
            daily: Object.keys(daily).sort().map((day) => ({ day, ...daily[day] })),
        };
        wsCache = { t: Date.now(), json };
        res.json(json);
    } catch (e) {
        res.status(502).json({ ok: false, configured: true, message: maskSecrets(String(e.message)).split(WEBSHARE_KEY).join('•••').slice(0, 300) });
    }
});

app.listen(PORT, '127.0.0.1', () => console.log(`panel on 127.0.0.1:${PORT}`));
