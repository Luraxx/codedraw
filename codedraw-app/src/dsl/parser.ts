/**
 * CodeDraw DSL — block-structured grammar.
 *
 * Top-level statements:
 *
 *   node <id> { ... }              -> shape (rectangle by default)
 *   edge <id> -> <id> { ... }      -> straight arrow bound to nodes
 *   edge <id> ~> <id> { ... }      -> elbow (90°) arrow bound to nodes
 *   edge <id> -- <id> { ... }      -> straight line bound to nodes
 *   arrow { from: x,y  to: x,y }   -> free arrow (no bindings)
 *   elbow { from: x,y  to: x,y }   -> free elbow arrow
 *   line  { from: x,y  to: x,y }   -> free line  (no bindings)
 *   text  { content: "..." }       -> free text
 *
 * The `{ ... }` block is optional — `node foo` and `edge a -> b` are valid.
 *
 * Block bodies hold `key: value` lines:
 *
 *   node:   label, shape, fill, stroke, strokeWidth, strokeStyle,
 *           roughness, at, size
 *   edge:   label, color, width, style, startHead, endHead, roughness,
 *           fromSide, toSide (elbow only: top|right|bottom|left)
 *   arrow:  from, to, label, color, width, style, startHead, endHead, roughness
 *   elbow:  from, to, label, color, width, style, startHead, endHead, roughness
 *   line:   from, to, color, width, style, roughness
 *   text:   content, at, size, color
 *
 * Style value vocabulary:
 *   shape       rectangle | ellipse | diamond
 *   strokeStyle solid | dashed | dotted
 *   style       solid | dashed | dotted   (edges/arrows)
 *   startHead   none | arrow | triangle | bar | dot
 *   endHead     none | arrow | triangle | bar | dot
 *   width       1 | 2 | 4                 (strokeWidth)
 *   roughness   0 | 1 | 2                 (0 = architect / clean, 2 = sketchy)
 *
 * Values:
 *   "string"            quoted, with \" \\ \n escapes
 *   ident               bare identifier (e.g. ellipse)
 *   #rgb / #rrggbb      color
 *   n[, n[, n[, n]]]    one to four numbers separated by commas
 *
 * Comments: lines starting with `#` (after optional whitespace), or trailing
 * `  # …` (hash preceded by whitespace and followed by space or EOL).
 * IDs match [A-Za-z_][A-Za-z0-9_]*.
 */

export type NodeShape = "rectangle" | "ellipse" | "diamond";
export type StrokeStyle = "solid" | "dashed" | "dotted";
export type Arrowhead = "none" | "arrow" | "triangle" | "bar" | "dot";

const VALID_STROKE_STYLES: ReadonlySet<StrokeStyle> = new Set([
  "solid",
  "dashed",
  "dotted",
]);
const VALID_ARROWHEADS: ReadonlySet<Arrowhead> = new Set([
  "none",
  "arrow",
  "triangle",
  "bar",
  "dot",
]);

