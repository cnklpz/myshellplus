// Typed wrappers for every Rust command. Field names are camelCase (serde rename_all).
import { Channel, invoke } from "@tauri-apps/api/core";

// ---------- types ----------
export type AgentPolicy = "deny" | "readonly" | "ask" | "auto";

export interface Host {
  id: string;
  name: string;
  groupName: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key" | "agent";
  /** key: id in key list; agent: SHA256 fingerprint of the agent key (null = any) */
  passwordSecret?: string | null;
  keyId?: string | null;
  jumpHostId?: string | null;
  /** SOCKS5 proxy; off keeps the saved settings */
  proxyEnabled: boolean;
  proxyHost: string;
  proxyPort: number;
  proxyUser: string;
  proxySecret?: string | null;
  tags: string[];
  color: string;
  notes: string;
  agentPolicy: AgentPolicy;
  sort: number;
  updatedAt: number;
}

/** Hotkeys in global-shortcut syntax ("Ctrl+Alt+KeyM"); "" = off. */
export interface HotkeySettings { toggle: string; switcher: string; openOnly: boolean }
export interface HotkeyStatus { toggleError?: string | null; switcherError?: string | null }
export interface SwitcherShow { openOnly: boolean; mainFocused: boolean }
export type SwitcherTarget = { tabId: string } | { hostId: string };

export interface AgentKey { fingerprint: string; comment: string; algo: string }
export interface OpAccount { id: string; email: string; url: string }
export interface OpStatus { detected: boolean; agent: boolean; cli: boolean; accounts: OpAccount[] }
/** category: SSH_KEY | SERVER | LOGIN | AGENT (agent-only fallback; id = fingerprint) */
export interface OpItem { id: string; title: string; category: string; vault: string; subtitle: string }
export interface OpVault { id: string; name: string }
export interface OpNewKey { id: string; publicKey: string; fingerprint: string }
export interface ChatMsg { role: "user" | "assistant"; content: string }
export interface OpHost { title: string; host: string; port?: number | null; username: string; password?: string | null; keyFingerprint?: string | null }

export interface KeyEntry { id: string; name: string; publicKey: string; updatedAt: number }
/** hostId null = every host; groupName "" = ungrouped */
export interface Snippet { id: string; name: string; command: string; tags: string[]; hostId?: string | null; groupName?: string; updatedAt: number }
export interface TunnelDef {
  id: string; name: string; hostId: string; kind: "local" | "remote" | "dynamic";
  bindAddr: string; bindPort: number; targetHost: string; targetPort: number; autoStart: boolean; updatedAt: number;
}
export interface TunnelStatus {
  id: string;
  running: boolean;
  up: number;
  down: number;
  active: number;
  error?: string | null;
  /** -R with bind port 0: the port the server actually allocated (null until known). */
  remotePort?: number | null;
}
export interface VaultStatus { initialized: boolean; unlocked: boolean; remembered: boolean; passwordEnabled: boolean }
export interface TermInfo { id: string; hostId: string; created: number; alive: boolean }
export interface ExecResult { stdout: string; stderr: string; exitCode: number | null; durationMs: number; truncated: boolean; timedOut: boolean }

export interface SysInfo { os: string; kernel: string; arch: string; hostname: string; cores: number; cpu: string; ip: string }
export interface DiskUsage { fs: string; mount: string; total: number; used: number }
export interface NetIf { name: string; rxRate: number; txRate: number; rxTotal: number; txTotal: number }
export interface Proc { pid: number; user: string; cpu: number; mem: number; rss: number; command: string }
export interface Sample {
  ts: number; cpu: number; cores: number[]; memTotal: number; memUsed: number; swapTotal: number; swapUsed: number;
  load: [number, number, number]; uptime: number; rxRate: number; txRate: number; readRate: number; writeRate: number;
  tcpConns: number; nets: NetIf[]; disks: DiskUsage[]; procs: Proc[];
}
export interface MonitorSnapshot { hostId: string; info: SysInfo | null; history: Sample[]; error: string | null }

export interface FileEntry { name: string; path: string; isDir: boolean; isLink: boolean; size: number; mtime: number; perms: number; owner: string }
export interface DirListing { path: string; entries: FileEntry[] }
export interface TransferInfo {
  id: string; hostId: string; direction: "upload" | "download"; local: string; remote: string;
  total: number; done: number; speed: number; state: "running" | "done" | "error" | "cancelled"; error?: string | null;
}
export interface BatchHostResult {
  batchId: string; hostId: string; state: "running" | "done" | "error";
  stdout: string; stderr: string; exitCode: number | null; durationMs: number; error?: string | null;
}
export interface HistoryHit { command: string; count: number; lastUsed: number }
export interface Suggestion { command: string; source: "history" | "snippet" | "builtin" | "ai"; description: string }
export interface NlCommand { command: string; explanation: string; dangerous: boolean }

