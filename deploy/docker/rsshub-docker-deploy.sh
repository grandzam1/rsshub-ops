#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

mode=${1:-}
revision=${2:-}
if ! { [[ $# -eq 2 && $mode == --deploy-staging && $revision =~ ^[0-9a-f]{40}$ ]] || [[ $# -eq 1 && $mode =~ ^--(rollback|recover)-staging$ ]]; }; then
    printf 'Usage: deploy-vps.sh --deploy-staging <main-sha> | --rollback-staging | --recover-staging\n' >&2
    exit 1
fi
if [[ $EUID -ne 0 ]]; then
    printf 'Run the installed helper through the approved root SSH/sudo setup.\n' >&2
    exit 1
fi

state_dir=/var/lib/rsshub-docker
runtime_env=/etc/rsshub-docker/rsshub.env
project=rsshub-docker-staging
repository_url=https://github.com/grandzam1/Rsshub.git
redis_source=redis:7-alpine@sha256:7f7d30b7fdd09467bac58198a1f166dd69789d348d4fe859cccb20e0cf287fbe

for tool in docker git python3 flock ss awk gzip timeout head stat df install mktemp; do
    command -v "$tool" >/dev/null || { printf 'Required command is missing: %s\n' "$tool" >&2; exit 1; }
done
docker compose version >/dev/null
docker info >/dev/null
install -d -m 0700 "$state_dir" "$state_dir/releases"
exec 9>"$state_dir/deploy.lock"
flock -n 9 || { printf 'Another staging operation is running.\n' >&2; exit 1; }

read_pointer() {
    local name
    [[ -f $state_dir/$1 ]] || return 0
    name=$(<"$state_dir/$1")
    [[ $name =~ ^[0-9a-f]{40}\.[A-Za-z0-9]+$ && -d $state_dir/releases/$name ]] || return 1
    printf '%s' "$state_dir/releases/$name"
}

write_pointer() {
    printf '%s\n' "${2##*/}" > "$state_dir/$1.next"
    mv "$state_dir/$1.next" "$state_dir/$1"
}

compose_for() {
    local release=$1 sha redis_image
    shift
    sha=$(<"$release/revision")
    redis_image=$(<"$release/redis-image")
    if python3 -c 'from pathlib import Path; import sys; sys.exit(0 if "RSSHUB_MODE=docker" in Path("/opt/rsshub-panel/.env").read_text().splitlines() else 1)'; then
        RSSHUB_IMAGE="rsshub-vps:$sha" docker compose --project-name "$project" \
            --env-file /opt/rsshub-panel/.env --file /var/lib/rsshub-docker/panel-stack/compose.yml "$@" || return 1
        if [[ ${1:-} == up ]]; then
            printf '{"action":"write","updates":{"RSSHUB_IMAGE":"rsshub-vps:%s"}}' "$sha" | \
                /usr/bin/node /opt/rsshub-panel/service.js env >/dev/null
        fi
    else
        RSSHUB_IMAGE="rsshub-vps:$sha" REDIS_IMAGE="$redis_image" RSSHUB_ENV_FILE="$release/rsshub.env" \
            docker compose --project-name "$project" --env-file /dev/null --file "$release/compose.yml" "$@"
    fi
}

load_images() {
    local sha expected actual
    gzip -dc "$1/rsshub-image.tar.gz" | docker image load --quiet >/dev/null || return 1
    gzip -dc "$1/redis-image.tar.gz" | docker image load --quiet >/dev/null || return 1
    sha=$(<"$1/revision")
    expected=$(<"$1/rsshub-image-id")
    actual=$(docker image inspect "rsshub-vps:$sha" --format '{{.Id}}') || return 1
    [[ $actual == "$expected" ]]
}

restore_release() {
    load_images "$1" || return 1
    compose_for "$1" config --quiet || return 1
    compose_for "$1" up --detach --no-build --pull never --wait --wait-timeout 180 redis rsshub
}

recover_pending() {
    local current pending
    current=$(read_pointer current)
    pending=$(read_pointer pending)
    [[ -n $pending ]] || return 0
    if [[ -n $current ]]; then
        restore_release "$current" || return 1
    else
        compose_for "$pending" stop rsshub redis || return 1
    fi
    rm -f "$state_dir/pending"
    printf 'Staging recovery completed; host services and Redis volumes were not removed.\n'
}

if [[ -f $state_dir/pending ]]; then
    recover_pending || { printf 'Recovery failed; keep the archives and retry --recover-staging.\n' >&2; exit 1; }
    if [[ $mode != --recover-staging ]]; then
        printf 'Recovered an interrupted operation. Retry the requested operation explicitly.\n' >&2
        exit 1
    fi
fi
if [[ $mode == --recover-staging ]]; then
    printf 'No pending staging recovery remains.\n'
    exit 0
fi

current=$(read_pointer current)
if [[ $mode == --rollback-staging ]]; then
    previous=$(read_pointer previous)
    [[ -n $previous ]] || { printf 'No previous healthy Docker release is available.\n' >&2; exit 1; }
    candidate=$previous
else
    managed=$(read_pointer managed)
    if [[ -z $current && -z $managed && -n $(docker ps -aq --filter "label=com.docker.compose.project=$project") ]]; then
        printf 'Untracked staging containers exist; refusing to take them over.\n' >&2
        exit 1
    fi
    if [[ -n $(ss -H -ltn 'sport = :11200') && -z $(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=rsshub --filter publish=11200) ]]; then
        printf 'Staging port 11200 belongs to another service; no service was stopped.\n' >&2
        exit 1
    fi
    available=$(df -Pk "$state_dir" | awk 'NR == 2 {print $4}')
    [[ $available -ge 6291456 ]] || { printf 'At least 6 GiB of free disk space is required; retained releases were not deleted.\n' >&2; exit 1; }

    python3 - "$runtime_env" <<'PY'
import pathlib
import re
import stat
import sys
from urllib.parse import urlsplit

path = pathlib.Path(sys.argv[1])
if not path.is_file() or path.is_symlink():
    sys.exit('Securely provision /etc/rsshub-docker/rsshub.env before deploying.')
metadata = path.stat()
if metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) & 0o077:
    sys.exit('The runtime environment must be root-owned with mode 0600.')
values = {}
for line in path.read_text().splitlines():
    if not line or line.startswith('#'):
        continue
    key, separator, value = line.partition('=')
    if not separator or not re.fullmatch(r'[A-Z][A-Z0-9_]*', key) or key in values:
        sys.exit('Use unique KEY=value entries in the raw-format runtime environment file.')
    values[key] = value
for key in ('TWITTER_AUTH_TOKEN', 'PROXY_URI', 'PROXY_URL_REGEX'):
    if not values.get(key):
        sys.exit(f'Missing required runtime setting: {key}')
    if values[key].startswith(('"', "'")):
        sys.exit(f'Raw-format runtime setting must not have surrounding quotes: {key}')
if values.get('PROXY_STRATEGY', 'all') != 'all':
    sys.exit('X/TikTok staging requires PROXY_STRATEGY=all.')
try:
    proxy = urlsplit(values['PROXY_URI'])
    if proxy.scheme != 'http' or not proxy.hostname or not proxy.port or not proxy.username or not proxy.password:
        raise ValueError()
    pattern = re.compile(values['PROXY_URL_REGEX'])
    domains = ('x.com', 'twitter.com', 'twimg.com', 'tiktok.com', 'tiktokcdn.com', 'tiktokv.com')
    if not all(pattern.search('https://www.' + domain + '/') for domain in domains):
        raise ValueError()
except (ValueError, re.error):
    sys.exit('Check the authenticated HTTP proxy URI and X/TikTok regex; values were not logged.')
PY

    repository=$state_dir/repository.git
    [[ -d $repository ]] || git init --bare "$repository"
    git --git-dir="$repository" fetch --no-tags "$repository_url" refs/heads/main
    git --git-dir="$repository" cat-file -e "$revision^{commit}"
    git --git-dir="$repository" merge-base --is-ancestor "$revision" FETCH_HEAD || {
        printf 'The requested commit must belong to main.\n' >&2
        exit 1
    }
    candidate=$(mktemp -d "$state_dir/releases/$revision.XXXXXXXX")
    git --git-dir="$repository" show "$revision:scripts/docker/vps-compose.yml" > "$candidate/compose.yml"
    install -m 0600 "$runtime_env" "$candidate/rsshub.env"
    printf '%s\n' "$revision" > "$candidate/revision"
    timeout 600 head -c 2147483649 > "$candidate/rsshub-image.tar.gz"
    [[ $(stat -c %s "$candidate/rsshub-image.tar.gz") -le 2147483648 ]] || { printf 'Image archive exceeds the 2 GiB limit.\n' >&2; exit 1; }
    gzip -t "$candidate/rsshub-image.tar.gz"
    gzip -dc "$candidate/rsshub-image.tar.gz" | docker image load --quiet >/dev/null
    image_id=$(docker image inspect "rsshub-vps:$revision" --format '{{.Id}}')
    image_revision=$(docker image inspect "$image_id" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
    [[ $image_revision == "$revision" ]] || { printf 'Image revision does not match the approved source commit.\n' >&2; exit 1; }
    printf '%s\n' "$image_id" > "$candidate/rsshub-image-id"
    docker image inspect "$redis_source" >/dev/null 2>&1 || docker image pull "$redis_source" >/dev/null
    redis_id=$(docker image inspect "$redis_source" --format '{{.Id}}')
    redis_image=rsshub-vps-redis:${redis_id#sha256:}
    docker image tag "$redis_id" "$redis_image"
    printf '%s\n' "$redis_image" > "$candidate/redis-image"
    docker image save "$redis_image" | gzip -1 > "$candidate/redis-image.tar.gz"
fi

compose_for "$candidate" config --quiet
write_pointer managed "$candidate"
write_pointer pending "$candidate"
recover_failure() {
    trap - ERR INT TERM
    set +e
    printf 'Staging operation failed; attempting recovery to the last healthy release.\n' >&2
    if ! recover_pending; then
        printf 'Recovery is incomplete. Retry the installed helper with --recover-staging.\n' >&2
    fi
    exit 1
}
trap recover_failure ERR INT TERM
if [[ $mode == --rollback-staging ]]; then
    load_images "$candidate"
fi
compose_for "$candidate" up --detach --no-build --pull never --wait --wait-timeout 180 redis rsshub
if [[ -n $current && $current != "$candidate" ]]; then
    write_pointer previous "$current"
fi
write_pointer current "$candidate"
rm -f "$state_dir/pending"
trap - ERR INT TERM
printf 'Docker staging is healthy at 127.0.0.1:11200. Retained release: %s\n' "${candidate##*/}"
printf 'Host RSSHub, host Redis, the admin panel, and Traefik were not changed.\n'