export interface ParsedNode {
  id: string;
  label: string;
  shape: NodeShape;
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  strokeStyle?: StrokeStyle;
  roughness?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export type EdgeKind = "arrow" | "line" | "elbow";

export interface ParsedLinearStyle {
  strokeColor?: string;
  strokeWidth?: number;
  strokeStyle?: StrokeStyle;
  startArrowhead?: Arrowhead;
  endArrowhead?: Arrowhead;
  roughness?: number;
}

export type EdgeSide = "top" | "right" | "bottom" | "left";

export interface ParsedEdge extends ParsedLinearStyle {
  from: string;
  to: string;
  label?: string;
  kind: EdgeKind;
  fromSide?: EdgeSide;
  toSide?: EdgeSide;
}

export interface ParsedFreeArrow extends ParsedLinearStyle {
  kind: EdgeKind;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  label?: string;
}

export interface ParsedText {
  text: string;
  x?: number;
  y?: number;
  fontSize?: number;
}

export interface ParseError {
  line: number;
  message: string;
  raw: string;
}

export interface ParseResult {
  nodes: ParsedNode[];
  edges: ParsedEdge[];
  freeArrows: ParsedFreeArrow[];
  texts: ParsedText[];
  errors: ParseError[];
}

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Headers may be followed by either an inline `{ k: v k: v }` block (entire
// block on the header line) or an opening `{` that starts a multi-line block.
const NODE_HEAD =
  /^node\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*\{([^{}]*)\}|\s*(\{))?\s*$/;
const EDGE_HEAD =
  /^edge\s+([A-Za-z_][A-Za-z0-9_]*)\s*(~>|->|--)\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s*\{([^{}]*)\}|\s*(\{))?\s*$/;
const SIMPLE_HEAD =
  /^(elbow|arrow|line|text)(?:\s*\{([^{}]*)\}|\s*(\{))?\s*$/;
const KV_RE = /^([A-Za-z_]+)\s*:\s*(.*)$/;

const VALID_SHAPES: ReadonlySet<NodeShape> = new Set([
  "rectangle",
  "ellipse",
  "diamond",
]);

const stripComment = (s: string): string => {
  // remove `  # …` trailing comments (hash preceded by whitespace, followed by space or EOL)
  let out = s.replace(/\s+#(\s.*|$)/, "");
  if (/^\s*#/.test(out)) out = "";
  return out;
};

type Value =
  | { kind: "string"; value: string }
  | { kind: "ident"; value: string }
  | { kind: "color"; value: string }
  | { kind: "numbers"; value: number[] };

const parseString = (raw: string): string | null => {
  if (raw[0] !== '"') return null;
  let i = 1;
  let out = "";
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') return out;
    if (c === "\\" && i + 1 < raw.length) {
      const n = raw[i + 1];
      out += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return null;
};

const parseValue = (raw: string): Value | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed[0] === '"') {
    const s = parseString(trimmed);
    return s === null ? null : { kind: "string", value: s };
  }
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) {
    return { kind: "color", value: trimmed };
  }
  if (/^-?\d/.test(trimmed)) {
    const parts = trimmed.split(",").map((p) => p.trim());
    const nums: number[] = [];
    for (const p of parts) {
      if (!/^-?\d+(\.\d+)?$/.test(p)) return null;
      nums.push(Number(p));
    }
    return { kind: "numbers", value: nums };
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    return { kind: "ident", value: trimmed };
  }
  return null;
};

interface BlockBody {
  entries: Map<string, Value>;
  errors: { line: number; message: string; raw: string }[];
}

/**
 * Split the body of an inline `{ ... }` block (without the surrounding
 * braces) into individual `key: value` substrings.
 *
 * Recognizes string-quote boundaries so a `"key: …"` inside a value does
 * not start a new entry.
 */
const splitInlineKvs = (body: string): string[] => {
  const starts: number[] = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '"') {
      i++;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === "\\" && i + 1 < body.length) i++;
        i++;
      }
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c) && (i === 0 || /\s|[,{]/.test(body[i - 1]))) {
      const m = /^([A-Za-z_]+)\s*:/.exec(body.slice(i));
      if (m) {
        starts.push(i);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  if (starts.length === 0) return [];
  const out: string[] = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : body.length;
    out.push(body.slice(s, e).replace(/,\s*$/, "").trim());
  }
  return out;
};

const parseInlineBlock = (body: string, lineNo: number): BlockBody => {
  const result: BlockBody = { entries: new Map(), errors: [] };
  for (const kv of splitInlineKvs(body)) {
    const m = KV_RE.exec(kv);
    if (!m) {
      result.errors.push({
        line: lineNo,
        raw: kv,
        message: `Expected "key: value" inside inline block, got "${kv}".`,
      });
      continue;
    }
    const [, key, rest] = m;
    const v = parseValue(rest);
    if (!v) {
      result.errors.push({
        line: lineNo,
        raw: kv,
        message: `Invalid value for "${key}": ${rest}`,
      });
      continue;
    }
    result.entries.set(key, v);
  }
  return result;
};

const parseBlock = (
  lines: string[],
  startIdx: number,
): { body: BlockBody; nextIdx: number } => {
  const body: BlockBody = { entries: new Map(), errors: [] };
  let i = startIdx;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = stripComment(raw).trim();
    i++;
    if (!trimmed) continue;
    if (trimmed === "}") return { body, nextIdx: i };
    const m = KV_RE.exec(trimmed);
    if (!m) {
      body.errors.push({
        line: i,
        raw,
        message: `Expected "key: value" inside block, got "${trimmed}".`,
      });
      continue;
    }
    const [, key, rest] = m;
    const v = parseValue(rest);
    if (!v) {
      body.errors.push({
        line: i,
        raw,
        message: `Invalid value for "${key}": ${rest}`,
      });
      continue;
    }
    body.entries.set(key, v);
  }
  body.errors.push({
    line: startIdx,
    raw: "",
    message: `Unterminated block (missing "}").`,
  });
  return { body, nextIdx: i };
};

