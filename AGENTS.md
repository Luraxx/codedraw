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
