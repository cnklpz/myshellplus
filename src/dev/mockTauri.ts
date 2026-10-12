// Dev-only: fake Tauri bridge so the UI can be opened in a plain browser (vite dev) for visual review.
// Loaded by main.tsx only when running outside Tauri in dev mode. Never bundled into the app logic.

type Cb = (payload: any) => void;
const callbacks = new Map<number, Cb>();
const listeners = new Map<string, number[]>();
let nextId = 1;

const now = Date.now();
const hosts = [
  { id: "h1", name: "web-prod-01", groupName: "生产", host: "10.0.1.11", port: 22, username: "root", authType: "key", keyId: "k1", jumpHostId: "h4", tags: ["nginx"], color: "#3fb6a8", notes: "", agentPolicy: "ask", sort: 0, updatedAt: now },
  { id: "h2", name: "web-prod-02", groupName: "生产", host: "10.0.1.12", port: 22, username: "root", authType: "key", keyId: "k1", jumpHostId: "h4", tags: ["nginx"], color: "", notes: "", agentPolicy: "readonly", sort: 0, updatedAt: now },
  { id: "h3", name: "db-master", groupName: "生产", host: "10.0.2.5", port: 22, username: "dba", authType: "password", passwordSecret: "s", tags: ["mysql"], color: "#e5a54b", notes: "", agentPolicy: "deny", sort: 0, updatedAt: now },
  { id: "h4", name: "bastion", groupName: "跳板", host: "47.100.12.34", port: 2222, username: "ops", authType: "key", keyId: "k1", tags: [], color: "", notes: "", agentPolicy: "auto", sort: 0, updatedAt: now },
  { id: "h5", name: "dev-box", groupName: "", host: "192.168.1.20", port: 22, username: "me", authType: "password", passwordSecret: "s", tags: [], color: "", notes: "", agentPolicy: "auto", sort: 0, updatedAt: now },
];

function sample(i: number) {
  const t = now - (60 - i) * 3000;
  const w = (a: number, b: number) => a + (Math.sin(i / 4) + 1) * b + Math.random() * b * 0.4;
  return {
    ts: t, cpu: w(12, 18), cores: [w(10, 20), w(5, 30), w(20, 10), w(8, 15)],
    memTotal: 8 * 2 ** 30, memUsed: w(4.2, 0.6) * 2 ** 30, swapTotal: 2 * 2 ** 30, swapUsed: 0.3 * 2 ** 30,
    load: [0.42, 0.38, 0.31], uptime: 86400 * 37 + 3600 * 5, rxRate: w(200e3, 300e3), txRate: w(80e3, 120e3),
    readRate: w(1e5, 4e5), writeRate: w(3e5, 6e5), tcpConns: 184,
    nets: [{ name: "eth0", rxRate: w(200e3, 300e3), txRate: w(80e3, 120e3), rxTotal: 9.3e11, txTotal: 2.1e11 }],
    disks: [
      { fs: "/dev/vda1", mount: "/", total: 80 * 2 ** 30, used: 52 * 2 ** 30 },
      { fs: "/dev/vdb", mount: "/data", total: 500 * 2 ** 30, used: 455 * 2 ** 30 },
    ],
    procs: [
      { pid: 1823, user: "www", cpu: 23.4, mem: 4.1, rss: 330e6, command: "nginx" },
      { pid: 912, user: "mysql", cpu: 11.2, mem: 31.5, rss: 2.6e9, command: "mysqld" },
      { pid: 4410, user: "root", cpu: 3.1, mem: 1.2, rss: 96e6, command: "node" },
      { pid: 1, user: "root", cpu: 0.0, mem: 0.1, rss: 12e6, command: "systemd" },
    ],
  };
}