export interface AiProvider { id: string; name: string; kind: "anthropic" | "openai"; baseUrl: string; model: string; apiKeySecret?: string | null }
export interface AiSettings { providers: AiProvider[]; active?: string | null; predictProvider?: string | null; predictEnabled: boolean; aiPredictEnabled: boolean; nlPredictEnabled: boolean; thinking: boolean; predictModel?: string | null }
export interface McpSettings { enabled: boolean; port: number; token: string }

export interface PromptEvent<T = any> { id: string; kind: "hostkey" | "agent"; data: T; created: number; expires: number }
export interface HostKeyPrompt { host: string; port: number; algo: string; fingerprint: string; changed: boolean; oldFingerprint?: string | null }
export interface AgentPrompt { hostId: string; hostName: string; host: string; action: string; detail: string; reason: string; dangerous: boolean }
export interface KnownHost { host: string; port: number; algo: string; fingerprint: string }
export interface AuditEntry { id: number; ts: number; source: string; hostId?: string | null; action: string; detail: string; result: string }
export interface Latency { hostId: string; ms: number | null; since?: number }
export interface Probe { hostId: string; ms: number | null; via: "ssh" | "tcp"; error?: string | null }
export interface ConnStep { hostId: string; label: string; detail?: string | null }
export interface ConnFailure { error: string; at: number }
export interface ConnState { hostId: string; state: "connecting" | "connected" | "error" | "disconnected"; error?: string | null }

/** One app log entry; ts is local time "2026-10-12 14:03:01.123". target: crash | perf | ui | app | conn:<hostId> | ... */
export interface LogEntry { ts: string; level: "ERROR" | "WARN" | "INFO" | "DEBUG"; target: string; msg: string }

export type ImportSource = "openssh" | "putty" | "xshell" | "mobaxterm" | "finalshell" | "termius" | "ishell" | "csv" | "backup";
export interface ImportCandidate {
  alias: string; name: string; group: string; host: string; port: number; username: string;
  password?: string | null; keyPath?: string | null; keyText?: string | null; keyPassphrase?: string | null;
  jumpAlias?: string | null; notes: string; tags: string[]; duplicate: boolean;
}
export interface ImportPreview { source: string; path: string; hosts: ImportCandidate[]; snippets: Snippet[]; tunnels: number; warnings: string[] }
export interface ImportResult { hosts: number; keys: number; snippets: number; tunnels: number; errors: string[] }

