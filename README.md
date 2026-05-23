# CodeDraw

> Code in — diagram out. A slim fork of [Excalidraw](https://github.com/excalidraw/excalidraw)
> with collaboration, Firebase, marketing and the library browser stripped
> out, plus a live code↔diagram editor and a headless HTTP render API.

Live: <https://codedraw.dehlwes.net> · API: <https://codedraw.dehlwes.net/api/>

<table><tr><td width="55%">

```
node start { label: "Start"      shape: ellipse  fill: #b2f2bb }
node input { label: "Read input"                               }
node check { label: "Valid?"     shape: diamond  fill: #fff3bf }
node work  { label: "Process"                   fill: #a5d8ff }
node error { label: "Show error"                fill: #ffc9c9
             stroke: #c92a2a                                   }
node done  { label: "End"        shape: ellipse  fill: #b2f2bb }

edge start -> input
edge input -> check
edge check -> work  { label: "yes" }
edge check -> error { label: "no"    color: #c92a2a style: dashed }
edge work  -> done
edge error -> input { label: "retry" style: dotted }
edge done  ~> start { label: "again" color: #1971c2
                      fromSide: right toSide: right }
```

</td><td width="45%">

<img src="https://raw.githubusercontent.com/Luraxx/codedraw/main/codedraw-app/public/image.png" width="420" alt="generated diagram"/>

</td></tr></table>

## Features

- **Split view** — Monaco editor on the left, Excalidraw canvas on the right.
- **Real-time, bidirectional sync** — typing updates the canvas; canvas edits
  (move, restyle, draw free shapes) feed back into the code.
- **Auto-layout** via [dagre](https://github.com/dagrejs/dagre) when no
  explicit coordinates are given.
- **Hide-code toggle** for a full-canvas mode.
- **HTTP API** that accepts DSL source and returns PNG / SVG / `.excalidraw` JSON.
- **Self-describing API** (`GET /grammar`, `GET /example`) for LLM and
  agent consumption.

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

node work  { label: "Process"    fill: #a5d8ff }
node error { label: "Show error" fill: #ffc9c9 }
node done  { label: "End" shape: ellipse fill: #b2f2bb }

edge start -> check
edge check -> work  { label: "yes" }
edge check -> error { label: "no" }
edge work  -> done
edge error -> start { label: "retry" }

text { content: "code in, diagram out" }
```

Attributes accepted per statement:

| Statement | Keys |
| --------- | ---- |
| `node`    | `label: "..."`, `shape: rectangle\|ellipse\|diamond`, `fill: #hex`, `stroke: #hex`, `at: x, y`, `size: w, h` |
| `edge`    | `label: "..."` |
| `arrow`   | `from: x, y`, `to: x, y`, `label: "..."` |
| `line`    | `from: x, y`, `to: x, y` |
| `text`    | `content: "..."`, `at: x, y`, `size: fontSize` |

Round-trip from canvas back to code is stable — every node gets explicit
`at:` and `size:` so dagre is bypassed and positions are preserved.

## Development

Requirements: Node ≥ 18, yarn 1.x.

```bash
yarn install
yarn start            # web UI at http://localhost:3001
yarn build            # → codedraw-app/dist
yarn preview          # → http://localhost:4173
```

Run the API in dev (the web app must be up — the API loads it headlessly):

```bash
CODEDRAW_WEB_URL=http://localhost:3001 yarn --cwd codedraw-api dev
# API listens on http://localhost:3000
```

## HTTP API

A Fastify service that accepts DSL source and returns **PNG / SVG / JSON**.
Internally it opens the SPA in headless Chromium (via Playwright) and
reuses Excalidraw's own export pipeline, so the output is identical to a
browser export.

### Endpoints

| Method | Path        | Description                                                |
|--------|-------------|------------------------------------------------------------|
| `GET`  | `/api/`         | Service index — endpoints, supported formats/shapes.   |
| `GET`  | `/api/health`   | Liveness; reports browser/page state.                  |
| `GET`  | `/api/grammar`  | Plain-text DSL grammar reference (self-describing).    |
| `GET`  | `/api/example`  | Plain-text working DSL sample.                         |
| `POST` | `/api/render`   | DSL code → PNG / SVG / JSON.                           |

`POST /api/render` body (JSON):

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
- Parser warnings are returned in the `x-codedraw-errors` header as a JSON
  array of `{ line, message, raw }`.

### Auth

Set `CODEDRAW_API_KEY` on the API container to enable bearer auth. Clients
must then send `Authorization: Bearer <key>`. Unset = open endpoint.

### Examples

```bash
# Inspect grammar / fetch a sample
curl https://codedraw.dehlwes.net/api/grammar
curl https://codedraw.dehlwes.net/api/example

# PNG to file
curl -X POST https://codedraw.dehlwes.net/api/render \
  -H "content-type: application/json" \
  -d '{"code":"node a { label: \"Start\" shape: ellipse }\nnode b { label: \"End\" }\nedge a -> b","format":"png","scale":2}' \
  --output diagram.png

# With auth
curl -X POST https://codedraw.dehlwes.net/api/render \
  -H "authorization: Bearer $CODEDRAW_API_KEY" \
  -H "content-type: application/json" \
  -d '{"code":"edge a -> b","format":"png"}' --output d.png
```

### Using CodeDraw from an LLM / agent

The API is intentionally self-describing — an agent only needs the base
URL (and optional bearer token):

1. `GET /api/grammar` — full DSL spec as plain text (drop into the system prompt).
2. `GET /api/example` — runnable sample, useful as a few-shot anchor.
3. Generate DSL `code`.
4. `POST /api/render` with `{ code, format }` and save the response.

Pseudo-loop:

```text
spec   = GET  https://codedraw.dehlwes.net/api/grammar
sample = GET  https://codedraw.dehlwes.net/api/example
code   = LLM.generate(prompt, spec, sample)
png    = POST https://codedraw.dehlwes.net/api/render  { code, format: "png", scale: 2 }
write "diagram.png", png
```

Pseudo-loop:

```text
spec   = GET  https://codedraw.dehlwes.net/api/grammar
sample = GET  https://codedraw.dehlwes.net/api/example
code   = LLM.generate(prompt, spec, sample)
png    = POST https://codedraw.dehlwes.net/api/render  { code, format: "png", scale: 2 }
write "diagram.png", png
```

If `x-codedraw-errors` is non-empty, re-prompt the model with those errors.

## Deployment

Production deploy on Hetzner with Caddy + Docker Compose is documented
separately: see [**docs/DEPLOYMENT.md**](docs/DEPLOYMENT.md).

## License & credits

CodeDraw is a fork of [Excalidraw](https://github.com/excalidraw/excalidraw)
and is distributed under the **MIT license** — see [`LICENSE`](LICENSE) and
[`NOTICE.md`](NOTICE.md).