const entries = [
  { name: "app", path: "/root/app", isDir: true, isLink: false, size: 4096, mtime: now / 1000 - 3600, perms: 0o755, owner: "root" },
  { name: "logs", path: "/root/logs", isDir: true, isLink: false, size: 4096, mtime: now / 1000 - 86400, perms: 0o755, owner: "root" },
  { name: ".bashrc", path: "/root/.bashrc", isDir: false, isLink: false, size: 3771, mtime: now / 1000 - 864000, perms: 0o644, owner: "root" },
  { name: "deploy.sh", path: "/root/deploy.sh", isDir: false, isLink: false, size: 1532, mtime: now / 1000 - 7200, perms: 0o755, owner: "root" },
  { name: "backup-2026-10-01.tar.gz", path: "/root/backup-2026-10-01.tar.gz", isDir: false, isLink: false, size: 1.4e9, mtime: now / 1000 - 900000, perms: 0o644, owner: "root" },
];

function emit(event: string, payload: unknown) {
  for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
}

const vault = { initialized: true, unlocked: new URLSearchParams(location.search).get("locked") === null, remembered: false };
const termChannels = new Map<string, number>();
const enc = new TextEncoder();

async function invoke(cmd: string, args: any = {}): Promise<any> {
  await new Promise((r) => setTimeout(r, 30));
  switch (cmd) {
    case "plugin:event|listen": {
      const arr = listeners.get(args.event) ?? [];
      arr.push(args.handler);
      listeners.set(args.event, arr);
      return args.handler;
    }
    case "plugin:event|unlisten":
      return null;
    case "vault_status": return { ...vault };
    case "vault_unlock": case "vault_setup": vault.unlocked = true; return null;
    case "vault_lock": vault.unlocked = false; return null;
    case "host_list": return hosts;
    case "key_list": return [{ id: "k1", name: "id_ed25519", publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq3xV2o0 ops@laptop", updatedAt: now }];
    case "conn_list": return ["h1", "h4"];
    case "conn_latency": return [{ hostId: "h1", ms: 290 }, { hostId: "h4", ms: 42 }];
    case "term_list": return [];
    case "term_open": {
      const id = "t" + nextId++;
      return { id, hostId: args.hostId, created: Date.now(), alive: true };
    }
    case "term_attach": {
      termChannels.set(args.id, args.sink.id);
      const h = hosts.find((x) => x.id === "h1")!;
      const text = `Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-45-generic x86_64)\r\n\r\nLast login: ${new Date().toUTCString()} from 10.0.0.2\r\n\x1b[1;32m${h.username}@${h.name}\x1b[0m:\x1b[1;34m~\x1b[0m# `;
      setTimeout(() => callbacks.get(args.sink.id)?.({ index: 0, message: enc.encode(text).buffer }), 50);
      return { id: args.id, hostId: "h1", created: Date.now(), alive: true };
    }
    case "term_write": {
      const cid = termChannels.get(args.id);
      const data = args.data === "\r" ? "\r\n\x1b[1;32mroot@web-prod-01\x1b[0m:\x1b[1;34m~\x1b[0m# " : args.data;
      const ch = callbacks.get(cid!);
      // Simulated slow link: echo comes back after ?lag=ms (default 300).
      const lag = Number(new URLSearchParams(location.search).get("lag") ?? 300);
      setTimeout(() => {
        (ch as any).__i = ((ch as any).__i ?? 0) + 1;
        ch?.({ index: (ch as any).__i, message: enc.encode(data).buffer });
      }, lag);
      return null;
    }
    case "monitor_subscribe":
      return {
        hostId: args.hostId,
        info: { os: "Ubuntu 24.04.1 LTS", kernel: "6.8.0-45-generic", arch: "x86_64", hostname: "web-prod-01", cores: 4, cpu: "Intel(R) Xeon(R) Platinum 8269CY CPU @ 2.50GHz", ip: "10.0.1.11" },
        history: Array.from({ length: 60 }, (_, i) => sample(i)),
        error: null,
      };
    case "sftp_list": return { path: args.path || "/root", entries };
    case "transfer_list": return [];
    case "tunnel_list":
      return [
        { id: "tu1", name: "MySQL", hostId: "h4", kind: "local", bindAddr: "127.0.0.1", bindPort: 13306, targetHost: "10.0.2.5", targetPort: 3306, autoStart: true, updatedAt: now },
        { id: "tu2", name: "代理", hostId: "h4", kind: "dynamic", bindAddr: "127.0.0.1", bindPort: 1080, targetHost: "", targetPort: 0, autoStart: false, updatedAt: now },
        { id: "tu3", name: "本地 Web 暴露", hostId: "h5", kind: "remote", bindAddr: "0.0.0.0", bindPort: 9000, targetHost: "127.0.0.1", targetPort: 3000, autoStart: false, updatedAt: now },
      ];
    case "tunnel_status":
      return [
        { id: "tu1", running: true, up: 1.2e6, down: 48e6, active: 2, error: null },
        { id: "tu3", running: false, up: 0, down: 0, active: 0, error: "服务器拒绝远程转发: request denied" },
      ];
    case "snippet_list":
      return [
        { id: "s1", name: "查看磁盘", command: "df -h", tags: ["系统"], updatedAt: now },
        { id: "s2", name: "重启服务", command: "systemctl restart {{service:nginx}}", tags: ["服务"], updatedAt: now },
        { id: "s3", name: "容器日志", command: "docker logs -f --tail 200 {{container}}", tags: ["docker"], updatedAt: now },
      ];
    case "predict_local":
      return [
        { command: "docker ps -a", source: "history", description: "用过 12 次" },
        { command: "docker logs -f --tail 200 ", source: "builtin", description: "容器日志" },
        { command: "docker compose up -d", source: "builtin", description: "后台启动 compose" },
      ].filter((s) => s.command.startsWith(args.input));
    case "ai_settings_get":
      return { providers: [{ id: "anthropic", name: "Claude", kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5", apiKeySecret: "x" }], active: "anthropic", predictProvider: "anthropic", predictEnabled: true, aiPredictEnabled: false };
    case "mcp_settings_get": return { settings: { enabled: true, port: 17890, token: "msp_3f9a0c1e2b7d4a6f8e1c0b9a7d6e5f4c3b2a1908" }, runningPort: 17890 };
    case "audit_list":
      return [
        { id: 3, ts: now - 60000, source: "agent", hostId: "h1", action: "run_command", detail: "systemctl status nginx", result: "allowed: policy" },
        { id: 2, ts: now - 120000, source: "agent", hostId: "h2", action: "run_command", detail: "rm -rf /tmp/cache", result: "denied: readonly" },
        { id: 1, ts: now - 300000, source: "user", hostId: null, action: "batch", detail: "3 台: uptime", result: "started" },
      ];
    case "prompt_list": return [];
    case "import_default_path": return args.source === "openssh" ? "C:\\Users\\me\\.ssh\\config" : null;
    case "ui_heartbeat": return null;
    case "batch_start": {
      const bid = "b" + nextId++;
      for (const hid of args.hostIds) {
        setTimeout(() => emit("batch", { batchId: bid, hostId: hid, state: "done", stdout: " 11:02:13 up 37 days,  5:01,  1 user,  load average: 0.42, 0.38, 0.31\n", stderr: "", exitCode: hid === "h2" ? 1 : 0, durationMs: 120, error: null }), 400);
      }
      return bid;
    }
    default:
      console.debug("[mock] unhandled", cmd, args);
      return null;
  }
}

setInterval(() => {
  const lag = Number(new URLSearchParams(location.search).get("lag") ?? 300);
  for (const id of ["h1", "h4"]) emit("latency", { hostId: id, ms: lag - 10 + Math.round(Math.random() * 20) });
}, 2000);
setInterval(() => emit("monitor", { hostId: "h1", sample: sample(60 + Math.random() * 10) }), 3000);

(window as any).__TAURI_INTERNALS__ = {
  invoke,
  transformCallback: (cb: Cb) => {
    const id = nextId++;
    callbacks.set(id, cb);
    return id;
  },
  unregisterCallback: (id: number) => callbacks.delete(id),
  convertFileSrc: (p: string) => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
};
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
export {};
