# CodeDraw — Agent API Reference

CodeDraw is a code-driven diagram editor. The user writes a small DSL in the left pane; the right pane shows the live Excalidraw diagram. Every canvas edit is serialized back to DSL automatically.

---

## Quick start — how to draw a diagram

### Option A: write to localStorage (recommended for automation)

```js
localStorage.setItem("codedraw.code.v1", dsl);
location.reload();
```

The app loads the stored code on startup.

### Option B: push directly into the running canvas

```js
const { parseDsl }    = await import("/src/dsl/parser.ts");
const { buildScene }  = await import("/src/dsl/buildScene.ts");
window.__excalidrawAPI.updateScene({ elements: buildScene(parseDsl(dsl)) });
```

### Option C: read the current DSL back

```js
const { serializeScene } = await import("/src/dsl/serialize.ts");
const dsl = serializeScene(window.__excalidrawAPI.getSceneElements());
```

---

## DSL grammar

```
program     = statement*
statement   = node_stmt | edge_stmt | free_stmt | text_stmt
node_stmt   = "node" ID [ body ]
edge_stmt   = "edge" ID op ID [ body ]
free_stmt   = ("arrow" | "elbow" | "line") body
text_stmt   = "text" body
op          = "->" | "~>" | "--"
body        = "{" kv* "}" | "{" kv ("," kv)* "}"   (multiline or inline)
kv          = KEY ":" value
ID          = [A-Za-z_][A-Za-z0-9_]*
KEY         = [A-Za-z_]+
value       = QUOTED_STRING | COLOR | NUMBERS | IDENT
QUOTED_STRING = '"' … '"'   (supports \" \\ \n)
COLOR       = "#" [0-9a-fA-F]{3,8}
NUMBERS     = number ("," number)*
IDENT       = [A-Za-z_][A-Za-z0-9_]*
comment     = "#" …       (full line or trailing "  # …")
```

The `{ }` block is **optional** — `node foo` and `edge a -> b` are valid bare statements.

---

## Statement reference

### `node <id> { … }`

Declares a shape. The `id` must be unique and match `[A-Za-z_][A-Za-z0-9_]*`.
If an `edge` references an undeclared id, a plain rectangle node is auto-created.

| key | type | default | description |
|-----|------|---------|-------------|
| `label` | `"string"` | id | text shown inside the shape |
| `shape` | ident | `rectangle` | `rectangle` \| `ellipse` \| `diamond` |
| `fill` | color | transparent | background fill color |
| `stroke` | color | `#1e1e1e` | border/stroke color |
| `strokeWidth` | number | `2` | `1` (thin) \| `2` (bold) \| `4` (extra bold) |
| `strokeStyle` | ident | `solid` | `solid` \| `dashed` \| `dotted` |
| `roughness` | number | `1` | `0` (clean/architect) \| `1` (artist) \| `2` (sketchy) |
| `at` | x, y | auto | top-left corner in canvas pixels; set to skip auto-layout |
| `size` | w, h | 180, 80 | width and height in canvas pixels |

**Examples:**

```
node start {
  label: "Start"
  shape: ellipse
  fill:  #b2f2bb
  at:    100, 50
  size:  160, 60
}

node error {
  label:       "Error"
  fill:        #ffc9c9
  stroke:      #c92a2a
  strokeWidth: 2
  strokeStyle: dashed
  roughness:   0
}
```

---

### `edge <from> -> <to> { … }` — straight arrow

### `edge <from> ~> <to> { … }` — elbow (90°) arrow

### `edge <from> -- <to> { … }` — straight line (no arrowhead)

All three share the same optional body keys:

| key | type | default | description |
|-----|------|---------|-------------|
| `label` | `"string"` | — | text label on the edge |
| `color` | color | `#1e1e1e` | stroke color |
| `width` | number | `2` | `1` \| `2` \| `4` |
| `style` | ident | `solid` | `solid` \| `dashed` \| `dotted` |
| `startHead` | ident | `none` | arrowhead at the **from** end |
| `endHead` | ident | `arrow` (arrows), `none` (lines) | arrowhead at the **to** end |
| `roughness` | number | `1` | `0` \| `1` \| `2` |
| `fromSide` | ident | auto | **elbow only** — pin start anchor: `top` \| `right` \| `bottom` \| `left` |
| `toSide` | ident | auto | **elbow only** — pin end anchor: `top` \| `right` \| `bottom` \| `left` |

**Arrowhead values:** `none` \| `arrow` \| `triangle` \| `bar` \| `dot`

**Arrow anchor behavior:**  
Arrows start and end at the *border* of the node, not the center. The intersection point is computed geometrically per shape:
- `rectangle` — closest side
- `ellipse` — ellipse boundary
- `diamond` — rhombus boundary

A small gap (`4 px`) keeps the arrowhead visually off the stroke.

**Elbow (`~>`) behavior:**  
Excalidraw's built-in elbow router handles routing automatically around the bound nodes. The DSL skeleton passes center-to-center start/end points and `elbowed: true`; the router computes the actual 90° waypoints.

