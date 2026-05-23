import fs from "fs";
import path from "path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import svgrPlugin from "vite-plugin-svgr";
import { woff2BrowserPlugin } from "../scripts/woff2/woff2-vite-plugins";

// Expose the repo-root AGENTS.md to the deployed app so AI agents can
// discover the DSL grammar at runtime via `/AGENTS.md` and `/llms.txt`
// (the emerging convention for LLM-readable site docs).
// Strategy: at config load time we copy AGENTS.md into ./public so vite's
// built-in static-file middleware (dev + build) serves both URLs without
// any custom request handling.
const syncAgentsDocs = (): Plugin => {
  const src = path.resolve(__dirname, "../AGENTS.md");
  const publicDir = path.resolve(__dirname, "public");
  const sync = () => {
    if (!fs.existsSync(src)) return;
    const body = fs.readFileSync(src, "utf-8");
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(path.join(publicDir, "AGENTS.md"), body);
    fs.writeFileSync(path.join(publicDir, "llms.txt"), body);
  };
  sync();
  return {
    name: "codedraw:agents-docs",
    configureServer(server) {
      server.watcher.add(src);
      server.watcher.on("change", (file) => {
        if (path.resolve(file) === src) sync();
      });
    },
    buildStart() {
      sync();
    },
  };
};

export default defineConfig(({ mode }) => {
  const envVars = loadEnv(mode, `../`);
  return {
    server: {
      port: Number(envVars.VITE_APP_PORT || 3001),
      open: true,
      host: true,
    },
    envDir: "../",
    resolve: {
      alias: [
        { find: /^@excalidraw\/common$/, replacement: path.resolve(__dirname, "../packages/common/src/index.ts") },
        { find: /^@excalidraw\/common\/(.*?)/, replacement: path.resolve(__dirname, "../packages/common/src/$1") },
        { find: /^@excalidraw\/element$/, replacement: path.resolve(__dirname, "../packages/element/src/index.ts") },
        { find: /^@excalidraw\/element\/(.*?)/, replacement: path.resolve(__dirname, "../packages/element/src/$1") },
        { find: /^@excalidraw\/excalidraw$/, replacement: path.resolve(__dirname, "../packages/excalidraw/index.tsx") },
        { find: /^@excalidraw\/excalidraw\/(.*?)/, replacement: path.resolve(__dirname, "../packages/excalidraw/$1") },
        { find: /^@excalidraw\/math$/, replacement: path.resolve(__dirname, "../packages/math/src/index.ts") },
        { find: /^@excalidraw\/math\/(.*?)/, replacement: path.resolve(__dirname, "../packages/math/src/$1") },
        { find: /^@excalidraw\/utils$/, replacement: path.resolve(__dirname, "../packages/utils/src/index.ts") },
        { find: /^@excalidraw\/utils\/(.*?)/, replacement: path.resolve(__dirname, "../packages/utils/src/$1") },
        { find: /^@excalidraw\/fractional-indexing$/, replacement: path.resolve(__dirname, "../packages/fractional-indexing/src/index.ts") },
      ],
    },
    build: {
      outDir: "dist",
      sourcemap: false,
      assetsInlineLimit: 0,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("packages/excalidraw/locales") && !id.match(/en\.json|percentages\.json/)) {
              const index = id.indexOf("locales/");
              return `locales/${id.substring(index + 8)}`;
            }
            if (id.includes("monaco-editor")) {
              return "monaco";
            }
            if (id.includes("@codemirror/") || id.includes("@lezer/")) {
              return "codemirror";
            }
          },
        },
      },
    },
    plugins: [woff2BrowserPlugin(), react(), svgrPlugin(), syncAgentsDocs()],
  };
});
