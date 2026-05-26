import dagre from "dagre";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { updateElbowArrowPoints } from "@excalidraw/element";
import type {
  ExcalidrawElement,
  ExcalidrawElbowArrowElement,
  NonDeletedSceneElementsMap,
  Ordered,
} from "@excalidraw/element/types";

import type {
  Arrowhead,
  NodeShape,
  ParsedLinearStyle,
  ParseResult,
  StrokeStyle,
} from "./parser";

const DEFAULT_W = 180;
const DEFAULT_H = 80;
const STROKE_GAP = 4;

// Approximate glyph width @ font-size 20 in Excalidraw's Virgil/Cascadia
// font fallback. Used only to auto-grow nodes whose user-supplied label
// would otherwise overflow the default box. We don't measure precisely
// because we're not in a DOM here.
const CHAR_W = 11;
const LINE_H = 25;
const NODE_PAD_X = 28;
const NODE_PAD_Y = 24;

const measureLabel = (
  label: string | undefined,
  shape: NodeShape | undefined,
): { w: number; h: number } => {
  if (!label) return { w: DEFAULT_W, h: DEFAULT_H };
  const lines = label.split("\n");
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  let w = Math.max(DEFAULT_W, longest * CHAR_W + NODE_PAD_X * 2);
  let h = Math.max(DEFAULT_H, lines.length * LINE_H + NODE_PAD_Y * 2);
  // For a rhombus the inscribed axis-aligned rectangle has size W/√2 ×
  // H/√2. To fit a text rectangle of (w, h) inside the rhombus we need
  // a bbox of ≈ w·√2 × h·√2. We bump the vertical growth a bit more for
  // multi-line labels because Excalidraw centers the text vertically and
  // the outer lines clip into the diamond corners.
  if (shape === "diamond") {
    w = Math.round(w * 1.5);
    h = Math.round(h * (lines.length > 1 ? 1.7 : 1.5));
  } else if (shape === "ellipse") {
    // Ellipse: inscribed rectangle is w/√2 × h/√2 too. 1.25 keeps things
    // tight but readable for typical single-line labels.
    w = Math.round(w * 1.25);
    h = Math.round(h * (lines.length > 1 ? 1.35 : 1.25));
  }
  return { w, h };
};

// Approximate size of an edge label box used to reserve space in dagre's
// layout. Without this, edge labels are positioned at the midpoint of an
// edge by Excalidraw and frequently land on top of an adjacent node
// because dagre's ranksep doesn't know they exist.
const measureEdgeLabel = (
  label: string | undefined,
): { w: number; h: number } => {
  if (!label) return { w: 0, h: 0 };
  const lines = label.split("\n");
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  // Edge labels use Excalidraw's smaller bound-text font (~16px), so
  // glyph width ≈ 8px, line height ≈ 20px. Add generous padding.
  return {
    w: longest * 8 + 16,
    h: lines.length * 20 + 12,
  };
};

interface NodeBox {
  x: number;
  y: number;
  w: number;
  h: number;
  shape: NodeShape;
}

const STROKE_WIDTHS: ReadonlySet<number> = new Set([1, 2, 4]);
const ARROWHEAD_VALUES: Record<
  Arrowhead,
  "arrow" | "triangle" | "bar" | "dot" | null
> = {
  none: null,
  arrow: "arrow",
  triangle: "triangle",
  bar: "bar",
  dot: "dot",
};

const sanitizeStrokeWidth = (w: number | undefined): number | undefined =>
  w !== undefined && STROKE_WIDTHS.has(w) ? w : undefined;

const sanitizeRoughness = (r: number | undefined): number | undefined => {
  if (r === undefined) return undefined;
  if (r < 0) return 0;
  if (r > 2) return 2;
  return Math.round(r);
};

/**
 * Find the intersection of the ray from the center of `box` toward
 * `(ox, oy)` with the box boundary (rectangle / ellipse / diamond),
 * inflated by `gap` so the arrow tip sits a few pixels off the stroke.
 */
const clipToShape = (
  box: NodeBox,
  ox: number,
  oy: number,
  gap = 0,
): { x: number; y: number } => {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = ox - cx;
  const dy = oy - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const a = box.w / 2 + gap;
  const b = box.h / 2 + gap;
  let t: number;
  switch (box.shape) {
    case "ellipse": {
      const rx = dx / a;
      const ry = dy / b;
      t = 1 / Math.sqrt(rx * rx + ry * ry);
      break;
    }
    case "diamond": {
      t = 1 / (Math.abs(dx) / a + Math.abs(dy) / b);
      break;
    }
    case "rectangle":
    default: {
      const tx = a / Math.abs(dx || 1e-9);
      const ty = b / Math.abs(dy || 1e-9);
      t = Math.min(tx, ty);
      break;
    }
  }
  return { x: cx + dx * t, y: cy + dy * t };
};

