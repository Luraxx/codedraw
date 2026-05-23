# syntax=docker/dockerfile:1.7

# --- build stage ---
FROM node:20-alpine AS builder
WORKDIR /app

# Copy manifests first for better layer caching.
COPY package.json yarn.lock ./
COPY .npmrc ./
COPY tsconfig.json ./
COPY .env.development .env.production ./
COPY codedraw-app/package.json codedraw-app/
COPY packages/common/package.json packages/common/
COPY packages/element/package.json packages/element/
COPY packages/excalidraw/package.json packages/excalidraw/
COPY packages/fractional-indexing/package.json packages/fractional-indexing/
COPY packages/math/package.json packages/math/
COPY packages/utils/package.json packages/utils/

RUN yarn install --frozen-lockfile --network-timeout 600000

# Now copy the rest of the sources.
COPY scripts ./scripts
COPY packages ./packages
COPY codedraw-app ./codedraw-app
# Repo-root docs the build pipeline embeds into the deployed app
# (served as /AGENTS.md and /llms.txt for AI/agent discoverability).
COPY AGENTS.md ./

RUN yarn build

# --- runtime stage ---
FROM nginx:1.27-alpine AS runtime
ENV API_UPSTREAM=codedraw-api:3000
COPY nginx.conf /etc/nginx/nginx.conf.template
COPY --from=builder /app/codedraw-app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
CMD ["/bin/sh", "-c", \
  "envsubst '$API_UPSTREAM' < /etc/nginx/nginx.conf.template > /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'"]
