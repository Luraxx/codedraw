export const DEFAULT_CODE = `# CodeDraw DSL — type code on the left, see the diagram on the right.
# Edits on the canvas are synced back into the code automatically.
#
# Nodes:  id [label] (shape, #bgColor, #strokeColor)
# Edges:  id1 -> id2 : optional label
# Line:   id1 -- id2 : without arrowhead
# Text:   "free text in quotes"

start [Start]          (ellipse, #b2f2bb)
input [Read input]     (rectangle)
check [Valid?]         (diamond, #fff3bf)
work  [Process]        (rectangle, #a5d8ff)
error [Show error]     (rectangle, #ffc9c9)
done  [End]            (ellipse, #b2f2bb)

start -> input
input -> check
check -> work  : yes
check -> error : no
work  -> done
error -> input : retry

"CodeDraw — code in, diagram out"
`;
