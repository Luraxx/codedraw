import Fastify from "fastify";
import { chromium, type Browser, type Page } from "playwright";

const WEB_URL = process.env.CODEDRAW_WEB_URL ?? "http://web";
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const API_KEY = process.env.CODEDRAW_API_KEY ?? "";
const MAX_CODE_BYTES = Number(process.env.CODEDRAW_MAX_CODE_BYTES ?? 64 * 1024);
const RENDER_TIMEOUT_MS = Number(process.env.CODEDRAW_RENDER_TIMEOUT_MS ?? 15000);

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

app.post<{ Body: RenderBody }>("/render", async (req, reply) => {
  const { code, format = "png", scale, padding, background, theme } = req.body ?? {};
  if (typeof code !== "string" || code.length === 0) {
    return reply.code(400).send({ error: "missing 'code' string" });
  }
  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
    return reply.code(413).send({ error: "code too large" });
  }
  if (!["svg", "png", "json"].includes(format)) {
    return reply.code(400).send({ error: "invalid format" });
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
      reply.header("x-codedraw-errors", JSON.stringify(result.errors));
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
    reply.header("x-codedraw-errors", JSON.stringify(result.errors));
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
