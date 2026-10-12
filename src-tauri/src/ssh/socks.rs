//! Minimal SOCKS5 client (RFC 1928 / 1929): CONNECT only, target resolved by the proxy.

use anyhow::{Result, anyhow, bail};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Runs the handshake on `s` (already connected to the proxy) so it then carries `host:port`.
pub async fn handshake(s: &mut TcpStream, host: &str, port: u16, auth: Option<(&str, &str)>) -> Result<()> {
    let methods: &[u8] = if auth.is_some() { &[0x00, 0x02] } else { &[0x00] };
    let mut hello = vec![0x05, methods.len() as u8];
    hello.extend_from_slice(methods);
    s.write_all(&hello).await?;

    let mut r = [0u8; 2];
    s.read_exact(&mut r).await?;
    if r[0] != 0x05 {
        bail!("不是 SOCKS5 代理");
    }
    match (r[1], auth) {
        (0x00, _) => {}
        (0x02, Some((user, pass))) => {
            if user.len() > 255 || pass.len() > 255 {
                bail!("代理用户名或密码过长");
            }
            let mut m = vec![0x01, user.len() as u8];
            m.extend_from_slice(user.as_bytes());
            m.push(pass.len() as u8);
            m.extend_from_slice(pass.as_bytes());
            s.write_all(&m).await?;
            s.read_exact(&mut r).await?;
            if r[1] != 0x00 {
                bail!("代理认证失败");
            }
        }
        (0x02, None) => bail!("代理需要用户名和密码"),
        _ => bail!("代理不支持该认证方式"),
    }

    if host.len() > 255 {
        bail!("目标地址过长");
    }
    let mut req = vec![0x05, 0x01, 0x00];
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            req.push(0x01);
            req.extend_from_slice(&ip.octets());
        }
        Ok(std::net::IpAddr::V6(ip)) => {
            req.push(0x04);
            req.extend_from_slice(&ip.octets());
        }
        Err(_) => {
            req.push(0x03);
            req.push(host.len() as u8);
            req.extend_from_slice(host.as_bytes());
        }
    }
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req).await?;

    let mut head = [0u8; 4];
    s.read_exact(&mut head).await?;
    if head[1] != 0x00 {
        return Err(anyhow!(match head[1] {
            0x01 => "代理服务器内部错误",
            0x02 => "代理规则禁止此连接",
            0x03 => "代理报告网络不可达",
            0x04 => "代理报告主机不可达",
            0x05 => "代理报告目标拒绝连接",
            0x06 => "代理连接目标超时",
            0x07 => "代理不支持 CONNECT",
            0x08 => "代理不支持该地址类型",
            _ => "代理连接目标失败",
        }));
    }
    // Skip the bound address in the reply.
    let skip = match head[3] {
        0x01 => 4,
        0x04 => 16,
        0x03 => s.read_u8().await? as usize,
        _ => bail!("代理响应无效"),
    };
    let mut rest = vec![0u8; skip + 2];
    s.read_exact(&mut rest).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn connect_with_auth() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut b = [0u8; 4];
            s.read_exact(&mut b).await.unwrap();
            assert_eq!(b, [5, 2, 0, 2]);
            s.write_all(&[5, 2]).await.unwrap();
            let mut a = [0u8; 9];
            s.read_exact(&mut a).await.unwrap();
            assert_eq!(&a, b"\x01\x03bob\x03pw!");
            s.write_all(&[1, 0]).await.unwrap();
            let mut req = [0u8; 5 + 9 + 2];
            s.read_exact(&mut req).await.unwrap();
            assert_eq!(&req[..5], &[5, 1, 0, 3, 9]);
            assert_eq!(&req[5..14], b"db.intern");
            assert_eq!(&req[14..], &22u16.to_be_bytes());
            s.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0, b'S']).await.unwrap();
        });
        let mut c = TcpStream::connect(addr).await.unwrap();
        handshake(&mut c, "db.intern", 22, Some(("bob", "pw!"))).await.unwrap();
        let mut x = [0u8; 1];
        c.read_exact(&mut x).await.unwrap();
        assert_eq!(x[0], b'S');
        server.await.unwrap();
    }
}
