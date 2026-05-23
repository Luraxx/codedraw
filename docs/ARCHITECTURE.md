# Architecture

CodeDraw is a fork of [Excalidraw](https://github.com/excalidraw/excalidraw) wrapped
in a side-by-side **code ⇄ diagram** editor. The user edits a small
block-structured DSL on the left; the right side renders the corresponding
Excalidraw scene. Both directions are bidirectional: dragging shapes on the
canvas rewrites the code, editing code re-renders the scene.

## Workspaces

```
codedraw/
├── codedraw-app/        # React app (Vite) — Monaco editor + Excalidraw canvas + DSL bridge
├── codedraw-api/        # (Optional) backend service
├── packages/
│   ├── common/          # Excalidraw shared utilities, constants, theme
│   ├── element/         # Element data model, bindings, elbow routing
│   ├── excalidraw/      # Excalidraw React component
│   ├── fractional-indexing/
│   ├── math/            # Vector / point / segment / range helpers (use `Point` type!)
│   └── utils/           # Misc helpers
├── docs/                # Project docs (you are here)
├── tests/               # Vitest setup
├── scripts/             # Build / release scripts
├── Dockerfile           # Multi-stage build → nginx static host
├── docker-compose.yml
├── nginx.conf
└── AGENTS.md            # DSL grammar & semantics — see docs/DSL.md
```

## DSL pipeline (codedraw-app/src/dsl)

```
source text ──parser.ts──▶ ParseResult ──buildScene.ts──▶ ExcalidrawElement[]
                                                              │
canvas state ◀──── Excalidraw component ◀────────────────────┘
     │
     └──serialize.ts──▶ source text  (when user edits on the canvas)
```

- **parser.ts** — recursive-descent block parser; tolerant of trailing commas,
  inline `{ k: v, k: v }` and multi-line forms.
- **buildScene.ts** — turns parsed nodes/edges into Excalidraw skeletons,
  runs dagre auto-layout when positions are missing, clips edge endpoints
  to the actual shape border, and re-routes elbow arrows via
  `updateElbowArrowPoints`.
- **serialize.ts** — round-trip-stable DSL emission; only writes style fields
  that diverge from Excalidraw defaults.

The scene is auto-centred on the origin **(0, 0)** when every node was
auto-positioned, so fresh code-driven diagrams land in the middle of the
visible canvas.

## Bidirectional sync (App.tsx)

- Canvas changes are debounced and serialised back to the editor.
- Code changes are parsed, validated (bounds + size sanity checks), then
  applied via `updateScene`.
- A DSL-based dedup signature avoids the classic feedback loop where each
  side keeps re-applying the other's output.
- The current source is persisted in `localStorage["codedraw:source:v4"]`.

## Tests

- `yarn test:app` — full Vitest suite (~1.3k tests, ~30 s).
- Setup file: [tests/setupTests.ts](../tests/setupTests.ts).

## Build & deploy

See [DEVELOPMENT.md](./DEVELOPMENT.md) and [DEPLOYMENT.md](./DEPLOYMENT.md).
