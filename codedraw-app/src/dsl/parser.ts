/**
 * CodeDraw DSL parser.
 *
 * Grammar (line-oriented, '#' starts a comment):
 *
 *   # Nodes
 *   <id> [<label>]                       -> rectangle
 *   <id> [<label>] (shape)               -> shape ∈ rectangle|ellipse|diamond
 *   <id> [<label>] (shape, #bg)
 *   <id> [<label>] (shape, #bg, #stroke)
 *   <id> [<label>] (shape, @x,y)         -> explicit position (px)
 *   <id> [<label>] (shape, @x,y,w,h)     -> explicit position + size
 *   (tokens inside the parens can appear in any order, separated by commas)
 *
 *   # Edges
 *   <id> -> <id>                         -> arrow
 *   <id> -> <id> : <label>               -> labelled arrow
 *   <id> -- <id> : <label>               -> plain line, no arrowhead
 *
 *   # Free text
 *   "free text in quotes"
 *
 * IDs match [A-Za-z_][A-Za-z0-9_]*.
 */

export type NodeShape = "rectangle" | "ellipse" | "diamond";

export interface ParsedNode {
  id: string;
  label: string;
  shape: NodeShape;
  backgroundColor?: string;
  strokeColor?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export type EdgeKind = "arrow" | "line";

export interface ParsedEdge {
  from: string;
  to: string;
  label?: string;
  kind: EdgeKind;
}

export interface ParsedText {
  text: string;
  x?: number;
  y?: number;
}

export interface ParseError {
  line: number;
  message: string;
  raw: string;
}

export interface ParseResult {
  nodes: ParsedNode[];
  edges: ParsedEdge[];
  texts: ParsedText[];
  errors: ParseError[];
}

const ID_RE = "[A-Za-z_][A-Za-z0-9_]*";
const NODE_RE = new RegExp(
  `^(${ID_RE})\\s*\\[([^\\]]*)\\](?:\\s*\\(([^)]*)\\))?\\s*$`,
);
const EDGE_RE = new RegExp(
  `^(${ID_RE})\\s*(-->|->|--)\\s*(${ID_RE})\\s*(?::\\s*(.*))?$`,
);
const TEXT_RE = /^"([^"]*)"(?:\s*\(([^)]*)\))?\s*$/;
const NUM = "-?\\d+(?:\\.\\d+)?";
const POS4_RE = new RegExp(`^@(${NUM}),(${NUM}),(${NUM}),(${NUM})$`);
const POS2_RE = new RegExp(`^@(${NUM}),(${NUM})$`);

const VALID_SHAPES: ReadonlySet<NodeShape> = new Set([
  "rectangle",
  "ellipse",
  "diamond",
]);

type StyleResult = Pick<
  ParsedNode,
  "shape" | "backgroundColor" | "strokeColor" | "x" | "y" | "width" | "height"
>;

const parseStyle = (raw: string | undefined): StyleResult => {
  const out: StyleResult = { shape: "rectangle" };
  if (!raw) {
    return out;
  }
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    // Reassemble position tokens that got split by our naive comma-split.
    // We re-glue on the fly: if we see '@x' followed by ',y[,w,h]', combine.
  }
  // Two-pass: collect tokens, then re-glue '@'-prefixed groups.
  const tokens = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const merged: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("@")) {
      // try to consume up to 3 more numeric neighbours
      let combined = t;
      while (
        i + 1 < tokens.length &&
        /^-?\d+(?:\.\d+)?$/.test(tokens[i + 1]) &&
        combined.split(",").length < 4
      ) {
        combined += "," + tokens[++i];
      }
      merged.push(combined);
    } else {
      merged.push(t);
    }
  }

  for (const p of merged) {
    if (VALID_SHAPES.has(p as NodeShape)) {
      out.shape = p as NodeShape;
      continue;
    }
    if (/^#[0-9a-fA-F]{3,8}$/.test(p)) {
      if (!out.backgroundColor) {
        out.backgroundColor = p;
      } else if (!out.strokeColor) {
        out.strokeColor = p;
      }
      continue;
    }
    const m4 = POS4_RE.exec(p);
    if (m4) {
      out.x = Number(m4[1]);
      out.y = Number(m4[2]);
      out.width = Number(m4[3]);
      out.height = Number(m4[4]);
      continue;
    }
    const m2 = POS2_RE.exec(p);
    if (m2) {
      out.x = Number(m2[1]);
      out.y = Number(m2[2]);
      continue;
    }
  }
  return out;
};

const parseTextPos = (raw: string | undefined): { x?: number; y?: number } => {
  if (!raw) return {};
  for (const p of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    // accept full @x,y in one token after our split? Better: glue manually.
  }
  // Same gluing trick as parseStyle, scoped for `@x,y` only.
  const tokens = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (
      tokens[i].startsWith("@") &&
      i + 1 < tokens.length &&
      /^-?\d+(?:\.\d+)?$/.test(tokens[i + 1])
    ) {
      const m = POS2_RE.exec(`${tokens[i]},${tokens[i + 1]}`);
      if (m) return { x: Number(m[1]), y: Number(m[2]) };
    }
  }
  return {};
};

export const parseDsl = (source: string): ParseResult => {
  const result: ParseResult = { nodes: [], edges: [], texts: [], errors: [] };
  const seen = new Map<string, number>();
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.replace(/\s+#.*$/, "").trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const textMatch = TEXT_RE.exec(trimmed);
    if (textMatch) {
      const [, text, posRaw] = textMatch;
      result.texts.push({ text, ...parseTextPos(posRaw) });
      continue;
    }

    const edgeMatch = EDGE_RE.exec(trimmed);
    if (edgeMatch) {
      const [, from, op, to, label] = edgeMatch;
      result.edges.push({
        from,
        to,
        label: label?.trim() || undefined,
        kind: op === "--" ? "line" : "arrow",
      });
      continue;
    }

    const nodeMatch = NODE_RE.exec(trimmed);
    if (nodeMatch) {
      const [, id, label, style] = nodeMatch;
      if (seen.has(id)) {
        result.errors.push({
          line: i + 1,
          raw,
          message: `Duplicate node id "${id}" (first defined on line ${seen.get(id)}).`,
        });
        continue;
      }
      seen.set(id, i + 1);
      result.nodes.push({ id, label: label.trim(), ...parseStyle(style) });
      continue;
    }

    result.errors.push({
      line: i + 1,
      raw,
      message: `Cannot parse line. Expected node, edge or "text".`,
    });
  }

  // Auto-create implicit nodes referenced only by edges.
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
