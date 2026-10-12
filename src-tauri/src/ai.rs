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
    /// Typing Chinese at the prompt asks the AI for a command.
    #[serde(default = "yes")]
    pub nl_predict_enabled: bool,
    /// Let the model think before answering (slower). Inline prediction never thinks.
    #[serde(default)]
    pub thinking: bool,
    /// Model override for inline prediction (e.g. a small fast model of the same provider).
    #[serde(default)]
    pub predict_model: Option<String>,
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
            nl_predict_enabled: true,
            thinking: false,
            predict_model: None,
        }
    }
}

pub fn settings(db: &Db) -> AiSettings {
    db.setting_or_default("ai")
}

pub struct Request<'a> {
    pub system: &'a str,
    pub user: String,
    pub max_tokens: u32,
    /// low | medium | high  (Anthropic effort; ignored by OpenAI-compatible)
    pub effort: &'a str,
    /// Allow thinking. When false we ask the model not to think (where the model lets us).
    pub think: bool,
    /// Use this model instead of the provider's configured one.
    pub model: Option<String>,
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
    let mut p = p.clone();
    if let Some(m) = req.model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        p.model = m.to_string();
    }
    match p.kind.as_str() {
        "anthropic" => anthropic(&p, &key, req).await,
        _ => openai(&p, &key, req).await,
    }
}

/// The `thinking` value that turns thinking off for a Claude model, if the model allows it.
/// Opus 5.5 / Fable 5.x / Mythos always think: there only a low effort keeps it short.
fn anthropic_thinking_off(model: &str) -> Option<Value> {
    let m = model.to_ascii_lowercase();
    if m.contains("opus-5-5") || m.contains("fable") || m.contains("mythos") {
        None
    } else if m.contains("sonnet-5-5") {
        Some(json!({ "type": "between_tools" }))
    } else {
        Some(json!({ "type": "disabled" }))
    }
}

/// Send, and if the endpoint rejects one of our optional speed knobs (400 naming it), retry without them.
async fn post_json(rb: impl Fn() -> reqwest::RequestBuilder, mut body: Value, optional: &[&str]) -> Result<(reqwest::StatusCode, Value)> {
    for attempt in 0..2 {
        let resp = rb().json(&body).send().await?;
        let status = resp.status();
        let v: Value = resp.json().await.unwrap_or(Value::Null);
        if attempt == 0 && status.as_u16() == 400 {
            let msg = v.to_string();
            let hit: Vec<&str> = optional.iter().copied().filter(|k| body.get(*k).is_some() && msg.contains(*k)).collect();
            if !hit.is_empty() {
                for k in hit {
                    body.as_object_mut().map(|o| o.remove(k));
                }
                continue;
            }
        }
        return Ok((status, v));
    }
    unreachable!()
}

async fn anthropic(p: &AiProvider, key: &str, req: Request<'_>) -> Result<String> {
    let url = format!("{}/v1/messages", p.base_url.trim_end_matches('/'));
    let official = p.base_url.contains("api.anthropic.com");
    let mut body = json!({
        "model": p.model,
        "max_tokens": req.max_tokens,
        "system": req.system,
        "messages": [{ "role": "user", "content": req.user }],
        "output_config": { "effort": if req.think { req.effort } else { "low" } },
    });
    if !req.think
        && let Some(t) = anthropic_thinking_off(&p.model)
    {
        body["thinking"] = t;
    }
    // Server-side refusal fallback (Claude API only; Haiku has none).
    let fallback = official && !p.model.to_ascii_lowercase().contains("haiku");
    if fallback {
        body["fallbacks"] = json!("default");
    }
    let http = client();
    let rb = || {
        let mut rb = http
            .post(&url)
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01");
        if fallback {
            rb = rb.header("anthropic-beta", "server-side-fallback-2026-07-01");
        }
        rb
    };
    let (status, v) = post_json(rb, body, &["thinking", "fallbacks", "output_config"]).await.context("请求 Claude API 失败")?;
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
    let mut body = json!({
        "model": p.model,
        "max_tokens": req.max_tokens,
        "messages": [
            { "role": "system", "content": req.system },
            { "role": "user", "content": req.user },
        ],
    });
    let model = p.model.to_ascii_lowercase();
    if model.contains("qwen") {
        // DashScope / vLLM style switch for Qwen3 hybrid thinking.
        body["enable_thinking"] = json!(req.think);
    } else if p.base_url.contains(":11434") {
        body["think"] = json!(req.think); // Ollama
    }
    let http = client();
    let rb = || {
        let rb = http.post(&url);
        if key.is_empty() { rb } else { rb.bearer_auth(key) }
    };
    let (status, v) = post_json(rb, body, &["enable_thinking", "think"]).await.context("请求 AI 接口失败")?;
    if !status.is_success() {
        bail!("AI 接口错误 {}: {}", status.as_u16(), v["error"]["message"].as_str().unwrap_or("未知错误"));
    }
    let text = v["choices"][0]["message"]["content"].as_str().unwrap_or_default();
    // Some local reasoning models inline their thoughts.
    let text = match (text.find("<think>"), text.find("</think>")) {
        (Some(_), Some(e)) => &text[e + "</think>".len()..],
        _ => text,
    };
    Ok(text.trim().to_string())
}

/// Pull the first JSON value out of a model reply (tolerates ```json fences and prose).
pub fn extract_json(s: &str) -> Option<Value> {
    let t = s.trim();
    if let Ok(v) = serde_json::from_str(t) {
        return Some(v);
    }
    let start = t.find(['{', '['])?;
    let end = t.rfind(['}', ']'])?;
    serde_json::from_str(t.get(start..=end)?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thinking_off_per_model() {
        assert_eq!(anthropic_thinking_off("claude-opus-5-5"), None);
        assert_eq!(anthropic_thinking_off("claude-fable-5-1"), None);
        assert_eq!(anthropic_thinking_off("claude-sonnet-5-5"), Some(json!({ "type": "between_tools" })));
        assert_eq!(anthropic_thinking_off("claude-haiku-5-5"), Some(json!({ "type": "disabled" })));
        assert!(crate::predict::is_natural_language("  查看磁盘"));
        assert!(!crate::predict::is_natural_language("git commit -m \"修复\""));
    }

    #[test]
    fn extract_json_never_panics() {
        assert_eq!(extract_json("} oops {"), None);
        assert_eq!(extract_json("]x["), None);
        assert_eq!(extract_json("说明 {\"a\":1} 结束"), Some(json!({ "a": 1 })));
        assert_eq!(extract_json("```json
[1,2]
```"), Some(json!([1, 2])));
    }
}
