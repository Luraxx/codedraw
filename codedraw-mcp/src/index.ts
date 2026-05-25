// CodeDraw MCP server.
//
// Exposes the codedraw REST API as a Model Context Protocol tool surface so
// that ChatGPT (Apps SDK / Custom GPT Connectors), Claude Desktop and other
// MCP clients can discover and call it without us hand-maintaining a schema
// on their side.
//
// Transport: Streamable HTTP on POST /mcp (the new ChatGPT default).
// All actual rendering / parsing is delegated to the existing codedraw-api
// via fetch — this server holds no DSL logic of its own.

import express, { type Request, type Response as ExpressResponse } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListResourceTemplatesRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const API_URL = (process.env.CODEDRAW_API_URL ?? "http://localhost:3010").replace(/\/$/, "");
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const SERVER_VERSION = process.env.npm_package_version ?? "0.1.0";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");

// ────────────────────────────────────────────────────────────
// Ephemeral download store
//
// render_diagram stashes the rendered SVG and PNG bytes here under a random
// id; clients (widgets, browsers, agents) can then fetch them via
// GET /downloads/{svg,png}/:id within the TTL window. Entries are dropped
// after first 410 to keep the surface predictable.
//
// Rationale: MCP image content blocks are unreliable for actual downloads
// across hosts; a plain HTTPS URL with the right Content-Type and
// Content-Disposition is the most portable way to give the user a
// "save as" experience.
// ────────────────────────────────────────────────────────────
type Blob = {
  mime: string;
  filename: string;
  data: Buffer;
  expiresAt: number;
};
const DOWNLOAD_TTL_MS = 30 * 60 * 1000;
const downloadStore = new Map<string, Blob>();

const newDownloadId = (): string => randomBytes(16).toString("hex");

const storeDownload = (kind: "svg" | "png", data: Buffer): string => {
  const id = newDownloadId();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  downloadStore.set(id, {
    mime: kind === "svg" ? "image/svg+xml" : "image/png",
    filename: `codedraw-${stamp}.${kind}`,
    data,
    expiresAt: Date.now() + DOWNLOAD_TTL_MS,
  });
  return id;
};

// Periodic sweep — runs every 5 min, kept unref'd so it never blocks shutdown.
const sweepDownloads = (): void => {
  const now = Date.now();
  for (const [id, blob] of downloadStore) {
    if (blob.expiresAt <= now) downloadStore.delete(id);
  }
};
setInterval(sweepDownloads, 5 * 60 * 1000).unref();

