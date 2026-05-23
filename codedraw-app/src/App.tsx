import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type Monaco } from "@monaco-editor/react";
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

const useDebounced = <T,>(value: T, delay: number): T => {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
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

const App = () => {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [source, setSource] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_CODE;
    } catch {
      return DEFAULT_CODE;
    }
  });

  const applyingFromCanvas = useRef(false);
  const canvasFrozenUntil = useRef(0);
  const lastAppliedSignature = useRef<string>("");
  const lastSerializedFromCanvas = useRef<string>("");

  const debouncedSource = useDebounced(source, 150);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, source);
    } catch {
      /* ignore */
    }
  }, [source]);

  const parsed = useMemo(() => parseDsl(debouncedSource), [debouncedSource]);

  // CODE → CANVAS
  // Depends only on `parsed`; `source` changes alone must not trigger this,
  // otherwise we'd repeatedly apply an out-of-date scene while the user is
  // still typing (debounce hasn't fired yet).
  useEffect(() => {
    if (!api) return;
    if (applyingFromCanvas.current) {
      applyingFromCanvas.current = false;
      return;
    }
    try {
      const elements = buildScene(parsed);
      // Freeze the canvas→code path for a tick: updateScene synchronously
      // fires onChange with re-numbered element versions, which would
      // otherwise serialise back over the user's hand-written code.
      canvasFrozenUntil.current = Date.now() + 250;
      api.updateScene({ elements });
      lastAppliedSignature.current = sceneSignature(elements);
    } catch (err) {
      console.error("[codedraw] buildScene failed", err);
    }
  }, [api, parsed]);

  // CANVAS → CODE
  const onCanvasChange = useCallback(
    (elements: readonly ExcalidrawElement[]) => {
      if (Date.now() < canvasFrozenUntil.current) return;
      const sig = sceneSignature(elements);
      if (sig === lastAppliedSignature.current) return;
      lastAppliedSignature.current = sig;

      const dsl = serializeScene(elements);
      if (dsl === lastSerializedFromCanvas.current) return;
      lastSerializedFromCanvas.current = dsl;
      if (dsl === source) return;

      applyingFromCanvas.current = true;
      setSource(dsl);
    },
    [source],
  );

  const { width, onMouseDown } = useResizableSplit();

  const errors = parsed.errors;

  return (
    <div className="cd-app">
      <header className="cd-header">
        <h1>CodeDraw</h1>
        <span style={{ opacity: 0.6 }}>code ⇄ diagram</span>
        <span className="cd-spacer" />
      </header>
      <div className="cd-split" style={{ ["--editor-width" as any]: width }}>
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
                .map((e) => `Line ${e.line}: ${e.message}${e.raw ? `  ›  ${e.raw}` : ""}`)
                .join("\n")}
            </div>
          )}
        </div>
        <div className="cd-divider" onMouseDown={onMouseDown} />
        <div className="cd-canvas">
          <Excalidraw
            excalidrawAPI={setApi}
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
              <MainMenu.DefaultItems.ClearCanvas />
              <MainMenu.DefaultItems.Export />
              <MainMenu.DefaultItems.SaveAsImage />
            </MainMenu>
            <WelcomeScreen>
              <WelcomeScreen.Hints.ToolbarHint />
              <WelcomeScreen.Hints.HelpHint />
            </WelcomeScreen>
          </Excalidraw>
        </div>
      </div>
    </div>
  );
};

export default App;
