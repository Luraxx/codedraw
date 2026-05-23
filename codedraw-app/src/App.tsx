import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
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

const STORAGE_KEY = "codedraw:source:v2";

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

/**
 * Cheap structural signature for an element array — used to avoid running
 * the (otherwise harmless but allocating) serializer on every cursor tick.
 */
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

  // Feedback-loop guards.
  // When code is applied to the canvas, the next Excalidraw onChange would
  // serialize the (just-applied) elements back into identical code — we use
  // the signature compare for that, no flag needed. The flag is only needed
  // when the canvas writes new code into the editor: Monaco will then fire
  // onChange, and we must skip rebuilding the scene from that text.
  const applyingFromCanvas = useRef(false);
  const lastAppliedSignature = useRef<string>("");
  const lastSerializedFromCanvas = useRef<string>("");

  const debouncedSource = useDebounced(source, 120);

  // persist
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, source);
    } catch {
      /* ignore quota */
    }
  }, [source]);

  // CODE → CANVAS
  const parsed = useMemo(() => parseDsl(debouncedSource), [debouncedSource]);
  useEffect(() => {
    if (!api) return;
    if (applyingFromCanvas.current) {
      // This source change originated from a canvas edit; the canvas is
      // already in the right state. Just consume the flag.
      applyingFromCanvas.current = false;
      return;
    }
    try {
      const elements = buildScene(parsed);
      api.updateScene({ elements });
      lastAppliedSignature.current = sceneSignature(elements);
      // also pre-seed the serialized cache so the next onChange tick
      // (triggered by updateScene itself) is a noop.
      lastSerializedFromCanvas.current = source;
    } catch (err) {
      console.error("[codedraw] buildScene failed", err);
    }
  }, [api, parsed, source]);

  // CANVAS → CODE
  const onCanvasChange = useCallback(
    (elements: readonly ExcalidrawElement[]) => {
      const sig = sceneSignature(elements);
      if (sig === lastAppliedSignature.current) return;
      lastAppliedSignature.current = sig;

      const dsl = serializeScene(elements);
      // Avoid feedback if the serializer produced the same text we already have.
      if (dsl === lastSerializedFromCanvas.current) return;
      lastSerializedFromCanvas.current = dsl;

      // If nothing changed at the source-of-truth level (after normalization)
      // do not touch Monaco — preserves the user's cursor/selection.
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
            defaultLanguage="plaintext"
            theme="vs-dark"
            value={source}
            onChange={(v) => setSource(v ?? "")}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              wordWrap: "on",
              scrollBeyondLastLine: false,
              tabSize: 2,
              automaticLayout: true,
            }}
          />
          {errors.length > 0 && (
            <div className="cd-errors">
              {errors
                .map((e) => `Line ${e.line}: ${e.message}  ›  ${e.raw}`)
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