// Best-effort base URL for download links. We honour, in order:
//   1. PUBLIC_BASE_URL env var (set in production to https://...)
//   2. X-Forwarded-Proto + X-Forwarded-Host (nginx / Coolify)
//   3. Host header
const baseUrlFromRequest = (req: Request): string => {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const fwdProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  const fwdHost = String(req.headers["x-forwarded-host"] ?? "").split(",")[0]?.trim();
  const proto = fwdProto || (req.socket && (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
  const host = fwdHost || req.headers.host || `${HOST}:${PORT}`;
  return `${proto}://${host}`;
};

// SVG sanitizer — strips potentially-unsafe / heavy nodes so the widget can
// embed the markup directly and the download is portable across viewers.
//   - <script> tags and on* attributes (defence in depth — codedraw never
//     emits these, but be conservative for third-party tooling).
//   - <foreignObject> (browser-dependent, breaks rasterisers).
//   - <metadata> blocks (often huge with embedded RDF / authoring tools).
const sanitizeSvg = (svg: string): string => {
  return svg
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/<metadata\b[\s\S]*?<\/metadata\s*>/gi, "")
    .replace(/\son[a-z]+="[^"]*"/gi, "")
    .replace(/\son[a-z]+='[^']*'/gi, "");
};

// Tiny helper around fetch that throws on non-2xx with the response body.
const apiFetch = async (path: string, init?: RequestInit): Promise<Response> => {
  const url = `${API_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`codedraw-api ${path} -> ${res.status}: ${body.slice(0, 500)}`);
  }
  return res;
};

// Best-effort dimension extraction from an SVG document. The codedraw SVG
// export uses Excalidraw's exporter which sets both width/height attrs and
// a viewBox, so this regex is reliable for our own output.
const extractSvgDims = (svg: string): { width?: number; height?: number } => {
  const wMatch = /\swidth="([\d.]+)"/.exec(svg);
  const hMatch = /\sheight="([\d.]+)"/.exec(svg);
  return {
    width: wMatch ? Number(wMatch[1]) : undefined,
    height: hMatch ? Number(hMatch[1]) : undefined,
  };
};

// PNG header parser. IHDR follows the 8-byte signature + 4-byte length +
// "IHDR" type tag, so width is bytes [16..20) and height [20..24).
const extractPngDims = (buf: Buffer): { width?: number; height?: number } => {
  if (buf.length < 24 || buf.toString("ascii", 12, 16) !== "IHDR") return {};
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};

// ────────────────────────────────────────────────────────────
// ChatGPT Apps SDK UI widget HTML
//
// Defined at module level so it can be served at a plain HTTP GET
// endpoint (GET /widget). ChatGPT fetches openai/outputTemplate via HTTP
// GET; the ui:// MCP resource scheme stopped working as of mid-2026.
// ────────────────────────────────────────────────────────────
const WIDGET_URI = "ui://widget/codedraw-preview-v7.html";
const WIDGET_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>CodeDraw preview</title>
<style>
  :root{
    --fg:#1e1e1e; --muted:#666; --bg:transparent;
    --btn-bg:#f1f3f5; --btn-fg:#1e1e1e; --btn-border:#dee2e6;
    --btn-hover:#e9ecef; --btn-ok:#37b24d;
  }
  @media (prefers-color-scheme: dark){
    :root{ --fg:#e6e6e6; --muted:#999;
           --btn-bg:#2b2f33; --btn-fg:#e6e6e6; --btn-border:#3a3f44;
           --btn-hover:#3a3f44; --btn-ok:#69db7c; }
  }
  html,body{margin:0;padding:0;background:var(--bg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--fg)}
  #wrap{display:flex;flex-direction:column;gap:8px;padding:12px;box-sizing:border-box}
  #preview{display:flex;align-items:center;justify-content:center;min-height:180px;border-radius:6px}
  #preview img{max-width:100%;height:auto;display:block}
  #preview pre{white-space:pre-wrap;font-size:11px;margin:0;width:100%;max-height:340px;overflow:auto}
  #empty{font-size:13px;color:var(--muted);padding:24px}
  #bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;color:var(--muted)}
  #bar .spacer{flex:1}
  button, a.btn{
    appearance:none;border:1px solid var(--btn-border);background:var(--btn-bg);color:var(--btn-fg);
    padding:5px 10px;border-radius:5px;font-size:12px;cursor:pointer;text-decoration:none;line-height:1.2;
  }
  button:hover, a.btn:hover{background:var(--btn-hover)}
  button.copied{color:var(--btn-ok);border-color:var(--btn-ok)}
</style>
</head>
<body>
<div id="wrap">
  <div id="preview"><div id="empty">No diagram yet.</div></div>
  <div id="bar" hidden>
    <span id="dims"></span>
    <span class="spacer"></span>
    <a class="btn" id="dlSvg" hidden>Download SVG</a>
    <a class="btn" id="dlPng" hidden>Download PNG</a>
    <button id="copySvg" hidden>Copy SVG</button>
  </div>
</div>
<script>
(function(){
  var preview = document.getElementById("preview");
  var bar     = document.getElementById("bar");
  var dimsEl  = document.getElementById("dims");
  var dlSvg   = document.getElementById("dlSvg");
  var dlPng   = document.getElementById("dlPng");
  var copyBtn = document.getElementById("copySvg");
  var lastSvg = null;
  var lastBlobUrl = null;

  function makeSvgUrl(svg){
    if(lastBlobUrl){ try { URL.revokeObjectURL(lastBlobUrl); } catch(_){} }
    var blob = new Blob([svg], { type: "image/svg+xml" });
    lastBlobUrl = URL.createObjectURL(blob);
    return lastBlobUrl;
  }

  function setDims(out){
    if(out && out.width && out.height){
      dimsEl.textContent = Math.round(out.width) + " × " + Math.round(out.height) + " px";
    } else {
      dimsEl.textContent = "";
    }
  }

  function setDownloads(out){
    var dls = (out && out.downloads) || {};
    if(dls.svgUrl){ dlSvg.href = dls.svgUrl; dlSvg.hidden = false; dlSvg.setAttribute("download",""); dlSvg.target="_blank"; dlSvg.rel="noopener"; }
    else { dlSvg.hidden = true; }
    if(dls.pngUrl){ dlPng.href = dls.pngUrl; dlPng.hidden = false; dlPng.setAttribute("download",""); dlPng.target="_blank"; dlPng.rel="noopener"; }
    else { dlPng.hidden = true; }
    copyBtn.hidden = !lastSvg;
    bar.hidden = (dlSvg.hidden && dlPng.hidden && copyBtn.hidden && !dimsEl.textContent);
  }

  function renderSvg(svgText, out){
    lastSvg = svgText;
    var url = makeSvgUrl(svgText);
    var img = document.createElement("img");
    img.alt = "CodeDraw diagram";
    img.src = url;
    preview.innerHTML = "";
    preview.appendChild(img);
    setDims(out);
    setDownloads(out);
  }

  function renderPng(b64, out){
    lastSvg = null;
    var img = document.createElement("img");
    img.alt = "CodeDraw diagram";
    img.src = "data:image/png;base64," + b64;
    if(out && out.width)  img.width  = out.width;
    if(out && out.height) img.height = out.height;
    preview.innerHTML = "";
    preview.appendChild(img);
    setDims(out);
    setDownloads(out);
  }

  function renderJson(out){
    lastSvg = null;
    var pre = document.createElement("pre");
    pre.textContent = JSON.stringify(out && out.scene, null, 2);
    preview.innerHTML = "";
    preview.appendChild(pre);
    setDims(out);
    setDownloads(out);
  }

  function render(out){
    if(!out) return;
    // Prefer SVG payload whenever present — even for format=png we may have
    // both, and SVG is sharper / scriptable for the widget surface.
    if(typeof out.svg === "string" && out.svg.length){
      renderSvg(out.svg, out);
      return;
    }
    if((out.format === "png") && typeof (out.pngBase64 || out.png) === "string"){
      renderPng(out.pngBase64 || out.png, out);
      return;
    }
    if(out.format === "json"){
      renderJson(out);
      return;
    }
  }

  copyBtn.addEventListener("click", function(){
    if(!lastSvg || !navigator.clipboard) return;
    navigator.clipboard.writeText(lastSvg).then(function(){
      copyBtn.textContent = "Copied";
      copyBtn.classList.add("copied");
      setTimeout(function(){
        copyBtn.textContent = "Copy SVG";
        copyBtn.classList.remove("copied");
      }, 1500);
    }).catch(function(){});
  });

  function fromToolResult(params){
    if(!params) return;
    var sc = params.structuredContent || params.toolOutput || {};
    var meta = params._meta || {};
    // Merge: structuredContent stays small (sent to model); _meta carries
    // the heavy svg / pngBase64 payloads exclusively for the widget.
    var merged = {};
    for(var k in sc){ if(Object.prototype.hasOwnProperty.call(sc,k)) merged[k] = sc[k]; }
    for(var k2 in meta){ if(Object.prototype.hasOwnProperty.call(meta,k2)) merged[k2] = meta[k2]; }
    if(merged.format || merged.svg || merged.pngBase64) render(merged);
  }

  var rendered = false;

  function tryRenderFromGlobals(){
    if(rendered) return true;
    try {
      var w = (typeof window !== "undefined") ? window.openai : null;
      if(!w) return false;
      var sc = w.toolOutput || {};
      var meta = w.toolResponseMetadata || w._meta || {};
      var merged = {};
      for(var k in sc){ if(Object.prototype.hasOwnProperty.call(sc,k)) merged[k] = sc[k]; }
      for(var k2 in meta){ if(Object.prototype.hasOwnProperty.call(meta,k2)) merged[k2] = meta[k2]; }
      if(merged.format || merged.svg || merged.pngBase64){
        render(merged);
        rendered = true;
        return true;
      }
    } catch(_){}
    return false;
  }

  // Initial attempt (fast path when globals are already populated, e.g. on
  // page reload where ChatGPT replays the tool result before our script runs).
  tryRenderFromGlobals();

  // Slow path: window.openai is typically populated AFTER the first script
  // turn during the bridge handshake. Poll briefly until it appears.
  if(!rendered){
    var tries = 0;
    var iv = setInterval(function(){
      if(tryRenderFromGlobals() || ++tries > 80){ clearInterval(iv); }
    }, 75);
    // Also retry after DOMContentLoaded and full load for good measure.
    if(document.readyState !== "complete"){
      document.addEventListener("DOMContentLoaded", tryRenderFromGlobals, { once: true });
      window.addEventListener("load", tryRenderFromGlobals, { once: true });
    }
  }

  window.addEventListener("message", function(event){
    if(event.source !== window.parent) return;
    var msg = event.data;
    if(!msg || msg.jsonrpc !== "2.0") return;
    if(msg.method === "ui/notifications/tool-result"){
      rendered = true;
      fromToolResult(msg.params);
    }
  }, { passive: true });

  // ChatGPT fires this event whenever window.openai globals are mutated.
  window.addEventListener("openai:set_globals", function(event){
    var globals = (event && event.detail && event.detail.globals) || null;
    if(globals && globals.toolOutput){
      // Merge with current _meta if present.
      var merged = {};
      var sc = globals.toolOutput || {};
      var meta = globals.toolResponseMetadata || (window.openai && window.openai.toolResponseMetadata) || {};
      for(var k in sc){ if(Object.prototype.hasOwnProperty.call(sc,k)) merged[k] = sc[k]; }
      for(var k2 in meta){ if(Object.prototype.hasOwnProperty.call(meta,k2)) merged[k2] = meta[k2]; }
      if(merged.format || merged.svg || merged.pngBase64){
        rendered = true;
        render(merged);
      }
    } else {
      // Fallback: re-read globals lazily.
      tryRenderFromGlobals();
    }
  }, { passive: true });
})();
</script>
</body>
</html>`;

const createServer = (baseUrl: string): McpServer => {
  const server = new McpServer({
    name: "codedraw",
    version: SERVER_VERSION,
  });

  // ────────────────────────────────────────────────────────────
  // ChatGPT Apps SDK UI widget
  //
  // openai/outputTemplate now points to a real HTTPS GET endpoint
  // (GET /widget) so ChatGPT can fetch it directly via HTTP.
  // The ui:// MCP resource is kept for backward compat with other
  // MCP clients that use resources/read.
  // ────────────────────────────────────────────────────────────
  const WIDGET_HTTP_URL = `${baseUrl}/widget`;

  server.registerResource(
    "codedraw-preview",
    WIDGET_URI,
    {
      title: "CodeDraw preview",
      description: "Inline iframe widget that renders the SVG / PNG / JSON returned by render_diagram.",
      mimeType: "text/html;profile=mcp-app",
      _meta: {
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Rendering diagram",
        "openai/toolInvocation/invoked": "Diagram ready",
      },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/html;profile=mcp-app",
          text: WIDGET_HTML,
          _meta: {
            "openai/widgetAccessible": true,
            "openai/toolInvocation/invoking": "Rendering diagram",
            "openai/toolInvocation/invoked": "Diagram ready",
          },
        },
      ],
    }),
  );

  // Mirror the widget into resources/templates/list — OpenAI's pizzaz reference
  // server registers the widget URI in BOTH resources/list AND
  // resources/templates/list. ChatGPT discovers the outputTemplate via the
  // templates list, so an empty list causes "Failed to fetch template".
  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: WIDGET_URI,
        name: "codedraw-preview",
        description: "CodeDraw preview widget markup",
        mimeType: "text/html;profile=mcp-app",
        _meta: {
          "openai/widgetAccessible": true,
          "openai/toolInvocation/invoking": "Rendering diagram",
          "openai/toolInvocation/invoked": "Diagram ready",
        },
      },
    ],
  }));

  // ────────────────────────────────────────────────────────────
  // render_diagram
  // ────────────────────────────────────────────────────────────
  server.registerTool(
    "render_diagram",
    {
      title: "Render CodeDraw diagram",
      description:
        "Render a CodeDraw DSL diagram. Use this whenever the user asks to draw, render, create, preview, sketch or export a diagram, flowchart, state machine, ER diagram, architecture sketch or any other visual graph.\n\n" +
        "DSL quick-reference (all styling options are supported):\n" +
        "  node id { label: \"text\"  shape: rectangle|ellipse|diamond  fill: #hex  stroke: #hex  strokeWidth: 1|2|4  strokeStyle: solid|dashed|dotted  roughness: 0|1|2  at: x,y  size: w,h }\n" +
        "  edge a -> b { label: \"text\"  color: #hex  width: 1|2|4  style: solid|dashed|dotted  startHead: none|arrow|triangle|bar|dot  endHead: none|arrow|triangle|bar|dot  roughness: 0|1|2 }\n" +
        "  edge a ~> b { ... fromSide: top|right|bottom|left  toSide: top|right|bottom|left }   # elbow (90° routed)\n" +
        "  edge a -- b { ... }   # line, no arrowhead\n" +
        "  arrow { from: x,y  to: x,y  color: #hex  style: dashed  ... }   # free unbound arrow\n" +
        "  text  { content: \"...\"  at: x,y  size: 20 }\n\n" +
        "Call get_grammar for the full reference, get_examples for ready-made snippets. " +
        "Default format is SVG (text, embeddable). Use format=png to receive a PNG image content block.",
      _meta: {
        "openai/outputTemplate": WIDGET_URI,
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Rendering diagram",
        "openai/toolInvocation/invoked": "Diagram ready",
        "ui/resourceUri": WIDGET_URI,
        ui: { resourceUri: WIDGET_URI },
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
      inputSchema: {
        code: z.string().min(1).describe("CodeDraw DSL source code"),
        format: z.enum(["svg", "png", "json"]).default("svg"),
        theme: z.enum(["light", "dark"]).default("light"),
        background: z
          .string()
          .default("#ffffff")
          .describe("Background color (hex or 'transparent')"),
        scale: z.number().min(0.25).max(5).default(1),
        padding: z.number().min(0).max(500).default(20),
      },
      outputSchema: {
        format: z.enum(["svg", "png", "json"]),
        width: z.number().optional(),
        height: z.number().optional(),
        svg: z.string().optional(),
        pngBase64: z
          .string()
          .optional()
          .describe("base64-encoded PNG (no data: prefix)"),
        scene: z.unknown().optional(),
        downloads: z
          .object({
            svgUrl: z.string().optional().describe("HTTPS URL to download the rendered SVG (valid ~30 min)"),
            pngUrl: z.string().optional().describe("HTTPS URL to download the rendered PNG (valid ~30 min)"),
            ttlSeconds: z.number().optional(),
          })
          .optional(),
      },
    },
    async ({ code, format, theme, background, scale, padding }) => {
      // JSON output is a pure data shape — no rasterisation, no downloads.
      if (format === "json") {
        const res = await apiFetch("/render", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, format, theme, background, scale, padding }),
        });
        const text = await res.text();
        const parsed = JSON.parse(text);
        return {
          content: [{ type: "text", text }],
          structuredContent: { format: "json", scene: parsed },
          _meta: { "ui/resourceUri": WIDGET_URI, ui: { resourceUri: WIDGET_URI } },
        };
      }

      // Otherwise render BOTH formats in parallel so the widget can show the
      // preview and we can hand the user a "Download SVG" *and* "Download PNG"
      // link regardless of which format they explicitly asked for.
      const renderPayload = (fmt: "svg" | "png"): Promise<Response> =>
        apiFetch("/render", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, format: fmt, theme, background, scale, padding }),
        });

      const [svgRes, pngRes] = await Promise.all([renderPayload("svg"), renderPayload("png")]);
      const svgRaw = await svgRes.text();
      const svg = sanitizeSvg(svgRaw);
      const pngBuf = Buffer.from(await pngRes.arrayBuffer());
      const pngBase64 = pngBuf.toString("base64");

      const svgId = storeDownload("svg", Buffer.from(svg, "utf8"));
      const pngId = storeDownload("png", pngBuf);
      const downloads = {
        svgUrl: `${baseUrl}/downloads/svg/${svgId}`,
        pngUrl: `${baseUrl}/downloads/png/${pngId}`,
        ttlSeconds: Math.round(DOWNLOAD_TTL_MS / 1000),
      };

      if (format === "svg") {
        const dims = extractSvgDims(svg);
        return {
          content: [
            { type: "text", text: svg },
            {
              type: "text",
              text: `Downloads (valid ${downloads.ttlSeconds}s):\nSVG: ${downloads.svgUrl}\nPNG: ${downloads.pngUrl}`,
            },
          ],
          // Keep structuredContent SMALL — it's sent to the model. The widget
          // gets the full payload via _meta over the MCP Apps UI bridge.
          structuredContent: { format: "svg", ...dims, downloads },
          _meta: { svg, pngBase64, downloads, "ui/resourceUri": WIDGET_URI, ui: { resourceUri: WIDGET_URI } },
        };
      }

      // format === "png"
      const dims = extractPngDims(pngBuf);
      return {
        content: [
          { type: "image", data: pngBase64, mimeType: "image/png" },
          {
            type: "text",
            text: `Downloads (valid ${downloads.ttlSeconds}s):\nSVG: ${downloads.svgUrl}\nPNG: ${downloads.pngUrl}`,
          },
        ],
        structuredContent: { format: "png", ...dims, downloads },
        _meta: { svg, pngBase64, downloads, "ui/resourceUri": WIDGET_URI, ui: { resourceUri: WIDGET_URI } },
      };
    },
  );

  // ────────────────────────────────────────────────────────────
  // validate_diagram
  // ────────────────────────────────────────────────────────────
  server.registerTool(
    "validate_diagram",
    {
      title: "Validate CodeDraw DSL",
      description:
        "Parse a CodeDraw DSL source and report syntax errors without rendering. Cheap and fast — use this in a correction loop before calling render_diagram if the DSL was just authored or modified.",
      inputSchema: {
        code: z.string().min(1).describe("CodeDraw DSL source code"),
      },
    },
    async ({ code }) => {
      const res = await apiFetch("/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const result = (await res.json()) as {
        valid: boolean;
        errors: { line: number; message: string }[];
      };
      const summary = result.valid
        ? "DSL is valid."
        : `${result.errors.length} error(s):\n` +
          result.errors.map((e) => `  line ${e.line}: ${e.message}`).join("\n");
      return {
        content: [{ type: "text", text: summary }],
        structuredContent: result,
      };
    },
  );

  // ────────────────────────────────────────────────────────────
  // inspect_diagram
  // ────────────────────────────────────────────────────────────
  server.registerTool(
    "inspect_diagram",
    {
      title: "Inspect CodeDraw diagram",
      description:
        "Parse a CodeDraw DSL source and return a structured analysis: counts of nodes / edges / texts, shape distribution, edge kinds, per-node in/out degree, a guessed diagram type (flowchart, sequence, state-machine, tree, network, free-form) and a list of warnings (isolated nodes, self-loops, auto-created nodes). Use this to understand an existing diagram before modifying it.",
      inputSchema: {
        code: z.string().min(1).describe("CodeDraw DSL source code"),
      },
    },
    async ({ code }) => {
      const res = await apiFetch("/inspect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const result = (await res.json()) as Record<string, unknown>;
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  // ────────────────────────────────────────────────────────────
  // get_grammar
  // ────────────────────────────────────────────────────────────
  server.registerTool(
    "get_grammar",
    {
      title: "Get CodeDraw DSL grammar",
      description:
        "Return the full CodeDraw DSL grammar reference as plain text. Call this once at the start of a session if you have not seen the grammar before, so you can author valid DSL.",
      inputSchema: {},
    },
    async () => {
      const res = await apiFetch("/grammar");
      const grammar = await res.text();
      return {
        content: [{ type: "text", text: grammar }],
        structuredContent: { grammar },
      };
    },
  );

  // ────────────────────────────────────────────────────────────
  // get_examples
  // ────────────────────────────────────────────────────────────
  server.registerTool(
    "get_examples",
    {
      title: "Get CodeDraw examples",
      description:
        "Return a curated set of named CodeDraw DSL snippets (id, name, description, code). Useful as few-shot examples when the user requests a specific kind of diagram or when you need to mimic the canonical style.",
      inputSchema: {},
    },
    async () => {
      const res = await apiFetch("/examples");
      const examples = (await res.json()) as readonly {
        id: string;
        name: string;
        description: string;
        code: string;
      }[];
      const summary = examples
        .map((e) => `• ${e.id} — ${e.name}: ${e.description}`)
        .join("\n");
      return {
        content: [{ type: "text", text: summary }],
        structuredContent: { examples },
      };
    },
  );

  return server;
};

// ────────────────────────────────────────────────────────────
// HTTP layer
// ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req, res) => {
  try {
    const upstream = await fetch(`${API_URL}/health`, { method: "GET" });
    res.json({
      ok: true,
      apiUrl: API_URL,
      apiHealthy: upstream.ok,
      version: SERVER_VERSION,
    });
  } catch (err) {
    res.status(503).json({
      ok: false,
      apiUrl: API_URL,
      apiHealthy: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.get("/", (_req, res) => {
  res.json({
    name: "codedraw-mcp",
    version: SERVER_VERSION,
    transport: "streamable-http",
    endpoint: "POST /mcp",
    tools: [
      "render_diagram",
      "validate_diagram",
      "inspect_diagram",
      "get_grammar",
      "get_examples",
    ],
    apiUrl: API_URL,
  });
});

// MCP entry. We instantiate a fresh server + transport per request which is
// the recommended pattern for stateless Streamable HTTP — sessionless and
// resilient across load-balancer hops.
const handleMcp = async (req: Request, res: ExpressResponse): Promise<void> => {
  try {
    const baseUrl = baseUrlFromRequest(req);
    const server = createServer(baseUrl);
    const transport = new StreamableHTTPServerTransport({
      // Stateless mode: every request gets a fresh server + transport. No
      // mcp-session-id round-tripping is needed, which makes the endpoint
      // safe to put behind a stateless load balancer (Coolify, nginx, etc).
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : "internal error",
        },
        id: null,
      });
    }
  }
};

app.post("/mcp", handleMcp);
// Some MCP clients probe GET /mcp; respond with the spec-compliant 405.
app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method Not Allowed. Use POST /mcp." },
    id: null,
  });
});

