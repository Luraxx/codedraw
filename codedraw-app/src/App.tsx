import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { loader, type Monaco } from "@monaco-editor/react";

// Pin Monaco loader to a versioned CDN; avoids spurious *.js.map 404s from
// the default unpkg HEAD URL and gives us reproducible builds.
loader.config({
  paths: {
    vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs",
  },
});
import {
  Excalidraw,
  MainMenu,
  WelcomeScreen,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { parseDsl } from "./dsl/parser";
import { buildScene } from "./dsl/buildScene";
import { serializeScene } from "./dsl/serialize";
import { DEFAULT_CODE } from "./defaultCode";
import "./app.css";

const STORAGE_KEY = "codedraw:source:v4";
const LANGUAGE_ID = "codedraw";

const registerCodedrawLanguage = (monaco: Monaco) => {
  if (monaco.languages.getLanguages().some((l) => l.id === LANGUAGE_ID)) {
    return;
  }
  monaco.languages.register({ id: LANGUAGE_ID });
  monaco.languages.setLanguageConfiguration(LANGUAGE_ID, {
    comments: { lineComment: "#" },
    brackets: [["{", "}"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: '"', close: '"' },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: '"', close: '"' },
    ],
  });
  monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, {
    defaultToken: "",
    keywords: ["node", "edge", "arrow", "line", "text"],
    shapes: ["rectangle", "ellipse", "diamond"],
    attributes: ["label", "shape", "fill", "stroke", "at", "size", "from", "to", "content"],
    tokenizer: {
      root: [
        [/^\s*#.*$/, "comment"],
        [/\s#\s.*$/, "comment"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/#[0-9a-fA-F]{3,8}\b/, "number.hex"],
        [/->|--/, "operator"],
        [
          /\b(node|edge|arrow|line|text)\b/,
          { cases: { "@keywords": "keyword" } },
        ],
        [
          /\b(rectangle|ellipse|diamond)\b/,
          { cases: { "@shapes": "type" } },
        ],
        [
          /\b(label|shape|fill|stroke|at|size|from|to|content)(?=\s*:)/,
          { cases: { "@attributes": "attribute.name" } },
        ],
        [/[{}]/, "@brackets"],
        [/[,:]/, "delimiter"],
        [/-?\d+(\.\d+)?/, "number"],
        [/[A-Za-z_]\w*/, "identifier"],
      ],
    },
  } as any);
};

const useDebounced = <T,>(value: T, delay: number): [T, () => void] => {
  const [v, setV] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setV(value), delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, delay]);
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setV(value);
  }, [value]);
  return [v, flush];
};

