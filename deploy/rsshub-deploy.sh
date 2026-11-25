#!/bin/bash
set -euo pipefail
STEPFILE=/opt/rsshub-panel/data/deploy-step.txt
mkdir -p /opt/rsshub-panel/data
trap 'rm -f "$STEPFILE"' EXIT
step() { echo "$1" > "$STEPFILE"; }
cd /opt/rsshub
step pull
su -s /bin/bash rsshub -c "git pull --ff-only"
step install
su -s /bin/bash rsshub -c "export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true; pnpm install --frozen-lockfile"
step build
su -s /bin/bash rsshub -c "pnpm build"
step restart
systemctl restart rsshub
step health
AK=$(grep "^ACCESS_KEY=" /opt/rsshub/.env 2>/dev/null | cut -d= -f2- || true)
for i in $(seq 1 15); do
    sleep 2
    if curl -fsS "http://127.0.0.1:1200/healthz${AK:+?key=$AK}"; then exit 0; fi
done
echo "health check did not pass within 30s" >&2
exit 1
