import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { chromium, type Browser, type Page } from "playwright";
import { EXAMPLES } from "./examples.js";
import { buildOpenApiSpec } from "./openapi.js";

declare global {
  interface Window {
    codedraw?: {
      renderSvg: (code: string, opts?: unknown) => Promise<{ svg: string; errors: unknown[] }>;
      renderPng: (code: string, opts?: unknown) => Promise<{ base64: string; errors: unknown[] }>;
      renderJson: (code: string) => Promise<unknown>;
      validateDsl: (code: string) => { valid: boolean; errors: { line: number; message: string }[] };
    };
  }
}

const WEB_URL = process.env.CODEDRAW_WEB_URL ?? "http://web";
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const API_KEY = process.env.CODEDRAW_API_KEY ?? "";
const MAX_CODE_BYTES = Number(process.env.CODEDRAW_MAX_CODE_BYTES ?? 64 * 1024);
const RENDER_TIMEOUT_MS = Number(process.env.CODEDRAW_RENDER_TIMEOUT_MS ?? 15000);
const RATE_LIMIT_MAX = Number(process.env.CODEDRAW_RATE_LIMIT_MAX ?? 30);
const RATE_LIMIT_WINDOW_MS = Number(
  process.env.CODEDRAW_RATE_LIMIT_WINDOW_MS ?? 60_000,
);
const RATE_LIMIT_GLOBAL_MAX = Number(
  process.env.CODEDRAW_RATE_LIMIT_GLOBAL_MAX ?? 300,
);

// Strict whitelists for free-form user input that ends up either in headers,
// embedded in SVG output, or in Excalidraw appState. Anything that doesn't
// match these patterns is rejected at the request boundary.
const COLOR_RE = /^#(?:[0-9a-fA-F]{3,8})$/;
const THEME_VALUES = new Set(["light", "dark"]);
const FORMAT_VALUES = new Set(["png", "svg", "json"]);

// HTTP header values must not contain CR/LF (header injection) or other
// control characters. Errors from the parser are user-controlled text, so
// strip everything that's unsafe before stuffing it into a response header.
const sanitizeHeader = (value: string): string =>
  value.replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ").slice(0, 4096);

interface RenderBody {
  code: string;
  format?: "svg" | "png" | "json";
  scale?: number;
  padding?: number;
  background?: string;
  theme?: "light" | "dark";
}

let browser: Browser | null = null;
let page: Page | null = null;
let pageReady: Promise<Page> | null = null;
// Serialize concurrent render calls — a single page can only run one evaluate
// at a time without races on the renderer's internal state.
let queue: Promise<unknown> = Promise.resolve();

