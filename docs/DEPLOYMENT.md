# Deployment

CodeDraw ships as two Docker images that the CI workflow publishes to
GitHub Container Registry:

| Image                              | Role                                  | Internal port |
|------------------------------------|---------------------------------------|---------------|
| `ghcr.io/<owner>/codedraw-web`     | nginx serving the SPA                 | `80`          |
| `ghcr.io/<owner>/codedraw-api`     | Fastify + headless Chromium renderer  | `3000`        |

The reference deployment is single-host Docker Compose behind Caddy.

---

## 1. Server prerequisites

Tested target: **Hetzner Cloud CX22 / CX32**, Ubuntu 22.04 LTS.

- ≥ 2 GB RAM (Chromium needs ~500 MB resident under load).
- ≥ 1 vCPU (PNG rasterisation is single-threaded per render).
- 5 GB disk (images ~700 MB combined).
- Inbound TCP 80 and 443 open in the Hetzner Cloud firewall.

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
```

## 2. Fetch the compose file

```bash
sudo mkdir -p /opt/codedraw && sudo chown $USER /opt/codedraw
cd /opt/codedraw
curl -O https://raw.githubusercontent.com/luisdehlwes/codedraw/main/docker-compose.yml
sed -i 's/OWNER/luisdehlwes/g' docker-compose.yml
```

Optional secrets via a sibling `.env` (Compose picks it up automatically):

```ini
# /opt/codedraw/.env
CODEDRAW_API_KEY=replace-with-a-long-random-string
```

If the GHCR images are private:

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u luisdehlwes --password-stdin
```

## 3. Start

```bash
docker compose pull
docker compose up -d
docker compose logs -f api    # wait for: Listening at http://0.0.0.0:3000
```

Exposed locally:

- `127.0.0.1:8080` — web UI
- `127.0.0.1:8081` — API

These should **not** be reachable from the public internet directly; bind
the reverse proxy on 443 instead.

## 4. TLS + reverse proxy (Caddy)

Point DNS at the server:

```
codedraw.dehlwes.net.      A    <server-ip>
codedraw-api.dehlwes.net.  A    <server-ip>
```

Install Caddy and write `/etc/caddy/Caddyfile`:

```caddyfile
codedraw.dehlwes.net {
  encode zstd gzip
  reverse_proxy 127.0.0.1:8080
}

codedraw-api.dehlwes.net {
  encode zstd gzip
  # API payloads are JSON, responses can be PNG up to ~5 MB.
  request_body {
    max_size 1MB
  }
  reverse_proxy 127.0.0.1:8081
}
```

```bash
sudo systemctl reload caddy
```

Caddy automatically obtains and renews Let's Encrypt certificates.

## 5. Smoke test

```bash
curl https://codedraw-api.dehlwes.net/health
curl https://codedraw-api.dehlwes.net/example | \
  jq -Rs '{code:., format:"png", scale:2}' | \
  curl -X POST https://codedraw-api.dehlwes.net/render \
       -H 'content-type: application/json' \
       --data-binary @- --output /tmp/d.png
file /tmp/d.png   # PNG image data, …
```

Open `https://codedraw.dehlwes.net` in the browser — the split editor +
canvas should load.

## 6. Updates

CI pushes a new `:latest` tag for both images on every merge to `main`.
To roll out:

```bash
cd /opt/codedraw
docker compose pull
docker compose up -d
```

State is held purely in `localStorage` on each visitor's browser, so
container restarts are loss-free.

## 7. Configuration reference

### `codedraw-api` env vars

| Variable                       | Default        | Meaning                                       |
|--------------------------------|----------------|-----------------------------------------------|
| `CODEDRAW_WEB_URL`             | `http://web`   | Where to reach the SPA from inside the API container. |
| `PORT`                         | `3000`         | Listen port inside the container.             |
| `HOST`                         | `0.0.0.0`      | Listen address.                               |
| `CODEDRAW_API_KEY`             | *(unset)*      | If set, requires `Authorization: Bearer …`.   |
| `CODEDRAW_MAX_CODE_BYTES`      | `65536`        | Reject payloads larger than this.             |
| `CODEDRAW_RENDER_TIMEOUT_MS`   | `15000`        | Per-render Playwright timeout.                |

### `codedraw-web`

The web image is a static nginx build of the SPA. No runtime configuration
— rebuild the image to change anything.

## 8. Operations

Common one-liners:

```bash
# Tail logs
docker compose logs -f web api

# Restart only the renderer (e.g. after Chromium memory pressure)
docker compose restart api

# Drop and recreate (state is in localStorage on the browser, not server-side)
docker compose down && docker compose up -d
```

Memory pressure: Chromium occasionally leaks under heavy load. A cron-style
nightly restart of the API container is harmless and recommended:

```bash
sudo systemctl edit --force --full codedraw-api-restart.service
# ── unit ──
# [Unit] Description=Nightly restart of codedraw-api
# [Service] Type=oneshot
# ExecStart=/usr/bin/docker compose -f /opt/codedraw/docker-compose.yml restart api

sudo systemctl edit --force --full codedraw-api-restart.timer
# [Unit] Description=Run codedraw-api restart nightly
# [Timer] OnCalendar=*-*-* 04:00:00 Persistent=true
# [Install] WantedBy=timers.target

sudo systemctl enable --now codedraw-api-restart.timer
```
