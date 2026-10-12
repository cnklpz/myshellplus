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
  authType: "password" | "key";
  passwordSecret?: string | null;
  keyId?: string | null;
  jumpHostId?: string | null;
  tags: string[];
  color: string;
  notes: string;
  agentPolicy: AgentPolicy;
  sort: number;
  updatedAt: number;
}

export interface KeyEntry { id: string; name: string; publicKey: string; updatedAt: number }
export interface Snippet { id: string; name: string; command: string; tags: string[]; updatedAt: number }
export interface TunnelDef {
  id: string; name: string; hostId: string; kind: "local" | "remote" | "dynamic";
  bindAddr: string; bindPort: number; targetHost: string; targetPort: number; autoStart: boolean; updatedAt: number;
}
export interface TunnelStatus { id: string; running: boolean; up: number; down: number; active: number; error?: string | null }
export interface VaultStatus { initialized: boolean; unlocked: boolean; remembered: boolean }
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
export interface AiSettings { providers: AiProvider[]; active?: string | null; predictProvider?: string | null; predictEnabled: boolean; aiPredictEnabled: boolean }
export interface McpSettings { enabled: boolean; port: number; token: string }

export interface PromptEvent<T = any> { id: string; kind: "hostkey" | "agent"; data: T; created: number; expires: number }
export interface HostKeyPrompt { host: string; port: number; algo: string; fingerprint: string; changed: boolean; oldFingerprint?: string | null }
export interface AgentPrompt { hostId: string; hostName: string; host: string; action: string; detail: string; reason: string; dangerous: boolean }
export interface AuditEntry { id: number; ts: number; source: string; hostId?: string | null; action: string; detail: string; result: string }
export interface Latency { hostId: string; ms: number | null }
export interface ConnState { hostId: string; state: "connecting" | "connected" | "error" | "disconnected"; error?: string | null }

export type ImportSource = "openssh" | "putty" | "xshell" | "mobaxterm" | "finalshell" | "csv" | "backup";
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
  vaultSetup: (password: string, remember: boolean) => invoke<void>("vault_setup", { password, remember }),
  vaultUnlock: (password: string, remember: boolean) => invoke<void>("vault_unlock", { password, remember }),
  vaultLock: () => invoke<void>("vault_lock"),
  vaultRemember: (on: boolean) => invoke<void>("vault_remember", { on }),
  vaultChangePassword: (old: string, next: string) => invoke<void>("vault_change_password", { old, new: next }),

  // hosts & keys
  hostList: () => invoke<Host[]>("host_list"),
  /** password: string sets, "" clears, undefined keeps */
  hostSave: (host: Partial<Host>, password?: string) => invoke<Host>("host_save", { host, password }),
  hostDelete: (id: string) => invoke<void>("host_delete", { id }),
  keyList: () => invoke<KeyEntry[]>("key_list"),
  keyImport: (name: string, privateKey: string, passphrase?: string) => invoke<KeyEntry>("key_import", { name, privateKey, passphrase }),
  keyGenerate: (name: string) => invoke<KeyEntry>("key_generate", { name }),
  keyDelete: (id: string) => invoke<void>("key_delete", { id }),

  // connections & terminals
  connConnect: (hostId: string) => invoke<void>("conn_connect", { hostId }),
  connDisconnect: (hostId: string) => invoke<void>("conn_disconnect", { hostId }),
  connList: () => invoke<string[]>("conn_list"),
  connLatency: () => invoke<Latency[]>("conn_latency"),
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
  historyRecord: (hostId: string, command: string) => invoke<void>("history_record", { hostId, command }),
  /** hostId "" = all hosts; newest first */
  historyList: (hostId: string, query = "", limit?: number) => invoke<HistoryHit[]>("history_list", { hostId, query, limit }),
  historyDelete: (hostId: string, command: string) => invoke<void>("history_delete", { hostId, command }),
  execRun: (hostId: string, command: string, timeoutSecs?: number) => invoke<ExecResult>("exec_run", { hostId, command, timeoutSecs }),

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
  aiSettingsGet: () => invoke<AiSettings>("ai_settings_get"),
  /** keys: providerId -> new API key ("" clears) */
  aiSettingsSave: (settings: AiSettings, keys: Record<string, string>) => invoke<void>("ai_settings_save", { settings, keys }),

  // MCP / agent
  mcpSettingsGet: () => invoke<{ settings: McpSettings; runningPort: number | null }>("mcp_settings_get"),
  mcpSettingsSave: (settings: McpSettings) => invoke<void>("mcp_settings_save", { settings }),
  mcpNewToken: () => invoke<string>("mcp_new_token"),
  promptList: () => invoke<PromptEvent[]>("prompt_list"),
  promptAnswer: (id: string, value: unknown) => invoke<void>("prompt_answer", { id, value }),
  auditList: (limit?: number) => invoke<AuditEntry[]>("audit_list", { limit }),

  // import / export
  importDefaultPath: (source: ImportSource) => invoke<string | null>("import_default_path", { source }),
  importPreview: (source: ImportSource, path: string, password?: string) => invoke<ImportPreview>("import_preview", { source, path, password }),
  importApply: (hosts: ImportCandidate[], snippets: Snippet[], backupPath?: string, backupPassword?: string) =>
    invoke<ImportResult>("import_apply", { hosts, snippets, backupPath, backupPassword }),
  exportBackup: (path: string, password?: string) => invoke<number>("export_backup", { path, password }),

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
