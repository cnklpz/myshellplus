use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
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
    run_input(conn, command, None, timeout).await
}

/// Like `run`, writing `stdin` to the command first (secrets go here, never into the command line).
pub async fn run_input(conn: &Conn, command: &str, stdin: Option<&[u8]>, timeout: Duration) -> Result<ExecResult> {
    let start = Instant::now();
    let deadline = tokio::time::Instant::now() + timeout;
    // Channel open, exec and the stdin write count against the timeout too (a stuck server
    // could otherwise hang them forever).
    let setup = async {
        let ch = conn.handle.channel_open_session().await?;
        ch.exec(true, command).await?;
        if let Some(data) = stdin {
            ch.data(data).await?;
            ch.eof().await?;
        }
        Ok::<_, anyhow::Error>(ch)
    };
    let mut ch = tokio::time::timeout_at(deadline, setup)
        .await
        .map_err(|_| anyhow!("执行超时：服务器未响应"))??;
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut code = None;
    let mut truncated = false;
    let res = tokio::time::timeout_at(deadline, async {
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
        let _ = tokio::time::timeout(Duration::from_secs(2), ch.close()).await;
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
