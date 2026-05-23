import dagre from "dagre";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { ParseResult } from "./parser";

const DEFAULT_W = 180;
const DEFAULT_H = 80;

/**
 * Build ExcalidrawElement[] from a parsed DSL.
 *
 * Layout strategy:
 * - If every node has explicit `at:` coordinates, no auto-layout runs.
 * - Otherwise dagre is used for all nodes; explicit positions still win.
 */
export const buildScene = (
  parsed: ParseResult,
): readonly ExcalidrawElement[] => {
  const needsAutoLayout = parsed.nodes.some(
    (n) => n.x === undefined || n.y === undefined,
  );

  const positions = new Map<
    string,
    { x: number; y: number; w: number; h: number }
  >();

  if (needsAutoLayout && parsed.nodes.length > 0) {
    const g = new dagre.graphlib.Graph();
    g.setGraph({
      rankdir: "TB",
      nodesep: 60,
      ranksep: 80,
      marginx: 40,
      marginy: 40,
    });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of parsed.nodes) {
      g.setNode(n.id, {
        width: n.width ?? DEFAULT_W,
        height: n.height ?? DEFAULT_H,
      });
    }
    for (const e of parsed.edges) {
      if (g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.from, e.to);
    }
    dagre.layout(g);
    for (const n of parsed.nodes) {
      const w = n.width ?? DEFAULT_W;
      const h = n.height ?? DEFAULT_H;
      if (n.x !== undefined && n.y !== undefined) {
        positions.set(n.id, { x: n.x, y: n.y, w, h });
      } else {
        const p = g.node(n.id);
        positions.set(n.id, { x: p.x - w / 2, y: p.y - h / 2, w, h });
      }
    }
  } else {
    for (const n of parsed.nodes) {
      positions.set(n.id, {
        x: n.x ?? 0,
        y: n.y ?? 0,
        w: n.width ?? DEFAULT_W,
        h: n.height ?? DEFAULT_H,
      });
    }
  }

  type Skel = Parameters<typeof convertToExcalidrawElements>[0][number];
  const skeleton: Skel[] = [];

  for (const n of parsed.nodes) {
    const p = positions.get(n.id)!;
    skeleton.push({
      type: n.shape,
      id: n.id,
      x: p.x,
      y: p.y,
      width: p.w,
      height: p.h,
      strokeColor: n.strokeColor ?? "#1e1e1e",
      backgroundColor: n.backgroundColor ?? "transparent",
      fillStyle: n.backgroundColor ? "hachure" : "solid",
      label: { text: n.label || n.id },
    } as Skel);
  }

  for (const e of parsed.edges) {
    skeleton.push({
      type: e.kind,
      x: 0,
      y: 0,
      strokeColor: "#1e1e1e",
      start: { id: e.from },
      end: { id: e.to },
      ...(e.label ? { label: { text: e.label } } : {}),
    } as Skel);
  }

  for (const a of parsed.freeArrows) {
    skeleton.push({
      type: a.kind,
      x: a.fromX,
      y: a.fromY,
      points: [
        [0, 0],
        [a.toX - a.fromX, a.toY - a.fromY],
      ],
      strokeColor: "#1e1e1e",
      ...(a.label ? { label: { text: a.label } } : {}),
    } as Skel);
  }

  // Text without explicit position: stack below the node bounding box.
  const allXs = [...positions.values()].map((p) => p.x);
  const allYs = [...positions.values()].map((p) => p.y + p.h);
  const baseX = allXs.length ? Math.min(...allXs) : 0;
  const baseY = allYs.length ? Math.max(...allYs) + 40 : 0;
  let cursor = 0;
  for (const t of parsed.texts) {
    const x = t.x ?? baseX;
    const y = t.y ?? baseY + cursor * 32;
    if (t.y === undefined) cursor++;
    skeleton.push({
      type: "text",
      x,
      y,
      text: t.text,
      fontSize: t.fontSize ?? 20,
    } as Skel);
  }

  return convertToExcalidrawElements(skeleton, { regenerateIds: false });
};
