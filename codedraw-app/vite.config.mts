import path from "path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import svgrPlugin from "vite-plugin-svgr";
import { woff2BrowserPlugin } from "../scripts/woff2/woff2-vite-plugins";

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
    plugins: [woff2BrowserPlugin(), react(), svgrPlugin()],
  };
});
