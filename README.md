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

```text
# Comments start with '#'.
# Nodes:  id [label]                 -> rectangle, neutral colors
#         id [label] (shape)         -> shape ∈ rectangle | ellipse | diamond
#         id [label] (shape, #bg)
#         id [label] (shape, #bg, #stroke)
# Edges:  id1 -> id2                 -> arrow
#         id1 -> id2 : label         -> labelled arrow
#         id1 -- id2 : label         -> plain line (no arrowhead)
# Text:   "free text in quotes"

start [Start]       (ellipse, #b2f2bb)
check [Valid?]      (diamond, #fff3bf)
ok    [Process]     (rectangle, #a5d8ff)
err   [Show error]  (rectangle, #ffc9c9)
done  [End]         (ellipse, #b2f2bb)

start -> check
check -> ok  : yes
check -> err : no
ok    -> done
err   -> check : retry
```

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

| Method | Path       | Description                              |
|--------|------------|------------------------------------------|
| `GET`  | `/health`  | Liveness; reports browser/page state.    |
| `POST` | `/render`  | DSL code → image.                        |

`POST /render` body (JSON):

```jsonc
{
  "code": "a [Start] (ellipse)\nb [End]\na -> b : go",
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
# PNG to file
curl -X POST http://server:8081/render \
  -H "content-type: application/json" \
  -d '{"code":"a [Start] (ellipse)\nb [End]\na -> b","format":"png","scale":2}' \
  --output diagram.png

# SVG to stdout
curl -X POST http://server:8081/render \
  -H "content-type: application/json" \
  -d '{"code":"a -> b -> c","format":"svg"}' > diagram.svg

# with auth
curl -X POST http://server:8081/render \
  -H "authorization: Bearer secret" \
  -H "content-type: application/json" \
  -d '{"code":"a -> b","format":"png"}' --output d.png
```

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

## License & credits

CodeDraw is a fork of [Excalidraw](https://github.com/excalidraw/excalidraw)
and is distributed under the **MIT license** — see [`LICENSE`](LICENSE) and
[`NOTICE.md`](NOTICE.md).
