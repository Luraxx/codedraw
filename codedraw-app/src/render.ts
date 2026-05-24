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

export interface InspectResult {
  valid: boolean;
  errors: { line: number; message: string }[];
  warnings: string[];
  diagramType:
    | "flowchart"
    | "sequence"
    | "state-machine"
    | "tree"
    | "network"
    | "free-form"
    | "empty";
  counts: {
    nodes: number;
    edges: number;
    texts: number;
    freeShapes: number;
    shapes: Record<string, number>;
    edgeKinds: Record<string, number>;
  };
  nodes: {
    id: string;
    label: string;
    shape: string;
    pinned: boolean;
    inDegree: number;
    outDegree: number;
  }[];
  edges: { from: string; to: string; kind: string; label?: string }[];
  texts: { text: string; pinned: boolean }[];
  freeShapes: { kind: string; from: [number, number]; to: [number, number]; label?: string }[];
}

const guessDiagramType = (
  nodes: ReturnType<typeof parseDsl>["nodes"],
  edges: ReturnType<typeof parseDsl>["edges"],
  freeArrows: ReturnType<typeof parseDsl>["freeArrows"],
  texts: ReturnType<typeof parseDsl>["texts"],
): InspectResult["diagramType"] => {
  if (nodes.length === 0 && edges.length === 0) {
    if (freeArrows.length > 0 || texts.length > 0) return "free-form";
    return "empty";
  }
  if (nodes.length > 0 && edges.length === 0 && freeArrows.length === 0) {
    return "free-form";
  }
  const hasDiamond = nodes.some((n) => n.shape === "diamond");
  const hasEllipse = nodes.some((n) => n.shape === "ellipse");
  const hasElbow = edges.some((e) => e.kind === "elbow");
  // build adjacency
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const e of edges) {
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }
  const selfLoops = edges.filter((e) => e.from === e.to).length;
  const maxIn = Math.max(0, ...Array.from(inDeg.values()));
  const maxOut = Math.max(0, ...Array.from(outDeg.values()));
  if (selfLoops > 0 || (hasEllipse && hasElbow)) return "state-machine";
  if (hasDiamond) return "flowchart";
  // tree heuristic: every node has at most 1 incoming, and edges form a DAG
  if (maxIn <= 1 && edges.length === nodes.length - 1) return "tree";
  // sequence: linear chain (each node deg<=2, edges == nodes-1)
  if (
    maxIn <= 1 &&
    maxOut <= 1 &&
    edges.length >= Math.max(1, nodes.length - 2) &&
    edges.length <= nodes.length
  ) {
    return "sequence";
  }
  if (maxIn >= 3 || maxOut >= 3) return "network";
  return "flowchart";
};

// Structured analysis used by POST /inspect. Parser-only (no buildScene).
// Returns enough metadata for an agent to reason about an existing diagram
// without re-tokenising the DSL itself.
export const inspectDsl = (code: string): InspectResult => {
  const parsed = parseDsl(code);
  const declaredIds = new Set(parsed.nodes.map((n) => n.id));

  // Synthesise any nodes that are referenced by an edge but not declared,
  // matching buildScene's "auto-create rectangle" behavior.
  const referenced = new Set<string>();
  for (const e of parsed.edges) {
    referenced.add(e.from);
    referenced.add(e.to);
  }
  const allNodes = [
    ...parsed.nodes,
    ...Array.from(referenced)
      .filter((id) => !declaredIds.has(id))
      .map((id) => ({ id, label: id, shape: "rectangle" as const })),
  ];

  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const e of parsed.edges) {
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }

  const shapes: Record<string, number> = {};
  const edgeKinds: Record<string, number> = {};
  for (const n of allNodes) shapes[n.shape] = (shapes[n.shape] ?? 0) + 1;
  for (const e of parsed.edges) edgeKinds[e.kind] = (edgeKinds[e.kind] ?? 0) + 1;
  for (const f of parsed.freeArrows) edgeKinds[f.kind] = (edgeKinds[f.kind] ?? 0) + 1;

  const warnings: string[] = [];
  // orphan nodes (no incoming + no outgoing edges)
  if (allNodes.length > 1) {
    for (const n of allNodes) {
      if ((inDeg.get(n.id) ?? 0) === 0 && (outDeg.get(n.id) ?? 0) === 0) {
        warnings.push(`Node "${n.id}" is isolated (no edges).`);
      }
    }
  }
  for (const e of parsed.edges) {
    if (e.from === e.to) {
      warnings.push(`Edge "${e.from} -> ${e.to}" is a self-loop.`);
    }
  }
  const autoCreated = allNodes.filter((n) => !declaredIds.has(n.id));
  if (autoCreated.length > 0) {
    warnings.push(
      `Auto-created ${autoCreated.length} node(s) referenced by edges but never declared: ${autoCreated.map((n) => n.id).join(", ")}.`,
    );
  }

  return {
    valid: parsed.errors.length === 0,
    errors: parsed.errors.map((e) => ({ line: e.line, message: e.message })),
    warnings,
    diagramType: guessDiagramType(
      parsed.nodes,
      parsed.edges,
      parsed.freeArrows,
      parsed.texts,
    ),
    counts: {
      nodes: allNodes.length,
      edges: parsed.edges.length,
      texts: parsed.texts.length,
      freeShapes: parsed.freeArrows.length,
      shapes,
      edgeKinds,
    },
    nodes: allNodes.map((n) => ({
      id: n.id,
      label: n.label,
      shape: n.shape,
      pinned: "x" in n && typeof (n as { x?: number }).x === "number",
      inDegree: inDeg.get(n.id) ?? 0,
      outDegree: outDeg.get(n.id) ?? 0,
    })),
    edges: parsed.edges.map((e) => ({
      from: e.from,
      to: e.to,
      kind: e.kind,
      label: e.label,
    })),
    texts: parsed.texts.map((t) => ({
      text: t.text,
      pinned: typeof t.x === "number",
    })),
    freeShapes: parsed.freeArrows.map((f) => ({
      kind: f.kind,
      from: [f.fromX, f.fromY] as [number, number],
      to: [f.toX, f.toY] as [number, number],
      label: f.label,
    })),
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