// ---------- commands ----------
export const api = {
  // vault
  vaultStatus: () => invoke<VaultStatus>("vault_status"),
  /** Turn on master password protection (default is Windows-account protection, no password). */
  vaultSetup: (password: string, remember: boolean) => invoke<void>("vault_setup", { password, remember }),
  vaultDisablePassword: (password: string) => invoke<void>("vault_disable_password", { password }),
  vaultUnlock: (password: string, remember: boolean) => invoke<void>("vault_unlock", { password, remember }),
  vaultLock: () => invoke<void>("vault_lock"),
  vaultRemember: (on: boolean) => invoke<void>("vault_remember", { on }),
  vaultChangePassword: (old: string, next: string) => invoke<void>("vault_change_password", { old, new: next }),

  // hosts & keys
  hostList: () => invoke<Host[]>("host_list"),
  /** password: string sets, "" clears, undefined keeps */
  hostSave: (host: Partial<Host>, password?: string, proxyPassword?: string) =>
    invoke<Host>("host_save", { host, password, proxyPassword }),
  hostDelete: (id: string) => invoke<void>("host_delete", { id }),
  keyList: () => invoke<KeyEntry[]>("key_list"),
  keyImport: (name: string, privateKey: string, passphrase?: string) => invoke<KeyEntry>("key_import", { name, privateKey, passphrase }),
  keyGenerate: (name: string) => invoke<KeyEntry>("key_generate", { name }),
  keyDelete: (id: string) => invoke<void>("key_delete", { id }),
  agentKeys: () => invoke<AgentKey[]>("agent_keys"),
  opStatus: () => invoke<OpStatus>("op_status"),
  opItems: (account?: string) => invoke<OpItem[]>("op_items", { account }),
  opItem: (reference: string, account?: string) => invoke<OpHost>("op_item", { reference, account }),
  opVaults: (account?: string) => invoke<OpVault[]>("op_vaults", { account }),
  /** The key pair is generated inside 1Password; only the public key comes back. */
  opCreateSshKey: (title: string, url: string, username: string, vault?: string, account?: string) =>
    invoke<OpNewKey>("op_create_ssh_key", { title, url, username, vault, account }),
  opCreateLogin: (title: string, url: string, username: string, password: string, vault?: string, account?: string) =>
    invoke<string>("op_create_login", { title, url, username, password, vault, account }),

  // connections & terminals
  connConnect: (hostId: string) => invoke<void>("conn_connect", { hostId }),
  connDisconnect: (hostId: string) => invoke<void>("conn_disconnect", { hostId }),
  connList: () => invoke<string[]>("conn_list"),
  /** host id -> last connect failure (live updates via the "conn-failures" event) */
  connFailures: () => invoke<Record<string, ConnFailure>>("conn_failures"),
  connFailureDismiss: (hostId: string) => invoke<void>("conn_failure_dismiss", { hostId }),
  connLatency: () => invoke<Latency[]>("conn_latency"),
  hostProbe: (hostIds: string[]) => invoke<Probe[]>("host_probe", { hostIds }),
  /** host id -> remote OS name (learned on connect; live updates via the "host-os" event) */
  hostOsMap: () => invoke<Record<string, string>>("host_os_map"),
  termOpen: (hostId: string, cols: number, rows: number) => invoke<TermInfo>("term_open", { hostId, cols, rows }),
  /** Output arrives on the channel as ArrayBuffer chunks (buffered output is replayed first). */
  termAttach: (id: string, onData: (data: ArrayBuffer) => void) => {
    const sink = new Channel<ArrayBuffer>();
    sink.onmessage = onData;
    return invoke<TermInfo>("term_attach", { id, sink });
  },
  termWrite: (id: string, data: string) => invoke<void>("term_write", { id, data }),
  termResize: (id: string, cols: number, rows: number) => invoke<void>("term_resize", { id, cols, rows }),
  termClose: (id: string) => invoke<void>("term_close", { id }),
  termList: () => invoke<TermInfo[]>("term_list"),
  /** Shell's current directory; null when it can't be determined (non-Linux, env marker dropped). */
  termCwd: (id: string) => invoke<string | null>("term_cwd", { id }),
  historyRecord: (hostId: string, command: string) => invoke<void>("history_record", { hostId, command }),
  /** hostId "" = all hosts; newest first */
  historyList: (hostId: string, query = "", limit?: number) => invoke<HistoryHit[]>("history_list", { hostId, query, limit }),
  historyDelete: (hostId: string, command: string) => invoke<void>("history_delete", { hostId, command }),
  /** `stdin` is written to the command (keeps secrets out of the command line and the audit log). */
  execRun: (hostId: string, command: string, timeoutSecs?: number, quiet?: boolean, stdin?: string) =>
    invoke<ExecResult>("exec_run", { hostId, command, timeoutSecs, quiet, stdin }),

  // monitor
  monitorSubscribe: (hostId: string) => invoke<MonitorSnapshot>("monitor_subscribe", { hostId }),
  monitorUnsubscribe: (hostId: string) => invoke<void>("monitor_unsubscribe", { hostId }),

  // sftp
  sftpList: (hostId: string, path: string) => invoke<DirListing>("sftp_list", { hostId, path }),
  sftpRead: (hostId: string, path: string) => invoke<string>("sftp_read", { hostId, path }),
  sftpWrite: (hostId: string, path: string, content: string) => invoke<void>("sftp_write", { hostId, path, content }),
  sftpMkdir: (hostId: string, path: string) => invoke<void>("sftp_mkdir", { hostId, path }),
  sftpRename: (hostId: string, from: string, to: string) => invoke<void>("sftp_rename", { hostId, from, to }),
  sftpRemove: (hostId: string, paths: string[]) => invoke<void>("sftp_remove", { hostId, paths }),
  sftpChmod: (hostId: string, path: string, mode: number) => invoke<void>("sftp_chmod", { hostId, path, mode }),
  transferStart: (hostId: string, direction: "upload" | "download", local: string, remote: string) =>
    invoke<string>("transfer_start", { hostId, direction, local, remote }),
  transferList: () => invoke<TransferInfo[]>("transfer_list"),
  transferCancel: (id: string) => invoke<void>("transfer_cancel", { id }),
  transferClear: () => invoke<void>("transfer_clear"),

  // tunnels
  tunnelList: () => invoke<TunnelDef[]>("tunnel_list"),
  tunnelSave: (tunnel: Partial<TunnelDef>) => invoke<TunnelDef>("tunnel_save", { tunnel }),
  tunnelDelete: (id: string) => invoke<void>("tunnel_delete", { id }),
  tunnelStart: (id: string) => invoke<void>("tunnel_start", { id }),
  tunnelStop: (id: string) => invoke<void>("tunnel_stop", { id }),
  tunnelStatus: () => invoke<TunnelStatus[]>("tunnel_status"),

  // snippets & batch
  snippetList: () => invoke<Snippet[]>("snippet_list"),
  snippetSave: (snippet: Partial<Snippet>) => invoke<Snippet>("snippet_save", { snippet }),
  snippetDelete: (id: string) => invoke<void>("snippet_delete", { id }),
  batchStart: (hostIds: string[], command: string, timeoutSecs: number) => invoke<string>("batch_start", { hostIds, command, timeoutSecs }),

  // prediction & AI
  predictLocal: (hostId: string, input: string) => invoke<Suggestion[]>("predict_local", { hostId, input }),
  predictAi: (hostId: string, input: string, screen: string) => invoke<Suggestion[]>("predict_ai", { hostId, input, screen }),
  aiNl2Cmd: (hostId: string, prompt: string) => invoke<NlCommand>("ai_nl2cmd", { hostId, prompt }),
  aiExplain: (hostId: string, text: string) => invoke<string>("ai_explain", { hostId, text }),
  aiChat: (hostId: string, messages: ChatMsg[], screen?: string) => invoke<string>("ai_chat", { hostId, messages, screen }),
  aiSettingsGet: () => invoke<AiSettings>("ai_settings_get"),
  /** keys: providerId -> new API key ("" clears) */
  aiSettingsSave: (settings: AiSettings, keys: Record<string, string>) =>
    invoke<void>("ai_settings_save", { settings, keys }).then(() => {
      window.dispatchEvent(new Event("msp:ai-settings"));
    }),

  // MCP / agent
  mcpSettingsGet: () => invoke<{ settings: McpSettings; runningPort: number | null; error?: string | null }>("mcp_settings_get"),
  mcpSettingsSave: (settings: McpSettings) => invoke<void>("mcp_settings_save", { settings }),
  mcpNewToken: () => invoke<string>("mcp_new_token"),
  promptList: () => invoke<PromptEvent[]>("prompt_list"),
  promptAnswer: (id: string, value: unknown) => invoke<void>("prompt_answer", { id, value }),
  auditList: (limit?: number) => invoke<AuditEntry[]>("audit_list", { limit }),
  knownHostList: () => invoke<KnownHost[]>("known_host_list"),
  knownHostDelete: (host: string, port: number) => invoke<void>("known_host_delete", { host, port }),

  // import / export
  importDefaultPath: (source: ImportSource) => invoke<string | null>("import_default_path", { source }),
  importPreview: (source: ImportSource, path: string, password?: string) => invoke<ImportPreview>("import_preview", { source, path, password }),
  importApply: (hosts: ImportCandidate[], snippets: Snippet[], backupPath?: string, backupPassword?: string) =>
    invoke<ImportResult>("import_apply", { hosts, snippets, backupPath, backupPassword }),
  /** `secrets` includes passwords and keys; `password` encrypts the file. */
  exportBackup: (path: string, secrets: boolean, password?: string) => invoke<number>("export_backup", { path, secrets, password }),

  // global hotkeys
  hotkeyGet: () => invoke<{ settings: HotkeySettings; status: HotkeyStatus }>("hotkey_get"),
  hotkeySave: (settings: HotkeySettings) => invoke<HotkeyStatus>("hotkey_save", { settings }),
  /** Pause the hotkeys while a new combination is being recorded. */
  hotkeySuspend: (on: boolean) => invoke<void>("hotkey_suspend", { on }),
  switcherPending: () => invoke<SwitcherShow | null>("switcher_pending"),
  switcherPresent: (height: number) => invoke<void>("switcher_present", { height }),
  switcherHide: () => invoke<void>("switcher_hide"),
  switcherPick: (target: SwitcherTarget) => invoke<void>("switcher_pick", { target }),

  // logs
  logWrite: (level: "error" | "warn" | "info", target: "crash" | "perf" | "ui", msg: string) => invoke<void>("log_write", { level, target, msg }),
  /** Recent warnings and errors, newest first. */
  logEvents: (limit?: number) => invoke<LogEntry[]>("log_events", { limit }),
  logDir: () => invoke<string | null>("log_dir"),
  /** Whole app log, redacted. */
  logExport: (path: string) => invoke<void>("log_export", { path }),
  /** The host's last connect attempt. */
  connLogExport: (hostId: string, path: string, redact: boolean) => invoke<void>("conn_log_export", { hostId, path, redact }),
  /** AI reading of the host's last connect attempt (Markdown); the log is redacted before sending. */
  connDiagnose: (hostId: string) => invoke<string>("conn_diagnose", { hostId }),

  // UI support
  uiHeartbeat: () => invoke<void>("ui_heartbeat"),
  /** Read a small (≤2MB) local text file, e.g. a private key picked with the open dialog. */
  localReadText: (path: string) => invoke<string>("local_read_text", { path }),
  /** Write a small local text file to a path picked with the save dialog. */
  localWriteText: (path: string, content: string) => invoke<void>("local_write_text", { path, content }),
};

/** Turn an invoke rejection into a readable message. */
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
