import grp
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

panel = pathlib.Path(__file__).resolve().parent
module = panel / 'service.js'
script = 'import {defaults,config} from ' + json.dumps(module.as_uri()) + '; console.log(JSON.stringify({defaults,values:Object.fromEntries(Object.keys(defaults).map((k)=>[k,config[k]]))}));'
settings = json.loads(subprocess.check_output(['/usr/bin/node', '--input-type=module', '-e', script], text=True))
c = settings['values']
if os.geteuid() != 0:
    raise SystemExit('Configuration installation requires root')
for key in ('RSSHUB_DIR', 'RSSHUB_ENV_FILE', 'PANEL_DIR', 'DOCKER_COMPOSE_DIR', 'DEPLOY_SCRIPT', 'DEPLOY_STATE_DIR'):
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', c[key]):
        raise SystemExit('Unsupported characters in ' + key)
for key in ('HOST_SERVICE', 'HOST_USER', 'HOST_GROUP', 'PANEL_USER', 'PANEL_GROUP', 'PANEL_SERVICE', 'DOCKER_SERVICE', 'DOCKER_REDIS_SERVICE', 'DOCKER_PROJECT', 'DOCKER_COMPOSE_FILE', 'DOCKER_VOLUME'):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+', c[key]):
        raise SystemExit('Unsupported characters in ' + key)
uid = int(subprocess.check_output(['id', '-u', c['PANEL_USER']], text=True))
gid = grp.getgrnam(c['PANEL_GROUP']).gr_gid
panel_env = panel / '.env'
text = panel_env.read_text()
existing = {line.split('=', 1)[0] for line in text.splitlines() if '=' in line and not line.startswith('#')}
extra = ''.join(key + '=' + str(value) + '\n' for key, value in settings['defaults'].items() if key not in existing)
if extra:
    panel_env.write_text(text.rstrip('\n') + '\n' + extra)
os.chown(panel, 0, 0)
os.chmod(panel, 0o755)
for name in ('server.js', 'service.js', 'configure.py'):
    os.chown(panel / name, 0, 0)
    os.chmod(panel / name, 0o755 if name == 'service.js' else 0o644)
for name in (c['PANEL_DATA_DIR'], c['PANEL_BACKUP_DIR']):
    p = pathlib.Path(name)
    p.mkdir(parents=True, exist_ok=True)
    os.chown(p, uid, gid)
    os.chmod(p, 0o700)
    for item in p.iterdir():
        if item.is_file():
            os.chmod(item, 0o600)
app_env = pathlib.Path(c['RSSHUB_ENV_FILE'])
app_text = app_env.read_text()
if not re.search(r'^NODE_OPTIONS=', app_text, re.M):
    app_text = app_text.rstrip('\n') + '\nNODE_OPTIONS=' + c['HOST_NODE_OPTIONS'] + '\n'
    app_env.write_text(app_text)
compose_dir = pathlib.Path(c['DOCKER_COMPOSE_DIR'])
compose_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(compose_dir, 0o700)
def var(name):
    return '${' + name + '}'
logging = {'driver': 'json-file', 'options': {'max-size': var('DOCKER_LOG_MAX_SIZE'), 'max-file': var('DOCKER_LOG_MAX_FILES')}}
health = "const http=require('node:http');const u=new URL('http://127.0.0.1:'+process.env.PORT+'/healthz');if(process.env.ACCESS_KEY)u.searchParams.set('key',process.env.ACCESS_KEY);const r=http.get(u,(s)=>{s.resume();process.exit(s.statusCode===200?0:1)});r.setTimeout(5000,()=>{r.destroy();process.exit(1)});r.on('error',()=>process.exit(1));"
compose = {'name': var('DOCKER_PROJECT'), 'services': {
    c['DOCKER_SERVICE']: {
        'image': var('RSSHUB_IMAGE'), 'restart': 'unless-stopped', 'cpus': var('RSSHUB_CPUS'),
        'mem_limit': var('RSSHUB_MEMORY'), 'memswap_limit': var('RSSHUB_MEMORY'), 'pids_limit': var('RSSHUB_PIDS'),
        'command': ['node', '--max-old-space-size=' + var('RSSHUB_HEAP_MB'), var('RSSHUB_ENTRY')],
        'env_file': [{'path': var('RSSHUB_ENV_FILE'), 'format': 'raw'}],
        'environment': {'NODE_ENV': 'production', 'PORT': var('RSSHUB_CONTAINER_PORT'), 'LISTEN_INADDR_ANY': '1', 'CACHE_TYPE': 'redis', 'REDIS_URL': var('DOCKER_REDIS_URL')},
        'ports': [var('DOCKER_BIND') + ':' + var('DOCKER_PUBLISH_PORT') + ':' + var('RSSHUB_CONTAINER_PORT')],
        'labels': {'traefik.enable': 'false'}, 'depends_on': {c['DOCKER_REDIS_SERVICE']: {'condition': 'service_healthy'}},
        'healthcheck': {'test': ['CMD', 'node', '-e', health], 'interval': '15s', 'timeout': '10s', 'retries': 6, 'start_period': '30s'},
        'logging': logging,
    },
    c['DOCKER_REDIS_SERVICE']: {
        'image': var('REDIS_IMAGE'), 'restart': 'unless-stopped', 'cpus': var('REDIS_CPUS'),
        'mem_limit': var('REDIS_MEMORY'), 'memswap_limit': var('REDIS_MEMORY'), 'pids_limit': var('REDIS_PIDS'),
        'command': ['redis-server', '--port', var('REDIS_CONTAINER_PORT'), '--maxmemory', var('REDIS_MAXMEMORY'), '--maxmemory-policy', 'allkeys-lru', '--appendonly', 'yes', '--appendfsync', 'everysec'],
        'labels': {'traefik.enable': 'false'}, 'volumes': [c['DOCKER_VOLUME'] + ':/data'],
        'healthcheck': {'test': ['CMD', 'redis-cli', '-p', var('REDIS_CONTAINER_PORT'), 'ping'], 'interval': '10s', 'timeout': '5s', 'retries': 6},
        'logging': logging,
    },
}, 'volumes': {c['DOCKER_VOLUME']: {}}}
compose_file = compose_dir / c['DOCKER_COMPOSE_FILE']
compose_file.write_text(json.dumps(compose, indent=2) + '\n')
os.chmod(compose_file, 0o600)
base = ['/usr/bin/docker', 'compose', '--project-directory', c['DOCKER_COMPOSE_DIR'], '--project-name', c['DOCKER_PROJECT'], '--env-file', str(panel_env), '--file', str(compose_file)]
validation = 'import {validateCompose} from ' + json.dumps(module.as_uri()) + '; validateCompose();'
subprocess.run(['/usr/bin/node', '--input-type=module', '-e', validation], check=True)
commands = [
    ['/bin/systemctl', 'restart', c['HOST_SERVICE']],
    ['/bin/systemctl', 'show', c['HOST_SERVICE'], '-p', 'ActiveEnterTimestamp,ActiveState,NRestarts'],
    ['/bin/journalctl', '-u', c['HOST_SERVICE'], '-n', '200', '--no-pager'],
    ['/usr/bin/redis-cli', '-h', c['HOST_REDIS_HOST'], '-p', c['HOST_REDIS_PORT'], 'FLUSHALL'],
    [c['DEPLOY_SCRIPT'], '""'],
    ['/usr/local/bin/rsshub-service', 'env'],
]
for args in ([ 'ps', '--all', '--format', 'json'], ['restart', c['DOCKER_SERVICE']],
             ['up', '-d', '--no-deps', '--force-recreate', c['DOCKER_SERVICE']],
             ['logs', '--no-color', '--tail', '200', c['DOCKER_SERVICE']],
             ['exec', '-T', c['DOCKER_REDIS_SERVICE'], 'redis-cli', '-p', c['REDIS_CONTAINER_PORT'], 'PING'],
             ['exec', '-T', c['DOCKER_REDIS_SERVICE'], 'redis-cli', '-p', c['REDIS_CONTAINER_PORT'], 'FLUSHALL']):
    commands.append(base + args)
