import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import ErrorBoundary from "@/components/ErrorBoundary";

// Render a visible overlay for any error that escapes React's ErrorBoundary
// (e.g. a top-level module evaluation throw). Without this, such failures show
// up only as a silent grey webview with no clue in the Extension Host log.
function showFatalOverlay(label: string, detail: unknown): void {
  const text = detail instanceof Error ? detail.stack || detail.message : String(detail);
  // eslint-disable-next-line no-console
  console.error(`[omni] ${label}:`, detail);
  const root = document.getElementById("root");
  if (!root) return;
  const pre = document.createElement("pre");
  pre.setAttribute(
    "style",
    "white-space:pre-wrap;word-break:break-word;padding:24px;color:#f85149;background:#0b0d12;font:13px/1.5 ui-monospace,monospace;margin:0",
  );
  pre.textContent = `Omni webview failed to start (${label}):\n\n${text}`;
  root.innerHTML = "";
  root.appendChild(pre);
}

window.addEventListener("error", (e) => showFatalOverlay("window error", e.error || e.message));
window.addEventListener("unhandledrejection", (e) =>
  showFatalOverlay("unhandled rejection", (e as PromiseRejectionEvent).reason),
);

// Initialize VS Code API for webview communication
declare const acquireVsCodeApi: () => any;
try {
  (window as any).vscode = acquireVsCodeApi();
} catch {
  // acquireVsCodeApi is not available in non-webview contexts
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