const fillNode = (node: ParsedNode, body: BlockBody, result: ParseResult) => {
  for (const [k, v] of body.entries) {
    switch (k) {
      case "label":
        if (v.kind === "string") node.label = v.value;
        break;
      case "shape":
        if (v.kind === "ident" && VALID_SHAPES.has(v.value as NodeShape)) {
          node.shape = v.value as NodeShape;
        }
        break;
      case "fill":
        if (v.kind === "color") node.backgroundColor = v.value;
        break;
      case "stroke":
        if (v.kind === "color") node.strokeColor = v.value;
        break;
      case "strokeWidth":
        if (v.kind === "numbers" && v.value.length === 1) {
          node.strokeWidth = v.value[0];
        }
        break;
      case "strokeStyle":
        if (
          v.kind === "ident" &&
          VALID_STROKE_STYLES.has(v.value as StrokeStyle)
        ) {
          node.strokeStyle = v.value as StrokeStyle;
        }
        break;
      case "roughness":
        if (v.kind === "numbers" && v.value.length === 1) {
          node.roughness = v.value[0];
        }
        break;
      case "at":
        if (v.kind === "numbers" && v.value.length === 2) {
          node.x = v.value[0];
          node.y = v.value[1];
        }
        break;
      case "size":
        if (v.kind === "numbers" && v.value.length === 2) {
          node.width = v.value[0];
          node.height = v.value[1];
        }
        break;
    }
  }
  for (const e of body.errors) result.errors.push(e);
};

const applyLinearStyle = (target: ParsedLinearStyle, body: BlockBody) => {
  for (const [k, v] of body.entries) {
    switch (k) {
      case "color":
        if (v.kind === "color") target.strokeColor = v.value;
        break;
      case "width":
        if (v.kind === "numbers" && v.value.length === 1) {
          target.strokeWidth = v.value[0];
        }
        break;
      case "style":
        if (
          v.kind === "ident" &&
          VALID_STROKE_STYLES.has(v.value as StrokeStyle)
        ) {
          target.strokeStyle = v.value as StrokeStyle;
        }
        break;
      case "startHead":
        if (
          v.kind === "ident" &&
          VALID_ARROWHEADS.has(v.value as Arrowhead)
        ) {
          target.startArrowhead = v.value as Arrowhead;
        }
        break;
      case "endHead":
        if (
          v.kind === "ident" &&
          VALID_ARROWHEADS.has(v.value as Arrowhead)
        ) {
          target.endArrowhead = v.value as Arrowhead;
        }
        break;
      case "roughness":
        if (v.kind === "numbers" && v.value.length === 1) {
          target.roughness = v.value[0];
        }
        break;
    }
  }
};

const VALID_SIDES = new Set<EdgeSide>(["top", "right", "bottom", "left"]);

const fillEdge = (edge: ParsedEdge, body: BlockBody, result: ParseResult) => {
  const lbl = body.entries.get("label");
  if (lbl && lbl.kind === "string") edge.label = lbl.value;
  const fs = body.entries.get("fromSide");
  if (fs && fs.kind === "ident" && VALID_SIDES.has(fs.value as EdgeSide)) {
    edge.fromSide = fs.value as EdgeSide;
  }
  const ts = body.entries.get("toSide");
  if (ts && ts.kind === "ident" && VALID_SIDES.has(ts.value as EdgeSide)) {
    edge.toSide = ts.value as EdgeSide;
  }
  applyLinearStyle(edge, body);
  for (const e of body.errors) result.errors.push(e);
};

const fillFreeArrow = (
  kind: EdgeKind,
  body: BlockBody,
  result: ParseResult,
  lineNo: number,
) => {
  const from = body.entries.get("from");
  const to = body.entries.get("to");
  if (
    !from || !to ||
    from.kind !== "numbers" || to.kind !== "numbers" ||
    from.value.length !== 2 || to.value.length !== 2
  ) {
    result.errors.push({
      line: lineNo,
      raw: "",
      message: `${kind} requires "from: x,y" and "to: x,y".`,
    });
    return;
  }
  const lbl = body.entries.get("label");
  const fa: ParsedFreeArrow = {
    kind,
    fromX: from.value[0],
    fromY: from.value[1],
    toX: to.value[0],
    toY: to.value[1],
    label: lbl && lbl.kind === "string" ? lbl.value : undefined,
  };
  applyLinearStyle(fa, body);
  result.freeArrows.push(fa);
  for (const e of body.errors) result.errors.push(e);
};

