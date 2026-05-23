# NOTICE

CodeDraw is a fork of **Excalidraw** (https://github.com/excalidraw/excalidraw)
which is © 2020 Excalidraw and contributors and licensed under the MIT License.

The original Excalidraw `LICENSE` is preserved verbatim in this repository
(see [`LICENSE`](LICENSE)). All modifications made in CodeDraw are likewise
released under the MIT License.

## Summary of changes vs upstream

- Removed `excalidraw-app/` (collaboration, Firebase persistence, share links,
  Excalidraw+ marketing UI, Text-to-Diagram LLM wizard, library browser
  integration, Sentry, PWA, Sitemap).
- Removed `examples/`, `firebase-project/`, `.codesandbox/`, `dev-docs/`,
  `crowdin.yml`, root `Dockerfile`/`docker-compose.yml`.
- Reduced locales in `packages/excalidraw/locales/` to `en` + `de-DE`.
- Added new `codedraw-app/` (Vite + React + Monaco) that embeds
  `<Excalidraw />` and renders a simple DSL into Excalidraw elements via
  `convertToExcalidrawElements` + dagre auto-layout.
- Added Dockerfile (multi-stage, nginx) and a GitHub Actions workflow that
  publishes the production image to `ghcr.io/luisdehlwes/codedraw`.

All credit for the underlying drawing engine, rendering, font handling and
React component design goes to the Excalidraw team and contributors.
