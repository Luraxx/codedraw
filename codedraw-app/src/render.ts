import { exportToSvg, exportToBlob } from "@excalidraw/utils/export";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
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
  const background = opts.background ?? "#ffffff";
  return {
    viewBackgroundColor: background === "transparent" ? "#ffffff" : background,
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

export const renderSvg = async (
  code: string,
  opts: RenderOptions = {},
): Promise<{ svg: string; errors: ParsePayload["errors"] }> => {
  const { elements, errors } = parseAndBuild(code);
  const svg = await exportToSvg({
    elements,
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
  const blob = await exportToBlob({
    elements,
    appState: buildAppState(opts),
    files: {},
    exportPadding: opts.padding ?? 20,
    mimeType: "image/png",
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
