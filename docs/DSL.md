# CodeDraw DSL — Quick Reference

> **Full grammar, value vocabulary and round-trip rules:** see
> [/AGENTS.md](../AGENTS.md) at the repo root. That file is also served at
> `/AGENTS.md` and `/llms.txt` on the deployed app so AI agents can fetch
> it at runtime.

## At a glance

```text
node id {
  label:  "Hello"
  shape:  rectangle | ellipse | diamond
  at:     x, y                     # absolute position; if omitted, auto-laid out by dagre
  size:   w, h
  fill:   #b2f2bb                  # or transparent
  stroke: #1e1e1e
  width:  1 | 2 | 4
  style:  solid | dashed | dotted
  rough:  0..2
}

edge from -> to {                  # straight arrow
  label:  "yes"
  stroke: #c92a2a
  style:  dashed
  width:  2
  rough:  1
  start:  none | arrow | triangle | bar | dot
  end:    none | arrow | triangle | bar | dot
}

edge from --> to { ... }           # elbow arrow (right-angle routed)
line from -- to   { ... }          # plain line (no arrowhead by default)
```

Inline form is equivalent:

```text
node a { label: "A", shape: ellipse, fill: #b2f2bb }
edge a -> b { style: dashed, end: triangle }
```

## Auto-layout

If **every** node omits `at:`, dagre runs (top-to-bottom) and the resulting
scene is centred on the origin so it appears in the middle of the canvas.
As soon as you pin any node with `at:`, all coordinates are treated as
absolute and left alone.

## Round-trip safety

Dragging shapes on the canvas rewrites the code. The serialiser only emits
fields that differ from Excalidraw defaults, so generated code stays terse.
Reloading the serialised code must reproduce the exact scene.
