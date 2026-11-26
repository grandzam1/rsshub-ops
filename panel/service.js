#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const moduleFile = fileURLToPath(import.meta.url);
const panelDir = path.dirname(fs.realpathSync(moduleFile));
const panelEnvFile = path.join(panelDir, '.env');
export function readEnv(file) {
    return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line) => {
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) return [];
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        return [[match[1], value]];
    }));
}
export function writeEnvFile(file, text) {
    const metadata = fs.statSync(file);
    const temporary = `${file}.${process.pid}.next`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, text);
        const created = fs.fstatSync(fd);
        if (created.uid !== metadata.uid || created.gid !== metadata.gid) fs.fchownSync(fd, metadata.uid, metadata.gid);
        fs.fchmodSync(fd, metadata.mode & 0o7777);
        fs.fsyncSync(fd);
        fs.renameSync(temporary, file);
    } finally {
        fs.closeSync(fd);
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}
export const panelEnv = readEnv(panelEnvFile);
export const defaults = {
    RSSHUB_MODE: 'host', RSSHUB_DIR: '/opt/rsshub', RSSHUB_ENV_FILE: '/opt/rsshub/.env', RSSHUB_ENTRY: 'dist/index.mjs',
    HEALTH_URL: 'http://127.0.0.1:1200/healthz', DOCKER_HEALTH_URL: 'http://127.0.0.1:11200/healthz',
    HOST_SERVICE: 'rsshub', HOST_REDIS_SERVICE: 'redis-server', HOST_USER: 'rsshub', HOST_GROUP: 'rsshub',
    HOST_REDIS_HOST: '127.0.0.1', HOST_REDIS_PORT: '6379',
    PANEL_DIR: panelDir, PANEL_PORT: '3100', PANEL_BIND: '127.0.0.1', PANEL_USER: 'rsshub', PANEL_GROUP: 'rsshub', PANEL_SERVICE: 'rsshub-panel',
    PANEL_DATA_DIR: path.join(panelDir, 'data'), PANEL_BACKUP_DIR: path.join(panelDir, 'backups'),
    DOCKER_COMPOSE_DIR: '/var/lib/rsshub-docker/panel-stack', DOCKER_COMPOSE_FILE: 'compose.yml',
    DOCKER_PROJECT: 'rsshub-docker-staging', DOCKER_SERVICE: 'rsshub', DOCKER_REDIS_SERVICE: 'redis',
    DEPLOY_SCRIPT: '/usr/local/bin/rsshub-deploy.sh', DEPLOY_STATE_DIR: '/run/rsshub-panel-ops',
    SOURCE_REPOSITORY: 'https://github.com/grandzam1/Rsshub.git', SOURCE_REF: '170170cbc5c8850ec701a659c824b38830651fa1',
    SOURCE_CACHE_DIR: '/var/lib/rsshub-docker/repository.git', BUILD_BUILDER: 'rsshub-migration-builder', IMAGE_PREFIX: 'rsshub-vps',
    HEALTH_WAIT_MS: '45000', DEPLOY_TIMEOUT_MS: '1800000', HOST_NODE_OPTIONS: '--max-http-header-size=32768',
    RSSHUB_IMAGE: 'rsshub-vps:170170cbc5c8850ec701a659c824b38830651fa1',
    REDIS_IMAGE: 'redis:7-alpine@sha256:7f7d30b7fdd09467bac58198a1f166dd69789d348d4fe859cccb20e0cf287fbe',
    DOCKER_BIND: '127.0.0.1', DOCKER_PUBLISH_PORT: '11200', RSSHUB_CONTAINER_PORT: '1200',
    RSSHUB_MEMORY: '768m', RSSHUB_HEAP_MB: '512', RSSHUB_CPUS: '0.75', RSSHUB_PIDS: '128',
    REDIS_MEMORY: '256m', REDIS_MAXMEMORY: '64mb', REDIS_CPUS: '0.25', REDIS_PIDS: '64', REDIS_CONTAINER_PORT: '6379',
    DOCKER_REDIS_URL: 'redis://redis:6379/',
    DOCKER_VOLUME: 'redis-data', DOCKER_LOG_MAX_SIZE: '10m', DOCKER_LOG_MAX_FILES: '3',
    WEBSHARE_BIN: '/usr/local/bin/webshare', PROXY_TEST_URL: 'https://api.ipify.org',
    X_TEST_ROUTE: '/twitter/user/X', PANEL_PREFIX: '/panel',
};
export const config = { ...defaults, ...panelEnv };
if (!['host', 'docker'].includes(config.RSSHUB_MODE) && process.argv[2] !== 'env') throw new Error('RSSHUB_MODE must be host or docker');
const dockerMode = config.RSSHUB_MODE === 'docker';
const stepFile = path.join(config.DEPLOY_STATE_DIR, 'deploy-step.txt');
const lockFile = path.join(config.DEPLOY_STATE_DIR, 'deploy.lock');
const composeArgs = ['compose', '--project-directory', config.DOCKER_COMPOSE_DIR, '--project-name', config.DOCKER_PROJECT,
    '--env-file', panelEnvFile, '--file', path.join(config.DOCKER_COMPOSE_DIR, config.DOCKER_COMPOSE_FILE)];
