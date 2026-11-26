import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { panelEnvOperation, readEnv, writeEnvFile, config, panelEnv, envGet, restartRsshub, applySettings, healthz, testProxy, testX, webshare, waitHealthy, maskSecrets, serviceStatus, stateFor, clearCache, logs, deploy, deploying as serviceDeploying, deploymentStep } from './service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = __dirname;
const RSSHUB_DIR = config.RSSHUB_DIR;
const ENV_FILE = config.RSSHUB_ENV_FILE;
const BACKUP_DIR = config.PANEL_BACKUP_DIR;
const PORT = Number(config.PANEL_PORT);

// ---- load panel env ----
const PANEL_PASSWORD = panelEnv.PANEL_PASSWORD;
const SESSION_SECRET = panelEnv.SESSION_SECRET;

// ---- managed env keys ----
const PANEL_ENV_FILE = path.join(PANEL_DIR, '.env');

// ---- sessions ----
function sign(v) { return crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex'); }
function makeCookie() {
    const exp = Date.now() + 12 * 3600 * 1000;
    return `panel_session=${exp}.${sign('s' + exp)}; HttpOnly; Path=${config.PANEL_PREFIX}; SameSite=Strict`;
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
function writeEnv(updates, removals) {
    const lines = readEnvLines();
    const seen = new Set();
    const out = lines.map(l => {
        const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
        if (!m) return l;
        const k = m[1];
        if (removals.has(k)) { seen.add(k); return null; }
        if (k in updates) { seen.add(k); return `${k}=${updates[k]}`; }
        return l;
    }).filter(l => l !== null);
    for (const [k, v] of Object.entries(updates)) {
        if (!seen.has(k)) out.push(`${k}=${v}`);
    }
    writeEnvFile(ENV_FILE, out.join('\n'));
}
function backupEnv() {
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    const name = `env-${Date.now()}`;
    fs.copyFileSync(ENV_FILE, path.join(BACKUP_DIR, name));
    fs.chmodSync(path.join(BACKUP_DIR, name), 0o600);
    return name;
}

// ---- sudo helpers ----

// ---- managed operations ----
const DATA_DIR = config.PANEL_DATA_DIR;
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
    if (req.url === config.PANEL_PREFIX) req.url = '/';
    else if (req.url.startsWith(config.PANEL_PREFIX + '/')) req.url = req.url.slice(config.PANEL_PREFIX.length);
    next();
});

// auth gate
app.use((req, res, next) => {
    if (req.path === '/api/login' || req.path === '/login') return next();
    if (!checkCookie(req)) {
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
        return res.redirect(config.PANEL_PREFIX + '/login');
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
    res.setHeader('Set-Cookie', `panel_session=; HttpOnly; Path=${config.PANEL_PREFIX}; Max-Age=0`);
    res.json({ ok: true });
});

app.get('/api/status', async (req, res) => {
    const status = serviceStatus();
    res.json({ ...status, rsshub: await healthz(), activeSince: status.since, accessKeySet: !!envGet('ACCESS_KEY') });
});

// ---- /api/state: banner state (cached + rate-limited) ----
const stateHits = new Map();
function stateRateOK(key) {
    const now = Date.now();
    const a = (stateHits.get(key) || []).filter(t => now - t < 60000);
    if (a.length >= 30) { stateHits.set(key, a); return false; }
    a.push(now); stateHits.set(key, a); return true;
}
let stateCache = { t: 0, json: null };
let healthFailStreak = 0;
let currentState = 'UNKNOWN';
let stateSince = Date.now();
const DEPLOY_STEPS = ['pull', 'install', 'build', 'restart', 'health'];
function deployStep() {
    const name = deploymentStep();
    const n = DEPLOY_STEPS.indexOf(name) + 1;
    return n ? { n, of: DEPLOY_STEPS.length, name } : null;
}
function deploying() { // panel deploy in progress, or GitHub Actions running the script over SSH
    return runningOp === 'deploy' || serviceDeploying();
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
    const { redis, since, activeState, restarts, lastDeploy } = serviceStatus();
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
    const { state, reason } = stateFor({ isDeploying: deploying(), runningOp, activeState, healthy, healthFailStreak, recentFailedOp, lastOp });
    setState(state);
    const json = {
        state, reason, since, step: state === 'DEPLOYING' ? deployStep() : null,
        elapsedSeconds: Math.floor((Date.now() - stateSince) / 1000),
        rsshub: healthy, redis, restarts, lastDeploy, operation,
    };
    if (state === 'ERROR') {
        try {
            json.logTail = logs().split('\n').slice(-20).join('\n');
        } catch { json.logTail = ''; }
    }
    stateCache = { t: Date.now(), json };
    res.json(json);
});

