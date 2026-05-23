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

const ARROWHEAD_NAME: Record<string, string> = {
  arrow: "arrow",
  triangle: "triangle",
  bar: "bar",
  dot: "dot",
};

const arrowheadToken = (head: unknown): string | null => {
  if (head === null || head === undefined) return null;
  if (typeof head !== "string") return null;
  return ARROWHEAD_NAME[head] ?? null;
};

const serializeNode = (
  el: ExcalidrawElement,
  id: string,
  label: string,
): string => {
  const lines: string[] = [];
  if (label && label !== id) lines.push(`label:       "${escapeString(label)}"`);
  if (el.type !== "rectangle") lines.push(`shape:       ${el.type}`);
  if (!isTransparent(el.backgroundColor)) {
    lines.push(`fill:        ${el.backgroundColor}`);
  }
  if (el.strokeColor && el.strokeColor !== "#1e1e1e") {
    lines.push(`stroke:      ${el.strokeColor}`);
  }
  if (el.strokeWidth && el.strokeWidth !== 2) {
    lines.push(`strokeWidth: ${el.strokeWidth}`);
  }
  if (el.strokeStyle && el.strokeStyle !== "solid") {
    lines.push(`strokeStyle: ${el.strokeStyle}`);
  }
  if (el.roughness !== undefined && el.roughness !== 1) {
    lines.push(`roughness:   ${el.roughness}`);
  }
  lines.push(`at:          ${round(el.x)}, ${round(el.y)}`);
  lines.push(`size:        ${round(el.width)}, ${round(el.height)}`);
  return `node ${id} {\n${indent(lines.join("\n"))}\n}`;
};

const linearStyleLines = (
  e: ExcalidrawLinearElement,
  kind: "arrow" | "line" | "elbow",
): string[] => {
  const lines: string[] = [];
  if (e.strokeColor && e.strokeColor !== "#1e1e1e") {
    lines.push(`color:     ${e.strokeColor}`);
  }
  if (e.strokeWidth && e.strokeWidth !== 2) {
    lines.push(`width:     ${e.strokeWidth}`);
  }
  if (e.strokeStyle && e.strokeStyle !== "solid") {
    lines.push(`style:     ${e.strokeStyle}`);
  }
  if (e.roughness !== undefined && e.roughness !== 1) {
    lines.push(`roughness: ${e.roughness}`);
  }
  const start = arrowheadToken((e as any).startArrowhead);
  if (start) lines.push(`startHead: ${start}`);
  const defaultEnd = kind === "line" ? null : "arrow";
  const endRaw = (e as any).endArrowhead;
  if (endRaw === null && defaultEnd !== null) {
    lines.push(`endHead:   none`);
  } else if (typeof endRaw === "string" && endRaw !== defaultEnd) {
    const tok = arrowheadToken(endRaw);
    if (tok) lines.push(`endHead:   ${tok}`);
  }
  return lines;
};

const sideFromFixedPoint = (
  fp: readonly [number, number] | undefined | null,
): "top" | "right" | "bottom" | "left" | null => {
  if (!fp) return null;
  const [x, y] = fp;
  if (y < 0) return "top";
  if (y > 1) return "bottom";
  if (x < 0) return "left";
  if (x > 1) return "right";
  return null;
};

const serializeEdge = (
  e: ExcalidrawLinearElement,
  from: string,
  to: string,
  op: "->" | "--" | "~>",
  label: string,
): string => {
  const kind: "arrow" | "line" | "elbow" =
    op === "--" ? "line" : op === "~>" ? "elbow" : "arrow";
  const lines: string[] = [];
  if (label) lines.push(`label:     "${escapeString(label)}"`);
  if (kind === "elbow") {
    const fs = sideFromFixedPoint(
      (e.startBinding as { fixedPoint?: [number, number] } | null)?.fixedPoint,
    );
    const ts = sideFromFixedPoint(
      (e.endBinding as { fixedPoint?: [number, number] } | null)?.fixedPoint,
    );
    if (fs) lines.push(`fromSide:  ${fs}`);
    if (ts) lines.push(`toSide:    ${ts}`);
  }
  lines.push(...linearStyleLines(e, kind));
  if (lines.length === 0) return `edge ${from} ${op} ${to}`;
  return `edge ${from} ${op} ${to} {\n${indent(lines.join("\n"))}\n}`;
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
  kind: "arrow" | "line" | "elbow",
  e: ExcalidrawLinearElement,
  label: string,
): string => {
  const pts = linearEndpoints(e);
  if (!pts) return "";
  const lines: string[] = [
    `from:      ${round(pts.fromX)}, ${round(pts.fromY)}`,
    `to:        ${round(pts.toX)}, ${round(pts.toY)}`,
  ];
  if (label && kind !== "line") {
    lines.push(`label:     "${escapeString(label)}"`);
  }
  lines.push(...linearStyleLines(e, kind));
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
    const isElbow = e.type === "arrow" && (e as any).elbowed === true;
    const fromId = linear.startBinding?.elementId;
    const toId = linear.endBinding?.elementId;
    const label = labelFor(e, byId);
    if (
      fromId && toId &&
      idMap.has(fromId) && idMap.has(toId)
    ) {
      const from = idMap.get(fromId)!;
      const to = idMap.get(toId)!;
      const op: "->" | "--" | "~>" =
        e.type === "line" ? "--" : isElbow ? "~>" : "->";
      edgeBlocks.push(serializeEdge(linear, from, to, op, label));
    } else {
      const kind: "arrow" | "line" | "elbow" =
        e.type === "line" ? "line" : isElbow ? "elbow" : "arrow";
      const block = serializeFreeLinear(kind, linear, label);
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

  const sections: { title: string; blocks: string[] }[] = [
    { title: "Nodes", blocks: nodeBlocks },
    { title: "Edges", blocks: edgeBlocks },
    { title: "Free shapes", blocks: freeBlocks },
    { title: "Text", blocks: textBlocks },
  ].filter((s) => s.blocks.length > 0);

  if (sections.length === 0) return "";

  const HEADER_RULE =
    "# ──────────────────────────────────────────────────────────";
  return sections
    .map(
      (s) =>
        `${HEADER_RULE}\n# ${s.title}\n${HEADER_RULE}\n\n${s.blocks.join("\n\n")}`,
    )
    .join("\n\n");
};
