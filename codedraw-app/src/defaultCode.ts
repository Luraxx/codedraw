export const DEFAULT_CODE = `# CodeDraw DSL — schreibe links Code, sieh rechts dein Diagramm.
# Knoten:  ID [Label] (shape, #bgColor, #strokeColor)
# Kanten:  ID -> ID : optionales Label
# Linie:   ID -- ID : ohne Pfeilspitze
# Text:    "Freitext in Anführungszeichen"

start  [Start]              (ellipse, #b2f2bb)
input  [Eingabe lesen]       (rectangle)
check  [Gültig?]             (diamond, #fff3bf)
work   [Verarbeiten]         (rectangle, #a5d8ff)
error  [Fehler anzeigen]     (rectangle, #ffc9c9)
done   [Ende]                (ellipse, #b2f2bb)

start  -> input
input  -> check
check  -> work  : ja
check  -> error : nein
work   -> done
error  -> input : retry

"CodeDraw — code in, diagram out"
`;
