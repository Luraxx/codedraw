import dagre from "dagre";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { ParseResult, ParsedNode } from "./parser";

const NODE_WIDTH = 180;
const NODE_HEIGHT = 80;
const TEXT_WIDTH = 240;
const TEXT_HEIGHT = 24;

const nodeSize = (n: ParsedNode) => ({ width: NODE_WIDTH, height: NODE_HEIGHT });

/**
 * Build a deterministic ExcalidrawElement[] from a parsed DSL.
 * Uses dagre for hierarchical layout, then hands off to Excalidraw's
 * `convertToExcalidrawElements` which resolves the arrow bindings.
 */
export const buildScene = (parsed: ParseResult): readonly ExcalidrawElement[] => {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 80, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of parsed.nodes) {
    g.setNode(n.id, nodeSize(n));
  }
  for (const e of parsed.edges) {
    if (g.hasNode(e.from) && g.hasNode(e.to)) {
      g.setEdge(e.from, e.to);
    }
  }
  dagre.layout(g);

  type Skel = Parameters<typeof convertToExcalidrawElements>[0][number];
  const skeleton: Skel[] = [];

  for (const n of parsed.nodes) {
    const pos = g.node(n.id);
    if (!pos) continue;
    skeleton.push({
      type: n.shape,
      id: n.id,
      x: pos.x - NODE_WIDTH / 2,
      y: pos.y - NODE_HEIGHT / 2,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
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

  // Stand-alone text lines arranged in a column below the graph.
  if (parsed.texts.length > 0) {
    const graphBounds = g.graph();
    const baseY = (graphBounds.height ?? 0) + 40;
    parsed.texts.forEach((t, i) => {
      skeleton.push({
        type: "text",
        x: 0,
        y: baseY + i * (TEXT_HEIGHT + 8),
        width: TEXT_WIDTH,
        height: TEXT_HEIGHT,
        text: t.text,
        fontSize: 20,
      } as Skel);
    });
  }

  return convertToExcalidrawElements(skeleton, { regenerateIds: false });
};
