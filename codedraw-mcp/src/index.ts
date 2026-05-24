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

import express, { type Request } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const API_URL = (process.env.CODEDRAW_API_URL ?? "http://localhost:3010").replace(/\/$/, "");
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const SERVER_VERSION = process.env.npm_package_version ?? "0.1.0";

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

const createServer = (): McpServer => {
  const server = new McpServer({
    name: "codedraw",
    version: SERVER_VERSION,
  });

  // ────────────────────────────────────────────────────────────
  // render_diagram
  // ────────────────────────────────────────────────────────────
  server.registerTool(
    "render_diagram",
    {
      title: "Render CodeDraw diagram",
      description:
        "Render a CodeDraw DSL diagram. Use this whenever the user asks to draw, render, create, preview, sketch or export a diagram, flowchart, state machine, ER diagram, architecture sketch or any other visual graph. " +
        "Input is the CodeDraw DSL source code (see get_grammar for the full reference and get_examples for ready-made snippets). " +
        "Default format is SVG (text, embeddable). Use format=png to receive a PNG image content block.",
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
    },
    async ({ code, format, theme, background, scale, padding }) => {
      const res = await apiFetch("/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, format, theme, background, scale, padding }),
      });

      if (format === "svg") {
        const svg = await res.text();
        const dims = extractSvgDims(svg);
        return {
          content: [{ type: "text", text: svg }],
          structuredContent: { format: "svg", ...dims, svg },
        };
      }

      if (format === "json") {
        const text = await res.text();
        const parsed = JSON.parse(text);
        return {
          content: [{ type: "text", text }],
          structuredContent: { format: "json", scene: parsed },
        };
      }

      // png
      const buf = Buffer.from(await res.arrayBuffer());
      const base64 = buf.toString("base64");
      const dims = extractPngDims(buf);
      return {
        content: [
          {
            type: "image",
            data: base64,
            mimeType: "image/png",
          },
        ],
        structuredContent: { format: "png", ...dims },
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
const handleMcp = async (req: Request, res: Response): Promise<void> => {
  try {
    const server = createServer();
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

app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(
    `codedraw-mcp listening on http://${HOST}:${PORT}  (proxying ${API_URL})`,
  );
});
