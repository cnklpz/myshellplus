// Drives the real MyShell+ window over WebView2's CDP port (see launch.sh).
import { chromium } from "playwright-core";

export const SSH = { host: "127.0.0.1", port: "2222", user: "tester", pass: "Test12345" };

export async function connect() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find((p) => p.url().includes("1420") || p.url().startsWith("http://tauri"));
  for (let i = 0; !page && i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    page = ctx.pages().find((p) => p.url().includes("1420"));
  }
  if (!page) page = ctx.pages()[0];
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
  return { browser, page, errors };
}

export async function shot(page, name) {
  await page.screenshot({ path: `shots/${name}.png` });
}

export function makeRunner(onFail) {
  const results = [];
  async function step(name, fn) {
    const t = Date.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true });
      console.log(`PASS  ${name.padEnd(34)} ${String(Date.now() - t).padStart(6)}ms  ${detail ?? ""}`);
    } catch (e) {
      results.push({ name, ok: false });
      if (onFail) await onFail(name).catch(() => {});
      console.log(`FAIL  ${name.padEnd(34)} ${String(Date.now() - t).padStart(6)}ms  ${String(e.message).split("\n")[0]}`);
    }
  }
  return { step, results };
}