const fillText = (body: BlockBody, result: ParseResult, lineNo: number) => {
  const c = body.entries.get("content");
  if (!c || c.kind !== "string") {
    result.errors.push({
      line: lineNo,
      raw: "",
      message: `text requires content: "...".`,
    });
    return;
  }
  const t: ParsedText = { text: c.value };
  const at = body.entries.get("at");
  if (at && at.kind === "numbers" && at.value.length === 2) {
    t.x = at.value[0];
    t.y = at.value[1];
  }
  const size = body.entries.get("size");
  if (size && size.kind === "numbers" && size.value.length === 1) {
    t.fontSize = size.value[0];
  }
  result.texts.push(t);
  for (const e of body.errors) result.errors.push(e);
};

export const parseDsl = (source: string): ParseResult => {
  const result: ParseResult = {
    nodes: [],
    edges: [],
    freeArrows: [],
    texts: [],
    errors: [],
  };
  const rawLines = source.split(/\r?\n/);
  const seenIds = new Map<string, number>();
  let i = 0;

  while (i < rawLines.length) {
    const raw = rawLines[i];
    const line = stripComment(raw).trim();
    if (!line) {
      i++;
      continue;
    }

    const nodeM = NODE_HEAD.exec(line);
    if (nodeM) {
      const [, id, inline, brace] = nodeM;
      if (!ID_RE.test(id)) {
        result.errors.push({ line: i + 1, raw, message: `Invalid id "${id}".` });
        i++;
        continue;
      }
      if (seenIds.has(id)) {
        result.errors.push({
          line: i + 1,
          raw,
          message: `Duplicate node id "${id}" (first on line ${seenIds.get(id)}).`,
        });
        i++;
        continue;
      }
      seenIds.set(id, i + 1);
      const node: ParsedNode = { id, label: id, shape: "rectangle" };
      const lineNo = i + 1;
      i++;
      if (inline !== undefined) {
        fillNode(node, parseInlineBlock(inline, lineNo), result);
      } else if (brace) {
        const { body, nextIdx } = parseBlock(rawLines, i);
        fillNode(node, body, result);
        i = nextIdx;
      }
      result.nodes.push(node);
      continue;
    }

    const edgeM = EDGE_HEAD.exec(line);
    if (edgeM) {
      const [, from, op, to, inline, brace] = edgeM;
      const edge: ParsedEdge = {
        from,
        to,
        kind: op === "--" ? "line" : op === "~>" ? "elbow" : "arrow",
      };
      const lineNo = i + 1;
      i++;
      if (inline !== undefined) {
        fillEdge(edge, parseInlineBlock(inline, lineNo), result);
      } else if (brace) {
        const { body, nextIdx } = parseBlock(rawLines, i);
        fillEdge(edge, body, result);
        i = nextIdx;
      }
      result.edges.push(edge);
      continue;
    }

    const simpleM = SIMPLE_HEAD.exec(line);
    if (simpleM) {
      const [, kw, inline, brace] = simpleM;
      const lineNo = i + 1;
      i++;
      let body: BlockBody | null = null;
      if (inline !== undefined) {
        body = parseInlineBlock(inline, lineNo);
      } else if (brace) {
        const parsedBlock = parseBlock(rawLines, i);
        body = parsedBlock.body;
        i = parsedBlock.nextIdx;
      } else {
        result.errors.push({
          line: lineNo,
          raw,
          message: `"${kw}" requires a { ... } block.`,
        });
        continue;
      }
      if (kw === "arrow") fillFreeArrow("arrow", body, result, lineNo);
      else if (kw === "elbow") fillFreeArrow("elbow", body, result, lineNo);
      else if (kw === "line") fillFreeArrow("line", body, result, lineNo);
      else fillText(body, result, lineNo);
      continue;
    }

    result.errors.push({
      line: i + 1,
      raw,
      message: `Cannot parse line. Expected node, edge, arrow, line or text.`,
    });
    i++;
  }

  // Auto-create implicit nodes for edges that reference undeclared ids.
  const ids = new Set(result.nodes.map((n) => n.id));
  for (const e of result.edges) {
    for (const id of [e.from, e.to]) {
      if (!ids.has(id)) {
        ids.add(id);
        result.nodes.push({ id, label: id, shape: "rectangle" });
      }
    }
  }

  return result;
};
