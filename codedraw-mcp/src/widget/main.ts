// CodeDraw preview — MCP App widget client.
//
// Renders the SVG / PNG / JSON produced by the `render_diagram` tool inside the
// host's sandboxed iframe.
//
// Two delivery channels are supported so the same widget works across hosts:
//   1. MCP Apps standard (Claude, and any spec-compliant host) via the official
//      `App` class from @modelcontextprotocol/ext-apps. `app.connect()` performs
//      the `ui/initialize` handshake; the host then pushes the tool result to
//      `app.ontoolresult`. THIS is what was missing before — the previous widget
//      only read ChatGPT globals and never initiated the handshake, so Claude
//      never delivered any data ("No diagram yet.").
//   2. ChatGPT Apps SDK via the `window.openai` globals + `openai:set_globals`
//      event (kept for backwards compatibility).
//
// The render path is CSP-safe: SVG is injected inline (no blob:/data: needed);
// PNG falls back to a data: URL only when no SVG is available.

import { App } from "@modelcontextprotocol/ext-apps";
import { collect, chooseRenderKind, type RenderOut } from "./collect";

const preview = document.getElementById("preview")!;
const bar = document.getElementById("bar")!;
const dimsEl = document.getElementById("dims")!;
const dlSvg = document.getElementById("dlSvg") as HTMLAnchorElement;
const dlPng = document.getElementById("dlPng") as HTMLAnchorElement;
const copyBtn = document.getElementById("copySvg") as HTMLButtonElement;

let lastSvg: string | null = null;
let rendered = false;

// ── rendering ────────────────────────────────────────────────

function setDims(out: RenderOut): void {
  if (out && out.width && out.height) {
    dimsEl.textContent = `${Math.round(out.width)} × ${Math.round(out.height)} px`;
  } else {
    dimsEl.textContent = "";
  }
}

function setDownloads(out: RenderOut): void {
  const dls = out?.downloads ?? {};
  if (dls.svgUrl) {
    dlSvg.href = dls.svgUrl;
    dlSvg.hidden = false;
    dlSvg.setAttribute("download", "");
    dlSvg.target = "_blank";
    dlSvg.rel = "noopener";
  } else {
    dlSvg.hidden = true;
  }
  if (dls.pngUrl) {
    dlPng.href = dls.pngUrl;
    dlPng.hidden = false;
    dlPng.setAttribute("download", "");
    dlPng.target = "_blank";
    dlPng.rel = "noopener";
  } else {
    dlPng.hidden = true;
  }
  copyBtn.hidden = !lastSvg;
  bar.hidden = dlSvg.hidden && dlPng.hidden && copyBtn.hidden && !dimsEl.textContent;
}

function renderSvg(svgText: string, out: RenderOut): void {
  lastSvg = svgText;
  // Inline the (server-sanitized) SVG markup directly — no blob:/data: URL, so
  // it renders under a strict CSP. Drop fixed width/height but keep the viewBox
  // so the CSS `max-width:100%` makes it responsive.
  preview.innerHTML = svgText;
  const svgEl = preview.querySelector("svg");
  if (svgEl) {
    svgEl.removeAttribute("width");
    svgEl.removeAttribute("height");
    svgEl.style.maxWidth = "100%";
    svgEl.style.height = "auto";
  }
  setDims(out);
  setDownloads(out);
}

function renderPng(b64: string, out: RenderOut): void {
  lastSvg = null;
  const img = document.createElement("img");
  img.alt = "CodeDraw diagram";
  img.src = `data:image/png;base64,${b64}`;
  preview.replaceChildren(img);
  setDims(out);
  setDownloads(out);
}

function renderJson(out: RenderOut): void {
  lastSvg = null;
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(out?.scene ?? null, null, 2);
  preview.replaceChildren(pre);
  setDims(out);
  setDownloads(out);
}

function render(out: RenderOut | null): void {
  if (!out) return;
  // Prefer inline SVG (sharpest + CSP-safe). Fall back to PNG, then JSON.
  switch (chooseRenderKind(out)) {
    case "svg":
      renderSvg(out.svg as string, out);
      break;
    case "png":
      renderPng(out.pngBase64 as string, out);
      break;
    case "json":
      renderJson(out);
      break;
    default:
      break;
  }
}

function renderFromResult(params: any): void {
  const out = collect(params);
  if (out && (out.svg || out.pngBase64 || out.scene !== undefined || out.format)) {
    rendered = true;
    render(out);
  }
}

// ── copy button ──────────────────────────────────────────────

copyBtn.addEventListener("click", () => {
  if (!lastSvg || !navigator.clipboard) return;
  navigator.clipboard
    .writeText(lastSvg)
    .then(() => {
      copyBtn.textContent = "Copied";
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.textContent = "Copy SVG";
        copyBtn.classList.remove("copied");
      }, 1500);
    })
    .catch(() => {});
});

// ── channel 2: ChatGPT Apps SDK (window.openai) ──────────────

function tryRenderFromOpenAiGlobals(): boolean {
  if (rendered) return true;
  const w = (window as any).openai;
  if (!w) return false;
  const merged: any = { ...(w.toolOutput ?? {}), ...(w.toolResponseMetadata ?? {}) };
  if (merged.format || merged.svg || merged.pngBase64) {
    rendered = true;
    render(merged as RenderOut);
    return true;
  }
  return false;
}

function startOpenAiChannel(): void {
  tryRenderFromOpenAiGlobals();
  if (!rendered) {
    let tries = 0;
    const iv = setInterval(() => {
      if (tryRenderFromOpenAiGlobals() || ++tries > 80) clearInterval(iv);
    }, 75);
  }
  window.addEventListener(
    "openai:set_globals",
    (event: any) => {
      const globals = event?.detail?.globals;
      if (globals?.toolOutput) {
        const merged: any = {
          ...(globals.toolOutput ?? {}),
          ...(globals.toolResponseMetadata ?? (window as any).openai?.toolResponseMetadata ?? {}),
        };
        if (merged.format || merged.svg || merged.pngBase64) {
          rendered = true;
          render(merged as RenderOut);
        }
      } else {
        tryRenderFromOpenAiGlobals();
      }
    },
    { passive: true } as AddEventListenerOptions,
  );
}

// ── channel 1: MCP Apps standard (Claude & spec-compliant hosts) ──

async function startMcpAppsChannel(): Promise<void> {
  const app = new App({ name: "CodeDraw preview", version: "1.0.0" });
  // Register the handler BEFORE connect() so the initial tool-result push
  // (a one-shot notification fired right after the handshake) is never missed.
  app.ontoolresult = (params) => renderFromResult(params);
  try {
    await app.connect();
  } catch (err) {
    // Surface connection failures for debugging instead of failing silently.
    // eslint-disable-next-line no-console
    console.error("[codedraw-widget] App.connect() failed:", err);
  }
}

// ── bootstrap ────────────────────────────────────────────────
// Pick the channel by host: ChatGPT exposes window.openai; everything else
// (Claude, basic-host, …) speaks the MCP Apps postMessage protocol.

if ((window as any).openai) {
  startOpenAiChannel();
} else {
  void startMcpAppsChannel();
}
