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

const buildIdMap = (
  els: readonly ExcalidrawElement[],
): Map<string, string> => {
  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const e of els) {
    if (e.isDeleted) continue;
    if (!SHAPE_TYPES.has(e.type)) continue;
    if (IDENT_RE.test(e.id) && !used.has(e.id)) {
      map.set(e.id, e.id);
      used.add(e.id);
    }
  }
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

const escapeString = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");

const indent = (s: string) => s.split("\n").map((l) => "  " + l).join("\n");

const serializeNode = (
  el: ExcalidrawElement,
  id: string,
  label: string,
): string => {
  const lines: string[] = [];
  if (label && label !== id) lines.push(`label:  "${escapeString(label)}"`);
  if (el.type !== "rectangle") lines.push(`shape:  ${el.type}`);
  if (!isTransparent(el.backgroundColor)) {
    lines.push(`fill:   ${el.backgroundColor}`);
  }
  if (el.strokeColor && el.strokeColor !== "#1e1e1e") {
    lines.push(`stroke: ${el.strokeColor}`);
  }
  lines.push(`at:     ${round(el.x)}, ${round(el.y)}`);
  lines.push(`size:   ${round(el.width)}, ${round(el.height)}`);
  return `node ${id} {\n${indent(lines.join("\n"))}\n}`;
};

const serializeEdge = (
  from: string,
  to: string,
  op: "->" | "--",
  label: string,
): string => {
  if (!label) return `edge ${from} ${op} ${to}`;
  return `edge ${from} ${op} ${to} {\n  label: "${escapeString(label)}"\n}`;
};

const linearEndpoints = (l: ExcalidrawLinearElement) => {
  const pts = l.points;
  if (!pts || pts.length < 2) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  return {
    fromX: l.x + first[0],
    fromY: l.y + first[1],
    toX: l.x + last[0],
    toY: l.y + last[1],
  };
};

const serializeFreeLinear = (
  kind: "arrow" | "line",
  e: ExcalidrawLinearElement,
  label: string,
): string => {
  const pts = linearEndpoints(e);
  if (!pts) return "";
  const lines = [
    `from:  ${round(pts.fromX)}, ${round(pts.fromY)}`,
    `to:    ${round(pts.toX)}, ${round(pts.toY)}`,
  ];
  if (label && kind === "arrow") {
    lines.push(`label: "${escapeString(label)}"`);
  }
  return `${kind} {\n${indent(lines.join("\n"))}\n}`;
};

const serializeText = (t: ExcalidrawTextElement): string => {
  const lines = [
    `content: "${escapeString(t.text)}"`,
    `at:      ${round(t.x)}, ${round(t.y)}`,
  ];
  if (t.fontSize && t.fontSize !== 20) {
    lines.push(`size:    ${round(t.fontSize)}`);
  }
  return `text {\n${indent(lines.join("\n"))}\n}`;
};

/**
 * Serialize an Excalidraw scene back into CodeDraw DSL.
 *
 * Round-trip-safe for nodes (rectangle/ellipse/diamond), arrows and lines
 * (whether bound to nodes or free-floating), and standalone text.
 * Unsupported element types are skipped.
 */
export const serializeScene = (
  elements: readonly ExcalidrawElement[],
): string => {
  const live = elements.filter((e) => !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  const idMap = buildIdMap(elements);

  const nodeBlocks: string[] = [];
  for (const e of live) {
    if (!SHAPE_TYPES.has(e.type)) continue;
    const id = idMap.get(e.id);
    if (!id) continue;
    nodeBlocks.push(serializeNode(e, id, labelFor(e, byId)));
  }

  const edgeBlocks: string[] = [];
  const freeBlocks: string[] = [];
  for (const e of live) {
    if (e.type !== "arrow" && e.type !== "line") continue;
    const linear = e as ExcalidrawLinearElement;
    const fromId = linear.startBinding?.elementId;
    const toId = linear.endBinding?.elementId;
    const label = labelFor(e, byId);
    if (
      fromId && toId &&
      idMap.has(fromId) && idMap.has(toId)
    ) {
      const from = idMap.get(fromId)!;
      const to = idMap.get(toId)!;
      edgeBlocks.push(serializeEdge(from, to, e.type === "arrow" ? "->" : "--", label));
    } else {
      const block = serializeFreeLinear(e.type, linear, label);
      if (block) freeBlocks.push(block);
    }
  }

  const textBlocks: string[] = [];
  for (const e of live) {
    if (e.type !== "text") continue;
    const t = e as ExcalidrawTextElement;
    if (t.containerId) continue; // already serialized as a node label
    textBlocks.push(serializeText(t));
  }

  const sections = [nodeBlocks, edgeBlocks, freeBlocks, textBlocks].filter(
    (s) => s.length,
  );
  return sections.map((s) => s.join("\n\n")).join("\n\n");
};
