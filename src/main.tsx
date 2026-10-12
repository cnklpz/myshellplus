import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles/base.css";
import { applyTheme, currentTheme } from "./lib/themes";

async function start() {
  applyTheme(currentTheme().id);
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
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

start();
