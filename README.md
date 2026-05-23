# CodeDraw

> Code rein — Diagramm raus. Ein schlanker Fork von [Excalidraw](https://github.com/excalidraw/excalidraw), entkoppelt von Collab / Firebase / Marketing, mit Live-Code-zu-Diagramm Editor.

## Was es kann

- **Split-View**: links Monaco Code-Editor, rechts Excalidraw-Canvas
- **Live-Update**: jede Änderung im Code wird sofort gerendert (Debounce 150 ms)
- **Auto-Layout** via [dagre](https://github.com/dagrejs/dagre) (hierarchisch, top-down)
- Volles Excalidraw-Editing am Canvas (Formen verschieben, einfärben, mehr Elemente hinzufügen, Export PNG/SVG)
- Persistenz in `localStorage`

## Die DSL

```text
# Kommentar
# Knoten:  id [label]                        -> rectangle, neutral
#          id [label] (shape)                -> shape ∈ rectangle|ellipse|diamond
#          id [label] (shape, #bg)
#          id [label] (shape, #bg, #stroke)
# Kante:   id1 -> id2                         -> Pfeil
#          id1 -> id2 : Label                 -> Pfeil mit Label
#          id1 -- id2 : Label                 -> Linie ohne Pfeilspitze
# Text:    "freier Text"

start [Start]            (ellipse, #b2f2bb)
check [Gültig?]          (diamond, #fff3bf)
ok    [Verarbeiten]      (rectangle, #a5d8ff)
err   [Fehler]           (rectangle, #ffc9c9)
done  [Ende]             (ellipse, #b2f2bb)

start -> check
check -> ok  : ja
check -> err : nein
ok    -> done
err   -> check : retry
```

## Entwicklung

Voraussetzungen: Node ≥ 18, yarn 1.x.

```bash
yarn install
yarn start            # http://localhost:3001
yarn build            # → codedraw-app/dist
yarn preview          # → http://localhost:4173
```

## Docker

```bash
docker build -t codedraw-web .
docker run --rm -p 8080:80 codedraw-web
# → http://localhost:8080
```

## HTTP-API (`codedraw-api`)

Zusätzlich zum Web-UI gibt es einen kleinen Service, der per HTTP DSL-Code
entgegennimmt und ein **PNG / SVG / JSON** zurückgibt. Intern öffnet er die
Web-App headless in Chromium und benutzt die Excalidraw-Export-Pipeline —
das Ergebnis ist also pixel-identisch zum Browser-Export.

### Endpoints

| Method | Path       | Beschreibung                              |
|--------|------------|-------------------------------------------|
| `GET`  | `/health`  | Status (browser/page bereit)              |
| `POST` | `/render`  | DSL-Code → PNG/SVG/JSON                   |

`POST /render` Body (JSON):

```jsonc
{
  "code": "a [Start] (ellipse)\nb [Ende]\na -> b : go",
  "format": "png",          // "png" | "svg" | "json"  (default: "png")
  "scale": 2,                // PNG only, 0.25 – 5  (default 1)
  "padding": 20,             // export padding in px (default 20)
  "background": "#ffffff",   // oder "transparent"
  "theme": "light"           // "light" | "dark"
}
```

Antwort:
- `format=png` → `image/png` Binary
- `format=svg` → `image/svg+xml` Text
- `format=json` → `.excalidraw`-Scene als JSON
- Parser-Warnings landen im Header `x-codedraw-errors` (JSON-Array).

### Auth

Setze `CODEDRAW_API_KEY` env-var auf den API-Container. Clients senden dann
`Authorization: Bearer <key>`. Ohne gesetzten Key ist der Endpoint offen.

### Beispiele

```bash
# PNG nach datei
curl -X POST http://server:8081/render \
  -H "content-type: application/json" \
  -d '{"code":"a [Start] (ellipse)\nb [Ende]\na -> b","format":"png","scale":2}' \
  --output diagram.png

# SVG nach stdout
curl -X POST http://server:8081/render \
  -H "content-type: application/json" \
  -d '{"code":"a -> b -> c","format":"svg"}' > diagram.svg

# mit auth
curl -X POST http://server:8081/render \
  -H "authorization: Bearer geheim" \
  -H "content-type: application/json" \
  -d '{"code":"a -> b","format":"png"}' --output d.png
```

## Deployment (Hetzner via GHCR)

CI baut zwei Images: `ghcr.io/luisdehlwes/codedraw-web` (nginx-SPA) und
`ghcr.io/luisdehlwes/codedraw-api` (Fastify + Chromium).

```bash
mkdir -p /opt/codedraw && cd /opt/codedraw
curl -O https://raw.githubusercontent.com/luisdehlwes/codedraw/main/docker-compose.yml
docker login ghcr.io          # nur falls Images privat
docker compose pull
docker compose up -d
```

Ports nach außen: `8080` = Web-UI, `8081` = API. Davor ein
Reverse-Proxy mit TLS (Caddy / nginx / Traefik), z.B.:

- `codedraw.example.com` → `http://localhost:8080`
- `codedraw-api.example.com` → `http://localhost:8081`

## Lizenz / Credits

CodeDraw ist ein Fork von [Excalidraw](https://github.com/excalidraw/excalidraw) und steht unter der **MIT-Lizenz** — siehe `LICENSE` und `NOTICE.md`.
