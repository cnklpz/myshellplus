use std::time::{Duration, Instant};

use anyhow::Result;
use russh::ChannelMsg;
use serde::Serialize;

use super::Conn;

const MAX_OUT: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<u32>,
    pub duration_ms: u64,
    pub truncated: bool,
    pub timed_out: bool,
}

/// Run a non-interactive command on the shared connection.
pub async fn run(conn: &Conn, command: &str, timeout: Duration) -> Result<ExecResult> {
    let start = Instant::now();
    let mut ch = conn.handle.channel_open_session().await?;
    ch.exec(true, command).await?;
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut code = None;
    let mut truncated = false;
    let res = tokio::time::timeout(timeout, async {
        while let Some(msg) = ch.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    if out.len() < MAX_OUT {
                        out.extend_from_slice(&data);
                    } else {
                        truncated = true;
                    }
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    if err.len() < MAX_OUT {
                        err.extend_from_slice(&data);
                    } else {
                        truncated = true;
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
    })
    .await;
    let timed_out = res.is_err();
    if timed_out {
        let _ = ch.close().await;
    }
    Ok(ExecResult {
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).into_owned(),
        exit_code: code,
        duration_ms: start.elapsed().as_millis() as u64,
        truncated,
        timed_out,
    })
}
