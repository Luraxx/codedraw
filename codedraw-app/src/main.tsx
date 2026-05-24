import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { renderSvg, renderPng, renderJson, validateDsl, inspectDsl } from "./render";

const params = new URLSearchParams(window.location.search);
const isRenderMode = params.get("mode") === "render";

declare global {
  interface Window {
    codedraw?: {
      renderSvg: typeof renderSvg;
      renderPng: typeof renderPng;
      renderJson: typeof renderJson;
      validateDsl: typeof validateDsl;
      inspectDsl: typeof inspectDsl;
      ready: true;
    };
  }
}

if (isRenderMode) {
  // Headless export mode: expose API on window, render nothing visible.
  window.codedraw = { renderSvg, renderPng, renderJson, validateDsl, inspectDsl, ready: true };
  document.body.style.background = "#000";
  const root = document.getElementById("root");
  if (root) {
    root.textContent = "codedraw render mode ready";
    root.style.color = "#666";
    root.style.fontFamily = "monospace";
    root.style.padding = "8px";
  }
} else {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
