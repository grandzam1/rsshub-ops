# rsshub-ops

Operational files for the self-hosted RSSHub instance + admin panel.
No secrets in this repo — only examples with empty values.

## Layout

| File | Goes to on the server | Purpose |
|---|---|---|
| `panel/` | `/opt/rsshub-panel/` | Express admin panel (login, env editor, actions, state banner, read-only Webshare usage tab). `server.js` is the whole backend; `public/` is the UI. |
| `panel/.env.example` | `/opt/rsshub-panel/.env` | Copy and fill: `PANEL_PASSWORD`, `SESSION_SECRET`, `WEBSHARE_API_KEY` (optional; enables the Webshare tab, needs the `webshare` CLI at `/usr/local/bin/webshare`). |
| `deploy/rsshub-deploy.sh` | `/usr/local/bin/rsshub-deploy.sh` | `git pull` → `pnpm install` → `pnpm build` → restart → health check. Writes the current step to `/opt/rsshub-panel/data/deploy-step.txt` for the panel banner. |
| `deploy/env/rsshub.env.example` | `/opt/rsshub/.env` | Copy and fill the RSSHub env (`REDIS_URL`, `PROXY_URI`, `TWITTER_AUTH_TOKEN`, `ACCESS_KEY`, …). |
| `deploy/systemd/rsshub.service` | `/etc/systemd/system/rsshub.service` | RSSHub service (user `rsshub`, `/usr/bin/node dist/index.mjs`). |
| `deploy/systemd/rsshub-panel.service` | `/etc/systemd/system/rsshub-panel.service` | Panel service (port 3100, loopback). |
| `deploy/systemd/redis-server.service.d/restart.conf` | same path | Redis auto-restart drop-in. |
| `deploy/sudoers/rsshub-panel` | `/etc/sudoers.d/rsshub-panel` | Passwordless sudo for the exact commands the panel needs. |
| `deploy/traefik/docker-compose.yml` | `/docker/traefik-*/docker-compose.yml` | Traefik, host network, Let's Encrypt (`ACME_EMAIL` env). |
| `deploy/traefik/dynamic/rsshub.yml` | `…/dynamic/rsshub.yml` | TLS router for the RSSHub host → `127.0.0.1:1200`. |
| `deploy/traefik/dynamic/panel.yml` | `…/dynamic/panel.yml` | Same host, `PathPrefix(/panel)` → `127.0.0.1:3100`. |
| `deploy/cron/*` | `/etc/cron.d/` | Docker image/builder prune jobs. |
| `deploy/github-workflow/deploy.yml` | `.github/workflows/deploy.yml` in the RSSHub repo | Reference copy: SSHs in and runs `sudo -n /usr/local/bin/rsshub-deploy.sh`. |

## Placeholders

Replace before use:

- `YOUR_SERVER_IP` — the VPS public IP.
- `YOUR_HOST` — the public hostname Traefik routes on (used in `deploy/traefik/dynamic/*.yml`).
- `YOUR_EMAIL` — Let's Encrypt contact (`ACME_EMAIL` for Traefik).

## Rebuild order

1. Create user `rsshub`; harden SSH.
2. Install Node 26, `pnpm`, Redis, Docker + Compose plugin.
3. `git clone` the RSSHub repo into `/opt/rsshub` (owned by `rsshub`).
4. Copy this repo's files into place (table above); `chmod 755 /usr/local/bin/rsshub-deploy.sh`; `visudo -cf` the sudoers file.
5. Create `/opt/rsshub/.env` and `/opt/rsshub-panel/.env` from the `.example` files and fill real values.
6. Start Traefik (`docker compose up -d`), then `systemctl enable --now redis-server rsshub rsshub-panel`.
7. In the RSSHub repo on GitHub, add the 4 Actions secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_KNOWN_HOSTS`, and put `deploy/github-workflow/deploy.yml` in place.

Never commit `.env`, `data/`, `backups/`, `acme.json`, or keys — see `.gitignore`.
