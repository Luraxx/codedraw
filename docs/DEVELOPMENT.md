# Development

## Prerequisites

- Node 20+
- Yarn 1.x (`yarn -v` should print `1.22.x`)

## Setup

```sh
yarn install
```

## Run the dev server

```sh
yarn dev          # Vite on http://localhost:3001/
```

The Excalidraw API is exposed as `window.__excalidrawAPI` in dev for quick
inspection from the browser console.

## Tests

```sh
yarn test:app                                # full Vitest suite (~30 s)
yarn vitest run packages/element/tests       # run a single subset
yarn vitest packages/<pkg>/tests/<file>      # watch mode
```

Test setup lives at [tests/setupTests.ts](../tests/setupTests.ts);
configuration in [vitest.config.mts](../vitest.config.mts).

## Lint / format

```sh
yarn lint
yarn fix          # auto-format with Prettier + eslint --fix
```

Husky + lint-staged enforce both on commit.

## Build

```sh
yarn build        # produces codedraw-app/dist (used by Dockerfile)
```

## Docker

```sh
docker compose up --build       # runs nginx on http://localhost:8080
```

## Working with the DSL

- Grammar reference: [/AGENTS.md](../AGENTS.md) (and [docs/DSL.md](./DSL.md)).
- Parser/builder/serializer all live under
  [codedraw-app/src/dsl/](../codedraw-app/src/dsl/).
- The serialised form is round-trip safe: dragging a shape and re-loading
  the resulting code must produce an identical scene.
