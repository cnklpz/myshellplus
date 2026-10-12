// End-to-end test of the real app against the local test SSH server (docker msp-sshd on :2222).
// Usage: ./launch.sh (fresh data dir) && node full.mjs [onlyStepSubstring]
import http from "node:http";
import { connect, makeRunner, shot, SSH } from "./lib.mjs";

const only = process.argv[2];
const { browser, page, errors } = await connect();
const { step, results } = makeRunner(async (name) => {
  await page.screenshot({ path: `shots/FAIL-${name.replace(/[^\w]+/g, "-")}.png` });
  for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
});
const run = (name, fn) => (!only || name.includes(only) ? step(name, fn) : null);
const sleep = (ms) => page.waitForTimeout(ms);
const invoke = (cmd, args) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args ?? {}]);

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

// Fake OpenAI-compatible endpoint: rejects the Qwen thinking switch once (client must retry without it).
const aiReqs = [];
const fakeAi = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = JSON.parse(body || "{}");
    aiReqs.push(j);
    res.setHeader("content-type", "application/json");
    if ("enable_thinking" in j) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: { message: "unrecognized field: enable_thinking" } }));
    }
    const user = j.messages?.at(-1)?.content ?? "";
    const content = user.includes("用户的需求")
      ? JSON.stringify([{ command: "df -h /", description: "磁盘占用" }])
      : user.includes("前缀: ech")
        ? JSON.stringify([{ command: "echo ai-from-fake", description: "测试" }])
        : "[]";
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise((r) => fakeAi.listen(0, "127.0.0.1", r));

await run("AI: Chinese at prompt becomes a command", async () => {
  const saved = await invoke("ai_settings_get");
  try {
    await invoke("ai_settings_save", {
      settings: {
        providers: [{ id: "fake", name: "Fake", kind: "openai", baseUrl: `http://127.0.0.1:${fakeAi.address().port}/v1`, model: "qwen-fake" }],
        active: "fake",
        predictProvider: "fake",
        predictEnabled: true,
        aiPredictEnabled: true,
        nlPredictEnabled: true,
        thinking: false,
      },
      keys: {},
    });
    await page.evaluate(() => window.dispatchEvent(new Event("msp:ai-settings")));
    await sleep(300);
    await typeInTerm("查看磁盘");
    await page.locator(".predict-row.ai", { hasText: "df -h /" }).waitFor({ timeout: 8000 });
    await shot(page, "06b-ai-nl");
    await page.keyboard.press("Enter"); // fills the command in, does not run the Chinese line
    await sleep(300);
    if (!(await termText()).includes("df -h /")) throw new Error("command not filled in");
    await page.keyboard.press("Enter");
    await waitTerm("Filesystem");
    if (!aiReqs.some((r) => !("enable_thinking" in r))) throw new Error("no retry without enable_thinking");

    await typeInTerm("ech");
    await page.locator(".predict-row.ai", { hasText: "ai-from-fake" }).waitFor({ timeout: 8000 });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+U");
  } finally {
    await invoke("ai_settings_save", { settings: saved, keys: {} });
    await page.evaluate(() => window.dispatchEvent(new Event("msp:ai-settings")));
  }
});

