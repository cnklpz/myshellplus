//! LLM providers: Anthropic Messages API and any OpenAI-compatible chat endpoint
//! (DeepSeek, Qwen, Ollama, ...). API keys live in the vault.

use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::db::Db;
use crate::vault::Vault;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProvider {
    pub id: String,
    pub name: String,
    /// anthropic | openai
    pub kind: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key_secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    #[serde(default)]
    pub providers: Vec<AiProvider>,
    /// Provider for chat / command generation.
    #[serde(default)]
    pub active: Option<String>,
    /// Provider for inline prediction (pick a fast model here).
    #[serde(default)]
    pub predict_provider: Option<String>,
    #[serde(default = "yes")]
    pub predict_enabled: bool,
    #[serde(default)]
    pub ai_predict_enabled: bool,
}

fn yes() -> bool {
    true
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            providers: vec![AiProvider {
                id: "anthropic".into(),
                name: "Claude".into(),
                kind: "anthropic".into(),
                base_url: "https://api.anthropic.com".into(),
                model: "claude-opus-5-5".into(),
                api_key_secret: None,
            }],
            active: Some("anthropic".into()),
            predict_provider: Some("anthropic".into()),
            predict_enabled: true,
            ai_predict_enabled: false,
        }
    }
}

pub fn settings(db: &Db) -> AiSettings {
    db.setting("ai").ok().flatten().unwrap_or_default()
}

pub struct Request<'a> {
    pub system: &'a str,
    pub user: String,
    pub max_tokens: u32,
    /// low | medium | high  (Anthropic effort; ignored by OpenAI-compatible)
    pub effort: &'a str,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .expect("http client")
}

pub async fn complete(db: &Db, vault: &Vault, provider_id: Option<&str>, req: Request<'_>) -> Result<String> {
    let s = settings(db);
    let pid = provider_id.or(s.active.as_deref()).ok_or_else(|| anyhow!("未配置 AI 服务"))?;
    let p = s
        .providers
        .iter()
        .find(|p| p.id == pid)
        .ok_or_else(|| anyhow!("AI 服务不存在: {pid}"))?;
    let key = match &p.api_key_secret {
        Some(id) => vault.get(id)?.to_string(),
        None if p.kind == "openai" => String::new(), // e.g. local Ollama
        None => bail!("请先在设置里填写 {} 的 API Key", p.name),
    };
    match p.kind.as_str() {
        "anthropic" => anthropic(p, &key, req).await,
        _ => openai(p, &key, req).await,
    }
}

async fn anthropic(p: &AiProvider, key: &str, req: Request<'_>) -> Result<String> {
    let url = format!("{}/v1/messages", p.base_url.trim_end_matches('/'));
    let official = p.base_url.contains("api.anthropic.com");
    let mut body = json!({
        "model": p.model,
        "max_tokens": req.max_tokens,
        "system": req.system,
        "messages": [{ "role": "user", "content": req.user }],
        "output_config": { "effort": req.effort },
    });
    let mut rb = client()
        .post(url)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01");
    // Server-side refusal fallback (Claude API only).
    if official {
        body["fallbacks"] = json!("default");
        rb = rb.header("anthropic-beta", "server-side-fallback-2026-07-01");
    }
    let resp = rb.json(&body).send().await.context("请求 Claude API 失败")?;
    let status = resp.status();
    let v: Value = resp.json().await.context("Claude API 返回格式错误")?;
    if !status.is_success() {
        bail!("Claude API 错误 {}: {}", status.as_u16(), v["error"]["message"].as_str().unwrap_or("未知错误"));
    }
    if v["stop_reason"] == "refusal" {
        bail!("模型拒绝了这个请求");
    }
    let text: String = v["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    Ok(text)
}

async fn openai(p: &AiProvider, key: &str, req: Request<'_>) -> Result<String> {
    let url = format!("{}/chat/completions", p.base_url.trim_end_matches('/'));
    let body = json!({
        "model": p.model,
        "max_tokens": req.max_tokens,
        "messages": [
            { "role": "system", "content": req.system },
            { "role": "user", "content": req.user },
        ],
    });
    let mut rb = client().post(url);
    if !key.is_empty() {
        rb = rb.bearer_auth(key);
    }
    let resp = rb.json(&body).send().await.context("请求 AI 接口失败")?;
    let status = resp.status();
    let v: Value = resp.json().await.context("AI 接口返回格式错误")?;
    if !status.is_success() {
        bail!("AI 接口错误 {}: {}", status.as_u16(), v["error"]["message"].as_str().unwrap_or("未知错误"));
    }
    Ok(v["choices"][0]["message"]["content"].as_str().unwrap_or_default().to_string())
}

/// Pull the first JSON value out of a model reply (tolerates ```json fences and prose).
pub fn extract_json(s: &str) -> Option<Value> {
    let t = s.trim();
    if let Ok(v) = serde_json::from_str(t) {
        return Some(v);
    }
    let start = t.find(['{', '['])?;
    let end = t.rfind(['}', ']'])?;
    serde_json::from_str(&t[start..=end]).ok()
}