const getPage = async (): Promise<Page> => {
  if (page && !page.isClosed()) return page;
  if (pageReady) return pageReady;
  pageReady = (async () => {
    if (!browser) {
      browser = await chromium.launch({
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
    }
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const p = await ctx.newPage();
    p.on("console", (msg) => {
      if (msg.type() === "error") {
        console.warn("[render-page]", msg.text());
      }
    });
    const target = `${WEB_URL.replace(/\/$/, "")}/?mode=render`;
    await p.goto(target, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await p.waitForFunction("window.codedraw && window.codedraw.ready === true", null, {
      timeout: RENDER_TIMEOUT_MS,
    });
    page = p;
    return p;
  })();
  try {
    return await pageReady;
  } finally {
    pageReady = null;
  }
};

const runQueued = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
};

const app = Fastify({ bodyLimit: MAX_CODE_BYTES + 16 * 1024, logger: true });

// Per-IP spam protection. Applied to all routes; expensive POST /render
// path is additionally protected by an in-process queue (see runQueued).
await app.register(rateLimit, {
  max: RATE_LIMIT_MAX,
  timeWindow: RATE_LIMIT_WINDOW_MS,
  global: true,
  cache: 10_000,
  // Combine with a global cap so a swarm of distinct IPs still can't
  // saturate the single Playwright page.
  hook: "preHandler",
  keyGenerator: (req) => req.ip,
});
// Global concurrency cap shared across IPs.
let globalWindow: { start: number; count: number } = { start: Date.now(), count: 0 };
app.addHook("preHandler", async (_req, reply) => {
  const now = Date.now();
  if (now - globalWindow.start > RATE_LIMIT_WINDOW_MS) {
    globalWindow = { start: now, count: 0 };
  }
  globalWindow.count += 1;
  if (globalWindow.count > RATE_LIMIT_GLOBAL_MAX) {
    reply.code(503).send({ error: "server busy, retry later" });
  }
});

app.addHook("preHandler", async (req, reply) => {
  if (!API_KEY) return;
  const auth = req.headers["authorization"];
  const provided =
    typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (provided !== API_KEY) {
    reply.code(401).send({ error: "unauthorized" });
  }
});

app.get("/health", async () => ({
  ok: true,
  browser: Boolean(browser),
  page: Boolean(page && !page.isClosed()),
  web: WEB_URL,
}));

const GRAMMAR_TEXT = `CodeDraw DSL — block-structured.

Top-level statements (each may be followed by an optional { ... } block):

  node <id> { label, shape, fill, stroke, at, size }
  edge <id> -> <id> { label }       arrow bound to two nodes
  edge <id> -- <id> { label }       line  bound to two nodes
  arrow { from: x,y  to: x,y  label }   free arrow, not bound to nodes
  line  { from: x,y  to: x,y }          free line,  not bound to nodes
  text  { content: "...", at: x,y, size: fontSize }

Attribute values:
  "string"          quoted, supports \\" \\\\ \\n escapes
  ident             bare identifier (e.g. ellipse)
  #rgb / #rrggbb    color
  n[, n[, n[, n]]]  one to four numbers separated by commas

Per statement:
  node:   label "string"; shape rectangle|ellipse|diamond (default rectangle);
          fill #hex; stroke #hex; at x,y; size w,h
  edge:   label "string"
  arrow:  from x,y; to x,y; label "string"
  line:   from x,y; to x,y
  text:   content "string"; at x,y; size fontSize

Identifiers match [A-Za-z_][A-Za-z0-9_]*.
Comments: lines beginning with '#' or trailing '  # ...'.
Implicit nodes: an edge that names an undeclared id auto-creates a
default rectangle node with that id as label.
If no node has an explicit 'at:' position, dagre lays out the graph
top-down. Otherwise positions from the code are honored verbatim.
`;

const EXAMPLE_CODE = `node start {
  label: "Start"
  shape: ellipse
  fill:  #b2f2bb
}

node check {
  label: "Valid?"
  shape: diamond
  fill:  #fff3bf
}

node work  { label: "Process"    fill: #a5d8ff }
node error { label: "Show error" fill: #ffc9c9 }
node done  { label: "End" shape: ellipse fill: #b2f2bb }

edge start -> check
edge check -> work  { label: "yes" }
edge check -> error { label: "no" }
edge work  -> done
edge error -> start { label: "retry" }

text { content: "code in, diagram out" }
`;

app.get("/grammar", async (_req, reply) => {
  reply.header("content-type", "text/plain; charset=utf-8");
  return GRAMMAR_TEXT;
});

app.get("/example", async (_req, reply) => {
  reply.header("content-type", "text/plain; charset=utf-8");
  return EXAMPLE_CODE;
});

app.get("/examples", async () => EXAMPLES);

app.get("/openapi.json", async (req) => {
  // Use the request's forwarded host so the spec advertises the same base
  // URL that the caller used (e.g. https://codedraw.dehlwes.net/api).
  const proto = (req.headers["x-forwarded-proto"] as string) ?? "http";
  const host = (req.headers["x-forwarded-host"] as string) ?? req.headers.host ?? "localhost";
  const prefix = (req.headers["x-forwarded-prefix"] as string) ?? "";
  return buildOpenApiSpec(`${proto}://${host}${prefix}`);
});

app.post<{ Body: { code?: unknown } }>("/validate", async (req, reply) => {
  const code = req.body?.code;
  if (typeof code !== "string" || code.length === 0) {
    return reply.code(400).send({ error: "missing 'code' string" });
  }
  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
    return reply.code(413).send({ error: "code too large" });
  }
  return runQueued(async () => {
    const p = await getPage();
    const result = await p.evaluate(
      ([c]) => window.codedraw!.validateDsl(c as string),
      [code] as const,
    );
    return result;
  });
});

app.get("/", async () => ({
  name: "codedraw-api",
  endpoints: {
    "GET /health":        "liveness + browser/page state",
    "GET /grammar":       "plain-text grammar reference",
    "GET /example":       "plain-text working DSL sample",
    "GET /examples":      "JSON array of curated named snippets",
    "GET /openapi.json":  "OpenAPI 3.1 spec (import into Custom GPT Actions)",
    "POST /validate":     "{ code } -> { valid, errors } (parser-only, cheap)",
    "POST /render":       "{ code, format?, scale?, padding?, background?, theme? } -> png | svg | json",
  },
  formats: ["png", "svg", "json"],
  shapes: ["rectangle", "ellipse", "diamond"],
  options: {
    format:     "'svg' | 'png' | 'json' (default 'png')",
    scale:      "PNG export scale 0.25–5 (default 1)",
    padding:    "padding in px around content (default 20)",
    background: "any CSS color (e.g. '#ffffff', '#00000000', 'red') or 'transparent'. Default '#ffffff'. Applies to both PNG and SVG — transparent yields no background rect.",
    theme:      "'light' | 'dark' (default 'light')",
  },
}));

app.post<{ Body: RenderBody }>("/render", async (req, reply) => {
  const { code, format = "png", scale, padding, background, theme } = req.body ?? {};
  if (typeof code !== "string" || code.length === 0) {
    return reply.code(400).send({ error: "missing 'code' string" });
  }
  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
    return reply.code(413).send({ error: "code too large" });
  }
  if (!FORMAT_VALUES.has(format)) {
    return reply.code(400).send({ error: "invalid format" });
  }
  if (theme !== undefined && !THEME_VALUES.has(theme)) {
    return reply.code(400).send({ error: "invalid theme" });
  }
  if (
    background !== undefined &&
    background !== "transparent" &&
    !COLOR_RE.test(background)
  ) {
    return reply
      .code(400)
      .send({ error: "invalid background (expected #hex or 'transparent')" });
  }
  if (
    scale !== undefined &&
    (typeof scale !== "number" || !Number.isFinite(scale) || scale < 0.25 || scale > 5)
  ) {
    return reply.code(400).send({ error: "invalid scale (0.25–5)" });
  }
  if (
    padding !== undefined &&
    (typeof padding !== "number" || !Number.isFinite(padding) || padding < 0 || padding > 500)
  ) {
    return reply.code(400).send({ error: "invalid padding (0–500)" });
  }

  return runQueued(async () => {
    const p = await getPage();
    const opts = { scale, padding, background, theme };

    if (format === "svg") {
      const result = await p.evaluate(
        async ([c, o]) => window.codedraw!.renderSvg(c as string, o as any),
        [code, opts] as const,
      );
      reply.header("content-type", "image/svg+xml; charset=utf-8");
      reply.header("x-codedraw-errors", sanitizeHeader(JSON.stringify(result.errors)));
      return result.svg;
    }

    if (format === "json") {
      const result = await p.evaluate(
        ([c]) => window.codedraw!.renderJson(c as string),
        [code] as const,
      );
      reply.header("content-type", "application/json; charset=utf-8");
      return result;
    }

    // PNG
    const result = await p.evaluate(
      async ([c, o]) => window.codedraw!.renderPng(c as string, o as any),
      [code, opts] as const,
    );
    const buf = Buffer.from(result.base64, "base64");
    reply.header("content-type", "image/png");
    reply.header("content-length", buf.byteLength);
    reply.header("x-codedraw-errors", sanitizeHeader(JSON.stringify(result.errors)));
    return reply.send(buf);
  });
});

const shutdown = async (signal: string) => {
  app.log.info(`received ${signal}, shutting down`);
  try {
    await app.close();
  } catch (e) {
    app.log.error(e);
  }
  if (browser) {
    await browser.close().catch(() => undefined);
  }
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

app.listen({ port: PORT, host: HOST }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
