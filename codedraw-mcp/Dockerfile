# syntax=docker/dockerfile:1.7

FROM node:20-alpine
WORKDIR /app
COPY package.json ./
# Installs prod deps AND devDeps (vite + vite-plugin-singlefile) — both are
# needed to build the widget bundle below.
RUN npm install --no-audit --no-fund
COPY tsconfig.json vite.config.ts ./
COPY src ./src
# Bundle the MCP App widget (src/widget/) into dist/widget/index.html, which the
# server reads at startup and serves as the ui:// resource.
RUN npm run build:widget
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "src/index.ts"]