**Examples:**

```
edge start -> input
edge start -> input { label: "begin" }
edge check -> error { label: "no", color: #c92a2a, style: dashed }
edge error -> input { label: "retry", style: dotted }
edge done  ~> start { label: "loop back", color: #1971c2, width: 2 }
edge end   ~> start { label: "again", fromSide: right, toSide: right }
edge a     -- b     { label: "link", style: dashed }
edge a     -> b     { startHead: dot, endHead: triangle }
```

---

### `arrow { … }` — free (unbound) arrow

### `elbow { … }` — free elbow arrow

### `line { … }` — free line

Free shapes are not bound to any node. `from` and `to` are **required**.

| key | type | required | description |
|-----|------|----------|-------------|
| `from` | x, y | ✓ | start point |
| `to` | x, y | ✓ | end point |
| `label` | `"string"` | — | label (arrow/elbow only) |
| `color` | color | — | stroke color |
| `width` | number | — | `1` \| `2` \| `4` |
| `style` | ident | — | `solid` \| `dashed` \| `dotted` |
| `startHead` | ident | — | see arrowhead values |
| `endHead` | ident | — | see arrowhead values |
| `roughness` | number | — | `0` \| `1` \| `2` |

```
arrow {
  from: 100, 200
  to:   300, 400
  label: "flows"
  style: dashed
}

line {
  from: 50, 50
  to:   200, 50
  color: #aaa
}
```

---

### `text { … }` — standalone text

| key | type | required | description |
|-----|------|----------|-------------|
| `content` | `"string"` | ✓ | the text to display |
| `at` | x, y | — | position (defaults below all nodes) |
| `size` | number | — | font size in px (default 20) |

```
text {
  content: "Title"
  at:      40, 10
  size:    28
}
```

---

## Auto-layout

If **any** node omits `at:`, dagre top-to-bottom layout is applied to all nodes that lack explicit positions. Nodes with explicit `at:` keep their coordinates even when auto-layout runs.

To pin a single node while letting others flow, set `at:` only on that node.

To reproduce identical layouts across runs, set `at:` on **all** nodes.

---

## Value vocabulary summary

| token | values |
|-------|--------|
| shape | `rectangle` `ellipse` `diamond` |
| style / strokeStyle | `solid` `dashed` `dotted` |
| arrowhead | `none` `arrow` `triangle` `bar` `dot` |
| width | `1` `2` `4` |
| roughness | `0` (clean) `1` (default) `2` (sketchy) |
| color | `#rgb` `#rrggbb` `#rrggbbaa` |

---

## Defaults (Excalidraw)

| property | default |
|----------|---------|
| `strokeColor` | `#1e1e1e` |
| `strokeWidth` | `2` |
| `strokeStyle` | `solid` |
| `roughness` | `1` |
| `backgroundColor` | `transparent` |
| endArrowhead for `->` / `~>` | `arrow` |
| endArrowhead for `--` | `null` (none) |

Serialization omits properties that match their default.

---

## Full example

```
# ──────────────────────────────────────────────────────────
# Nodes
# ──────────────────────────────────────────────────────────

node start {
  label: "Start"
  shape: ellipse
  fill:  #b2f2bb
}

node input {
  label: "Read input"
}

node check {
  label: "Valid?"
  shape: diamond
  fill:  #fff3bf
}

node work {
  label: "Process"
  fill:  #a5d8ff
}

node error {
  label:       "Show error"
  fill:        #ffc9c9
  stroke:      #c92a2a
  strokeWidth: 2
}

node done {
  label: "End"
  shape: ellipse
  fill:  #b2f2bb
}

# ──────────────────────────────────────────────────────────
# Edges
# ──────────────────────────────────────────────────────────

edge start -> input
edge input -> check
edge check -> work  { label: "yes" }
edge check -> error { label: "no",    color: #c92a2a, style: dashed }
edge work  -> done
edge error -> input { label: "retry", style: dotted }
edge done  ~> start { label: "again", color: #1971c2, width: 2 }

# ──────────────────────────────────────────────────────────
# Text
# ──────────────────────────────────────────────────────────

text {
  content: "Validation flow"
  at:      40, 10
  size:    24
}
```

---

## Round-trip safety

The serializer (`serialize.ts`) converts live Excalidraw elements back to DSL. It:
- Uses the element `id` directly as the node id when it matches `[A-Za-z_][A-Za-z0-9_]*`, otherwise assigns `n1`, `n2`, …
- Omits all keys that equal their Excalidraw defaults
- Emits `endHead: none` explicitly when an arrow/elbow has `endArrowhead: null`
- Preserves `~>` (elbow) vs `->` (arrow) vs `--` (line) per element

Code → canvas → code produces identical output for any well-formed input (positions may differ by ±1 px due to rounding).

---

## Source files

