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

/**
 * Returns true when the (open) segment from `(x1,y1)` to `(x2,y2)`
 * intersects the interior of `box` (slightly deflated so endpoints
 * sitting exactly on a box boundary do not count as crossings).
 */
const segmentCrossesBox = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  box: NodeBox,
): boolean => {
  const pad = 2;
  const minX = box.x + pad;
  const maxX = box.x + box.w - pad;
  const minY = box.y + pad;
  const maxY = box.y + box.h - pad;
  const dx = x2 - x1;
  const dy = y2 - y1;
  let tEnter = 0;
  let tExit = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > tExit) return false;
      if (t > tEnter) tEnter = t;
    } else {
      if (t < tEnter) return false;
      if (t < tExit) tExit = t;
    }
    return true;
  };
  if (!clip(-dx, x1 - minX)) return false;
  if (!clip(dx, maxX - x1)) return false;
  if (!clip(-dy, y1 - minY)) return false;
  if (!clip(dy, maxY - y1)) return false;
  return tExit > tEnter && tEnter < 1 && tExit > 0;
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
  // Captured by the auto-layout pass: dagre's routed waypoints for each
  // edge that spans more than one rank. Used to detour around real nodes
  // sitting in the same column as a long-edge endpoint.
  const dagrePts = new Map<string, { x: number; y: number }[]>();

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
    for (const e of parsed.edges) {
      if (!g.hasNode(e.from) || !g.hasNode(e.to)) continue;
      const ge = g.edge(e.from, e.to) as { points?: { x: number; y: number }[] } | undefined;
      if (ge?.points && ge.points.length >= 2) {
        dagrePts.set(`${e.from}->${e.to}`, ge.points.map((p) => ({ x: p.x, y: p.y })));
      }
    }
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
      for (const [k, pts] of dagrePts) {
        dagrePts.set(
          k,
          pts.map((p) => ({ x: p.x + centerDx, y: p.y + centerDy })),
        );
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

  // Pre-compute a lane index for each back-edge so that several
  // simultaneously back-routed edges don't stack their vertical
  // detour segments (and their labels) on top of each other. Lanes
  // are assigned by the rightmost x of the wider of {from,to} box, so
  // edges that originate further right get an outer lane.
  const backEdgeLane = new Map<number, number>();
  if (needsAutoLayout) {
    const candidates: { idx: number; rightX: number }[] = [];
    parsed.edges.forEach((e, idx) => {
      if (e.kind === "elbow") return;
      if (e.from === e.to) return;
      const f = boxes.get(e.from);
      const t = boxes.get(e.to);
      if (!f || !t) return;
      if (t.y + t.h <= f.y) {
        candidates.push({ idx, rightX: Math.max(f.x + f.w, t.x + t.w) });
      }
    });
    // Inner lane = leftmost rightX, so edges that already start far
    // right end up on the outermost lane.
    candidates.sort((a, b) => a.rightX - b.rightX);
    candidates.forEach((c, i) => backEdgeLane.set(c.idx, i));
  }

  let edgeIndex = -1;
  for (const e of parsed.edges) {
    edgeIndex++;
    const fromBox = boxes.get(e.from);
    const toBox = boxes.get(e.to);
    const isElbow = e.kind === "elbow";
    const isLine = e.kind === "line";
    const type: "arrow" | "line" = isLine ? "line" : "arrow";

    if (fromBox && toBox) {
      // Self-loop: Excalidraw can't auto-route start==end on the same
      // node, so emit an unbound polyline that arcs above the node.
      if (e.from === e.to) {
        const sx = fromBox.x + fromBox.w * 0.35;
        const sy = fromBox.y - STROKE_GAP;
        const loopH = 40;
        const loopW = fromBox.w * 0.3;
        const skel: Record<string, unknown> = {
          type,
          x: sx,
          y: sy,
          points: [
            [0, 0],
            [0, -loopH],
            [loopW, -loopH],
            [loopW, 0],
          ],
          strokeColor: "#1e1e1e",
        };
        if (isElbow) {
          // Elbow router with manual points: keep as plain polyline.
        }
        if (e.label) {
          skeleton.push({
            type: "text",
            x: sx + loopW / 2 - (e.label.length * 5),
            y: sy - loopH - 22,
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
      let waypoints: { x: number; y: number }[] | undefined;
      // Back-edge in auto-layout: target sits above the source. Routing a
      // straight arrow would cut through any nodes ranked between them.
      // Re-route around the right side as a 3-segment unbound polyline.
      const isBackEdge =
        !isElbow &&
        needsAutoLayout &&
        toBox.y + toBox.h <= fromBox.y &&
        e.from !== e.to;
      if (isBackEdge) {
        const lane = backEdgeLane.get(edgeIndex) ?? 0;
        // Detour around ALL boxes — not just from/to — so the
        // horizontal segments don't cut through unrelated nodes that
        // happen to share a rank with from or to.
        let maxRight = 0;
        let maxBottom = 0;
        for (const b of boxes.values()) {
          if (b.x + b.w > maxRight) maxRight = b.x + b.w;
          if (b.y + b.h > maxBottom) maxBottom = b.y + b.h;
        }
        const detourX = maxRight + 48 + lane * 40;
        const yBelow = maxBottom + 30 + lane * 16;
        const startAnchor = sideAnchor(fromBox, "bottom");
        const endAnchor = sideAnchor(toBox, "top");
        // Lift the entry into toBox into the inter-rank gap so the
        // left-traveling segment doesn't shave the top of toBox's row.
        const yLift = endAnchor.y - 30 - lane * 14;
        const sx = startAnchor.x;
        const sy = startAnchor.y;
        const skel: Record<string, unknown> = {
          type,
          x: sx,
          y: sy,
          points: [
            [0, 0],
            [0, yBelow - sy],
            [detourX - sx, yBelow - sy],
            [detourX - sx, yLift - sy],
            [endAnchor.x - sx, yLift - sy],
            [endAnchor.x - sx, endAnchor.y - sy],
          ],
          strokeColor: "#1e1e1e",
        };
        if (e.label) {
          // Center label on the vertical detour, staggered per lane
          // so multiple back-edges never overlap.
          const lines = e.label.split("\n");
          const labelW = lines.reduce((m, l) => Math.max(m, l.length), 0) * 8;
          skeleton.push({
            type: "text",
            x: detourX - labelW - 10,
            y: (yBelow + yLift) / 2 - 10 + (lane % 2 === 0 ? 0 : 14),
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
        // In an auto-laid-out scene, ranks flow top-to-bottom, so when
        // the target sits in a downstream rank prefer entering from
        // its TOP (and exiting from the source's BOTTOM). This gives
        // clean perpendicular arrowheads on wide fan-outs / fan-ins
        // where the closest-edge clip would otherwise hit a side.
        const downstream =
          needsAutoLayout && toBox.y >= fromBox.y + fromBox.h + 8;
        if (downstream) {
          start = sideAnchor(fromBox, "bottom");
          end = sideAnchor(toBox, "top");
          // If the straight line would cut through any unrelated node,
          // try to detour via dagre's routed waypoints (which were
          // computed to minimise crossings during ordering).
          let crosses = false;
          for (const [id, b] of boxes) {
            if (id === e.from || id === e.to) continue;
            if (segmentCrossesBox(start.x, start.y, end.x, end.y, b)) {
              crosses = true;
              break;
            }
          }
          if (crosses) {
            const pts = dagrePts.get(`${e.from}->${e.to}`);
            if (pts && pts.length >= 3) {
              // dagre's first/last point sit near the source/target
              // centres; we keep our own anchor clips on the boundary
              // and inject the intermediate waypoints in between.
              waypoints = pts.slice(1, -1);
              // If any waypoint still lands inside another box, shove
              // it sideways to the nearest column gap.
              for (let i = 0; i < waypoints.length; i++) {
                const wp = waypoints[i];
                for (const [id, b] of boxes) {
                  if (id === e.from || id === e.to) continue;
                  if (
                    wp.x > b.x - 4 &&
                    wp.x < b.x + b.w + 4 &&
                    wp.y > b.y - 4 &&
                    wp.y < b.y + b.h + 4
                  ) {
                    // Pick the closer side of `b` and push past it.
                    const leftGap = wp.x - b.x;
                    const rightGap = b.x + b.w - wp.x;
                    if (leftGap < rightGap) wp.x = b.x - 24;
                    else wp.x = b.x + b.w + 24;
                  }
                }
              }
            }
          }
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
        points: waypoints && waypoints.length > 0 && !isElbow
          ? [
              [0, 0],
              ...waypoints.map((w) => [w.x - sx, w.y - sy] as [number, number]),
              [ex - sx, ey - sy],
            ]
          : [
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
