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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
// MCP App UI widget HTML
//
// Served as an MCP resource at WIDGET_URI. Hosts load it via resources/read
// against the ui:// URI advertised by the tool's `_meta.ui.resourceUri`
// (Claude / MCP Apps standard) and `openai/outputTemplate` (ChatGPT). The
// widget then performs the MCP Apps handshake to receive the tool result.
// ────────────────────────────────────────────────────────────
const WIDGET_URI = "ui://widget/codedraw-preview-v8.html";

// The widget markup is built from src/widget/ (TypeScript + the official
// @modelcontextprotocol/ext-apps `App` client) into a single, self-contained
// HTML file by Vite (`npm run build:widget`). We read it once at startup and
// serve it as the ui:// resource below. Bump the -vN suffix in WIDGET_URI
// whenever the widget changes so hosts re-fetch it instead of serving a cached
// copy.
const WIDGET_HTML = ((): string => {
  const file = fileURLToPath(new URL("../dist/widget/index.html", import.meta.url));
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(
      `Widget bundle not found at ${file}. Run "npm run build:widget" first ` +
        `(it runs automatically via the "start"/"dev" scripts and in the Docker image). ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
})();

const createServer = (baseUrl: string): McpServer => {
  const server = new McpServer({
    name: "codedraw",
    version: SERVER_VERSION,
  });

  // ────────────────────────────────────────────────────────────
  // MCP App UI widget — registered as an MCP resource.
  // ────────────────────────────────────────────────────────────
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

app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(
    `codedraw-mcp listening on http://${HOST}:${PORT}  (proxying ${API_URL})`,
  );
});
