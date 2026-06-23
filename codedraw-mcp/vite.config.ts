import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Builds the MCP App widget (src/widget/index.html + main.ts) into a single,
// self-contained HTML file at dist/widget/index.html. viteSingleFile inlines
// the bundled JS (including @modelcontextprotocol/ext-apps) and CSS into the
// HTML so the host can render it in its deny-by-default CSP iframe without any
// external asset requests. The MCP server reads this file at startup and serves
// it as the ui:// resource.
export default defineConfig({
  root: "src/widget",
  plugins: [viteSingleFile()],
  build: {
    outDir: "../../dist/widget",
    emptyOutDir: true,
    target: "es2020",
    // viteSingleFile needs everything inlined; keep the asset/chunk limits high.
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000_000,
  },
});