await run("home: latency test", async () => {
  await page.locator(".sb-item", { hasText: "首页" }).click();
  await page.locator(".page-header button", { hasText: "全部测速" }).click();
  const card = page.locator(".home-card", { hasText: "e2e-box" });
  await card.locator(".home-latency-value").filter({ hasText: /\d+ ms/ }).waitFor({ timeout: 8000 });
  await card.locator(".home-more").click();
  await page.locator(".home-menu button", { hasText: "测速" }).click();
  await card.locator(".home-latency-value").filter({ hasText: /\d+ ms/ }).waitFor({ timeout: 8000 });
  await shot(page, "06c-home-latency");
  await page.locator(".sb-item", { hasText: "终端" }).click();
  await page.locator(".term-view:visible .xterm").waitFor();
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

// ---------------------------------------------------------------- batch 2
const modal = () => page.locator(".page-modal-overlay:visible .page-modal");
const closeModal = async () => {
  await page.keyboard.press("Escape");
  await sleep(300);
};
const backToTerm = async () => {
  await page.locator(".sb-item", { hasText: "终端" }).click();
  await sleep(300);
};

await run("global search palette", async () => {
  await page.locator(".gs-trigger").click();
  await page.locator(".pal-input").waitFor();
  await shot(page, "10a-palette-empty");
  await page.keyboard.type("e2e");
  await page.locator(".pal-item", { hasText: "e2e-box" }).first().waitFor();
  await shot(page, "10-global-search");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("主题");
  await page.locator(".pal-item", { hasText: "外观 · 主题" }).first().waitFor();
  await page.keyboard.press("Enter");
  await modal().locator(".theme-tile").first().waitFor();
  await closeModal();
  await page.keyboard.press("Control+p");
  await page.locator(".pal-input").waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".pal-input").waitFor({ state: "detached" });
});

await run("global context menu", async () => {
  await page.locator(".sb-item", { hasText: "首页" }).click();
  await page.locator(".page").first().click({ button: "right", position: { x: 600, y: 600 } });
  const m = page.locator(".gctx");
  await m.waitFor();
  const t = await m.innerText();
  if (!t.includes("搜索") || !t.includes("新建服务器")) throw new Error(t);
  await shot(page, "10b-global-ctx");
  await page.keyboard.press("Escape");
  await page.locator(".home-head input, .page-header input").first().click({ button: "right" });
  const t2 = await page.locator(".gctx").innerText();
  if (!t2.includes("粘贴") || !t2.includes("全选")) throw new Error(t2);
  await page.keyboard.press("Escape");
});

await run("context menu + history", async () => {
  await backToTerm();
  await page.locator(".term-view:visible .xterm-screen").click({ button: "right" });
  const menu = page.locator(".ctx-menu");
  await menu.waitFor();
  await shot(page, "11-context-menu");
  const labels = await menu.innerText();
  for (const l of ["粘贴", "清屏", "命令历史", "重新连接"]) if (!labels.includes(l)) throw new Error("menu missing " + l);
  await menu.getByText("命令历史").click();
  const dlg = page.locator(".dialog", { hasText: "命令历史" });
  await dlg.waitFor();
  await sleep(600);
  const hist = await dlg.innerText();
  if (!hist.includes("echo hello")) throw new Error("history missing echo: " + hist.slice(0, 200));
  await shot(page, "12-history");
  await page.keyboard.press("Escape");
});

await run("batch dialog sends lines", async () => {
  await page.locator(".term-toolbar .term-tool", { hasText: "批量执行" }).click();
  const dlg = page.locator(".dialog", { hasText: "批量执行" });
  await dlg.waitFor();
  await dlg.locator("textarea").fill("echo batch-one\necho batch-$((1+1))");
  await shot(page, "13-batch-dialog");
  await dlg.getByRole("button", { name: /执行/ }).click();
  await waitTerm("batch-2");
});

await run("multi-host exec modal", async () => {
  await page.locator(".term-toolbar .term-tool", { hasText: "多机执行" }).click();
  const m = modal();
  await m.getByText("e2e-box").first().click();
  await m.locator("textarea").first().fill("uname -s");
  await m.getByRole("button", { name: /执行/ }).click();
  await m.getByText("Linux").first().waitFor({ timeout: 15000 });
  await shot(page, "14-multi-exec");
  await closeModal();
});

await run("commands: create", async () => {
  await page.locator(".term-toolbar .term-tool", { hasText: /^命令$/ }).click();
  const m = modal();
  await m.getByTitle("新建命令").click();
  const dlg = page.locator(".dialog").last();
  await dlg.locator("input").first().fill("查看内核");
  await dlg.locator("textarea").fill("uname -r");
  await dlg.getByRole("button", { name: "保存" }).click();
  await m.getByText("查看内核").waitFor();
  await shot(page, "15-commands");
  await closeModal();
});

await run("tunnel: local forward works", async () => {
  await page.locator(".term-toolbar .term-tool", { hasText: "隧道" }).click();
  const m = modal();
  await m.getByRole("button", { name: /新建/ }).first().click();
  const dlg = page.locator(".dialog").last();
  await dlg.getByPlaceholder("数据库").fill("ssh-self");
  await dlg.locator(".select-btn").first().click();
  await page.locator(".select-menu .select-item", { hasText: "e2e-box" }).click();
  // inputs: 名称, 监听地址, 监听端口, 目标地址, 目标端口
  const inputs = dlg.locator("input.input");
  await inputs.nth(2).fill("18922");
  await inputs.nth(3).fill("127.0.0.1");
  await inputs.nth(4).fill("2222");
  await dlg.getByRole("button", { name: "保存" }).click();
  await m.getByText("ssh-self").waitFor();
  await m.getByRole("button", { name: /启动/ }).first().click();
  await sleep(1500);
  const st = await invoke("tunnel_status");
  await shot(page, "16-tunnels");
  if (!st.some((t) => t.running)) throw new Error("not running: " + JSON.stringify(st));
  await closeModal();
});

for (const [name, sel, needle] of [
  ["detail: cpu", '.mon-tile:has-text("CPU")', /型号|架构/],
  ["detail: memory", '.mon-tile:has-text("内存")', /可用|缓存/],
  ["detail: network", '.mon-sec:has-text("网络")', /端口|接收/],
  ["detail: disk", '.mon-sec:has-text("磁盘"):not(:has-text("IO"))', /挂载|inode/i],
]) {
  await run(name, async () => {
    await page.locator(".side-tabs button", { hasText: "状态" }).click();
    await sleep(500);
    await page.locator(".side-body " + sel).first().click();
    const d = page.locator(".dialog");
    await d.waitFor();
    await sleep(2500);
    const t = await d.innerText();
    if (!needle.test(t)) throw new Error("missing detail content: " + t.slice(0, 160));
    await shot(page, "17-" + name.replace(/\W+/g, "-"));
    await page.keyboard.press("Escape");
    await sleep(300);
  });
}

await run("files: mkdir + delete", async () => {
  await page.locator(".side-tabs button", { hasText: "文件" }).click();
  await sleep(1200);
  const body = page.locator(".side-body");
  await body.getByTitle(/新建文件夹/).first().click().catch(async () => {
    await body.locator(".fp-list").click({ button: "right", position: { x: 60, y: 260 } });
    await page.getByText("新建文件夹").first().click();
  });
  const dlg = page.locator(".dialog").last();
  await dlg.locator("input").first().fill("e2e-dir");
  await page.keyboard.press("Enter");
  await body.getByText("e2e-dir").waitFor();
  await body.getByText("e2e-dir").click({ button: "right" });
  await page.locator(".fp-menu, .ctx-menu").getByText("删除").click();
  await page.locator(".dialog").last().getByRole("button", { name: /删除/ }).click();
  await body.getByText("e2e-dir").waitFor({ state: "detached" });
});

await run("settings: add AI service from preset", async () => {
  await page.locator(".sb-item", { hasText: "设置" }).click();
  await page.locator(".set-nav button, .set-nav *", { hasText: "AI 服务" }).first().click().catch(() => {});
  await page.locator("button", { hasText: "添加服务" }).click();
  await page.locator(".select-menu .select-item", { hasText: "DeepSeek" }).click();
  const url = page.locator("input.input.mono[value='https://api.deepseek.com']");
  await url.waitFor({ timeout: 3000 });
  // quick pick a Claude model on the first Claude service
  await page.locator("button", { hasText: "常用模型" }).nth(1).click();
  await page.locator(".select-menu .select-item", { hasText: "sonnet-5-5" }).click();
  await page.locator("input.input.mono[value='claude-sonnet-5-5']").first().waitFor({ timeout: 3000 });
  await shot(page, "17b-ai-add");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
});

await run("theme switch", async () => {
  await page.locator(".sb-item", { hasText: "设置" }).click();
  await modal().getByText("外观").first().click();
  await modal().locator(".theme-tile", { hasText: "纸白" }).click();
  await sleep(500);
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg-0").trim());
  await shot(page, "18-theme-paper");
  await modal().locator(".theme-tile", { hasText: "石墨" }).click();
  if (bg !== "#ffffff") throw new Error("theme not applied: " + bg);
});

await run("master password on/off", async () => {
  await modal().getByText("安全").first().click();
  await modal().locator(".toggle").first().click();
  let dlg = page.locator(".dialog", { hasText: "开启主密码保护" });
  await dlg.locator("input[type=password]").nth(0).fill("e2e-password-1");
  await dlg.locator("input[type=password]").nth(1).fill("e2e-password-1");
  await dlg.getByRole("button", { name: "开启" }).click();
  await dlg.waitFor({ state: "detached" });
  await modal().getByText("立即锁定").waitFor();
  await modal().locator(".toggle").first().click();
  dlg = page.locator(".dialog", { hasText: "关闭主密码保护" });
  await dlg.locator("input[type=password]").fill("e2e-password-1");
  await dlg.locator(".dialog-footer").getByRole("button", { name: "关闭" }).click();
  await dlg.waitFor({ state: "detached" });
  const st = await invoke("vault_status");
  if (st.passwordEnabled || !st.unlocked) throw new Error(JSON.stringify(st));
  await closeModal();
});

await run("agent: enable MCP + call", async () => {
  await page.locator(".sb-item", { hasText: "Agent" }).click();
  const m = modal();
  await m.locator(".toggle").first().click();
  await sleep(1000);
  const s = await invoke("mcp_settings_get");
  if (!s.runningPort) throw new Error("MCP not running");
  const r = await fetch(`http://127.0.0.1:${s.runningPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + s.settings.token },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_hosts", arguments: {} } }),
  }).then((x) => x.json());
  if (!JSON.stringify(r).includes("e2e-box")) throw new Error(JSON.stringify(r).slice(0, 200));
  await shot(page, "19-agent");
  await closeModal();
});

await run("import CSV", async () => {
  const fs = await import("node:fs");
  fs.writeFileSync("D:/xm/msp-e2e/hosts.csv", "name,group,host,port,username\nimported-1,导入组,10.9.9.1,22,root\n");
  await page.locator(".gs-trigger").click();
  await page.keyboard.type("导入服务器");
  await page.keyboard.press("Enter");
  const d = page.locator(".dialog", { hasText: "导入" });
  await d.getByText("CSV").first().click();
  await d.locator("input.input").last().fill("D:\\xm\\msp-e2e\\hosts.csv");
  await d.getByRole("button", { name: "下一步" }).click();
  await d.getByText("imported-1").waitFor();
  await shot(page, "20-import");
  await d.getByRole("button", { name: /^导入/ }).last().click();
  await d.getByText(/完成/).last().waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".sb-hosts").getByText("imported-1").waitFor();
});

// ---------------------------------------------------------------- batch 3
const hostId = async (name) => (await invoke("host_list")).find((h) => h.name === name)?.id;
const remote = async (cmd) => (await invoke("exec_run", { hostId: await hostId("e2e-box"), command: cmd })).stdout;

await run("home: group tabs + export", async () => {
  await page.locator(".sb-item", { hasText: "首页" }).click();
  await page.locator(".home-tab", { hasText: "导入组" }).click();
  await page.locator(".home-card", { hasText: "imported-1" }).waitFor();
  if (await page.locator(".home-card", { hasText: "e2e-box" }).count()) throw new Error("other group still shown");
  await shot(page, "20b-home-tabs");
  await page.locator(".home-tab", { hasText: "全部" }).click();
  await page.locator(".home-card", { hasText: "e2e-box" }).waitFor();
  await page.locator(".page-header button", { hasText: "导出" }).click();
  await page.getByText("导出备份").first().waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".sb-item", { hasText: "终端" }).click();
  await page.locator(".term-view:visible .xterm").waitFor();
});

await run("local echo overlay on slow link", async () => {
  await backToTerm();
  await page.evaluate(() => {
    localStorage.setItem("localEcho", "on");
    window.dispatchEvent(new Event("local-echo-change"));
  });
  await page.locator(".term-view:visible .xterm-helper-textarea").focus();
  await page.keyboard.type("echo predicted", { delay: 5 });
  const shown = await page.evaluate(() => {
    const o = [...document.querySelectorAll(".local-echo")].find((e) => e.style.display !== "none");
    return o ? o.textContent : "";
  });
  await page.keyboard.press("Enter");
  await waitTerm("predicted");
  await page.evaluate(() => {
    localStorage.setItem("localEcho", "auto");
    window.dispatchEvent(new Event("local-echo-change"));
  });
  if (!shown) throw new Error("no overlay while typing");
  return `overlay "${shown}"`;
});

await run("files: create + edit + save", async () => {
  await page.locator(".side-tabs button", { hasText: "文件" }).click();
  await sleep(800);
  const body = page.locator(".side-body");
  await body.locator(".fp-list").click({ button: "right", position: { x: 60, y: 300 } });
  await page.getByText("新建文件", { exact: true }).click();
  await page.locator(".dialog").last().locator("input").first().fill("e2e.txt");
  await page.keyboard.press("Enter");
  await body.getByText("e2e.txt").dblclick();
  const ed = page.locator(".dialog", { hasText: "e2e.txt" });
  await ed.locator("textarea").fill("line-1\n中文内容\n");
  await page.keyboard.press("Control+s");
  await sleep(800);
  await shot(page, "21-editor");
  await page.keyboard.press("Escape");
  const out = await remote("cat ~/e2e.txt; rm -f ~/e2e.txt");
  if (!out.includes("中文内容")) throw new Error("saved content: " + out);
});

await run("upload via transfer + list refresh", async () => {
  const fs = await import("node:fs");
  fs.writeFileSync("D:/xm/msp-e2e/up.bin", Buffer.alloc(300000, 7));
  const home = (await invoke("sftp_list", { hostId: await hostId("e2e-box"), path: "" })).path;
  const id = await invoke("transfer_start", { hostId: await hostId("e2e-box"), direction: "upload", local: "D:\\xm\\msp-e2e\\up.bin", remote: home + "/up.bin" });
  for (let i = 0; i < 30; i++) {
    const t = (await invoke("transfer_list")).find((x) => x.id === id);
    if (t && t.state !== "running") {
      if (t.state !== "done") throw new Error(t.error);
      break;
    }
    await sleep(200);
  }
  const size = (await remote("wc -c < ~/up.bin; rm -f ~/up.bin")).trim();
  if (size !== "300000") throw new Error("size " + size);
});

await run("key manager: generate key", async () => {
  await page.locator(".home-card, .sb-hosts .hs-host").first();
  await page.locator(".sb-hosts").getByText("e2e-box").click({ button: "right" });
  await page.getByText("编辑", { exact: true }).last().click();
  const editor = page.locator(".he-main, .he-dialog, .overlay").last();
  await editor.getByText("密钥", { exact: true }).first().click();
  await editor.getByRole("button", { name: /管理/ }).first().click();
  const km = page.locator(".dialog", { hasText: "密钥" }).last();
  await km.getByRole("button", { name: /生成/ }).click();
  await page.locator(".dialog").last().locator("input").first().fill("e2e-key");
  await page.locator(".dialog").last().getByRole("button", { name: /生成/ }).last().click();
  await page.getByText(/ssh-ed25519 AAAA/).first().waitFor();
  await shot(page, "22-keygen");
  for (let i = 0; i < 2; i++) await page.keyboard.press("Escape");
  // leave the host on password auth: cancel the editor without saving
  await page.getByRole("button", { name: "取消" }).last().click().catch(() => {});
  await page.keyboard.press("Escape");
  const keys = await invoke("key_list");
  if (!keys.some((k) => k.name === "e2e-key" && k.publicKey.startsWith("ssh-ed25519"))) throw new Error("key not saved");
});

await run("dangerous batch needs confirm", async () => {
  await backToTerm();
  await page.locator(".term-toolbar .term-tool", { hasText: "批量执行" }).click();
  const dlg = page.locator(".dialog", { hasText: "批量执行" });
  await dlg.locator("textarea").fill("rm -rf /tmp/e2e-danger-test");
  await dlg.getByRole("button", { name: /执行/ }).click();
  await page.getByText("包含高风险命令").waitFor();
  await shot(page, "23-danger");
  await page.getByRole("button", { name: "取消" }).first().click();
  await page.keyboard.press("Escape");
});

await run("snippet with variables", async () => {
  await invoke("snippet_save", { snippet: { name: "打印变量", command: "echo var-{{word:abc}}", tags: [] } });
  await page.locator(".side-tabs button", { hasText: "命令" }).click();
  await page.locator(".side-body").getByText("打印变量").click();
  const d = page.locator(".dialog").last();
  await d.locator("input").first().fill("xyz");
  await page.keyboard.press("Enter");
  await sleep(300);
  await page.keyboard.press("Enter");
  await waitTerm("var-xyz");
});

await run("disconnect + reconnect", async () => {
  await page.locator(".sb-hosts").getByText("e2e-box").click({ button: "right" });
  await page.getByText("断开", { exact: true }).last().click();
  await page.getByText("连接已断开").waitFor({ timeout: 10000 });
  await shot(page, "24-disconnected");
  await page.getByRole("button", { name: /重新连接/ }).click();
  await sleep(2500);
  await typeInTerm("echo back-$((2*21))\r");
  await waitTerm("back-42");
});

await run("AI without key shows error", async () => {
  await page.locator(".term-toolbar .term-tool", { hasText: "AI 命令" }).click();
  await page.keyboard.type("列出当前目录");
  await page.keyboard.press("Enter");
  await page.getByText(/API Key|AI 服务/).first().waitFor({ timeout: 8000 });
  await shot(page, "25-ai-nokey");
  await page.keyboard.press("Escape");
});

await run("theme persists after reload", async () => {
  await page.evaluate(() => localStorage.setItem("theme", "nord"));
  await page.reload();
  await page.getByText("首页").first().waitFor();
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg-0").trim());
  await page.evaluate(() => localStorage.setItem("theme", "graphite"));
  if (bg !== "#2e3440") throw new Error("bg " + bg);
});

await run("sessions survive UI reload", async () => {
  await page.reload();
  await page.locator(".sb-item", { hasText: "终端" }).click();
  await page.locator(".term-view:visible .xterm").waitFor();
  await sleep(800);
  await typeInTerm("echo alive-$((6*7))\r");
  await waitTerm("alive-42");
});

await run("lock screen + unlock", async () => {
  await invoke("vault_setup", { password: "e2e-password-2", remember: false });
  await invoke("vault_lock");
  await page.reload();
  const pw = page.locator("input[type=password]").first();
  await pw.waitFor();
  await shot(page, "26-locked");
  await pw.fill("wrong-password");
  await page.keyboard.press("Enter");
  await page.getByText(/错误/).first().waitFor();
  await pw.fill("e2e-password-2");
  await page.keyboard.press("Enter");
  await page.locator(".sb-item", { hasText: "首页" }).waitFor();
  await invoke("vault_disable_password", { password: "e2e-password-2" });
});

console.log("\nerrors:", errors.length ? errors.slice(0, 10) : "none");
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
fakeAi.close();
await browser.close();
process.exit(failed ? 1 : 0);