const redisArgs = ['-h', config.HOST_REDIS_HOST, '-p', config.HOST_REDIS_PORT];
function run(bin, args, timeout = 15000, sudo = false) {
    return execFileSync(sudo && process.getuid() !== 0 ? '/usr/bin/sudo' : bin,
        sudo && process.getuid() !== 0 ? ['-n', bin, ...args] : args,
        { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
function compose(args, timeout = 15000) { return run('/usr/bin/docker', [...composeArgs, ...args], timeout, true); }
function command(bin, args, timeout = Number(config.DEPLOY_TIMEOUT_MS), options = {}) {
    return new Promise((resolve, reject) => {
        execFile(bin, args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
            const output = maskSecrets((stdout || '') + (stderr || ''));
            if (output) process.stdout.write(output);
            if (error) reject(new Error(`${path.basename(bin)} failed (${error.code ?? error.signal ?? 'unknown'})`));
            else resolve(stdout);
        });
    });
}
export function maskSecrets(text) {
    let out = String(text);
    const values = { ...panelEnv, ...readEnv(config.RSSHUB_ENV_FILE) };
    for (const [key, value] of Object.entries(values)) {
        if (/TOKEN|KEY|SECRET|PASSWORD|COOKIE|AUTH|_URI$/.test(key) && value && value.length > 3) {
            out = out.split(value).join('[REDACTED]');
            for (const part of value.split(',')) if (part.length > 8) out = out.split(part).join('[REDACTED]');
        }
    }
    return out.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
        .replace(/([?&](?:key|token|auth_token|access_token)=)[^&\s"'<>]+/gi, '$1[REDACTED]')
        .replace(/([A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|COOKIE)[A-Za-z0-9_]*[=:]\s*)[^\s"']+/gi, '$1[REDACTED]')
        .replace(/\b[0-9a-f]{24,}\b/gi, '[REDACTED]').replace(/gh[pousr]_\w+/g, '[REDACTED]');
}
export function validateCompose() { return compose(['config', '--quiet']); }
export function envGet(key) { return readEnv(config.RSSHUB_ENV_FILE)[key]; }
export function testProxy() {
    let proxy = envGet('PROXY_URI');
    if (!proxy) {
        const protocol = envGet('PROXY_PROTOCOL'), host = envGet('PROXY_HOST'), port = envGet('PROXY_PORT');
        if (!protocol || !host || !port) return { ok: false, message: 'Proxy not configured' };
        proxy = `${protocol}://${host}:${port}`;
    }
    try {
        const code = run('/usr/bin/curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '15', '--proxy', proxy, config.PROXY_TEST_URL], 20000);
        return { ok: code === '200', message: `Proxy returned HTTP ${code}` };
    } catch { return { ok: false, message: 'Proxy test failed' }; }
}
export async function testX() {
    try {
        const response = await fetch(healthUrl(config.X_TEST_ROUTE), { signal: AbortSignal.timeout(30000) });
        return { ok: response.ok, message: `Route returned HTTP ${response.status}` };
    } catch (error) { return { ok: false, message: maskSecrets(error.message) }; }
}
export function webshare(args) {
    return new Promise((resolve, reject) => {
        execFile(config.WEBSHARE_BIN, [...args, '--json'], {
            timeout: 30000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8',
            env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', NO_COLOR: '1', WEBSHARE_API_KEY: panelEnv.WEBSHARE_API_KEY },
        }, (error, stdout, stderr) => {
            if (error) return reject(new Error(String(stderr || error.message).trim()));
            try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Unexpected output from webshare CLI')); }
        });
    });
}
export function healthUrl(route) {
    const url = new URL(dockerMode ? config.DOCKER_HEALTH_URL : config.HEALTH_URL);
    if (route) { url.pathname = route; url.search = ''; }
    const key = envGet('ACCESS_KEY');
    if (key) url.searchParams.set('key', key);
    return url;
}
export async function healthz() {
    try { return (await fetch(healthUrl(), { signal: AbortSignal.timeout(8000) })).ok; }
    catch { return false; }
}
export async function waitHealthy(ms = Number(config.HEALTH_WAIT_MS)) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await healthz()) return true;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
}
export function restartRsshub() {
    return dockerMode ? compose(['restart', config.DOCKER_SERVICE], 60000)
        : run('/bin/systemctl', ['restart', config.HOST_SERVICE], 30000, true);
}
export function applySettings() {
    return dockerMode ? compose(['up', '-d', '--no-deps', '--force-recreate', config.DOCKER_SERVICE], 60000) : restartRsshub();
}
export function clearCache() {
    return dockerMode ? compose(['exec', '-T', config.DOCKER_REDIS_SERVICE, 'redis-cli', '-p', config.REDIS_CONTAINER_PORT, 'FLUSHALL'])
        : run('/usr/bin/redis-cli', [...redisArgs, 'FLUSHALL'], 15000, true);
}
export function logs() {
    return maskSecrets(dockerMode ? compose(['logs', '--no-color', '--tail', '200', config.DOCKER_SERVICE])
        : run('/bin/journalctl', ['-u', config.HOST_SERVICE, '-n', '200', '--no-pager'], 15000, true));
}
export function deploymentStep() {
    try { return fs.readFileSync(stepFile, 'utf8').trim(); } catch { return ''; }
}
export function deploying() {
    try { process.kill(Number(fs.readFileSync(lockFile, 'utf8')), 0); return true; }
    catch (error) { return error.code === 'EPERM'; }
}
export function stateFor({ isDeploying, runningOp, activeState, healthy, healthFailStreak, recentFailedOp, lastOp }) {
    if (isDeploying) return { state: 'DEPLOYING', reason: `Deploy in progress${runningOp === 'deploy' ? ' (started from the panel)' : ' (from GitHub)'}` };
    if (runningOp || activeState === 'activating') return { state: 'RESTARTING', reason: runningOp ? `Operation in progress: ${runningOp}` : 'Service is starting up' };
    if (activeState === 'failed') return { state: 'ERROR', reason: 'Service failed — check the logs below' };
    if (activeState === 'active' && healthFailStreak >= 2) return { state: 'ERROR', reason: 'Service is up but not answering health checks' };
    if (recentFailedOp) return { state: 'ERROR', reason: `Last operation failed: ${lastOp.name}` };
    if (activeState === 'inactive') return { state: 'STOPPED', reason: 'Service is stopped' };
    if (activeState === 'active' && healthy) return { state: 'RUNNING', reason: 'Up and healthy' };
    return { state: 'UNKNOWN', reason: '' };
}
export function serviceStatus() {
    let redis = false;
    try { redis = (dockerMode ? compose(['exec', '-T', config.DOCKER_REDIS_SERVICE, 'redis-cli', '-p', config.REDIS_CONTAINER_PORT, 'PING'])
        : run('/usr/bin/redis-cli', [...redisArgs, 'PING'])).trim() === 'PONG'; } catch {}
    let activeState = '', since = '', restarts = null, lastDeploy = '';
    try {
        if (dockerMode) {
            const text = compose(['ps', '--all', '--format', 'json']);
            const rows = text.trim().startsWith('[') ? JSON.parse(text) : text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
            const app = rows.find((row) => row.Service === config.DOCKER_SERVICE);
            const redisRow = rows.find((row) => row.Service === config.DOCKER_REDIS_SERVICE);
            activeState = !app || app.State === 'exited' || app.State === 'dead' ? 'inactive'
                : app.State === 'restarting' || app.Health === 'starting' ? 'activating'
                : app.State !== 'running' || app.Health === 'unhealthy' ? 'failed' : 'active';
            if (redisRow?.State !== 'running' || redisRow.Health === 'unhealthy') redis = false;
            if (activeState === 'active' && !redis) activeState = 'failed';
            since = app?.RunningFor || '';
            const created = new Date(app?.CreatedAt || '');
            if (!Number.isNaN(created.getTime())) lastDeploy = created.toISOString();
        } else {
            const text = run('/bin/systemctl', ['show', config.HOST_SERVICE, '-p', 'ActiveEnterTimestamp,ActiveState,NRestarts'], 15000, true);
            const values = Object.fromEntries(text.trim().split('\n').map((line) => line.split('=')));
            activeState = values.ActiveState; since = values.ActiveEnterTimestamp; restarts = Number(values.NRestarts);
            lastDeploy = fs.statSync(path.join(config.RSSHUB_DIR, config.RSSHUB_ENTRY)).mtime.toISOString();
        }
    } catch {}
    return { redis, activeState, since, restarts, lastDeploy, mode: config.RSSHUB_MODE };
}
export function deploy() {
    return new Promise((resolve) => {
        execFile('/usr/bin/sudo', ['-n', config.DEPLOY_SCRIPT],
            { timeout: Number(config.DEPLOY_TIMEOUT_MS), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
                let output = maskSecrets((stdout || '') + (stderr || ''));
                if (output.length > 40000) output = output.slice(-40000);
                resolve({ ok: !error, output, message: error ? 'Deploy failed' : 'Deploy finished' });
            });
    });
}
export function panelEnvOperation(payload) {
    try {
        return JSON.parse(execFileSync('/usr/bin/sudo', ['-n', '/usr/local/bin/rsshub-service', 'env'], {
            input: JSON.stringify(payload), encoding: 'utf8', timeout: 180000, stdio: ['pipe', 'pipe', 'pipe'],
        }));
    } catch { throw new Error('Panel environment helper failed'); }
}
async function envRoot() {
    if (process.getuid() !== 0 || process.argv.length !== 3) throw new Error('Environment changes require the approved sudo entry point');
    const request = JSON.parse(fs.readFileSync(0, 'utf8'));
    const backupDir = '/var/lib/rsshub-docker/panel-backups/editor';
    if (request.action === 'write') {
        const updates = request.updates || {};
        const removals = new Set(request.removals || []);
        for (const key of [...Object.keys(updates), ...removals]) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid environment variable name');
        for (const value of Object.values(updates)) if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('Values must be single-line strings');
        fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
        const backup = `panel-${Date.now()}-${process.pid}`;
        const original = fs.readFileSync(panelEnvFile, 'utf8');
        fs.writeFileSync(path.join(backupDir, backup), original, { mode: 0o600, flag: 'wx' });
        const seen = new Set();
        const lines = original.split('\n').flatMap((line) => {
            const key = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)?.[1];
            if (!key) return [line];
            seen.add(key);
            return removals.has(key) ? [] : [Object.hasOwn(updates, key) ? `${key}=${updates[key]}` : line];
        });
        for (const [key, value] of Object.entries(updates)) if (!seen.has(key)) lines.push(`${key}=${value}`);
        writeEnvFile(panelEnvFile, lines.join('\n'));
        return { ok: true, backup };
    }
    if (request.action === 'restore') {
        if (!/^panel-\d+-\d+$/.test(request.backup || '')) throw new Error('Invalid panel backup');
        writeEnvFile(panelEnvFile, fs.readFileSync(path.join(backupDir, request.backup), 'utf8'));
        return { ok: true };
    }
    if (request.action === 'apply') {
        if (!['host', 'docker'].includes(config.RSSHUB_MODE)) throw new Error('RSSHUB_MODE must be host or docker');
        applySettings();
        return { ok: await waitHealthy() };
    }
    if (request.action === 'restart') {
        run('/bin/systemctl', ['--no-block', 'restart', config.PANEL_SERVICE]);
        return { ok: true };
    }
    throw new Error('Unknown environment operation');
}
function replacePanelSetting(key, value) {
    const original = fs.readFileSync(panelEnvFile, 'utf8');
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    const text = pattern.test(original) ? original.replace(pattern, `${key}=${value}`) : `${original.trimEnd()}\n${key}=${value}\n`;
    writeEnvFile(panelEnvFile, text);
}
async function deployRoot() {
    if (process.getuid() !== 0) throw new Error('Deploy requires the approved sudo entry point');
    if (process.argv.length !== 3) throw new Error('Deploy does not accept arguments');
    fs.mkdirSync(config.DEPLOY_STATE_DIR, { recursive: true, mode: 0o755 });
    const fd = fs.openSync(lockFile, 'wx', 0o644);
    fs.writeFileSync(fd, String(process.pid));
    const step = (name) => fs.writeFileSync(stepFile, name, { mode: 0o644 });
    try {
        if (dockerMode) {
            step('pull');
            await command('/usr/bin/git', ['--git-dir', config.SOURCE_CACHE_DIR, 'fetch', '--no-tags', config.SOURCE_REPOSITORY, 'refs/heads/main']);
            const revision = run('/usr/bin/git', ['--git-dir', config.SOURCE_CACHE_DIR, 'rev-parse', `${config.SOURCE_REF}^{commit}`]).trim();
            if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Invalid deployment revision');
            run('/usr/bin/git', ['--git-dir', config.SOURCE_CACHE_DIR, 'merge-base', '--is-ancestor', revision, 'FETCH_HEAD']);
            const oldImage = readEnv(panelEnvFile).RSSHUB_IMAGE;
            const newImage = `${config.IMAGE_PREFIX}:${revision}-${Date.now()}`;
            step('build');
            try {
                await command('/usr/bin/docker', ['buildx', 'build', '--builder', config.BUILD_BUILDER, '--load', '--platform', 'linux/amd64',
                    '--build-arg', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1', '--label', `org.opencontainers.image.revision=${revision}`,
                    '--tag', newImage, `${config.SOURCE_REPOSITORY}#${revision}`]);
            } finally { try { run('/usr/bin/docker', ['buildx', 'stop', config.BUILD_BUILDER], 30000); } catch {} }
            step('restart');
            replacePanelSetting('RSSHUB_IMAGE', newImage);
            try {
                compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '180'], 210000);
                step('health');
                if (!await waitHealthy()) throw new Error('Docker deployment failed its health check');
            } catch (error) {
                replacePanelSetting('RSSHUB_IMAGE', oldImage);
                compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '180'], 210000);
                throw new Error('Docker deployment failed; previous image restored');
            }
        } else {
            const user = (args) => command('/usr/sbin/runuser', ['-u', config.HOST_USER, '--', ...args], Number(config.DEPLOY_TIMEOUT_MS), { cwd: config.RSSHUB_DIR });
            step('pull'); await user(['/usr/bin/git', 'pull', '--ff-only']);
            step('install'); await user(['/usr/bin/env', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true', 'pnpm', 'install', '--frozen-lockfile']);
            step('build'); await user(['/usr/bin/env', 'pnpm', 'build']);
            step('restart'); restartRsshub();
            step('health'); if (!await waitHealthy()) throw new Error('Host deployment failed its health check');
        }
        process.stdout.write('Deployment healthy\n');
    } finally {
        fs.closeSync(fd);
        fs.unlinkSync(lockFile);
        if (fs.existsSync(stepFile)) fs.unlinkSync(stepFile);
    }
}
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(moduleFile)) {
    if (!['deploy', 'env'].includes(process.argv[2])) throw new Error('Only deploy and env are supported');
    const operation = process.argv[2] === 'env' ? envRoot().then((result) => process.stdout.write(JSON.stringify(result))) : deployRoot();
    operation.catch((error) => { process.stderr.write(maskSecrets(error.message) + '\n'); process.exitCode = 1; });
}
