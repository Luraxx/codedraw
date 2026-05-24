import { exportToSvg, exportToBlob } from "@excalidraw/utils/export";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

import { parseDsl } from "./dsl/parser";
import { buildScene } from "./dsl/buildScene";

export interface RenderOptions {
  /** export padding around content; default 20 */
  padding?: number;
  /** export scale, only PNG; default 1, capped at 5 */
  scale?: number;
  /** background color (CSS) or "transparent"; default "#ffffff" */
  background?: string;
  /** "light" or "dark"; default "light" */
  theme?: "light" | "dark";
}

const buildAppState = (opts: RenderOptions): Partial<AppState> => {
  // When theme=dark and no explicit background is provided, default to a
  // dark canvas — otherwise dark-theme strokes (light grey) render almost
  // invisibly on the default white background.
  const defaultBg = opts.theme === "dark" ? "#121212" : "#ffffff";
  const background = opts.background ?? defaultBg;
  return {
    viewBackgroundColor: background === "transparent" ? defaultBg : background,
    exportBackground: background !== "transparent",
    exportScale: Math.min(5, Math.max(0.25, opts.scale ?? 1)),
    theme: opts.theme ?? "light",
  };
};

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.readAsDataURL(blob);
  });

export interface ParsePayload {
  ok: boolean;
  errors: { line: number; message: string; raw: string }[];
  elements: readonly ExcalidrawElement[];
}

const parseAndBuild = (code: string): ParsePayload => {
  const parsed = parseDsl(code);
  const elements = buildScene(parsed);
  return { ok: parsed.errors.length === 0, errors: parsed.errors, elements };
};

export interface ValidateResult {
  valid: boolean;
  errors: { line: number; message: string }[];
}

// Parser-only check used by POST /validate. Skips buildScene (no dagre, no
// element synthesis) so it's roughly an order of magnitude cheaper than a
// full render and safe to call in an agent correction loop.
export const validateDsl = (code: string): ValidateResult => {
  const parsed = parseDsl(code);
  return {
    valid: parsed.errors.length === 0,
    errors: parsed.errors.map((e) => ({ line: e.line, message: e.message })),
  };
};

// Default ink color used by buildScene. When exporting in dark theme we
// swap any occurrence with a light tone so strokes and text stay legible
// on the dark canvas. User-specified colors (anything other than the
// default) are left untouched.
const DEFAULT_INK = "#1e1e1e";
const DARK_INK = "#e6e6e6";

const adaptForTheme = (
  elements: readonly ExcalidrawElement[],
  theme: "light" | "dark" | undefined,
): readonly ExcalidrawElement[] => {
  if (theme !== "dark") return elements;
  return elements.map((el) => {
    const next = { ...el } as ExcalidrawElement;
    if ((next as { strokeColor?: string }).strokeColor === DEFAULT_INK) {
      (next as { strokeColor?: string }).strokeColor = DARK_INK;
    }
    return next;
  });
};

export const renderSvg = async (
  code: string,
  opts: RenderOptions = {},
): Promise<{ svg: string; errors: ParsePayload["errors"] }> => {
  const { elements, errors } = parseAndBuild(code);
  const svg = await exportToSvg({
    elements: adaptForTheme(elements, opts.theme),
    appState: buildAppState(opts),
    files: {},
    exportPadding: opts.padding ?? 20,
  });
  return { svg: svg.outerHTML, errors };
};

export const renderPng = async (
  code: string,
  opts: RenderOptions = {},
): Promise<{ base64: string; errors: ParsePayload["errors"] }> => {
  const { elements, errors } = parseAndBuild(code);
  const scale = Math.min(5, Math.max(0.25, opts.scale ?? 1));
  const blob = await exportToBlob({
    elements: adaptForTheme(elements, opts.theme),
    appState: buildAppState(opts),
    files: {},
    exportPadding: opts.padding ?? 20,
    mimeType: "image/png",
    getDimensions: (width, height) => ({
      width: Math.round(width * scale),
      height: Math.round(height * scale),
      scale,
    }),
  });
  return { base64: await blobToBase64(blob), errors };
};

export const renderJson = (code: string) => {
  const { elements, errors } = parseAndBuild(code);
  return {
    elements,
    errors,
    type: "excalidraw" as const,
    version: 2,
    source: "https://codedraw.local",
  };
};
