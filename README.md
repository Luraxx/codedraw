# CodeDraw

> Code in — diagram out. A slim fork of [Excalidraw](https://github.com/excalidraw/excalidraw)
> with collaboration, Firebase, marketing and the library browser stripped
> out, plus a live code↔diagram editor and a headless HTTP render API.

[![Live Demo](https://img.shields.io/badge/Live_Demo-codedraw.dehlwes.net-4263eb?style=flat-square&logo=globe&logoColor=white)](https://codedraw.dehlwes.net)
[![Render API](https://img.shields.io/badge/API-POST_%2Frender-51cf66?style=flat-square&logo=fastify&logoColor=white)](https://codedraw.dehlwes.net/api/render)
[![MCP Server](https://img.shields.io/badge/MCP-codedraw.dehlwes.net%2Fmcp-f76707?style=flat-square&logo=openai&logoColor=white)](https://codedraw.dehlwes.net/mcp)
[![MIT License](https://img.shields.io/badge/license-MIT-adb5bd?style=flat-square)](LICENSE)

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
# API listens on http://localhost:3010
```

Run the MCP server in dev (the API must be up):

```bash
CODEDRAW_API_URL=http://localhost:3010 yarn --cwd codedraw-mcp dev
# MCP listens on http://localhost:3020
```

Or start everything at once via Docker Compose:

```bash
docker compose up
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
| `GET`  | `/api/examples` | Curated named DSL snippets for few-shot prompting.     |
| `GET`  | `/api/openapi.json` | OpenAPI 3.1 spec (Custom GPT Actions, MCP discovery). |
| `POST` | `/api/validate` | Parser-only validation, returns `{ valid, errors }`.   |
| `POST` | `/api/inspect`  | Structured analysis: `diagramType`, nodes, edges, warnings. |
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

## MCP server

CodeDraw ships a [Model Context Protocol](https://modelcontextprotocol.io/)
server that lets **ChatGPT, Claude, Cursor** and any other MCP-aware client
draw diagrams by writing DSL — with a live inline preview in supported hosts.

| | |
|---|---|
| **MCP endpoint** | `https://codedraw.dehlwes.net/mcp` |
| **Transport** | Streamable HTTP, stateless |
| **Auth** | none (open) |

### Available tools

| Tool | What it does |
|------|-------------|
| `render_diagram` | DSL → **SVG** (default) / PNG image / Excalidraw JSON. In ChatGPT Developer-Mode the result is shown as an inline visual preview. |
| `validate_diagram` | Fast parser-only check — use in an agent correction loop before paying for a full render. |
| `inspect_diagram` | Structured analysis: `diagramType`, node/edge counts, degree warnings, `fromSide`/`toSide` hints. |
| `get_grammar` | Full DSL grammar reference as plain text — drop into the system prompt. |
| `get_examples` | Curated named DSL snippets for few-shot prompting. |

---

### ChatGPT (Developer-Mode connector)

> Renders diagrams as **interactive inline previews** via the MCP Apps SDK widget.

1. Open ChatGPT → **Settings → Apps & Connectors** → enable **Developer mode**.
2. Click **Create connector**.
3. Fill in:
   - **Name:** `CodeDraw`
   - **URL:** `https://codedraw.dehlwes.net/mcp`
4. In the **Description** field paste exactly:

   > Use CodeDraw whenever the user asks for a diagram, flowchart, state machine, sequence, tree, network, or any other shape-and-arrow drawing. Write the diagram in CodeDraw's tiny DSL (`node …`, `edge a -> b`, `edge a ~> b` for elbow, `edge a -- b` for line, `text`, `arrow/elbow/line` for free shapes), call `validate_diagram` first if you are uncertain, then `render_diagram` (default SVG, request `format: "png"` to embed an image). Use `get_grammar` and `get_examples` for reference. Never invent your own diagram syntax.

5. Save and start a new chat. Ask *"Draw a login flow"* — ChatGPT will call `render_diagram` and show the diagram inline.

---

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "codedraw": {
      "type": "http",
      "url": "https://codedraw.dehlwes.net/mcp"
    }
  }
}
```

Restart Claude Desktop. The five tools appear automatically; ask Claude to draw
a diagram and it will call `render_diagram` and return the SVG inline.

---

### Cursor

Open **Settings → MCP** (or edit `.cursor/mcp.json` in your project root):

```json
{
  "mcpServers": {
    "codedraw": {
      "type": "http",
      "url": "https://codedraw.dehlwes.net/mcp"
    }
  }
}
```

In Agent mode, ask Cursor to create an architecture diagram — it will write DSL
and call `render_diagram`, returning the SVG you can embed in docs or open in
the browser.

---

### VS Code (GitHub Copilot agent mode)

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "codedraw": {
      "type": "http",
      "url": "https://codedraw.dehlwes.net/mcp"
    }
  }
}
```

---

### MCP Inspector (debug / smoke test)

```bash
npx @modelcontextprotocol/inspector https://codedraw.dehlwes.net/mcp
```

Opens a browser UI where you can call tools, inspect the widget resource, and
verify `structuredContent` shape before wiring up a real client.

---

### Self-hosting the MCP server

```bash
# env vars required
CODEDRAW_API_URL=http://localhost:3010   # URL of the codedraw-api service
PORT=3020

cd codedraw-mcp && yarn dev
```

Docker Compose already wires everything:

```bash
docker compose up
# web  → http://localhost:8080
# api  → http://localhost:8081
# mcp  → http://localhost:8082/mcp
```

---

## License & credits

CodeDraw is a fork of [Excalidraw](https://github.com/excalidraw/excalidraw)
and is distributed under the **MIT license** — see [`LICENSE`](LICENSE) and
[`NOTICE.md`](NOTICE.md).