| file | purpose |
|------|---------|
| `codedraw-app/src/dsl/parser.ts` | tokenize / parse DSL → `ParseResult` |
| `codedraw-app/src/dsl/buildScene.ts` | `ParseResult` → `ExcalidrawElement[]` (runs dagre, clips anchors) |
| `codedraw-app/src/dsl/serialize.ts` | `ExcalidrawElement[]` → DSL string |
| `codedraw-app/src/defaultCode.ts` | default diagram shown on first load |
| `codedraw-app/src/App.tsx` | React glue; localStorage key `codedraw.code.v1` |
| `codedraw-app/src/render.ts` | SPA-side `renderSvg` / `renderPng` / `renderJson` |
| `codedraw-api/src/index.ts` | Fastify + Playwright server exposing `POST /render` |

---

## HTTP render API

The companion `codedraw-api` service renders DSL headlessly via Playwright.

**Endpoint:** `POST /render`
**Production:** `https://codedraw.dehlwes.net/api/render`
**Local dev:**  `http://localhost:3010/render`

### Request body

| key | type | default | description |
|-----|------|---------|-------------|
| `code` | string | — | DSL source (required) |
| `format` | `"png"` \| `"svg"` \| `"json"` | `"png"` | output format |
| `theme` | `"light"` \| `"dark"` | `"light"` | dark theme also inverts the default ink color so strokes/text stay visible |
| `background` | color \| `"transparent"` | white (`#ffffff`) or dark (`#121212`) | canvas background; `"transparent"` removes the background and falls back to the theme default during preview |
| `scale` | number `0.25`–`5` | `1` | PNG only — pixel density multiplier |
| `padding` | number | `20` | viewport padding around the diagram |

### Responses

- `200` `image/png` — when `format:"png"` (binary)
- `200` `image/svg+xml` — when `format:"svg"`
- `200` `application/json` — `{ elements, errors, type, version, source }` (Excalidraw scene)
- `400` — DSL parse errors (returned as JSON `{ errors }`)
- `500` — Playwright / render failure

### Examples

```bash
# PNG, dark theme, hires
curl -X POST http://localhost:3010/render \
  -H 'content-type: application/json' \
  -d '{"code":"node a\nnode b\nedge a -> b","format":"png","theme":"dark","scale":2}' \
  --output diagram.png

# SVG with custom background
curl -X POST http://localhost:3010/render \
  -H 'content-type: application/json' \
  -d '{"code":"node x","format":"svg","background":"#fef3c7"}'

# Raw Excalidraw JSON (for further processing)
curl -X POST http://localhost:3010/render \
  -H 'content-type: application/json' \
  -d '{"code":"node x -> y","format":"json"}'
```

---

## Behaviors & rendering rules

These are the implementation details an AI assistant needs to predict what a
DSL fragment will produce on the canvas.

### Node auto-sizing

If neither `size:` nor `at:` constrains a node, its box auto-grows from the
label so long labels are never clipped:

- Width  = `max(180, longestLine * 11 + 56)`
- Height = `max(80,  lineCount  * 25 + 48)`
- `diamond` shapes are scaled to `145 %`, `ellipse` to `120 %` so the label fits inside the inscribed area.

Multi-line labels (use `\n` inside a quoted string) grow the box vertically.

### Self-loops

`edge x -> x` (or `~>` / `--`) emits an arc that leaves the **top** of `x`,
loops upward, and re-enters the top. The optional `label:` is placed above
the arc. Excalidraw cannot route an arrow with `start == end`, so this is
synthesised as an unbound 4-point polyline.

### Auto-routed back-edges

Under auto-layout (any node without `at:`), if a straight `edge a -> b`
points "upward" (target sits above the source after dagre layout), the
arrow is re-routed as a 3-segment polyline that detours around the
**right** side of every intermediate rank, so it never cuts through
unrelated nodes. The `label:` is placed at the detour midpoint.

To opt out of the detour: pin nodes manually with `at:`, or use the elbow
operator `~>` so Excalidraw's elbow router handles routing.

### Dark theme color inversion

When `theme:"dark"` is requested via the render API, every element whose
`strokeColor` equals the default ink (`#1e1e1e`) is swapped to a light tone
(`#e6e6e6`) before export. User-supplied colors are left untouched, so you
can still author dark-theme-aware palettes explicitly.

### Edge-label rendering

Labels on `--` (line) edges are emitted as free `text` elements above the
midpoint, because Excalidraw silently drops `boundElements` labels on
`line` type. Labels on `->` and `~>` use Excalidraw's native bound text.

### Comments

`#` starts a comment that runs to end-of-line — either on its own line or
trailing a statement. Use `text { content: "..." }` for on-canvas
annotations.

### String escapes (inside `"…"`)

| escape | result |
|--------|--------|
| `\n`   | newline (renders as a line break inside labels / text) |
| `\t`   | tab |
| `\r`   | carriage return |
| `\"`   | literal `"` |
| `\\`   | literal `\` |

### Layout coordinate origin

Auto-laid-out scenes are centred around `(0, 0)` (Excalidraw's viewport
origin) so generated diagrams appear in the middle of the canvas on first
load. As soon as **any** node uses `at:`, all coordinates are treated as
absolute and no centering shift is applied.