// settings read (non-secret values OK to return)
app.get('/api/settings', (req, res) => {
    res.json({ rsshub: readEnv(ENV_FILE), panel: readEnv(PANEL_ENV_FILE) });
});

// keys list — masked
app.get('/api/keys', (req, res) => {
    res.json(Object.entries({ rsshub: readEnv(ENV_FILE), panel: readEnv(PANEL_ENV_FILE) })
        .flatMap(([source, values]) => Object.entries(values).map(([name, value]) => ({ source, name, value }))));
});

function badVal(k, v) { return validators[k] && !validators[k](v); }

// save settings and/or keys
app.post('/api/save', async (req, res) => {
    const { settings = {}, keys = {}, removeKeys = [], panelSettings = {}, removePanelKeys = [] } = req.body || {};
    const updates = { ...settings, ...keys }, removals = new Set(removeKeys);
    for (const key of [...Object.keys(updates), ...removals, ...Object.keys(panelSettings), ...removePanelKeys]) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return res.status(400).json({ error: 'Invalid environment variable name' });
    }
    for (const [key, value] of Object.entries(updates)) {
        updates[key] = String(value);
        if (value !== '' && badVal(key, updates[key])) return res.status(400).json({ error: `Invalid value for ${key}` });
    }
    if ([...Object.values(updates), ...Object.values(panelSettings)].some((value) => typeof value !== 'string' || /[\r\n\0]/.test(value))) return res.status(400).json({ error: 'Values must be single-line strings' });
    const panelChanged = Object.keys(panelSettings).length > 0 || removePanelKeys.length > 0;
    return runManaged('save', res, async () => {
        const backup = backupEnv();
        let panelBackup;
        try {
            if (panelChanged) panelBackup = panelEnvOperation({ action: 'write', updates: panelSettings, removals: removePanelKeys }).backup;
            writeEnv(updates, removals);
            const healthy = panelChanged ? panelEnvOperation({ action: 'apply' }).ok : (applySettings(), await waitHealthy());
            if (!healthy) throw new Error('Saved environment failed its health check');
            if (panelChanged) res.on('finish', () => { try { panelEnvOperation({ action: 'restart' }); } catch {} });
            return { ok: true, backup, message: 'Settings saved, restarted and healthy' };
        } catch (e) {
            // rollback
            if (panelBackup) panelEnvOperation({ action: 'restore', backup: panelBackup });
            writeEnvFile(ENV_FILE, fs.readFileSync(path.join(BACKUP_DIR, backup), 'utf8'));
            const recovered = panelChanged ? panelEnvOperation({ action: 'apply' }).ok : (applySettings(), await waitHealthy());
            return { code: 500, error: recovered ? 'Save failed; previous settings restored and healthy' : 'Save failed; previous settings restored but recovery health check failed', rolledBack: true, recovered };
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
        writeEnvFile(ENV_FILE, fs.readFileSync(p, 'utf8'));
        applySettings();
        if (await waitHealthy()) return { ok: true, message: `Restored ${name}` };
        writeEnvFile(ENV_FILE, fs.readFileSync(path.join(BACKUP_DIR, backup), 'utf8'));
        applySettings();
        return { code: 500, error: 'Restored version failed health check; reverted.', rolledBack: true };
    });
});

app.post('/api/actions/restart', (req, res) => runManaged('restart', res, async () => {
    restartRsshub();
    const ok = await waitHealthy();
    return { ok, message: ok ? 'Restarted and healthy' : 'Restarted but health check still failing' };
}));

app.post('/api/actions/clear-cache', (req, res) => runManaged('clear-cache', res, async () => {
    const out = clearCache().trim();
    return { ok: true, message: out };
}));

app.post('/api/actions/deploy', (req, res) => runManaged('deploy', res, deploy));

app.get('/api/logs', (req, res) => {
    try {
        res.json({ ok: true, logs: logs() });
    } catch (e) { res.status(500).json({ error: maskSecrets(e.message) }); }
});

app.post('/api/test-proxy', (req, res) => res.json(testProxy()));

app.post('/api/test-x', async (req, res) => res.json(await testX()));

// ---- Webshare usage (read-only, via the webshare CLI) ----
const WEBSHARE_KEY = panelEnv.WEBSHARE_API_KEY;
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

app.listen(PORT, config.PANEL_BIND, () => console.log(`panel on ${config.PANEL_BIND}:${PORT}`));