// ────────────────────────────────────────────────────────────
// Download endpoints
//
// render_diagram exposes `downloads.svgUrl` / `downloads.pngUrl` pointing
// here. We register the routes twice: once at the root and once under the
// "/mcp/" prefix so the same URL works whether the deployment is reached
// directly (local dev) or via the production nginx location that forwards
// "/mcp/*" to this service without rewriting the path.
// ────────────────────────────────────────────────────────────
const serveDownload = (
  expectedKind: "svg" | "png",
  req: Request,
  res: ExpressResponse,
): void => {
  const id = String(req.params.id ?? "");
  const blob = downloadStore.get(id);
  if (!blob) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (blob.expiresAt <= Date.now()) {
    downloadStore.delete(id);
    res.status(410).json({ error: "expired" });
    return;
  }
  const expectedMime = expectedKind === "svg" ? "image/svg+xml" : "image/png";
  if (blob.mime !== expectedMime) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.setHeader("Content-Type", blob.mime);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${blob.filename}"`,
  );
  res.setHeader("Cache-Control", "private, max-age=60");
  res.status(200).end(blob.data);
};

app.get("/downloads/svg/:id", (req, res) => serveDownload("svg", req, res));
app.get("/downloads/png/:id", (req, res) => serveDownload("png", req, res));
app.get("/mcp/downloads/svg/:id", (req, res) => serveDownload("svg", req, res));
app.get("/mcp/downloads/png/:id", (req, res) => serveDownload("png", req, res));

// ────────────────────────────────────────────────────────────
// Widget endpoint
//
// ChatGPT fetches openai/outputTemplate via HTTP GET. Serve the same HTML
// at both root and /mcp/ prefix to handle Coolify's path-based routing.
// ────────────────────────────────────────────────────────────
const serveWidget = (_req: Request, res: ExpressResponse): void => {
  res.setHeader("Content-Type", "text/html;profile=mcp-app");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).send(WIDGET_HTML);
};
app.get("/widget", serveWidget);
app.get("/mcp/widget", serveWidget);

app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(
    `codedraw-mcp listening on http://${HOST}:${PORT}  (proxying ${API_URL})`,
  );
});
