# CodeDraw

> Code in — diagram out. A slim fork of [Excalidraw](https://github.com/excalidraw/excalidraw) with collaboration, Firebase, marketing and library-browser stripped out, plus a live code-to-diagram editor and a headless HTTP render API.

## What it does

- **Split view**: Monaco code editor on the left, Excalidraw canvas on the right.
- **Live update**: every change in the editor is re-rendered (150 ms debounce).
- **Auto layout** via [dagre](https://github.com/dagrejs/dagre) (hierarchical, top-down).
- Full Excalidraw editing on the canvas: move/restyle shapes, add elements, export PNG/SVG.
- Persistence in `localStorage`.
- **HTTP API** that accepts DSL code and returns a PNG, SVG or `.excalidraw` JSON.

## The DSL

Block-structured. Each top-level statement starts with a keyword
(`node`, `edge`, `arrow`, `line`, `text`) and has an optional `{ ... }`
block of `key: value` attributes.

```text
# Comments start with '#' (line or trailing).
#
# node <id> { label, shape, fill, stroke, at, size }
# edge <id> -> <id> { label }       arrow, bound to nodes
# edge <id> -- <id> { label }       line,  bound to nodes
# arrow { from: x,y  to: x,y  label }   free arrow
# line  { from: x,y  to: x,y }          free line
# text  { content: "...", at, size }    free text
#
# Shapes: rectangle (default) | ellipse | diamond
# The { ... } block is optional when no attributes are needed.

node start {
  label: "Start"
  shape: ellipse
  fill:  #b2f2bb
}

node check {
  label: "Valid?"
  shape: diamond
  fill:  #fff3bf
}

node work  { label: "Process"   fill: #a5d8ff }
node error { label: "Show error" fill: #ffc9c9 }
node done  { label: "End" shape: ellipse fill: #b2f2bb }

edge start -> check
edge check -> work  { label: "yes" }
edge check -> error { label: "no" }
edge work  -> done
edge error -> start { label: "retry" }

text { content: "code in, diagram out" }
```

Attributes accepted in blocks:

| Statement | Keys |
| --------- | ---- |
| `node`    | `label: "..."`, `shape: rectangle\|ellipse\|diamond`, `fill: #hex`, `stroke: #hex`, `at: x, y`, `size: w, h` |
| `edge`    | `label: "..."` |
| `arrow`   | `from: x, y`, `to: x, y`, `label: "..."` |
| `line`    | `from: x, y`, `to: x, y` |
| `text`    | `content: "..."`, `at: x, y`, `size: fontSize` |

Canvas edits (move, restyle, add free arrows, etc.) are serialised back
into this same DSL in real time — round-trip is stable.

## Development

Requirements: Node ≥ 18, yarn 1.x.

```bash
yarn install
yarn start            # web UI at http://localhost:3001
yarn build            # → codedraw-app/dist
yarn preview          # → http://localhost:4173
```

Run the API in dev mode (requires the web app to be running, since the API
loads it headlessly):

```bash
# in another shell, after `yarn start` is up
CODEDRAW_WEB_URL=http://localhost:3001 yarn --cwd codedraw-api dev
# API listens on http://localhost:3000
```

## Docker (web only)

```bash
docker build -t codedraw-web .
docker run --rm -p 8080:80 codedraw-web
# → http://localhost:8080
```

## HTTP API (`codedraw-api`)

A small Fastify service that accepts DSL code over HTTP and returns
**PNG / SVG / JSON**. Internally it opens the web app headlessly in
Chromium (via Playwright) and reuses Excalidraw's own export pipeline, so
the output is pixel-identical to a browser export.

### Endpoints

| Method | Path        | Description                                                |
|--------|-------------|------------------------------------------------------------|
| `GET`  | `/`         | Service index — lists endpoints, supported formats/shapes. |
| `GET`  | `/health`   | Liveness; reports browser/page state.                      |
| `GET`  | `/grammar`  | Plain-text DSL grammar reference (self-describing).        |
| `GET`  | `/example`  | Plain-text working DSL sample.                             |
| `POST` | `/render`   | DSL code → PNG / SVG / JSON.                               |

`POST /render` body (JSON):

```jsonc
{
  // DSL source — see GET /grammar for the full reference
  "code": "node a { label: \"Start\" shape: ellipse }\nnode b { label: \"End\" }\nedge a -> b { label: \"go\" }",
  "format": "png",          // "png" | "svg" | "json"  (default: "png")
  "scale": 2,                // PNG only, 0.25 – 5  (default: 1)
  "padding": 20,             // export padding in px (default: 20)
  "background": "#ffffff",   // CSS color, or "transparent"
  "theme": "light"           // "light" | "dark"
}
```

Response:

- `format=png`  → `image/png` binary
- `format=svg`  → `image/svg+xml` text
- `format=json` → `.excalidraw` scene as JSON
- Parser warnings (unparsable lines, etc.) are returned in the
  `x-codedraw-errors` header as a JSON array.

### Auth

Set `CODEDRAW_API_KEY` on the API container to enable bearer auth. Clients
must then send `Authorization: Bearer <key>`. If the env var is unset, the
endpoint is open.

### Examples

```bash
# Inspect the grammar and a sample (great for LLMs / scripting)
curl http://server:8081/grammar
curl http://server:8081/example

# PNG to file
curl -X POST http://server:8081/render \
  -H "content-type: application/json" \
  -d '{"code":"node a { label: \"Start\" shape: ellipse }\nnode b { label: \"End\" }\nedge a -> b","format":"png","scale":2}' \
  --output diagram.png

# SVG to stdout from the canned example
curl -X POST http://server:8081/render \
  -H "content-type: application/json" \
  --data "$(jq -Rs '{code:., format:\"svg\"}' < <(curl -s http://server:8081/example))" > diagram.svg

# with auth
curl -X POST http://server:8081/render \
  -H "authorization: Bearer secret" \
  -H "content-type: application/json" \
  -d '{"code":"edge a -> b","format":"png"}' --output d.png
```

### Using CodeDraw from an LLM / agent

The API is intentionally self-describing so an AI agent only needs the
base URL (and optional bearer token) to produce diagrams:

1. `GET /grammar` — the complete DSL spec as plain text. Drop it into the
   system prompt or fetch on demand.
2. `GET /example` — a runnable starter snippet. Useful as a few-shot
   anchor.
3. Generate DSL `code` matching the grammar.
4. `POST /render` with `{ "code": "...", "format": "svg" | "png" }` and
   save the binary response.

Minimal pseudo-loop:

```text
spec  = GET  /grammar
start = GET  /example
code  = LLM.generate(prompt, spec, start)
png   = POST /render  { code, format: "png", scale: 2 }
write "diagram.png" png
```

Parser warnings are returned in the `x-codedraw-errors` response header
(JSON array of `{ line, message, raw }`). An agent should re-prompt the
model with those errors if non-empty.

### Configuration (API)

| Env var                       | Default          | Meaning                                   |
|-------------------------------|------------------|-------------------------------------------|
| `CODEDRAW_WEB_URL`            | `http://web`     | Where the web app is reachable from the API container. |
| `PORT`                        | `3000`           | API listen port.                          |
| `CODEDRAW_API_KEY`            | *(unset)*        | If set, requires `Authorization: Bearer`. |
| `CODEDRAW_MAX_CODE_BYTES`     | `65536`          | Reject larger payloads.                   |
| `CODEDRAW_RENDER_TIMEOUT_MS`  | `15000`          | Per-render Playwright timeout.            |

## Deployment

CI builds two images and pushes them to GHCR:

- `ghcr.io/<owner>/codedraw-web` — nginx serving the SPA
- `ghcr.io/<owner>/codedraw-api` — Fastify + headless Chromium

On any Docker host:

```bash
mkdir -p /opt/codedraw && cd /opt/codedraw
curl -O https://raw.githubusercontent.com/<owner>/codedraw/main/docker-compose.yml
# edit docker-compose.yml and replace "OWNER" with your GitHub user/org
docker login ghcr.io          # only if the images are private
docker compose pull
docker compose up -d
```

Exposed ports: `8080` = web UI, `8081` = API. Put a reverse proxy with TLS
(Caddy / nginx / Traefik) in front of them, e.g.:

- `codedraw.example.com`      → `http://localhost:8080`
- `codedraw-api.example.com`  → `http://localhost:8081`

### Hetzner quickstart (Cloud / Cloud VM)

On a fresh Ubuntu 22.04+ CX22/CX32 (≥ 2 GB RAM recommended — Chromium is
hungry):

```bash
# 1. Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# 2. Pull the compose file and edit OWNER + (optional) API key
mkdir -p /opt/codedraw && cd /opt/codedraw
curl -O https://raw.githubusercontent.com/<owner>/codedraw/main/docker-compose.yml
sed -i 's/OWNER/<your-github-user>/g' docker-compose.yml
# optionally: echo 'CODEDRAW_API_KEY=changeme' >> .env  (compose reads .env automatically)

# 3. (private images only) log in to GHCR
echo $GHCR_TOKEN | docker login ghcr.io -u <user> --password-stdin

# 4. Start
docker compose pull
docker compose up -d
docker compose logs -f api    # wait for "Listening at http://0.0.0.0:3000"

# 5. Smoke test
curl http://localhost:8081/health
curl http://localhost:8081/example | \
  jq -Rs '{code:., format:"png", scale:2}' | \
  curl -X POST http://localhost:8081/render \
       -H 'content-type: application/json' \
       --data-binary @- --output /tmp/d.png
```

For TLS, point a Hetzner DNS A-record at the VM and put Caddy in front:

```caddyfile
codedraw.example.com {
  reverse_proxy localhost:8080
}
codedraw-api.example.com {
  reverse_proxy localhost:8081
}
```

Hetzner firewall: open 80/443 inbound to the VM. The 8080/8081 ports do
not need to be exposed publicly when Caddy is in place.

## License & credits

CodeDraw is a fork of [Excalidraw](https://github.com/excalidraw/excalidraw)
and is distributed under the **MIT license** — see [`LICENSE`](LICENSE) and
[`NOTICE.md`](NOTICE.md).
