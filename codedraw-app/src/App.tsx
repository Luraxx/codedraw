import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  Excalidraw,
  MainMenu,
  WelcomeScreen,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import "@excalidraw/excalidraw/index.css";

import { parseDsl } from "./dsl/parser";
import { buildScene } from "./dsl/buildScene";
import { DEFAULT_CODE } from "./defaultCode";
import "./app.css";

const STORAGE_KEY = "codedraw:source";

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

const App = () => {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [source, setSource] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_CODE;
    } catch {
      return DEFAULT_CODE;
    }
  });

  const debounced = useDebounced(source, 150);
  const parsed = useMemo(() => parseDsl(debounced), [debounced]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, source);
    } catch {
      /* ignore quota errors */
    }
  }, [source]);

  useEffect(() => {
    if (!api) return;
    try {
      const elements = buildScene(parsed);
      api.updateScene({ elements });
      api.scrollToContent(elements, { fitToContent: true, animate: false });
    } catch (err) {
      // surface as parse error so user sees what's wrong
      console.error("[codedraw] buildScene failed", err);
    }
  }, [api, parsed]);

  const { width, onMouseDown } = useResizableSplit();

  const errors = parsed.errors;

  return (
    <div className="cd-app">
      <header className="cd-header">
        <h1>CodeDraw</h1>
        <span style={{ opacity: 0.6 }}>code → diagram</span>
        <span className="cd-spacer" />
        <a
          href="https://github.com/luisdehlwes/codedraw"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
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
            langCode="de-DE"
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