const applyLinearStyleToSkel = (
  skel: Record<string, unknown>,
  style: ParsedLinearStyle,
  defaults: { endArrowhead: "default" | "none" },
): void => {
  if (style.strokeColor) skel.strokeColor = style.strokeColor;
  const sw = sanitizeStrokeWidth(style.strokeWidth);
  if (sw !== undefined) skel.strokeWidth = sw;
  if (style.strokeStyle) skel.strokeStyle = style.strokeStyle as StrokeStyle;
  const rough = sanitizeRoughness(style.roughness);
  if (rough !== undefined) skel.roughness = rough;
  if (style.startArrowhead) {
    skel.startArrowhead = ARROWHEAD_VALUES[style.startArrowhead];
  }
  if (style.endArrowhead) {
    skel.endArrowhead = ARROWHEAD_VALUES[style.endArrowhead];
  } else if (defaults.endArrowhead === "none") {
    skel.endArrowhead = null;
  }
};

/**
 * Build ExcalidrawElement[] from a parsed DSL.
 *
 * Layout strategy:
 * - If every node has explicit `at:` coordinates, no auto-layout runs.
 * - Otherwise dagre is used for all nodes; explicit positions still win.
 *
 * Edge geometry:
 * - For all bound edges (straight, elbow, line) we clip the polyline
 *   endpoints to the actual node border (rectangle/ellipse/diamond
 *   intersection) so the tip sits a few px off the stroke instead of
 *   piercing into the shape. Bindings stay on so dragging still works.
 * - Elbow arrows additionally get re-routed via Excalidraw's
 *   `updateElbowArrowPoints` after `convertToExcalidrawElements`.
 */
