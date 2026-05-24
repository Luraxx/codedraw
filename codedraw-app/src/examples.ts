// Mirror of codedraw-api/src/examples.ts. Kept in sync manually because
// the api package and the app package don't share a code path. Six small
// snippets isn't worth a build-time shared package yet — if this list
// grows, promote it to packages/codedraw-shared.

export interface Example {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly code: string;
}

export const EXAMPLES: readonly Example[] = [
  {
    id: "flow",
    name: "Flow chart",
    description: "Top-down decision flow with shapes, colors and a retry loop.",
    code: `node start { label: "Start"      shape: ellipse fill: #b2f2bb }
node input { label: "Read input" }
node check { label: "Valid?"     shape: diamond fill: #fff3bf }
node work  { label: "Process"    fill: #a5d8ff }
node error { label: "Show error" fill: #ffc9c9 stroke: #c92a2a }
node done  { label: "End"        shape: ellipse fill: #b2f2bb }

edge start -> input
edge input -> check
edge check -> work  { label: "yes" }
edge check -> error { label: "no", color: #c92a2a, style: dashed }
edge work  -> done
edge error -> input { label: "retry", style: dotted }
edge done  ~> start { label: "again", color: #1971c2,
                      fromSide: right, toSide: right }
`,
  },
  {
    id: "sequence",
    name: "Sequence-ish",
    description: "Linear pipeline with elbow back-edge.",
    code: `node a { label: "Client"  shape: ellipse fill: #d0bfff }
node b { label: "API"     fill: #a5d8ff }
node c { label: "Worker"  fill: #b2f2bb }
node d { label: "DB"      shape: ellipse fill: #ffd8a8 }

edge a -> b { label: "POST /job" }
edge b -> c { label: "enqueue" }
edge c -> d { label: "store" }
edge d ~> a { label: "result",
              fromSide: right, toSide: right, color: #1971c2 }
`,
  },
  {
    id: "free",
    name: "Free shapes",
    description: "Unbound arrows, lines, and standalone text.",
    code: `node hub { label: "Hub" shape: ellipse fill: #ffe066 }

arrow { from: 40,  40  to: 280, 200 label: "in"  color: #1971c2 }
arrow { from: 540, 40  to: 320, 200 label: "in"  color: #1971c2 }
arrow { from: 280, 320 to: 80,  500 label: "out" color: #c92a2a style: dashed }
arrow { from: 320, 320 to: 540, 500 label: "out" color: #c92a2a style: dashed }

line { from: 0, 600 to: 620, 600 style: dotted }
text { content: "system boundary" at: 230, 610 size: 14 }
`,
  },
  {
    id: "self-loop",
    name: "Self-loop",
    description: "Edge from a node back to itself, with a label.",
    code: `node poll { label: "Poll status" fill: #a5d8ff }
node done { label: "Done" shape: ellipse fill: #b2f2bb }

edge poll -> poll { label: "wait 1s" color: #1971c2 }
edge poll -> done { label: "ready" }
`,
  },
  {
    id: "sketch",
    name: "Sketchy roughness",
    description: "Same diagram, sketchy hand-drawn feel via roughness: 2.",
    code: `node a { label: "Idea"     shape: ellipse fill: #ffe066 roughness: 2 }
node b { label: "Prototype" fill: #a5d8ff roughness: 2 }
node c { label: "Ship"      shape: ellipse fill: #b2f2bb roughness: 2 }

edge a -> b { label: "build" roughness: 2 }
edge b -> c { label: "launch" roughness: 2 }
`,
  },
  {
    id: "dark",
    name: "Dark theme",
    description:
      'Pair with theme: "dark" when calling /render — light fills stay vivid, default ink turns light.',
    code: `node a { label: "Dark mode" fill: #4263eb }
node b { label: "Bright fills"     fill: #51cf66 }
node c { label: "Stay readable"    shape: ellipse fill: #ffd43b }

edge a -> b { label: "looks good" }
edge b -> c { label: "trust me" }
`,
  },
];
