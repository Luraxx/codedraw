export const DEFAULT_CODE = `# CodeDraw DSL — type code on the left, see the diagram on the right.
# Canvas edits sync back into the code automatically.
#
# Statements:
#   node <id> { ... }                 a shape (rectangle by default)
#   edge <id> -> <id> { ... }         straight arrow between two nodes
#   edge <id> ~> <id> { ... }         elbow (90°) arrow between two nodes
#   edge <id> -- <id> { ... }         line between two nodes (no arrowhead)
#   arrow { from: x,y  to: x,y ... }  free arrow (no bindings)
#   elbow { from: x,y  to: x,y ... }  free elbow arrow
#   line  { from: x,y  to: x,y ... }  free line
#   text  { content: "..."   ... }    free text
#
# node body  : label, shape, fill, stroke, strokeWidth, strokeStyle,
#              roughness, at, size
# edge body  : label, color, width, style, startHead, endHead, roughness
# arrow body : from, to, label, color, width, style, startHead, endHead, roughness
# elbow body : from, to, label, color, width, style, startHead, endHead, roughness
# line body  : from, to, color, width, style, roughness
# text body  : content, at, size
#
# Value vocabulary:
#   shape       rectangle | ellipse | diamond
#   strokeStyle solid | dashed | dotted          (also: style for edges)
#   startHead   none | arrow | triangle | bar | dot
#   endHead     none | arrow | triangle | bar | dot
#   width       1 | 2 | 4                        (strokeWidth)
#   roughness   0 | 1 | 2                        (0 = clean, 2 = sketchy)
#
# Arrows anchor at the node border (rectangle / ellipse / diamond),
# not at the center.

# ──────────────────────────────────────────────────────────
# Nodes
# ──────────────────────────────────────────────────────────

node start {
  label: "Start"
  shape: ellipse
  fill:  #b2f2bb
}

node input {
  label: "Read input"
}

node check {
  label: "Valid?"
  shape: diamond
  fill:  #fff3bf
}

node work {
  label: "Process"
  fill:  #a5d8ff
}

node error {
  label:       "Show error"
  fill:        #ffc9c9
  stroke:      #c92a2a
  strokeWidth: 2
}

node done {
  label: "End"
  shape: ellipse
  fill:  #b2f2bb
}

# ──────────────────────────────────────────────────────────
# Edges
# ──────────────────────────────────────────────────────────

edge start -> input
edge input -> check
edge check -> work  { label: "yes" }
edge check -> error { label: "no", color: #c92a2a, style: dashed }
edge work  -> done
edge error -> input { label: "retry", style: dotted }
edge done  ~> start { label: "again", color: #1971c2, width: 2 }

# ──────────────────────────────────────────────────────────
# Text
# ──────────────────────────────────────────────────────────

text {
  content: "CodeDraw — code in, diagram out"
}
`;