export const buildScene = (
  parsed: ParseResult,
): readonly ExcalidrawElement[] => {
  const needsAutoLayout = parsed.nodes.some(
    (n) => n.x === undefined || n.y === undefined,
  );

  const boxes = new Map<string, NodeBox>();

  if (needsAutoLayout && parsed.nodes.length > 0) {
    const g = new dagre.graphlib.Graph();
    g.setGraph({
      rankdir: "TB",
      nodesep: 80,
      ranksep: 110,
      edgesep: 30,
      marginx: 40,
      marginy: 40,
    });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of parsed.nodes) {
      const m = measureLabel(n.label, n.shape);
      g.setNode(n.id, {
        width: n.width ?? m.w,
        height: n.height ?? m.h,
      });
    }
    for (const e of parsed.edges) {
      if (!g.hasNode(e.from) || !g.hasNode(e.to)) continue;
      // Reserve space for edge labels so dagre keeps ranks far enough
      // apart that the label doesn't crash into the neighbour node.
      const lm = measureEdgeLabel(e.label);
      g.setEdge(e.from, e.to, lm.w && lm.h
        ? { width: lm.w, height: lm.h, labelpos: "c" }
        : {});
    }
    dagre.layout(g);
    for (const n of parsed.nodes) {
      const m = measureLabel(n.label, n.shape);
      const w = n.width ?? m.w;
      const h = n.height ?? m.h;
      if (n.x !== undefined && n.y !== undefined) {
        boxes.set(n.id, { x: n.x, y: n.y, w, h, shape: n.shape });
      } else {
        const p = g.node(n.id);
        boxes.set(n.id, {
          x: p.x - w / 2,
          y: p.y - h / 2,
          w,
          h,
          shape: n.shape,
        });
      }
    }
  } else {
    for (const n of parsed.nodes) {
      const m = measureLabel(n.label, n.shape);
      boxes.set(n.id, {
        x: n.x ?? 0,
        y: n.y ?? 0,
        w: n.width ?? m.w,
        h: n.height ?? m.h,
        shape: n.shape,
      });
    }
  }

  // Centre the auto-laid-out scene around (0, 0) so new code-driven
  // diagrams appear in the middle of the canvas (Excalidraw's default
  // viewport sits at the origin). We only shift when *every* node was
  // auto-positioned — as soon as the user pins anything with `at:`, all
  // coordinates are treated as absolute and left alone. Texts and free
  // arrows are shifted by the same offset so user-positioned labels
  // (e.g. titles) keep their relative position to the diagram.
  const allAutoPositioned = parsed.nodes.every(
    (n) => n.x === undefined || n.y === undefined,
  );
  let centerDx = 0;
  let centerDy = 0;
  if (allAutoPositioned && boxes.size > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const b of boxes.values()) {
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.w > maxX) maxX = b.x + b.w;
      if (b.y + b.h > maxY) maxY = b.y + b.h;
    }
    centerDx = -(minX + maxX) / 2;
    centerDy = -(minY + maxY) / 2;
    if (centerDx !== 0 || centerDy !== 0) {
      for (const [id, b] of boxes) {
        boxes.set(id, { ...b, x: b.x + centerDx, y: b.y + centerDy });
      }
    }
  }

  type Skel = Parameters<typeof convertToExcalidrawElements>[0][number];
  const skeleton: Skel[] = [];

  for (const n of parsed.nodes) {
    const p = boxes.get(n.id)!;
    const sw = sanitizeStrokeWidth(n.strokeWidth);
    const rough = sanitizeRoughness(n.roughness);
    const skel: Record<string, unknown> = {
      type: n.shape,
      id: n.id,
      x: p.x,
      y: p.y,
      width: p.w,
      height: p.h,
      strokeColor: n.strokeColor ?? "#1e1e1e",
      backgroundColor: n.backgroundColor ?? "transparent",
      fillStyle: "solid",
      label: { text: n.label || n.id },
    };
    if (sw !== undefined) skel.strokeWidth = sw;
    if (n.strokeStyle) skel.strokeStyle = n.strokeStyle;
    if (rough !== undefined) skel.roughness = rough;
    skeleton.push(skel as Skel);
  }

  // ─────────────────────────────────────────────────────────────────
  // Edge routing pre-pass: smart side selection + anchor distribution
  //
  // For every bound, straight-or-line, non-self-loop edge we pick the
  // cardinal side of `from` that faces `to` (and vice versa) using a
  // gap-aware heuristic that respects axis overlap. Then we group all
  // edges by `(nodeId, side)` and slide their anchors along the side so
  // that multiple arrows leaving / entering the same face never stack
  // on top of each other. Self-loops pick the least-used side instead
  // of always sitting on top.
  // ─────────────────────────────────────────────────────────────────
  type SideName = "top" | "right" | "bottom" | "left";
  const SIDES: readonly SideName[] = ["top", "right", "bottom", "left"];
  const sideAnchorCenter = (
    box: NodeBox,
    side: SideName,
  ): { x: number; y: number } => {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    switch (side) {
      case "top":    return { x: cx, y: box.y - STROKE_GAP };
      case "bottom": return { x: cx, y: box.y + box.h + STROKE_GAP };
      case "left":   return { x: box.x - STROKE_GAP, y: cy };
      case "right":  return { x: box.x + box.w + STROKE_GAP, y: cy };
    }
  };
  /**
   * Place the i-th anchor (of n total) along `side` of `box`.
   * Top / bottom spread horizontally; left / right spread vertically.
   * Indexes are 1-based-style: `i = 0..n-1` maps to fractions
   * `1/(n+1) .. n/(n+1)` so a single edge sits on the midpoint.
   */
  const sideAnchorAt = (
    box: NodeBox,
    side: SideName,
    i: number,
    n: number,
  ): { x: number; y: number } => {
    const frac = (i + 1) / (n + 1);
    // Keep anchors away from the box corners (rough/diamond shapes look
    // ugly when arrows tuck into a vertex). 18 px of inset works for
    // typical 80-100 px tall boxes.
    const inset = 18;
    const innerW = Math.max(0, box.w - inset * 2);
    const innerH = Math.max(0, box.h - inset * 2);
    switch (side) {
      case "top":
        return { x: box.x + inset + innerW * frac, y: box.y - STROKE_GAP };
      case "bottom":
        return {
          x: box.x + inset + innerW * frac,
          y: box.y + box.h + STROKE_GAP,
        };
      case "left":
        return { x: box.x - STROKE_GAP, y: box.y + inset + innerH * frac };
      case "right":
        return {
          x: box.x + box.w + STROKE_GAP,
          y: box.y + inset + innerH * frac,
        };
    }
  };
  /** Outward-pointing unit normal of a side (used for sort keys). */
  const sideNormal = (
    side: SideName,
  ): { dx: number; dy: number } => {
    switch (side) {
      case "top":    return { dx: 0, dy: -1 };
      case "bottom": return { dx: 0, dy: 1 };
      case "left":   return { dx: -1, dy: 0 };
      case "right":  return { dx: 1, dy: 0 };
    }
  };
  /**
   * Pick the cardinal side of `from` that faces `to`, normalized by the
   * box's aspect ratio (a "face-hit" decision — which face does the ray
   * from centre to other exit?). Used for free-positioned diagrams where
   * the user has explicit `at:` coordinates and no global flow direction.
   */
  const faceHit = (from: NodeBox, to: NodeBox): SideName => {
    // Prefer the horizontal face when the target box sits fully to the
    // right / left of the source box — this matches human intuition for
    // services-in-columns layouts where a slight vertical offset would
    // otherwise flip the anchor onto the top/bottom face.
    if (to.x >= from.x + from.w) return "right";
    if (to.x + to.w <= from.x) return "left";
    if (to.y >= from.y + from.h) return "bottom";
    if (to.y + to.h <= from.y) return "top";
    // Boxes overlap on both axes — fall back to aspect-ratio normalised angle.
    const dx = (to.x + to.w / 2) - (from.x + from.w / 2);
    const dy = (to.y + to.h / 2) - (from.y + from.h / 2);
    const hw = Math.max(1, from.w / 2);
    const hh = Math.max(1, from.h / 2);
    if (Math.abs(dx) / hw > Math.abs(dy) / hh) {
      return dx >= 0 ? "right" : "left";
    }
    return dy >= 0 ? "bottom" : "top";
  };
  /**
   * Pick the from/to side pair for an edge.
   *
   * Decision tree:
   *  1. Under TB auto-layout the flow direction is vertical by construction.
   *     A forward edge (target's top strictly below source's bottom) ALWAYS
   *     exits the source's `bottom` and enters the target's `top`. This is
   *     the convention every human draws for top-down trees / flowcharts,
   *     and the per-side distribution keeps fan-outs visually clean.
   *  2. Same-rank auto-layout edges (y-ranges overlap) use horizontal sides.
   *  3. Pinned diagrams fall back to per-end `faceHit`, which lets sideways
   *     dense column graphs (e.g. the boss diagram) exit through the side
   *     facing the target instead of always going down.
   */
  const chooseSides = (
    from: NodeBox,
    to: NodeBox,
  ): { fromSide: SideName; toSide: SideName } => {
    if (needsAutoLayout) {
      const tBelow = to.y >= from.y + from.h;
      const tAbove = to.y + to.h <= from.y;
      if (tBelow) return { fromSide: "bottom", toSide: "top" };
      if (tAbove) return { fromSide: "top", toSide: "bottom" };
      const dx = (to.x + to.w / 2) - (from.x + from.w / 2);
      return dx >= 0
        ? { fromSide: "right", toSide: "left" }
        : { fromSide: "left", toSide: "right" };
    }
    return { fromSide: faceHit(from, to), toSide: faceHit(to, from) };
  };

  // Pre-compute desired sides for each edge so we can do per-side
  // distribution afterwards. Elbow edges, self-loops and back-edges
  // are handled separately further down and don't participate here.
  interface EdgePlan {
    fromSide: SideName;
    toSide: SideName;
    fromAnchor: { x: number; y: number };
    toAnchor: { x: number; y: number };
  }
  const edgePlans: (EdgePlan | undefined)[] = new Array(parsed.edges.length);
  // Per (nodeId, side) → list of edges anchored to it, each tagged with
  // the *other* endpoint's centre so we can sort the entries naturally.
  interface UsageEntry {
    edgeIdx: number;
    endpoint: "from" | "to";
    otherCx: number;
    otherCy: number;
  }
  const usage = new Map<string, UsageEntry[]>();
  const usageKey = (id: string, side: SideName): string => `${id}\u0000${side}`;

  for (let i = 0; i < parsed.edges.length; i++) {
    const e = parsed.edges[i];
    if (e.kind === "elbow") continue;
    if (e.from === e.to) continue;
    const fb = boxes.get(e.from);
    const tb = boxes.get(e.to);
    if (!fb || !tb) continue;
    // Back-edges (target above source in auto-layout) use the existing
    // detour routing, not the smart anchor logic.
    if (needsAutoLayout && tb.y + tb.h <= fb.y) continue;
    const sides = chooseSides(fb, tb);
    const fromSide: SideName = e.fromSide ?? sides.fromSide;
    const toSide: SideName = e.toSide ?? sides.toSide;
    edgePlans[i] = {
      fromSide,
      toSide,
      fromAnchor: sideAnchorCenter(fb, fromSide),
      toAnchor: sideAnchorCenter(tb, toSide),
    };
    const fbCx = fb.x + fb.w / 2;
    const fbCy = fb.y + fb.h / 2;
    const tbCx = tb.x + tb.w / 2;
    const tbCy = tb.y + tb.h / 2;
    const kf = usageKey(e.from, fromSide);
    const kt = usageKey(e.to, toSide);
    (usage.get(kf) ?? usage.set(kf, []).get(kf)!).push({
      edgeIdx: i,
      endpoint: "from",
      otherCx: tbCx,
      otherCy: tbCy,
    });
    (usage.get(kt) ?? usage.set(kt, []).get(kt)!).push({
      edgeIdx: i,
      endpoint: "to",
      otherCx: fbCx,
      otherCy: fbCy,
    });
  }

  // Second pre-pass: back-edges. Each is routed through the right gutter,
  // but multiple back-edges sharing a target / overlapping bands would
  // collide (same bus y, same detour x, same target anchor). Stagger them
  // so each gets its own riser and the target entry points spread along
  // the right side. We also mark source.right + target.right as "used"
  // in the usage map so self-loops know to pick a different side.
  interface BackEdgeRoute {
    busY: number;
    detourX: number;
    sourceAnchor: { x: number; y: number };
    targetAnchor: { x: number; y: number };
  }
  const backEdgeRoutes: (BackEdgeRoute | undefined)[] = new Array(
    parsed.edges.length,
  );
  // First pass: collect back-edges per target (for entry distribution).
  const backEdgesByTarget = new Map<string, number[]>();
  const isBackEdgeIdx: boolean[] = new Array(parsed.edges.length).fill(false);
  for (let i = 0; i < parsed.edges.length; i++) {
    const e = parsed.edges[i];
    if (e.kind === "elbow") continue;
    if (e.from === e.to) continue;
    const fb = boxes.get(e.from);
    const tb = boxes.get(e.to);
    if (!fb || !tb) continue;
    if (!(needsAutoLayout && tb.y + tb.h <= fb.y)) continue;
    isBackEdgeIdx[i] = true;
    const list = backEdgesByTarget.get(e.to) ?? [];
    list.push(i);
    backEdgesByTarget.set(e.to, list);
    // Reserve right side on both endpoints so self-loops avoid it.
    const krf = usageKey(e.from, "right");
    const krt = usageKey(e.to, "right");
    (usage.get(krf) ?? usage.set(krf, []).get(krf)!).push({
      edgeIdx: i,
      endpoint: "from",
      otherCx: tb.x + tb.w / 2,
      otherCy: tb.y + tb.h / 2,
    });
    (usage.get(krt) ?? usage.set(krt, []).get(krt)!).push({
      edgeIdx: i,
      endpoint: "to",
      otherCx: fb.x + fb.w / 2,
      otherCy: fb.y + fb.h / 2,
    });
  }
  // Second pass: compute staggered routes per back-edge.
  let backEdgeOrder = 0;
  for (const [targetId, idxList] of backEdgesByTarget) {
    const tb = boxes.get(targetId);
    if (!tb) continue;
    // Sort entries by source y (top-most source enters higher on right side).
    idxList.sort((a, b) => {
      const sa = boxes.get(parsed.edges[a].from);
      const sb = boxes.get(parsed.edges[b].from);
      return (sa?.y ?? 0) - (sb?.y ?? 0);
    });
    for (let k = 0; k < idxList.length; k++) {
      const idx = idxList[k];
      const e = parsed.edges[idx];
      const fb = boxes.get(e.from)!;
      const bandTop = Math.min(tb.y, fb.y) - 8;
      const bandBot = Math.max(tb.y + tb.h, fb.y + fb.h);
      let detourX = Math.max(fb.x + fb.w, tb.x + tb.w) + 40;
      let busY = bandBot + 36;
      for (const other of boxes.values()) {
        if (other === fb || other === tb) continue;
        const overlapsBand = !(
          other.y + other.h < bandTop || other.y > bandBot + 80
        );
        if (!overlapsBand) continue;
        if (other.x + other.w + 40 > detourX) {
          detourX = other.x + other.w + 40;
        }
        if (other.y + other.h + 36 > busY) {
          busY = other.y + other.h + 36;
        }
      }
      // Stagger this back-edge's riser & bus so it doesn't collide with
      // siblings entering the same target or others sharing the gutter.
      // Outer (later) edges sit further out / lower.
      const lane = backEdgeOrder++;
      detourX += lane * 18;
      busY += lane * 14;
      // Distribute the target entry along its right side.
      const targetAnchor = sideAnchorAt(tb, "right", k, idxList.length);
      const sourceAnchor = {
        x: fb.x + fb.w / 2,
        y: fb.y + fb.h + STROKE_GAP,
      };
      backEdgeRoutes[idx] = {
        busY,
        detourX,
        sourceAnchor,
        targetAnchor,
      };
    }
  }

  // Distribute: for every side that has more than one anchor, sort the
  // entries by the "natural" order along that side (horizontally for
  // top/bottom, vertically for left/right) and slide each anchor along
  // the side so they don't stack on the midpoint.
  for (const [key, entries] of usage) {
    if (entries.length <= 1) continue;
    const sepIdx = key.indexOf("\u0000");
    const nodeId = key.slice(0, sepIdx);
    const side = key.slice(sepIdx + 1) as SideName;
    const box = boxes.get(nodeId);
    if (!box) continue;
    const horizontal = side === "top" || side === "bottom";
    entries.sort((a, b) =>
      horizontal ? a.otherCx - b.otherCx : a.otherCy - b.otherCy,
    );
    for (let k = 0; k < entries.length; k++) {
      const en = entries[k];
      const anchor = sideAnchorAt(box, side, k, entries.length);
      const plan = edgePlans[en.edgeIdx];
      if (!plan) continue;
      if (en.endpoint === "from") plan.fromAnchor = anchor;
      else plan.toAnchor = anchor;
    }
  }

  for (let edgeIdx = 0; edgeIdx < parsed.edges.length; edgeIdx++) {
    const e = parsed.edges[edgeIdx];
    const fromBox = boxes.get(e.from);
    const toBox = boxes.get(e.to);
    const isElbow = e.kind === "elbow";
    const isLine = e.kind === "line";
    const type: "arrow" | "line" = isLine ? "line" : "arrow";

    if (fromBox && toBox) {
      // Self-loop: Excalidraw can't auto-route start==end on the same
      // node, so emit an unbound polyline that arcs above the node.
      if (e.from === e.to) {
        // Pick a side with little / no other edge traffic so the loop
        // doesn't collide with the regular arrows. Default order
        // prefers top → right → bottom → left.
        const candidates: SideName[] = e.fromSide
          ? [e.fromSide]
          : (["top", "right", "bottom", "left"] as SideName[]);
        let chosenSide: SideName = candidates[0];
        let bestLoad = Infinity;
        for (const s of candidates) {
          const load = (usage.get(usageKey(e.from, s)) ?? []).length;
          if (load < bestLoad) {
            bestLoad = load;
            chosenSide = s;
          }
        }
        const loopExtent = 40;
        const buildLoop = (side: SideName): {
          sx: number;
          sy: number;
          pts: [number, number][];
          labelX: number;
          labelY: number;
        } => {
          const half = (side === "top" || side === "bottom"
            ? fromBox.w
            : fromBox.h) * 0.3;
          if (side === "top") {
            const sx = fromBox.x + fromBox.w * 0.35;
            const sy = fromBox.y - STROKE_GAP;
            return {
              sx, sy,
              pts: [[0, 0], [0, -loopExtent], [half, -loopExtent], [half, 0]],
              labelX: sx + half / 2,
              labelY: sy - loopExtent - 22,
            };
          }
          if (side === "bottom") {
            const sx = fromBox.x + fromBox.w * 0.35;
            const sy = fromBox.y + fromBox.h + STROKE_GAP;
            return {
              sx, sy,
              pts: [[0, 0], [0, loopExtent], [half, loopExtent], [half, 0]],
              labelX: sx + half / 2,
              labelY: sy + loopExtent + 6,
            };
          }
          if (side === "right") {
            const sx = fromBox.x + fromBox.w + STROKE_GAP;
            const sy = fromBox.y + fromBox.h * 0.35;
            return {
              sx, sy,
              pts: [[0, 0], [loopExtent, 0], [loopExtent, half], [0, half]],
              labelX: sx + loopExtent + 6,
              labelY: sy + half / 2 - 10,
            };
          }
          // left
          const sx = fromBox.x - STROKE_GAP;
          const sy = fromBox.y + fromBox.h * 0.35;
          return {
            sx, sy,
            pts: [[0, 0], [-loopExtent, 0], [-loopExtent, half], [0, half]],
            labelX: sx - loopExtent - 6 - (e.label?.length ?? 0) * 8,
            labelY: sy + half / 2 - 10,
          };
        };
        const built = buildLoop(chosenSide);
        const skel: Record<string, unknown> = {
          type,
          x: built.sx,
          y: built.sy,
          points: built.pts,
          strokeColor: "#1e1e1e",
        };
        if (e.label) {
          skeleton.push({
            type: "text",
            x: built.labelX - (e.label.length * 5),
            y: built.labelY,
            text: e.label,
            fontSize: 16,
          } as Skel);
        }
        applyLinearStyleToSkel(skel, e, {
          endArrowhead: isLine ? "none" : "default",
        });
        skeleton.push(skel as Skel);
        continue;
      }
      const fcx = fromBox.x + fromBox.w / 2;
      const fcy = fromBox.y + fromBox.h / 2;
      const tcx = toBox.x + toBox.w / 2;
      const tcy = toBox.y + toBox.h / 2;

      // Elbow arrows: anchor on a *cardinal* border midpoint (top / right /
      // bottom / left) of each bound box, with a small outside gap. The
      // user may override per side via `fromSide:` / `toSide:`; otherwise
      // we pick the dominant axis (vertical vs. horizontal) automatically.
      // `convertToExcalidrawElements` derives an outside `fixedPoint`
      // (e.g. [0.5, 1.05]) so Excalidraw's elbow router leaves and enters
      // the boxes perpendicularly — producing real L-routes whose tips
      // rest on the border, not in the centre of the box.
      // Straight arrows / lines clip to the closest border edge.
      const sideAnchor = (
        box: NodeBox,
        side: "top" | "right" | "bottom" | "left",
      ): { x: number; y: number } => {
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        switch (side) {
          case "top":    return { x: cx, y: box.y - STROKE_GAP };
          case "bottom": return { x: cx, y: box.y + box.h + STROKE_GAP };
          case "left":   return { x: box.x - STROKE_GAP, y: cy };
          case "right":  return { x: box.x + box.w + STROKE_GAP, y: cy };
        }
      };
      let start: { x: number; y: number };
      let end: { x: number; y: number };
      // Back-edge in auto-layout: target sits above the source. Routing a
      // straight arrow would cut through any nodes ranked between them.
      // Re-route around the right side as a 3-segment unbound polyline.
      const isBackEdge =
        !isElbow &&
        needsAutoLayout &&
        toBox.y + toBox.h <= fromBox.y &&
        e.from !== e.to;
      if (isBackEdge) {
        const route = backEdgeRoutes[edgeIdx];
        const endAnchor = route?.targetAnchor ?? sideAnchor(toBox, "right");
        const sx = route?.sourceAnchor.x ?? (fromBox.x + fromBox.w / 2);
        const sy = route?.sourceAnchor.y ?? (fromBox.y + fromBox.h + STROKE_GAP);
        const busY = route?.busY ?? (fromBox.y + fromBox.h + 36);
        const detourX =
          route?.detourX ??
          Math.max(fromBox.x + fromBox.w, toBox.x + toBox.w) + 40;
        const skel: Record<string, unknown> = {
          type,
          x: sx,
          y: sy,
          points: [
            [0, 0],
            [0, busY - sy],
            [detourX - sx, busY - sy],
            [detourX - sx, endAnchor.y - sy],
            [endAnchor.x - sx, endAnchor.y - sy],
          ],
          strokeColor: "#1e1e1e",
        };
        if (e.label) {
          skeleton.push({
            type: "text",
            x: detourX + 6,
            y: (busY + endAnchor.y) / 2 - 10,
            text: e.label,
            fontSize: 16,
          } as Skel);
        }
        applyLinearStyleToSkel(skel, e, {
          endArrowhead: isLine ? "none" : "default",
        });
        skeleton.push(skel as Skel);
        continue;
      }
      if (isElbow) {
        const dx = tcx - fcx;
        const dy = tcy - fcy;
        const autoFromSide: "top" | "right" | "bottom" | "left" =
          Math.abs(dy) >= Math.abs(dx)
            ? dy >= 0 ? "bottom" : "top"
            : dx >= 0 ? "right" : "left";
        const autoToSide: "top" | "right" | "bottom" | "left" =
          Math.abs(dy) >= Math.abs(dx)
            ? dy >= 0 ? "top" : "bottom"
            : dx >= 0 ? "left" : "right";
        start = sideAnchor(fromBox, e.fromSide ?? autoFromSide);
        end = sideAnchor(toBox, e.toSide ?? autoToSide);
      } else {
        const plan = edgePlans[edgeIdx];
        if (plan) {
          start = plan.fromAnchor;
          end = plan.toAnchor;
        } else {
          start = clipToShape(fromBox, tcx, tcy, STROKE_GAP);
          end = clipToShape(toBox, fcx, fcy, STROKE_GAP);
        }
      }
      const sx = start.x;
      const sy = start.y;
      const ex = end.x;
      const ey = end.y;

      const skel: Record<string, unknown> = {
        type,
        x: sx,
        y: sy,
        width: ex - sx,
        height: ey - sy,
        points: [
          [0, 0],
          [ex - sx, ey - sy],
        ],
        strokeColor: "#1e1e1e",
        start: { id: e.from },
        end: { id: e.to },
      };
      if (isElbow) {
        skel.elbowed = true;
        skel.roundness = null;
      }
      // Excalidraw drops `boundElements` labels on `line` type; emit a
      // free text element above the segment midpoint so the label still shows.
      if (e.label) {
        if (isLine) {
          skeleton.push({
            type: "text",
            x: (sx + ex) / 2 - e.label.length * 4,
            y: (sy + ey) / 2 - 22,
            text: e.label,
            fontSize: 16,
          } as Skel);
        } else {
          skel.label = { text: e.label };
        }
      }
      applyLinearStyleToSkel(skel, e, {
        endArrowhead: isLine ? "none" : "default",
      });
      skeleton.push(skel as Skel);
    } else {
      const skel: Record<string, unknown> = {
        type,
        x: 0,
        y: 0,
        strokeColor: "#1e1e1e",
        start: { id: e.from },
        end: { id: e.to },
      };
      if (isElbow) {
        skel.elbowed = true;
        skel.roundness = null;
      }
      if (e.label && !isLine) skel.label = { text: e.label };
      applyLinearStyleToSkel(skel, e, {
        endArrowhead: isLine ? "none" : "default",
      });
      skeleton.push(skel as Skel);
    }
  }

  for (const a of parsed.freeArrows) {
    const isElbow = a.kind === "elbow";
    const isLine = a.kind === "line";
    const type: "arrow" | "line" = isLine ? "line" : "arrow";
    // Shift with the auto-centering offset so absolute coordinates stay
    // relative to the diagram (otherwise free arrows defined alongside
    // auto-laid-out nodes end up far off-canvas).
    const fromX = a.fromX + centerDx;
    const fromY = a.fromY + centerDy;
    const toX = a.toX + centerDx;
    const toY = a.toY + centerDy;
    const skel: Record<string, unknown> = {
      type,
      x: fromX,
      y: fromY,
      points: [
        [0, 0],
        [toX - fromX, toY - fromY],
      ],
      strokeColor: "#1e1e1e",
    };
    if (isElbow) {
      skel.elbowed = true;
      skel.roundness = null;
    }
    if (a.label) {
      if (isLine) {
        skeleton.push({
          type: "text",
          x: (fromX + toX) / 2 - a.label.length * 4,
          y: (fromY + toY) / 2 - 22,
          text: a.label,
          fontSize: 16,
        } as Skel);
      } else {
        skel.label = { text: a.label };
      }
    }
    applyLinearStyleToSkel(skel, a, {
      endArrowhead: isLine ? "none" : "default",
    });
    skeleton.push(skel as Skel);
  }

  const allXs = [...boxes.values()].map((p) => p.x);
  const allYs = [...boxes.values()].map((p) => p.y + p.h);
  const baseX = allXs.length ? Math.min(...allXs) : 0;
  const baseY = allYs.length ? Math.max(...allYs) + 40 : 0;
  let cursor = 0;
  for (const t of parsed.texts) {
    // When the diagram was auto-centered around (0, 0), shift user-pinned
    // text positions by the same offset so titles / annotations keep
    // their relative position to the diagram.
    const userX = t.x !== undefined ? t.x + centerDx : undefined;
    const userY = t.y !== undefined ? t.y + centerDy : undefined;
    const x = userX ?? baseX;
    const y = userY ?? baseY + cursor * 32;
    if (t.y === undefined) cursor++;
    skeleton.push({
      type: "text",
      x,
      y,
      text: t.text,
      fontSize: t.fontSize ?? 20,
    } as Skel);
  }

  const converted = convertToExcalidrawElements(skeleton, {
    regenerateIds: false,
  });

  const elementsMap = new Map(
    converted.map((e) => [e.id, e as Ordered<ExcalidrawElement>]),
  ) as unknown as NonDeletedSceneElementsMap;
  return converted.map((el) => {
    if (el.type !== "arrow" || !(el as ExcalidrawElbowArrowElement).elbowed) {
      return el;
    }
    const arrow = el as ExcalidrawElbowArrowElement;
    try {
      const update = updateElbowArrowPoints(arrow, elementsMap, {
        points: arrow.points,
      });
      return { ...arrow, ...update };
    } catch {
      return el;
    }
  });
};
