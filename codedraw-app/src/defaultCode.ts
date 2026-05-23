export const DEFAULT_CODE = `# CodeDraw DSL — type code on the left, see the diagram on the right.
# Canvas edits sync back into the code automatically.
#
# Statements:
#   node <id> { label, shape, fill, stroke, at, size }
#   edge <id> -> <id> { label }       arrow bound to nodes
#   edge <id> -- <id> { label }       line bound to nodes
#   arrow { from: x,y  to: x,y  label }   free arrow
#   line  { from: x,y  to: x,y }          free line
#   text  { content: "...", at, size }    free text
#
# Shapes: rectangle (default), ellipse, diamond
# The { ... } block is optional when no attributes are needed.

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
  label: "Show error"
  fill:  #ffc9c9
}

node done {
  label: "End"
  shape: ellipse
  fill:  #b2f2bb
}

edge start -> input
edge input -> check
edge check -> work  { label: "yes" }
edge check -> error { label: "no" }
edge work  -> done
edge error -> input { label: "retry" }

text {
  content: "CodeDraw — code in, diagram out"
}
`;
