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
docker build -t codedraw .
docker run --rm -p 8080:80 codedraw
# → http://localhost:8080
```

## Deployment (Hetzner via GHCR)

1. Repo auf GitHub liegt → der Workflow `.github/workflows/build-and-push.yml` baut bei jedem Push auf `main` ein Image und pushed es nach `ghcr.io/luisdehlwes/codedraw:latest`.
2. Auf dem Hetzner-Server (Docker + Compose vorausgesetzt):
   ```bash
   mkdir -p /opt/codedraw && cd /opt/codedraw
   curl -O https://raw.githubusercontent.com/luisdehlwes/codedraw/main/docker-compose.yml
   docker login ghcr.io          # nur falls Image privat
   docker compose pull
   docker compose up -d
   ```
   App läuft danach auf Port `8080` — davor ein nginx / Caddy / Traefik als Reverse-Proxy mit TLS.

## Lizenz / Credits

CodeDraw ist ein Fork von [Excalidraw](https://github.com/excalidraw/excalidraw) und steht unter der **MIT-Lizenz** — siehe `LICENSE` und `NOTICE.md`.
