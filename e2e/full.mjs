// End-to-end test of the real app against the local test SSH server (docker msp-sshd on :2222).
// Usage: ./launch.sh (fresh data dir) && node full.mjs [onlyStepSubstring]
import { connect, makeRunner, shot, SSH } from "./lib.mjs";

const only = process.argv[2];
const { browser, page, errors } = await connect();
const { step, results } = makeRunner();
const run = (name, fn) => (!only || name.includes(only) ? step(name, fn) : null);
const sleep = (ms) => page.waitForTimeout(ms);

/** Plain text of the active terminal (xterm buffer). */
const termText = () => page.evaluate(() => window.__termBus?.active()?.screenText(200) ?? "");
const typeInTerm = async (text) => {
  await page.locator(".term-view:visible .xterm-helper-textarea").focus();
  await page.keyboard.type(text, { delay: 15 });
};
const waitTerm = async (needle, ms = 8000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if ((await termText()).includes(needle)) return;
    await sleep(200);
  }
  throw new Error(`terminal never showed "${needle}"; tail: ${(await termText()).slice(-160)}`);
};

await run("home renders", async () => {
  await page.getByRole("heading", { name: "服务器" }).waitFor();
  await shot(page, "01-home-empty");
});

await run("add host via editor", async () => {
  await page.locator(".home-head button, .page-header button", { hasText: "新建" }).first().click();
  await page.getByPlaceholder("web-01").fill("e2e-box");
  await page.getByPlaceholder("生产").fill("测试");
  await page.getByPlaceholder("192.168.1.10").fill(SSH.host);
  const port = page.locator("input.num.mono").first();
  await port.fill(SSH.port);
  await page.getByPlaceholder("root").fill(SSH.user);
  await page.locator('input[type="password"]').first().fill(SSH.pass);
  await shot(page, "02-host-editor");
  await page.getByRole("button", { name: "保存" }).click();
  await page.locator(".home-card", { hasText: "e2e-box" }).waitFor();
  await shot(page, "03-home-card");
});

await run("connect + trust host key", async () => {
  await page.locator(".home-card", { hasText: "e2e-box" }).getByRole("button", { name: /快速连接/ }).click();
  const trust = page.getByRole("button", { name: "信任并连接" });
  await trust.waitFor({ timeout: 10000 });
  await shot(page, "04-hostkey");
  await trust.click();
  await page.locator(".term-view:visible .xterm").waitFor({ timeout: 10000 });
  await sleep(1500);
  await shot(page, "05-terminal");
});

await run("terminal echo", async () => {
  await typeInTerm("echo hello-$((40+2))\r");
  await waitTerm("hello-42");
});

await run("prediction popup", async () => {
  await typeInTerm("ech");
  await page.locator(".predict-popup, .pp, [class*=predict]").first().waitFor({ timeout: 4000 });
  await shot(page, "06-predict");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+U");
});

await run("monitor panel data", async () => {
  await page.locator(".side-tabs button", { hasText: "状态" }).click();
  await page.locator(".side-body").getByText(/CPU/).first().waitFor();
  await sleep(4500);
  const txt = await page.locator(".side-body").innerText();
  if (!/Alpine|Linux/.test(txt)) throw new Error("no OS info: " + txt.slice(0, 120));
  await shot(page, "07-monitor");
});

await run("monitor detail: processes", async () => {
  await page.locator(".side-body").getByText("进程", { exact: false }).first().click();
  await page.locator(".dialog").waitFor();
  await sleep(2000);
  const t = await page.locator(".dialog").innerText();
  if (!/PID/i.test(t)) throw new Error("no process table");
  await shot(page, "08-detail-proc");
  await page.keyboard.press("Escape");
});

await run("files panel lists home", async () => {
  await page.locator(".side-tabs button", { hasText: "文件" }).click();
  await sleep(1500);
  const t = await page.locator(".side-body").innerText();
  if (!/\/config|ssh_host_keys|logs/.test(t)) throw new Error("no listing: " + t.slice(0, 160));
  await shot(page, "09-files");
});

console.log("\nerrors:", errors.length ? errors.slice(0, 10) : "none");
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await browser.close();
process.exit(failed ? 1 : 0);
