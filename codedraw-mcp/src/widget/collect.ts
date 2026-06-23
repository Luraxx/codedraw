// Pure extraction of a renderable payload from a CallToolResult.
//
// Kept DOM-free and dependency-free so it can be unit-tested in Node. The widget
// (main.ts) imports `collect` and feeds the result into its DOM renderer.
//
// We merge every source the host might forward, because hosts differ in what
// they pass to the widget:
//   - structuredContent: { format, width, height, downloads }   (small, model-facing)
//   - _meta:             { svg, pngBase64, downloads }           (heavy, widget-only)
//   - content[]:         inline SVG text / PNG image block / JSON / download URLs
// Anything present wins in that order, with content[] as the always-available
// fallback so the preview renders even if structuredContent/_meta are dropped.

export type Downloads = { svgUrl?: string; pngUrl?: string; ttlSeconds?: number };

export type RenderOut = {
  format?: "svg" | "png" | "json";
  width?: number;
  height?: number;
  svg?: string;
  pngBase64?: string;
  scene?: unknown;
  downloads?: Downloads;
};

export function collect(params: any): RenderOut | null {
  if (!params) return null;
  const sc = (params.structuredContent as Record<string, unknown>) ?? {};
  const meta = (params._meta as Record<string, unknown>) ?? {};
  const out: RenderOut = { ...sc, ...meta } as RenderOut;

  const content = Array.isArray(params.content) ? params.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "image" && typeof block.data === "string") {
      out.pngBase64 = out.pngBase64 ?? block.data;
      out.format = out.format ?? "png";
    } else if (block.type === "text" && typeof block.text === "string") {
      const t = block.text.trim();
      if (/^<svg[\s>]/i.test(t)) {
        out.svg = out.svg ?? block.text;
        out.format = out.format ?? "svg";
      } else if (out.scene === undefined && /^[[{]/.test(t)) {
        try {
          const parsed = JSON.parse(t);
          if (parsed && (parsed.elements || parsed.type === "excalidraw" || parsed.scene)) {
            out.scene = out.scene ?? (parsed.scene ?? parsed);
            out.format = out.format ?? "json";
          }
        } catch {
          /* not JSON — ignore */
        }
      }
      if (!out.downloads) {
        const svgM = /SVG:\s*(\S+)/.exec(block.text);
        const pngM = /PNG:\s*(\S+)/.exec(block.text);
        if (svgM || pngM) out.downloads = { svgUrl: svgM?.[1], pngUrl: pngM?.[1] };
      }
    }
  }
  return out;
}

// Mirrors the renderer's selection logic — exposed so the choice of render path
// can be asserted in tests without a DOM.
export function chooseRenderKind(out: RenderOut | null): "svg" | "png" | "json" | "none" {
  if (!out) return "none";
  if (out.format === "json" && out.scene !== undefined) return "json";
  if (typeof out.svg === "string" && out.svg.length) return "svg";
  if (typeof out.pngBase64 === "string" && out.pngBase64.length) return "png";
  if (out.scene !== undefined) return "json";
  return "none";
}
