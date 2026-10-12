use std::path::Path;

use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::util::{new_id, now_ms};

/// Every synced table carries `id`, `updated_at` and `deleted` so cloud sync can merge by last-write-wins.
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS hosts(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'password',
  password_secret TEXT,
  key_id TEXT,
  jump_host_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  color TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  agent_policy TEXT NOT NULL DEFAULT 'ask',
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS keys(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL DEFAULT '',
  private_secret TEXT NOT NULL,
  passphrase_secret TEXT,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS secrets(
  id TEXT PRIMARY KEY,
  nonce BLOB NOT NULL,
  data BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS snippets(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tunnels(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  bind_addr TEXT NOT NULL DEFAULT '127.0.0.1',
  bind_port INTEGER NOT NULL,
  target_host TEXT NOT NULL DEFAULT '',
  target_port INTEGER NOT NULL DEFAULT 0,
  auto_start INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS history(
  host_id TEXT NOT NULL,
  command TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  last_used INTEGER NOT NULL,
  PRIMARY KEY(host_id, command)
);
CREATE TABLE IF NOT EXISTS known_hosts(
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  algo TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY(host, port)
);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  host_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vault_meta(key TEXT PRIMARY KEY, value BLOB NOT NULL);
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub group_name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// password | key
    pub auth_type: String,
    #[serde(default)]
    pub password_secret: Option<String>,
    #[serde(default)]
    pub key_id: Option<String>,
    #[serde(default)]
    pub jump_host_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub notes: String,
    /// deny | readonly | ask | auto
    #[serde(default = "default_policy")]
    pub agent_policy: String,
    #[serde(default)]
    pub sort: i64,
    #[serde(default)]
    pub updated_at: i64,
}

fn default_policy() -> String {
    "ask".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyEntry {
    pub id: String,
    pub name: String,
    pub public_key: String,
    #[serde(skip_serializing)]
    pub private_secret: String,
    #[serde(skip_serializing)]
    pub passphrase_secret: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelDef {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub host_id: String,
    /// local | remote | dynamic
    pub kind: String,
    pub bind_addr: String,
    pub bind_port: u16,
    #[serde(default)]
    pub target_host: String,
    #[serde(default)]
    pub target_port: u16,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: i64,
    pub ts: i64,
    pub source: String,
    pub host_id: Option<String>,
    pub action: String,
    pub detail: String,
    pub result: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryHit {
    pub command: String,
    pub count: i64,
    pub last_used: i64,
}

pub struct Db {
    conn: Mutex<Connection>,
}

fn json_vec(s: String) -> Vec<String> {
    serde_json::from_str(&s).unwrap_or_default()
}

fn host_from_row(r: &Row) -> rusqlite::Result<Host> {
    Ok(Host {
        id: r.get("id")?,
        name: r.get("name")?,
        group_name: r.get("group_name")?,
        host: r.get("host")?,
        port: r.get::<_, i64>("port")? as u16,
        username: r.get("username")?,
        auth_type: r.get("auth_type")?,
        password_secret: r.get("password_secret")?,
        key_id: r.get("key_id")?,
        jump_host_id: r.get("jump_host_id")?,
        tags: json_vec(r.get("tags")?),
        color: r.get("color")?,
        notes: r.get("notes")?,
        agent_policy: r.get("agent_policy")?,
        sort: r.get("sort")?,
        updated_at: r.get("updated_at")?,
    })
}

fn tunnel_from_row(r: &Row) -> rusqlite::Result<TunnelDef> {
    Ok(TunnelDef {
        id: r.get("id")?,
        name: r.get("name")?,
        host_id: r.get("host_id")?,
        kind: r.get("kind")?,
        bind_addr: r.get("bind_addr")?,
        bind_port: r.get::<_, i64>("bind_port")? as u16,
        target_host: r.get("target_host")?,
        target_port: r.get::<_, i64>("target_port")? as u16,
        auto_start: r.get::<_, i64>("auto_start")? != 0,
        updated_at: r.get("updated_at")?,
    })
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).with_context(|| format!("打开数据库失败: {}", path.display()))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    // ---------- hosts ----------
    pub fn list_hosts(&self) -> Result<Vec<Host>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT * FROM hosts WHERE deleted=0 ORDER BY group_name, sort, name")?;
        let rows = st.query_map([], host_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_host(&self, id: &str) -> Result<Host> {
        let c = self.conn.lock();
        c.query_row("SELECT * FROM hosts WHERE id=?1 AND deleted=0", [id], host_from_row)
            .optional()?
            .ok_or_else(|| anyhow::anyhow!("服务器不存在: {id}"))
    }

    pub fn save_host(&self, mut h: Host) -> Result<Host> {
        if h.id.is_empty() {
            h.id = new_id();
        }
        h.updated_at = now_ms();
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO hosts(id,name,group_name,host,port,username,auth_type,password_secret,key_id,jump_host_id,tags,color,notes,agent_policy,sort,updated_at,deleted)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,0)
             ON CONFLICT(id) DO UPDATE SET name=?2,group_name=?3,host=?4,port=?5,username=?6,auth_type=?7,password_secret=?8,key_id=?9,
               jump_host_id=?10,tags=?11,color=?12,notes=?13,agent_policy=?14,sort=?15,updated_at=?16,deleted=0",
            params![
                h.id, h.name, h.group_name, h.host, h.port as i64, h.username, h.auth_type, h.password_secret, h.key_id,
                h.jump_host_id, serde_json::to_string(&h.tags)?, h.color, h.notes, h.agent_policy, h.sort, h.updated_at
            ],
        )?;
        Ok(h)
    }

    pub fn delete_host(&self, id: &str) -> Result<()> {
        let c = self.conn.lock();
        c.execute("UPDATE hosts SET deleted=1, updated_at=?2 WHERE id=?1", params![id, now_ms()])?;
        c.execute("UPDATE tunnels SET deleted=1, updated_at=?2 WHERE host_id=?1", params![id, now_ms()])?;
        Ok(())
    }

    // ---------- keys ----------
    pub fn list_keys(&self) -> Result<Vec<KeyEntry>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT id,name,public_key,private_secret,passphrase_secret,updated_at FROM keys WHERE deleted=0 ORDER BY name")?;
        let rows = st
            .query_map([], |r| {
                Ok(KeyEntry {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    public_key: r.get(2)?,
                    private_secret: r.get(3)?,
                    passphrase_secret: r.get(4)?,
                    updated_at: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_key(&self, id: &str) -> Result<KeyEntry> {
        self.list_keys()?
            .into_iter()
            .find(|k| k.id == id)
            .ok_or_else(|| anyhow::anyhow!("密钥不存在: {id}"))
    }

    pub fn save_key(&self, k: &KeyEntry) -> Result<()> {
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO keys(id,name,public_key,private_secret,passphrase_secret,updated_at,deleted) VALUES(?1,?2,?3,?4,?5,?6,0)
             ON CONFLICT(id) DO UPDATE SET name=?2,public_key=?3,private_secret=?4,passphrase_secret=?5,updated_at=?6,deleted=0",
            params![k.id, k.name, k.public_key, k.private_secret, k.passphrase_secret, now_ms()],
        )?;
        Ok(())
    }

    pub fn delete_key(&self, id: &str) -> Result<()> {
        let c = self.conn.lock();
        c.execute("UPDATE keys SET deleted=1, updated_at=?2 WHERE id=?1", params![id, now_ms()])?;
        Ok(())
    }

    // ---------- secrets (ciphertext only) ----------
    pub fn put_secret_raw(&self, id: &str, nonce: &[u8], data: &[u8]) -> Result<()> {
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO secrets(id,nonce,data,updated_at,deleted) VALUES(?1,?2,?3,?4,0)
             ON CONFLICT(id) DO UPDATE SET nonce=?2,data=?3,updated_at=?4,deleted=0",
            params![id, nonce, data, now_ms()],
        )?;
        Ok(())
    }

    pub fn get_secret_raw(&self, id: &str) -> Result<(Vec<u8>, Vec<u8>)> {
        let c = self.conn.lock();
        c.query_row("SELECT nonce,data FROM secrets WHERE id=?1 AND deleted=0", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?
            .ok_or_else(|| anyhow::anyhow!("凭据不存在"))
    }

    #[allow(dead_code)] // used by cloud sync
    pub fn all_secrets_raw(&self) -> Result<Vec<(String, Vec<u8>, Vec<u8>)>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT id,nonce,data FROM secrets WHERE deleted=0")?;
        let rows = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn delete_secret(&self, id: &str) -> Result<()> {
        let c = self.conn.lock();
        c.execute("UPDATE secrets SET deleted=1, updated_at=?2 WHERE id=?1", params![id, now_ms()])?;
        Ok(())
    }

    // ---------- vault meta ----------
    pub fn meta_get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let c = self.conn.lock();
        Ok(c.query_row("SELECT value FROM vault_meta WHERE key=?1", [key], |r| r.get(0)).optional()?)
    }

    pub fn meta_set(&self, key: &str, value: &[u8]) -> Result<()> {
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO vault_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn meta_del(&self, key: &str) -> Result<()> {
        let c = self.conn.lock();
        c.execute("DELETE FROM vault_meta WHERE key=?1", [key])?;
        Ok(())
    }

    // ---------- snippets ----------
    pub fn list_snippets(&self) -> Result<Vec<Snippet>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT id,name,command,tags,updated_at FROM snippets WHERE deleted=0 ORDER BY name")?;
        let rows = st
            .query_map([], |r| {
                Ok(Snippet {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    command: r.get(2)?,
                    tags: json_vec(r.get(3)?),
                    updated_at: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn save_snippet(&self, mut s: Snippet) -> Result<Snippet> {
        if s.id.is_empty() {
            s.id = new_id();
        }
        s.updated_at = now_ms();
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO snippets(id,name,command,tags,updated_at,deleted) VALUES(?1,?2,?3,?4,?5,0)
             ON CONFLICT(id) DO UPDATE SET name=?2,command=?3,tags=?4,updated_at=?5,deleted=0",
            params![s.id, s.name, s.command, serde_json::to_string(&s.tags)?, s.updated_at],
        )?;
        Ok(s)
    }

    pub fn delete_snippet(&self, id: &str) -> Result<()> {
        let c = self.conn.lock();
        c.execute("UPDATE snippets SET deleted=1, updated_at=?2 WHERE id=?1", params![id, now_ms()])?;
        Ok(())
    }

    // ---------- tunnels ----------
    pub fn list_tunnels(&self) -> Result<Vec<TunnelDef>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT * FROM tunnels WHERE deleted=0 ORDER BY name")?;
        let rows = st.query_map([], tunnel_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_tunnel(&self, id: &str) -> Result<TunnelDef> {
        let c = self.conn.lock();
        c.query_row("SELECT * FROM tunnels WHERE id=?1 AND deleted=0", [id], tunnel_from_row)
            .optional()?
            .ok_or_else(|| anyhow::anyhow!("隧道不存在"))
    }

    pub fn save_tunnel(&self, mut t: TunnelDef) -> Result<TunnelDef> {
        if t.id.is_empty() {
            t.id = new_id();
        }
        t.updated_at = now_ms();
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO tunnels(id,name,host_id,kind,bind_addr,bind_port,target_host,target_port,auto_start,updated_at,deleted)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0)
             ON CONFLICT(id) DO UPDATE SET name=?2,host_id=?3,kind=?4,bind_addr=?5,bind_port=?6,target_host=?7,target_port=?8,auto_start=?9,updated_at=?10,deleted=0",
            params![
                t.id, t.name, t.host_id, t.kind, t.bind_addr, t.bind_port as i64, t.target_host, t.target_port as i64,
                t.auto_start as i64, t.updated_at
            ],
        )?;
        Ok(t)
    }

    pub fn delete_tunnel(&self, id: &str) -> Result<()> {
        let c = self.conn.lock();
        c.execute("UPDATE tunnels SET deleted=1, updated_at=?2 WHERE id=?1", params![id, now_ms()])?;
        Ok(())
    }

    // ---------- history ----------
    pub fn record_history(&self, host_id: &str, command: &str) -> Result<()> {
        let cmd = command.trim();
        if cmd.is_empty() || cmd.len() > 2000 {
            return Ok(());
        }
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO history(host_id,command,count,last_used) VALUES(?1,?2,1,?3)
             ON CONFLICT(host_id,command) DO UPDATE SET count=count+1,last_used=?3",
            params![host_id, cmd, now_ms()],
        )?;
        Ok(())
    }

    /// Commands starting with `prefix`, this host's first, ranked by frequency and recency.
    pub fn search_history(&self, host_id: &str, prefix: &str, limit: usize) -> Result<Vec<HistoryHit>> {
        let c = self.conn.lock();
        let like = format!("{}%", prefix.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        let mut st = c.prepare(
            "SELECT command, SUM(count) AS cnt, MAX(last_used) AS lu,
                    MAX(CASE WHEN host_id=?1 THEN 1 ELSE 0 END) AS local
             FROM history WHERE command LIKE ?2 ESCAPE '\' AND command <> ?3
             GROUP BY command
             ORDER BY local DESC, cnt * 1.0 / (1 + (?4 - lu) / 86400000.0) DESC
             LIMIT ?5",
        )?;
        let rows = st
            .query_map(params![host_id, like, prefix, now_ms(), limit as i64], |r| {
                Ok(HistoryHit { command: r.get(0)?, count: r.get(1)?, last_used: r.get(2)? })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// History of one host ("" = all hosts), newest first, optionally filtered by substring.
    pub fn list_history(&self, host_id: &str, query: &str, limit: usize) -> Result<Vec<HistoryHit>> {
        let c = self.conn.lock();
        let like = format!("%{}%", query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        let mut st = c.prepare(
            "SELECT command, SUM(count), MAX(last_used) FROM history
             WHERE (?1 = '' OR host_id = ?1) AND command LIKE ?2 ESCAPE '\'
             GROUP BY command ORDER BY MAX(last_used) DESC LIMIT ?3",
        )?;
        let rows = st
            .query_map(params![host_id, like, limit as i64], |r| {
                Ok(HistoryHit { command: r.get(0)?, count: r.get(1)?, last_used: r.get(2)? })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn delete_history(&self, host_id: &str, command: &str) -> Result<()> {
        let c = self.conn.lock();
        c.execute("DELETE FROM history WHERE (?1 = '' OR host_id = ?1) AND command = ?2", params![host_id, command])?;
        Ok(())
    }

    pub fn recent_history(&self, host_id: &str, limit: usize) -> Result<Vec<String>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT command FROM history WHERE host_id=?1 ORDER BY last_used DESC LIMIT ?2")?;
        let rows = st
            .query_map(params![host_id, limit as i64], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(rows)
    }

    // ---------- known hosts ----------
    pub fn known_host(&self, host: &str, port: u16) -> Result<Option<(String, String)>> {
        let c = self.conn.lock();
        Ok(c
            .query_row(
                "SELECT algo,fingerprint FROM known_hosts WHERE host=?1 AND port=?2",
                params![host, port as i64],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    }

    pub fn trust_host(&self, host: &str, port: u16, algo: &str, fp: &str) -> Result<()> {
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO known_hosts(host,port,algo,fingerprint) VALUES(?1,?2,?3,?4)
             ON CONFLICT(host,port) DO UPDATE SET algo=?3,fingerprint=?4",
            params![host, port as i64, algo, fp],
        )?;
        Ok(())
    }

    // ---------- audit ----------
    pub fn audit(&self, source: &str, host_id: Option<&str>, action: &str, detail: &str, result: &str) -> Result<()> {
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO audit(ts,source,host_id,action,detail,result) VALUES(?1,?2,?3,?4,?5,?6)",
            params![now_ms(), source, host_id, action, detail, result],
        )?;
        // keep the log bounded
        c.execute("DELETE FROM audit WHERE id <= (SELECT MAX(id) FROM audit) - 20000", [])?;
        Ok(())
    }

    pub fn list_audit(&self, limit: usize) -> Result<Vec<AuditEntry>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT id,ts,source,host_id,action,detail,result FROM audit ORDER BY id DESC LIMIT ?1")?;
        let rows = st
            .query_map([limit as i64], |r| {
                Ok(AuditEntry {
                    id: r.get(0)?,
                    ts: r.get(1)?,
                    source: r.get(2)?,
                    host_id: r.get(3)?,
                    action: r.get(4)?,
                    detail: r.get(5)?,
                    result: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    // ---------- settings ----------
    pub fn setting<T: serde::de::DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let c = self.conn.lock();
        let v: Option<String> = c.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0)).optional()?;
        Ok(match v {
            Some(s) => serde_json::from_str(&s).ok(),
            None => None,
        })
    }

    pub fn set_setting<T: Serialize>(&self, key: &str, value: &T) -> Result<()> {
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2",
            params![key, serde_json::to_string(value)?],
        )?;
        Ok(())
    }
}
