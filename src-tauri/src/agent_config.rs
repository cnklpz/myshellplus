//! One-click registration of the MCP server in external agents' config files. Only our own
//! entry is touched; every other key, table and comment in the file is kept as written.

use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use toml_edit::{DocumentMut, InlineTable, Item, Table, value};

use crate::mcp::McpSettings;

const NAME: &str = "myshellplus";
/// stdio-only keys that would conflict with an HTTP entry left over from an older setup.
const STDIO_KEYS: [&str; 5] = ["command", "args", "env", "env_vars", "cwd"];

/// `$CODEX_HOME/config.toml`, falling back to `~/.codex/config.toml`.
fn codex_config_path() -> Result<PathBuf> {
    if let Some(h) = std::env::var_os("CODEX_HOME").filter(|h| !h.is_empty()) {
        return Ok(PathBuf::from(h).join("config.toml"));
    }
    let home = dirs::home_dir().ok_or_else(|| anyhow!("找不到用户目录"))?;
    Ok(home.join(".codex").join("config.toml"))
}

/// Sets `[mcp_servers.myshellplus]` to the Streamable HTTP entry, keeping the rest of `src`.
fn merge_codex(src: &str, url: &str, token: &str) -> Result<String> {
    let mut doc: DocumentMut = src.parse().context("Codex 配置不是有效的 TOML")?;
    let servers = doc.as_table_mut().entry("mcp_servers").or_insert_with(|| {
        let mut t = Table::new();
        t.set_implicit(true);
        Item::Table(t)
    });
    let servers = servers.as_table_like_mut().ok_or_else(|| anyhow!("Codex 配置中 mcp_servers 不是表"))?;
    let entry = servers.entry(NAME).or_insert(Item::Table(Table::new()));
    let entry = entry.as_table_like_mut().ok_or_else(|| anyhow!("Codex 配置中 mcp_servers.{NAME} 不是表"))?;
    for k in STDIO_KEYS {
        entry.remove(k);
    }
    let mut headers = InlineTable::new();
    headers.insert("Authorization", format!("Bearer {token}").into());
    entry.insert("url", value(url));
    entry.insert("http_headers", value(headers));
    Ok(doc.to_string())
}

/// Writes the entry into Codex's config and returns the file path. The file is replaced via a
/// temp file + rename so a crash never leaves a half-written config behind.
pub async fn write_codex(s: &McpSettings) -> Result<PathBuf> {
    let path = codex_config_path()?;
    let src = match tokio::fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(anyhow!(e).context(format!("读取 {} 失败", path.display()))),
    };
    let out = merge_codex(&src, &format!("http://127.0.0.1:{}/mcp", s.port), &s.token)?;
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.with_context(|| format!("创建 {} 失败", dir.display()))?;
    }
    let tmp = path.with_extension("toml.myshellplus.tmp");
    tokio::fs::write(&tmp, out).await.with_context(|| format!("写入 {} 失败", tmp.display()))?;
    if let Err(e) = tokio::fs::rename(&tmp, &path).await {
        crate::util::log_err("删除临时文件失败", tokio::fs::remove_file(&tmp).await);
        return Err(anyhow!(e).context(format!("写入 {} 失败", path.display())));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "http://127.0.0.1:17890/mcp";

    #[test]
    fn creates_entry_in_empty_file() {
        let out = merge_codex("", URL, "tok").unwrap();
        let doc: DocumentMut = out.parse().unwrap();
        let e = &doc["mcp_servers"][NAME];
        assert_eq!(e["url"].as_str(), Some(URL));
        assert_eq!(e["http_headers"]["Authorization"].as_str(), Some("Bearer tok"));
        assert!(!out.contains("[mcp_servers]\n"), "parent table should stay implicit: {out}");
    }

    #[test]
    fn keeps_other_settings_and_comments() {
        let src = "# top comment\nmodel = \"gpt\"\n\n[mcp_servers.other]\ncommand = \"npx\" # keep\nargs = [\"-y\"]\n\n[plugins.x]\nenabled = true\n";
        let out = merge_codex(src, URL, "tok").unwrap();
        assert!(out.starts_with("# top comment\nmodel = \"gpt\"\n"));
        assert!(out.contains("command = \"npx\" # keep"));
        assert!(out.contains("[plugins.x]\nenabled = true"));
        let doc: DocumentMut = out.parse().unwrap();
        assert_eq!(doc["mcp_servers"][NAME]["url"].as_str(), Some(URL));
    }

    #[test]
    fn updates_existing_entry_and_drops_stdio_keys() {
        let src = "[mcp_servers.myshellplus]\ncommand = \"old\"\nargs = []\nurl = \"http://old\"\ntool_timeout_sec = 120\n";
        let out = merge_codex(src, URL, "new").unwrap();
        let doc: DocumentMut = out.parse().unwrap();
        let e = &doc["mcp_servers"][NAME];
        assert!(e.get("command").is_none() && e.get("args").is_none());
        assert_eq!(e["url"].as_str(), Some(URL));
        assert_eq!(e["tool_timeout_sec"].as_integer(), Some(120));
        assert_eq!(e["http_headers"]["Authorization"].as_str(), Some("Bearer new"));
        assert_eq!(merge_codex(&out, URL, "new").unwrap(), out, "second write must be a no-op");
    }

    #[test]
    fn handles_dotted_keys() {
        let src = "mcp_servers.myshellplus.url = \"http://old\"\n";
        let out = merge_codex(src, URL, "t").unwrap();
        let doc: DocumentMut = out.parse().unwrap();
        assert_eq!(doc["mcp_servers"][NAME]["url"].as_str(), Some(URL));
    }

    #[test]
    fn rejects_invalid_input() {
        assert!(merge_codex("model = ", URL, "t").is_err());
        assert!(merge_codex("mcp_servers = 1\n", URL, "t").is_err());
        assert!(merge_codex("mcp_servers.myshellplus = 1\n", URL, "t").is_err());
    }
}
