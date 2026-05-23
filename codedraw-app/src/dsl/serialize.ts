import type {
  ExcalidrawElement,
  ExcalidrawLinearElement,
  ExcalidrawTextElement,
} from "@excalidraw/element/types";

const SHAPE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const round = (n: number) => Math.round(n);

const isTransparent = (c: string | undefined) =>
  !c || c === "transparent" || c === "#00000000";

/**
 * Build a stable, parser-friendly identifier for an element.
 * Returns the element's own id if it's already a clean identifier,
 * otherwise a generated `n<index>` fallback. The mapping is stable
 * within a single serialize() call.
 */
const buildIdMap = (
  els: readonly ExcalidrawElement[],
): Map<string, string> => {
  const map = new Map<string, string>();
  const used = new Set<string>();
  // first pass: keep clean ids
  for (const e of els) {
    if (e.isDeleted) continue;
    if (!SHAPE_TYPES.has(e.type)) continue;
    if (IDENT_RE.test(e.id) && !used.has(e.id)) {
      map.set(e.id, e.id);
      used.add(e.id);
    }
  }
  // second pass: synthesize for the rest
  let counter = 1;
  for (const e of els) {
    if (e.isDeleted) continue;
    if (!SHAPE_TYPES.has(e.type)) continue;
    if (map.has(e.id)) continue;
    let candidate = `n${counter++}`;
    while (used.has(candidate)) candidate = `n${counter++}`;
    map.set(e.id, candidate);
    used.add(candidate);
  }
  return map;
};

const labelFor = (
  el: ExcalidrawElement,
  byId: Map<string, ExcalidrawElement>,
): string => {
  const bound = (el.boundElements ?? []).find((b) => b.type === "text");
  if (!bound) return "";
  const t = byId.get(bound.id) as ExcalidrawTextElement | undefined;
  return t && !t.isDeleted ? t.text : "";
};

const styleTokens = (
  el: ExcalidrawElement,
): string[] => {
  const tokens: string[] = [];
  tokens.push(el.type);
  if (!isTransparent(el.backgroundColor)) tokens.push(el.backgroundColor);
  // Only emit strokeColor if it differs from the default we use when building.
  if (el.strokeColor && el.strokeColor !== "#1e1e1e") {
    if (isTransparent(el.backgroundColor)) {
      // ensure we still have a bg slot so parser puts color in stroke slot
      tokens.push("transparent");
    }
    tokens.push(el.strokeColor);
  }
  const pos = `@${round(el.x)},${round(el.y)},${round(el.width)},${round(el.height)}`;
  tokens.push(pos);
  return tokens;
};

const escapeLabelInBrackets = (s: string) =>
  s.replace(/\]/g, "\\]").replace(/\r?\n/g, " ");

const escapeEdgeLabel = (s: string) => s.replace(/\r?\n/g, " ");

/**
 * Serialize an Excalidraw scene back into CodeDraw DSL.
 *
 * Only handles types CodeDraw understands: rectangle/ellipse/diamond,
 * arrow/line and standalone text. Unknown element types (image, freedraw,
 * etc.) are silently skipped.
 *
 * Positions and sizes are always emitted so the round-trip is stable —
 * the parser will see explicit @x,y,w,h and skip auto-layout.
 */
export const serializeScene = (
  elements: readonly ExcalidrawElement[],
): string => {
  const live = elements.filter((e) => !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  const idMap = buildIdMap(elements);

  const nodeLines: string[] = [];
  for (const e of live) {
    if (!SHAPE_TYPES.has(e.type)) continue;
    const id = idMap.get(e.id);
    if (!id) continue;
    const label = labelFor(e, byId) || id;
    const tokens = styleTokens(e);
    nodeLines.push(`${id} [${escapeLabelInBrackets(label)}] (${tokens.join(", ")})`);
  }

  const edgeLines: string[] = [];
  for (const e of live) {
    if (e.type !== "arrow" && e.type !== "line") continue;
    const linear = e as ExcalidrawLinearElement;
    const fromId = linear.startBinding?.elementId;
    const toId = linear.endBinding?.elementId;
    if (!fromId || !toId) continue;
    const from = idMap.get(fromId);
    const to = idMap.get(toId);
    if (!from || !to) continue;
    const op = e.type === "arrow" ? "->" : "--";
    const label = labelFor(e, byId);
    edgeLines.push(`${from} ${op} ${to}${label ? ` : ${escapeEdgeLabel(label)}` : ""}`);
  }

  const textLines: string[] = [];
  for (const e of live) {
    if (e.type !== "text") continue;
    const t = e as ExcalidrawTextElement;
    if (t.containerId) continue; // bound label, already emitted as node label
    const escaped = t.text.replace(/"/g, '\\"').replace(/\r?\n/g, " ");
    textLines.push(`"${escaped}" (@${round(t.x)},${round(t.y)})`);
  }

  const sections = [nodeLines, edgeLines, textLines].filter((s) => s.length);
  return sections.map((s) => s.join("\n")).join("\n\n");
};
