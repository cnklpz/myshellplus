import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles/base.css";
import { applyTheme, currentTheme } from "./lib/themes";

async function start() {
  applyTheme(currentTheme().id);
  if ("__TAURI_INTERNALS__" in window) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    if (getCurrentWindow().label === "switcher") {
      const { Switcher } = await import("./features/switcher/Switcher");
      ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Switcher />);
      return;
    }
  }
  // xterm measures glyphs once at startup: make sure the bundled mono font is ready first.
  await Promise.race([
    document.fonts.load('14px "JetBrains Mono Variable"').catch(() => {}),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
  // Opening the vite dev server in a normal browser: install a fake backend for UI review.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    await import("./dev/mockTauri");
  }
  const { default: App } = await import("./App");
  const { ErrorBoundary, reloadUi } = await import("./components/ErrorBoundary");
  // Ctrl+Shift+R / F5: reload the UI (sessions survive in the backend).
  window.addEventListener(
    "keydown",
    (e) => {
      if ((e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "r") || e.key === "F5") {
        e.preventDefault();
        reloadUi();
      }
    },
    true,
  );
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

start();