def sudo_arg(value):
    return value.replace('\\', '\\\\').replace(',', '\\,').replace(':', '\\:').replace('=', '\\=')
sudoers = c['PANEL_USER'] + ' ALL=(root) NOPASSWD: ' + ', \\\n    '.join(' '.join(sudo_arg(arg) for arg in command) for command in commands) + '\n'
candidate = pathlib.Path('/etc/sudoers.d/rsshub-panel.next')
candidate.write_text(sudoers)
os.chmod(candidate, 0o440)
subprocess.run(['/usr/sbin/visudo', '-cf', str(candidate)], check=True)
candidate.replace('/etc/sudoers.d/rsshub-panel')
deploy = pathlib.Path(c['DEPLOY_SCRIPT'])
deploy.write_text(r'''#!/bin/sh
set -eu
case " ${SSH_ORIGINAL_COMMAND:-} " in
    *\ /usr/local/bin/rsshub-docker-deploy.sh\ --deploy-staging\ *)
        exec /usr/local/bin/rsshub-docker-deploy.sh --deploy-staging "${SSH_ORIGINAL_COMMAND##* }"
        ;;
esac
exec rsshub-service deploy
''')
os.chown(deploy, 0, 0)
os.chmod(deploy, 0o755)
link = pathlib.Path('/usr/local/bin/rsshub-service')
if not link.exists():
    link.symlink_to(module)
units = {
 c['PANEL_SERVICE']: f'''[Unit]
Description=RSSHub admin panel
After=network.target

[Service]
Type=simple
User={c['PANEL_USER']}
Group={c['PANEL_GROUP']}
WorkingDirectory={c['PANEL_DIR']}
ExecStart=/usr/bin/node {c['PANEL_DIR']}/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
''',
 c['HOST_SERVICE']: f'''[Unit]
Description=RSSHub
After=network.target {c['HOST_REDIS_SERVICE']}.service

[Service]
Type=simple
User={c['HOST_USER']}
Group={c['HOST_GROUP']}
WorkingDirectory={c['RSSHUB_DIR']}
EnvironmentFile={c['RSSHUB_ENV_FILE']}
ExecStart=/usr/bin/node {c['RSSHUB_DIR']}/{c['RSSHUB_ENTRY']}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
''',
}
for name, contents in units.items():
    pathlib.Path('/etc/systemd/system', name + '.service').write_text(contents)
example = []
for key, default in settings['defaults'].items():
    example.extend(['# Default: ' + str(default), key + '='])
for key in ('PANEL_PASSWORD', 'SESSION_SECRET', 'WEBSHARE_API_KEY'):
    example.extend(['# Existing panel credential; preserve its provisioned value.', key + '='])
(panel / '.env.example').write_text('\n'.join(example) + '\n')
app_example = []
for line in app_env.read_text().splitlines():
    if re.match(r'^[A-Z][A-Z0-9_]*=', line):
        key = line.split('=', 1)[0]
        app_example.extend(['# RSSHub runtime setting ' + key + '; use the existing provisioned value.', key + '='])
pathlib.Path(c['RSSHUB_DIR'], '.env.example').write_text('\n'.join(app_example) + '\n')
print('Installed centralized configuration, compose, exact sudo rules, and generated units; services not restarted.')