const useResizableSplit = () => {
  const [width, setWidth] = useState<string>("40%");
  const dragging = useRef(false);
  const onMouseDown = useCallback(() => {
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const pct = Math.min(80, Math.max(15, (e.clientX / window.innerWidth) * 100));
      setWidth(`${pct}%`);
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);
  return { width, onMouseDown };
};

const sceneSignature = (els: readonly ExcalidrawElement[]): string => {
  let s = "";
  for (const e of els) {
    if (e.isDeleted) continue;
    s += `${e.id}:${e.type}:${e.version}|`;
  }
  return s;
};

// Logical "page" used by the minimap and the out-of-bounds validation.
// Elements outside this rectangle (or larger/smaller than the size bounds
// below) trigger a validation error in the code panel so authors notice
// before the diagram drifts off-screen.
// Canvas is centred on (0,0) so code-generated diagrams (which buildScene
// auto-centres at the origin) sit in the middle of the bounded area and
// don't get falsely flagged as "outside the canvas".
const CANVAS_BOUNDS = { x: -2000, y: -1500, w: 4000, h: 3000 } as const;
const MIN_ELEMENT_SIZE = 5;
const MAX_ELEMENT_SIZE = 2500;

type ViewportInfo = {
  scrollX: number;
  scrollY: number;
  zoom: number;
  width: number;
  height: number;
};

type ValidationError = { line: number; message: string; raw?: string };

const validateElements = (
  els: readonly ExcalidrawElement[],
): ValidationError[] => {
  const errs: ValidationError[] = [];
  for (const e of els) {
    if (e.isDeleted) continue;
    if (e.type === "text") continue; // texts have dynamic size; skip
    if (e.type === "arrow" || e.type === "line") continue; // connectors can have tiny cross-sections by design
    const w = e.width ?? 0;
    const h = e.height ?? 0;
    const minSide = Math.min(Math.abs(w), Math.abs(h));
    const maxSide = Math.max(Math.abs(w), Math.abs(h));
    if (minSide > 0 && minSide < MIN_ELEMENT_SIZE) {
      errs.push({
        line: 0,
        message: `Element "${e.id}" is too small (${Math.round(w)}×${Math.round(h)})`,
      });
    }
    if (maxSide > MAX_ELEMENT_SIZE) {
      errs.push({
        line: 0,
        message: `Element "${e.id}" is too large (${Math.round(w)}×${Math.round(h)}); max ${MAX_ELEMENT_SIZE}`,
      });
    }
    const x1 = e.x;
    const y1 = e.y;
    const x2 = e.x + w;
    const y2 = e.y + h;
    if (
      x1 < CANVAS_BOUNDS.x ||
      y1 < CANVAS_BOUNDS.y ||
      x2 > CANVAS_BOUNDS.x + CANVAS_BOUNDS.w ||
      y2 > CANVAS_BOUNDS.y + CANVAS_BOUNDS.h
    ) {
      errs.push({
        line: 0,
        message: `Element "${e.id}" is outside the canvas (${Math.round(x1)},${Math.round(y1)})`,
      });
    }
  }
  return errs;
};

const Minimap = ({
  elements,
  viewport,
  backgroundColor,
}: {
  elements: readonly ExcalidrawElement[];
  viewport: ViewportInfo | null;
  backgroundColor: string;
}) => {
  const W = 200;
  const H = 150;
  const PAD = 6;
  const scale = Math.min(
    (W - PAD * 2) / CANVAS_BOUNDS.w,
    (H - PAD * 2) / CANVAS_BOUNDS.h,
  );
  const sx = (x: number) => PAD + (x - CANVAS_BOUNDS.x) * scale;
  const sy = (y: number) => PAD + (y - CANVAS_BOUNDS.y) * scale;

  const viewRect = viewport
    ? {
        x: sx(-viewport.scrollX),
        y: sy(-viewport.scrollY),
        w: (viewport.width / viewport.zoom) * scale,
        h: (viewport.height / viewport.zoom) * scale,
      }
    : null;

  return (
    <div className="cd-minimap" aria-hidden="true">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <rect
          x={PAD}
          y={PAD}
          width={CANVAS_BOUNDS.w * scale}
          height={CANVAS_BOUNDS.h * scale}
          fill={backgroundColor}
          stroke="#3a4150"
          strokeWidth={1}
        />
        {elements.map((e) => {
          if (e.isDeleted) return null;
          const w = Math.abs(e.width ?? 0) * scale;
          const h = Math.abs(e.height ?? 0) * scale;
          const x = sx(e.x);
          const y = sy(e.y);
          const outside =
            e.x < CANVAS_BOUNDS.x ||
            e.y < CANVAS_BOUNDS.y ||
            e.x + (e.width ?? 0) > CANVAS_BOUNDS.x + CANVAS_BOUNDS.w ||
            e.y + (e.height ?? 0) > CANVAS_BOUNDS.y + CANVAS_BOUNDS.h;
          const fill = outside ? "#f08c8c" : "#7aa2f7";
          if (e.type === "arrow" || e.type === "line") {
            return (
              <line
                key={e.id}
                x1={x}
                y1={y}
                x2={x + w}
                y2={y + h}
                stroke={fill}
                strokeWidth={1}
              />
            );
          }
          return (
            <rect
              key={e.id}
              x={x}
              y={y}
              width={Math.max(1, w)}
              height={Math.max(1, h)}
              fill={fill}
              opacity={0.85}
            />
          );
        })}
        {viewRect && (
          <rect
            x={viewRect.x}
            y={viewRect.y}
            width={viewRect.w}
            height={viewRect.h}
            fill="none"
            stroke="#ffd866"
            strokeWidth={1.5}
            strokeDasharray="3 2"
          />
        )}
      </svg>
    </div>
  );
};

const App = () => {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [editorHidden, setEditorHidden] = useState(false);
  const [source, setSource] = useState<string>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored && stored.trim().length > 0 ? stored : DEFAULT_CODE;
    } catch {
      return DEFAULT_CODE;
    }
  });
  const [liveElements, setLiveElements] = useState<readonly ExcalidrawElement[]>([]);
  const [viewport, setViewport] = useState<ViewportInfo | null>(null);
  const [canvasBg, setCanvasBg] = useState<string>("#ffffff");

  // The DSL of the scene we most recently pushed to Excalidraw. Any incoming
  // onChange whose serialised form matches this value is just Excalidraw
  // echoing our own update back and must be ignored — otherwise the user's
  // hand-written source gets clobbered by the round-tripped serialisation.
  const lastDslPushed = useRef<string>("");
  const lastLiveSignature = useRef<string>("");
  const lastViewportSig = useRef<string>("");
  // Timestamp of the most recent code→canvas push. Excalidraw normalises
  // elements (binding text labels, recalculating bounds, etc.) and fires one
  // or more onChange callbacks whose serialised DSL differs from what we
  // pushed. Treat any onChange within this window as a normalisation echo:
  // refresh lastDslPushed but never write back to `source`.
  const lastPushAt = useRef<number>(0);
  const didInitialFit = useRef<boolean>(false);

  const [debouncedSource, flushSync] = useDebounced(source, 150);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, source);
    } catch {
      /* ignore */
    }
  }, [source]);

  // Ctrl+B / Cmd+B → toggle the code panel.
  // Shift+Enter   → force-sync code to canvas without waiting for the debounce.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        setEditorHidden((h) => !h);
        return;
      }
      if (e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        flushSync();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flushSync]);

  const parsed = useMemo(() => parseDsl(debouncedSource), [debouncedSource]);

  // CODE → CANVAS
  // Only depends on `parsed`. The canvas→code path uses DSL-based dedup
  // (lastDslPushed) so timing of Excalidraw's onChange callbacks doesn't
  // matter.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const push = () => {
      if (cancelled) return;
      try {
        const elements = buildScene(parsed);
        lastDslPushed.current = serializeScene(elements);
        lastPushAt.current = Date.now();
        api.updateScene({ elements });
        if (!didInitialFit.current && elements.length > 0) {
          didInitialFit.current = true;
          requestAnimationFrame(() => {
            try {
              api.scrollToContent(elements, { fitToContent: true, animate: false });
            } catch {
              /* ignore */
            }
          });
        }
      } catch (err) {
        console.error("[codedraw] buildScene failed", err);
      }
    };
    // Defer the very first push by a frame so Excalidraw has finished
    // mounting and won't overwrite our scene with `initialData` afterwards.
    if (!didInitialFit.current) {
      const raf = requestAnimationFrame(push);
      return () => {
        cancelled = true;
        cancelAnimationFrame(raf);
      };
    }
    push();
    return () => {
      cancelled = true;
    };
  }, [api, parsed]);

  // CANVAS → CODE
  const onCanvasChange = useCallback(
    (
      elements: readonly ExcalidrawElement[],
      appState: {
        scrollX: number;
        scrollY: number;
        zoom: { value: number };
        width: number;
        height: number;
        viewBackgroundColor?: string;
      },
    ) => {
      const liveSig = sceneSignature(elements);
      if (liveSig !== lastLiveSignature.current) {
        lastLiveSignature.current = liveSig;
        setLiveElements(elements);
      }
      const vpSig = `${appState.scrollX}|${appState.scrollY}|${appState.zoom.value}|${appState.width}|${appState.height}`;
      if (vpSig !== lastViewportSig.current) {
        lastViewportSig.current = vpSig;
        setViewport({
          scrollX: appState.scrollX,
          scrollY: appState.scrollY,
          zoom: appState.zoom.value,
          width: appState.width,
          height: appState.height,
        });
      }
      if (appState.viewBackgroundColor && appState.viewBackgroundColor !== canvasBg) {
        setCanvasBg(appState.viewBackgroundColor);
      }

      const dsl = serializeScene(elements);
      // Echo window after a code→canvas push: Excalidraw runs normalisation
      // passes that mutate `boundElements`, recompute sizes, etc. and fires
      // onChange with a slightly different serialised form. Refresh our
      // baseline but never write back to source during this window.
      if (Date.now() - lastPushAt.current < 400) {
        lastDslPushed.current = dsl;
        return;
      }
      if (dsl === lastDslPushed.current) return;
      if (dsl === source) return;
      lastDslPushed.current = dsl;
      setSource(dsl);
    },
    [source, canvasBg],
  );

  const { width, onMouseDown } = useResizableSplit();

  const validationErrors = useMemo(
    () => validateElements(liveElements),
    [liveElements],
  );
  const errors = [...parsed.errors, ...validationErrors];

  return (
    <div className="cd-app">
      <header className="cd-header">
        <h1>CodeDraw</h1>
        <span style={{ opacity: 0.6 }}>code ⇄ diagram</span>
        <span className="cd-spacer" />
        <button
          type="button"
          className="cd-btn"
          onClick={flushSync}
          title="Sync code → canvas now (Shift+Enter)"
        >
          Sync ⮐
        </button>
        <button
          type="button"
          className="cd-btn"
          onClick={() => setEditorHidden((h) => !h)}
          title={editorHidden ? "Show code panel (Ctrl+B)" : "Hide code panel (Ctrl+B)"}
        >
          {editorHidden ? "Show code" : "Hide code"}
        </button>
      </header>
      <div
        className={`cd-split${editorHidden ? " cd-split--canvas-only" : ""}`}
        style={{ ["--editor-width" as any]: width }}
      >
        {!editorHidden && (
          <div className="cd-editor">
          <Editor
            height="100%"
            language={LANGUAGE_ID}
            theme="vs-dark"
            value={source}
            beforeMount={registerCodedrawLanguage}
            onChange={(v) => setSource(v ?? "")}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              wordWrap: "on",
              scrollBeyondLastLine: false,
              tabSize: 2,
              automaticLayout: true,
              bracketPairColorization: { enabled: true },
            }}
          />
          {errors.length > 0 && (
            <div className="cd-errors">
              {errors
                .map((e) =>
                  e.line > 0
                    ? `Line ${e.line}: ${e.message}${e.raw ? `  ›  ${e.raw}` : ""}`
                    : `⚠ ${e.message}`,
                )
                .join("\n")}
            </div>
          )}
          </div>
        )}
        {!editorHidden && <div className="cd-divider" onMouseDown={onMouseDown} />}
        <div className="cd-canvas">
          <Excalidraw
            onExcalidrawAPI={(a) => { setApi(a); (window as any).__excalidrawAPI = a; }}
            initialData={{ appState: { viewBackgroundColor: "#ffffff" } }}
            onChange={onCanvasChange}
            UIOptions={{
              canvasActions: {
                loadScene: false,
                saveToActiveFile: false,
                export: { saveFileToDisk: true },
              },
            }}
          >
            <MainMenu>
              <MainMenu.DefaultItems.ToggleTheme />
              <MainMenu.DefaultItems.ChangeCanvasBackground />
              <MainMenu.DefaultItems.Preferences />
              <MainMenu.DefaultItems.ClearCanvas />
              <MainMenu.DefaultItems.Export />
              <MainMenu.DefaultItems.SaveAsImage />
            </MainMenu>
            <WelcomeScreen>
              <WelcomeScreen.Hints.ToolbarHint />
              <WelcomeScreen.Hints.HelpHint />
            </WelcomeScreen>
          </Excalidraw>
          <Minimap elements={liveElements} viewport={viewport} backgroundColor={canvasBg} />
        </div>
      </div>
    </div>
  );
};

export default App;
