/**
 * CodeDraw DSL parser
 *
 * Grammar (line-oriented, # introduces a comment):
 *
 *   # Nodes
 *   <id> [<label>]              -> rectangle, default color
 *   <id> [<label>] (shape)      -> shape ∈ rectangle|ellipse|diamond
 *   <id> [<label>] (shape, #hex)
 *   <id> [<label>] (shape, #bg, #stroke)
 *
 *   # Edges
 *   <id> -> <id>                -> plain arrow
 *   <id> -> <id> : <label>      -> labeled arrow
 *   <id> --> <id> : <label>     -> same (alias)
 *   <id> -- <id> : <label>      -> line (no arrow head)
 *
 *   # Standalone text
 *   "free text on its own line"
 *
 * Whitespace is forgiving. IDs match [A-Za-z_][A-Za-z0-9_]*.
 */

export type NodeShape = "rectangle" | "ellipse" | "diamond";

export interface ParsedNode {
  id: string;
  label: string;
  shape: NodeShape;
  backgroundColor?: string;
  strokeColor?: string;
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
}

export interface ParseResult {
  nodes: ParsedNode[];
  edges: ParsedEdge[];
  texts: ParsedText[];
  errors: ParseError[];
}

export interface ParseError {
  line: number;
  message: string;
  raw: string;
}

const ID_RE = "[A-Za-z_][A-Za-z0-9_]*";

const NODE_RE = new RegExp(
  `^(${ID_RE})\\s*\\[([^\\]]*)\\](?:\\s*\\(([^)]*)\\))?\\s*$`,
);
const EDGE_RE = new RegExp(
  `^(${ID_RE})\\s*(-->|->|--)\\s*(${ID_RE})\\s*(?::\\s*(.*))?$`,
);
const TEXT_RE = /^"([^"]*)"\s*$/;

const VALID_SHAPES: ReadonlySet<NodeShape> = new Set([
  "rectangle",
  "ellipse",
  "diamond",
]);

const parseStyle = (
  raw: string | undefined,
): Pick<ParsedNode, "shape" | "backgroundColor" | "strokeColor"> => {
  const out: Pick<ParsedNode, "shape" | "backgroundColor" | "strokeColor"> = {
    shape: "rectangle",
  };
  if (!raw) {
    return out;
  }
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  for (const p of parts) {
    if (VALID_SHAPES.has(p as NodeShape)) {
      out.shape = p as NodeShape;
    } else if (/^#[0-9a-fA-F]{3,8}$/.test(p)) {
      if (!out.backgroundColor) {
        out.backgroundColor = p;
      } else {
        out.strokeColor = p;
      }
    }
  }
  return out;
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
      result.texts.push({ text: textMatch[1] });
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
          message: `Duplicate node id "${id}" (first defined on line ${seen.get(id)})`,
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
