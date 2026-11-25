use std::collections::HashMap;
use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket as StdUdpSocket};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::oneshot;
use uuid::Uuid;

pub const UDP_DISCOVERY_PORT: u16 = 45888;
pub const HTTP_SYNC_PORT: u16 = 45889;
const PAIRING_TTL_MS: u64 = 5 * 60 * 1000;
const PEER_STALE_MS: u64 = 16_000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredPeer {
  pub device_id: String,
  pub device_name: String,
  pub ip: String,
  pub http_port: u16,
  pub last_seen_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
  pub running: bool,
  pub local_ip: Option<String>,
  pub http_port: u16,
  pub device_id: String,
  pub device_name: String,
  pub discovered_peers: Vec<DiscoveredPeer>,
  pub active_pairing_code: Option<String>,
  pub pairing_expires_at: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedPeerInfo {
  pub device_id: String,
  pub device_name: String,
  pub pairing_secret: String,
  pub ip: String,
  pub port: u16,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IncomingExchangeEvent {
  req_id: String,
  peer_device_id: String,
  payload_json: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UdpBeacon {
  app: String,
  v: u8,
  device_id: String,
  device_name: String,
  http_port: u16,
}

#[derive(Default)]
struct SyncInner {
  running: bool,
  device_id: String,
  device_name: String,
  http_port: u16,
  discovered: HashMap<String, DiscoveredPeer>,
  pairing_code: Option<(String, u64)>,
  /// Paired peer secrets (`device_id -> pairing_secret`) synced from SQLite.
  peer_secrets: HashMap<String, String>,
  pending_exchanges: HashMap<String, oneshot::Sender<String>>,
}

#[derive(Clone, Default)]
pub struct SyncState {
  inner: Arc<Mutex<SyncInner>>,
}

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

/// Pure-Rust HMAC-SHA256 returning uppercase hex.
fn hmac_sha256_hex(secret: &str, message: &str) -> String {
  const BLOCK_SIZE: usize = 64;
  let key_bytes = secret.as_bytes();
  let mut key_block = [0u8; BLOCK_SIZE];
  if key_bytes.len() > BLOCK_SIZE {
    let hashed = Sha256::digest(key_bytes);
    key_block[..32].copy_from_slice(&hashed);
  } else {
    key_block[..key_bytes.len()].copy_from_slice(key_bytes);
  }

  let mut o_key_pad = [0u8; BLOCK_SIZE];
  let mut i_key_pad = [0u8; BLOCK_SIZE];
  for i in 0..BLOCK_SIZE {
    o_key_pad[i] = key_block[i] ^ 0x5c;
    i_key_pad[i] = key_block[i] ^ 0x36;
  }

  let mut inner_hasher = Sha256::new();
  inner_hasher.update(i_key_pad);
  inner_hasher.update(message.as_bytes());
  let inner_digest = inner_hasher.finalize();

  let mut outer_hasher = Sha256::new();
  outer_hasher.update(o_key_pad);
  outer_hasher.update(inner_digest);
  let digest = outer_hasher.finalize();

  let mut hex = String::with_capacity(64);
  for b in digest {
    hex.push_str(&format!("{b:02x}"));
  }
  hex
}

fn detect_local_ipv4() -> Option<Ipv4Addr> {
  // Opening a UDP socket to a public IP (no packets actually sent) reveals the
  // active LAN interface's IPv4 address reliably on both macOS and Android.
  let sock = StdUdpSocket::bind("0.0.0.0:0").ok()?;
  sock.connect("8.8.8.8:80").ok()?;
  match sock.local_addr().ok()?.ip() {
    IpAddr::V4(v4) if !v4.is_loopback() => Some(v4),
    _ => None,
  }
}

fn resolve_safe_data_path(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
  let clean = relative.trim_start_matches('/');
  if clean.is_empty()
    || clean
      .split(['/', '\\'])
      .any(|seg| seg.is_empty() || seg == ".." || seg == ".")
  {
    return Err("非法文件路径".into());
  }
  let allowed = clean.starts_with("books/")
    || clean.starts_with("covers/")
    || clean.starts_with("images/");
  if !allowed {
    return Err("仅允许同步 books/、covers/、images/ 目录下的文件".into());
  }
  let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
  let candidate = base.join(clean);
  if !candidate.starts_with(&base) {
    return Err("路径越界".into());
  }
  Ok(candidate)
}

fn parse_query_param(target: &str, key: &str) -> Option<String> {
  let query = target.split_once('?')?.1;
  for pair in query.split('&') {
    if let Some((k, v)) = pair.split_once('=') {
      if k == key {
        return Some(percent_decode(v));
      }
    }
  }
  None
}

fn percent_decode(input: &str) -> String {
  let bytes = input.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' && i + 2 < bytes.len() {
      if let Ok(hex_str) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
        if let Ok(val) = u8::from_str_radix(hex_str, 16) {
          out.push(val);
          i += 3;
          continue;
        }
      }
    }
    out.push(bytes[i]);
    i += 1;
  }
  String::from_utf8_lossy(&out).to_string()
}

fn percent_encode_path(input: &str) -> String {
  let mut out = String::with_capacity(input.len() + 8);
  for b in input.bytes() {
    match b {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'/' => {
        out.push(b as char);
      }
      _ => out.push_str(&format!("%{b:02X}")),
    }
  }
  out
}

struct ParsedHttpRequest {
  method: String,
  target: String,
  headers: HashMap<String, String>,
  body: Vec<u8>,
}

async fn read_http_request(stream: &mut TcpStream) -> Result<ParsedHttpRequest, String> {
  let mut buf = Vec::<u8>::with_capacity(4096);
  let mut tmp = [0u8; 4096];
  let header_end = loop {
    let n = stream
      .read(&mut tmp)
      .await
      .map_err(|e| format!("读取请求头失败: {e}"))?;
    if n == 0 {
      return Err("连接已关闭".into());
    }
    buf.extend_from_slice(&tmp[..n]);
    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
      break pos + 4;
    }
    if buf.len() > 64 * 1024 {
      return Err("请求头过大".into());
    }
  };

  let header_str = String::from_utf8_lossy(&buf[..header_end]);
  let mut lines = header_str.split("\r\n");
  let req_line = lines.next().ok_or("空请求行")?;
  let mut req_parts = req_line.split_whitespace();
  let method = req_parts.next().ok_or("缺少方法")?.to_string();
  let target = req_parts.next().ok_or("缺少路径")?.to_string();

  let mut headers = HashMap::new();
  for line in lines {
    if let Some((k, v)) = line.split_once(':') {
      headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
    }
  }

  let content_len = headers
    .get("content-length")
    .and_then(|s| s.parse::<usize>().ok())
    .unwrap_or(0);

  let mut body = Vec::with_capacity(content_len);
  body.extend_from_slice(&buf[header_end..]);
  while body.len() < content_len {
    let remaining = content_len - body.len();
    let mut chunk = vec![0u8; remaining.min(64 * 1024)];
    let n = stream
      .read(&mut chunk)
      .await
      .map_err(|e| format!("读取请求体失败: {e}"))?;
    if n == 0 {
      break;
    }
    body.extend_from_slice(&chunk[..n]);
  }
  body.truncate(content_len);

  Ok(ParsedHttpRequest {
    method,
    target,
    headers,
    body,
  })
}

async fn write_http_response(
  stream: &mut TcpStream,
  status: u16,
  content_type: &str,
  body: &[u8],
) {
  let reason = match status {
    200 => "OK",
    400 => "Bad Request",
    401 => "Unauthorized",
    403 => "Forbidden",
    404 => "Not Found",
    _ => "Internal Server Error",
  };
  let header = format!(
    "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
    body.len()
  );
  let _ = stream.write_all(header.as_bytes()).await;
  let _ = stream.write_all(body).await;
  let _ = stream.flush().await;
}

fn verify_hmac(
  state: &Arc<Mutex<SyncInner>>,
  req: &ParsedHttpRequest,
) -> Result<String, String> {
  let dev_id = req
    .headers
    .get("x-rb-device-id")
    .ok_or("缺少设备 ID")?
    .clone();
  let ts = req
    .headers
    .get("x-rb-timestamp")
    .ok_or("缺少时间戳")?;
  let sig = req
    .headers
    .get("x-rb-signature")
    .ok_or("缺少签名")?;

  let ts_num = ts.parse::<u64>().map_err(|_| "时间戳非法")?;
  let diff = now_ms().abs_diff(ts_num);
  if diff > 10 * 60 * 1000 {
    return Err("请求时间戳偏差过大".into());
  }

  let secret = {
    let guard = state.lock().map_err(|_| "状态锁异常")?;
    guard
      .peer_secrets
      .get(&dev_id)
      .cloned()
      .ok_or("设备尚未配对")?
  };

  let expected = hmac_sha256_hex(&secret, &format!("{}|{}|{}", req.method, req.target, ts));
  if !expected.eq_ignore_ascii_case(sig) {
    return Err("HMAC 签名校验失败".into());
  }
  Ok(dev_id)
}

async fn handle_http_client(
  mut stream: TcpStream,
  peer_addr: SocketAddr,
  app: AppHandle,
  state: Arc<Mutex<SyncInner>>,
) {
  let req = match read_http_request(&mut stream).await {
    Ok(r) => r,
    Err(_) => return,
  };

  let path_only = req.target.split('?').next().unwrap_or(&req.target);

  match (req.method.as_str(), path_only) {
    ("GET", "/sync/ping") => {
      let (device_id, device_name) = {
        let g = state.lock().unwrap();
        (g.device_id.clone(), g.device_name.clone())
      };
      let body = serde_json::json!({
        "ok": true,
        "deviceId": device_id,
        "deviceName": device_name
      })
      .to_string();
      write_http_response(&mut stream, 200, "application/json", body.as_bytes()).await;
    }

    ("POST", "/sync/pair") => {
      #[derive(Deserialize)]
      #[serde(rename_all = "camelCase")]
      struct PairReq {
        device_id: String,
        device_name: String,
        code: String,
        http_port: Option<u16>,
      }

      let parsed: PairReq = match serde_json::from_slice(&req.body) {
        Ok(v) => v,
        Err(_) => {
          write_http_response(&mut stream, 400, "text/plain", b"invalid pair payload").await;
          return;
        }
      };

      let result = {
        let mut g = state.lock().unwrap();
        let valid = match &g.pairing_code {
          Some((active_code, exp)) if active_code == parsed.code.trim() && now_ms() <= *exp => true,
          _ => false,
        };
        if !valid {
          Err("配对码错误或已过期")
        } else {
          let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
          g.peer_secrets.insert(parsed.device_id.clone(), secret.clone());
          g.pairing_code = None;
          Ok((g.device_id.clone(), g.device_name.clone(), secret))
        }
      };

      match result {
        Ok((my_id, my_name, secret)) => {
          let peer_info = PairedPeerInfo {
            device_id: parsed.device_id,
            device_name: parsed.device_name,
            pairing_secret: secret.clone(),
            ip: peer_addr.ip().to_string(),
            port: parsed.http_port.unwrap_or(HTTP_SYNC_PORT),
          };
          let _ = app.emit("sync-paired", peer_info);

          let resp = serde_json::json!({
            "deviceId": my_id,
            "deviceName": my_name,
            "pairingSecret": secret
          })
          .to_string();
          write_http_response(&mut stream, 200, "application/json", resp.as_bytes()).await;
        }
        Err(msg) => {
          write_http_response(&mut stream, 403, "text/plain", msg.as_bytes()).await;
        }
      }
    }

    ("POST", "/sync/exchange") => {
      let peer_dev_id = match verify_hmac(&state, &req) {
        Ok(id) => id,
        Err(msg) => {
          write_http_response(&mut stream, 401, "text/plain", msg.as_bytes()).await;
          return;
        }
      };

      let req_id = Uuid::new_v4().to_string();
      let (tx, rx) = oneshot::channel::<String>();
      {
        let mut g = state.lock().unwrap();
        g.pending_exchanges.insert(req_id.clone(), tx);
      }

      let payload_json = String::from_utf8_lossy(&req.body).to_string();
      let _ = app.emit(
        "sync-exchange-request",
        IncomingExchangeEvent {
          req_id: req_id.clone(),
          peer_device_id: peer_dev_id,
          payload_json,
        },
      );

      match tokio::time::timeout(Duration::from_secs(20), rx).await {
        Ok(Ok(reply_json)) => {
          write_http_response(&mut stream, 200, "application/json", reply_json.as_bytes()).await;
        }
        _ => {
          let mut g = state.lock().unwrap();
          g.pending_exchanges.remove(&req_id);
          write_http_response(&mut stream, 500, "text/plain", b"exchange timeout").await;
        }
      }
    }

    ("GET", "/sync/file") => {
      if let Err(msg) = verify_hmac(&state, &req) {
        write_http_response(&mut stream, 401, "text/plain", msg.as_bytes()).await;
        return;
      }
      let rel = match parse_query_param(&req.target, "path") {
        Some(p) => p,
        None => {
          write_http_response(&mut stream, 400, "text/plain", b"missing path").await;
          return;
        }
      };
      let full_path = match resolve_safe_data_path(&app, &rel) {
        Ok(p) => p,
        Err(e) => {
          write_http_response(&mut stream, 403, "text/plain", e.as_bytes()).await;
          return;
        }
      };
      match fs::read(&full_path) {
        Ok(bytes) => {
          write_http_response(&mut stream, 200, "application/octet-stream", &bytes).await;
        }
        Err(_) => {
          write_http_response(&mut stream, 404, "text/plain", b"file not found").await;
        }
      }
    }

    ("POST", "/sync/file") => {
      if let Err(msg) = verify_hmac(&state, &req) {
        write_http_response(&mut stream, 401, "text/plain", msg.as_bytes()).await;
        return;
      }
      let rel = match parse_query_param(&req.target, "path") {
        Some(p) => p,
        None => {
          write_http_response(&mut stream, 400, "text/plain", b"missing path").await;
          return;
        }
      };
      let full_path = match resolve_safe_data_path(&app, &rel) {
        Ok(p) => p,
        Err(e) => {
          write_http_response(&mut stream, 403, "text/plain", e.as_bytes()).await;
          return;
        }
      };
      if let Some(parent) = full_path.parent() {
        let _ = fs::create_dir_all(parent);
      }
      match fs::write(&full_path, &req.body) {
        Ok(_) => write_http_response(&mut stream, 200, "application/json", b"{\"ok\":true}").await,
        Err(e) => {
          write_http_response(&mut stream, 500, "text/plain", e.to_string().as_bytes()).await;
        }
      }
    }

    _ => {
      write_http_response(&mut stream, 404, "text/plain", b"not found").await;
    }
  }
}

async fn send_http_request(
  ip: &str,
  port: u16,
  method: &str,
  target: &str,
  auth: Option<(&str, &str)>,
  content_type: &str,
  body: &[u8],
) -> Result<(u16, Vec<u8>), String> {
  let addr = format!("{ip}:{port}");
  let mut stream = tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(&addr))
    .await
    .map_err(|_| format!("连接 {addr} 超时"))?
    .map_err(|e| format!("无法连接 {addr}: {e}"))?;

  let mut header = format!(
    "{method} {target} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n",
    body.len()
  );

  if let Some((dev_id, secret)) = auth {
    let ts = now_ms().to_string();
    let sig = hmac_sha256_hex(secret, &format!("{method}|{target}|{ts}"));
    header.push_str(&format!(
      "X-RB-Device-Id: {dev_id}\r\nX-RB-Timestamp: {ts}\r\nX-RB-Signature: {sig}\r\n"
    ));
  }
  header.push_str("\r\n");

  stream
    .write_all(header.as_bytes())
    .await
    .map_err(|e| format!("发送请求头失败: {e}"))?;
  if !body.is_empty() {
    stream
      .write_all(body)
      .await
      .map_err(|e| format!("发送请求体失败: {e}"))?;
  }
  stream.flush().await.map_err(|e| e.to_string())?;

  let mut raw = Vec::<u8>::with_capacity(4096);
  stream
    .read_to_end(&mut raw)
    .await
    .map_err(|e| format!("读取响应失败: {e}"))?;

  let split = raw
    .windows(4)
    .position(|w| w == b"\r\n\r\n")
    .ok_or("无效的 HTTP 响应")?;
  let head_str = String::from_utf8_lossy(&raw[..split]);
  let status = head_str
    .lines()
    .next()
    .and_then(|l| l.split_whitespace().nth(1))
    .and_then(|s| s.parse::<u16>().ok())
    .unwrap_or(500);

  Ok((status, raw[split + 4..].to_vec()))
}

#[tauri::command]
pub async fn sync_start(
  app: AppHandle,
  state: State<'_, SyncState>,
  device_id: String,
  device_name: String,
  known_peers: Vec<(String, String)>,
) -> Result<SyncStatus, String> {
  let already_running = {
    let mut g = state.inner.lock().map_err(|_| "状态锁异常")?;
    g.device_id = device_id.clone();
    g.device_name = device_name.clone();
    for (pid, secret) in known_peers {
      g.peer_secrets.insert(pid, secret);
    }
    if g.running {
      true
    } else {
      g.running = true;
      g.http_port = HTTP_SYNC_PORT;
      false
    }
  };

  if !already_running {
    // 1. Start HTTP Sync Server
    let http_state = state.inner.clone();
    let http_app = app.clone();
    let listener = TcpListener::bind(("0.0.0.0", HTTP_SYNC_PORT))
      .await
      .map_err(|e| format!("绑定同步端口 {HTTP_SYNC_PORT} 失败: {e}"))?;

    tauri::async_runtime::spawn(async move {
      loop {
        if let Ok((stream, addr)) = listener.accept().await {
          let st = http_state.clone();
          let ap = http_app.clone();
          tauri::async_runtime::spawn(handle_http_client(stream, addr, ap, st));
        }
      }
    });

    // 2. Start UDP LAN Discovery (broadcast + listen)
    let udp_state = state.inner.clone();
    tauri::async_runtime::spawn(async move {
      let std_sock = match StdUdpSocket::bind(("0.0.0.0", UDP_DISCOVERY_PORT))
        .or_else(|_| StdUdpSocket::bind(("0.0.0.0", 0)))
      {
        Ok(s) => s,
        Err(_) => return,
      };
      let _ = std_sock.set_broadcast(true);
      let _ = std_sock.set_nonblocking(true);
      let sock = match UdpSocket::from_std(std_sock) {
        Ok(s) => Arc::new(s),
        Err(_) => return,
      };

      // Broadcaster task
      let tx_sock = sock.clone();
      let tx_state = udp_state.clone();
      tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3));
        loop {
          interval.tick().await;
          let beacon = {
            let g = tx_state.lock().unwrap();
            UdpBeacon {
              app: "readingbook".into(),
              v: 2,
              device_id: g.device_id.clone(),
              device_name: g.device_name.clone(),
              http_port: g.http_port,
            }
          };
          if let Ok(bytes) = serde_json::to_vec(&beacon) {
            let _ = tx_sock
              .send_to(&bytes, ("255.255.255.255", UDP_DISCOVERY_PORT))
              .await;
            if let Some(local) = detect_local_ipv4() {
              let octets = local.octets();
              let directed = Ipv4Addr::new(octets[0], octets[1], octets[2], 255);
              let _ = tx_sock
                .send_to(&bytes, (directed, UDP_DISCOVERY_PORT))
                .await;
            }
          }
        }
      });

      // Receiver loop
      let mut buf = [0u8; 1024];
      loop {
        if let Ok((n, addr)) = sock.recv_from(&mut buf).await {
          if let Ok(beacon) = serde_json::from_slice::<UdpBeacon>(&buf[..n]) {
            if beacon.app != "readingbook" || beacon.v != 2 {
              continue;
            }
            let mut g = udp_state.lock().unwrap();
            if beacon.device_id == g.device_id {
              continue;
            }
            let ts = now_ms();
            g.discovered.insert(
              beacon.device_id.clone(),
              DiscoveredPeer {
                device_id: beacon.device_id,
                device_name: beacon.device_name,
                ip: addr.ip().to_string(),
                http_port: beacon.http_port,
                last_seen_ms: ts,
              },
            );
          }
        }
      }
    });
  }

  sync_get_status(state).await
}

#[tauri::command]
pub async fn sync_get_status(state: State<'_, SyncState>) -> Result<SyncStatus, String> {
  let ts = now_ms();
  let mut g = state.inner.lock().map_err(|_| "状态锁异常")?;
  g.discovered
    .retain(|_, p| ts.saturating_sub(p.last_seen_ms) <= PEER_STALE_MS);

  let (active_pairing_code, pairing_expires_at) = match &g.pairing_code {
    Some((code, exp)) if ts <= *exp => (Some(code.clone()), Some(*exp)),
    _ => {
      g.pairing_code = None;
      (None, None)
    }
  };

  Ok(SyncStatus {
    running: g.running,
    local_ip: detect_local_ipv4().map(|ip| ip.to_string()),
    http_port: if g.http_port == 0 { HTTP_SYNC_PORT } else { g.http_port },
    device_id: g.device_id.clone(),
    device_name: g.device_name.clone(),
    discovered_peers: g.discovered.values().cloned().collect(),
    active_pairing_code,
    pairing_expires_at,
  })
}

#[tauri::command]
pub async fn sync_register_peer_secret(
  state: State<'_, SyncState>,
  peer_device_id: String,
  pairing_secret: String,
) -> Result<(), String> {
  let mut g = state.inner.lock().map_err(|_| "状态锁异常")?;
  g.peer_secrets.insert(peer_device_id, pairing_secret);
  Ok(())
}

#[tauri::command]
pub async fn sync_generate_pairing_code(
  state: State<'_, SyncState>,
) -> Result<(String, u64), String> {
  let raw = Uuid::new_v4().as_u128();
  let code = format!("{:06}", (raw % 900_000) + 100_000);
  let exp = now_ms() + PAIRING_TTL_MS;
  let mut g = state.inner.lock().map_err(|_| "状态锁异常")?;
  g.pairing_code = Some((code.clone(), exp));
  Ok((code, exp))
}

#[tauri::command]
pub async fn sync_pair_with_peer(
  state: State<'_, SyncState>,
  ip: String,
  port: u16,
  code: String,
) -> Result<PairedPeerInfo, String> {
  let (my_id, my_name, my_port) = {
    let g = state.inner.lock().map_err(|_| "状态锁异常")?;
    (g.device_id.clone(), g.device_name.clone(), g.http_port)
  };
  let body = serde_json::json!({
    "deviceId": my_id,
    "deviceName": my_name,
    "code": code.trim(),
    "httpPort": my_port
  })
  .to_string();

  let (status, resp_bytes) =
    send_http_request(&ip, port, "POST", "/sync/pair", None, "application/json", body.as_bytes())
      .await?;

  if status != 200 {
    let err_txt = String::from_utf8_lossy(&resp_bytes);
    return Err(format!("配对失败 ({status}): {err_txt}"));
  }

  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct PairResp {
    device_id: String,
    device_name: String,
    pairing_secret: String,
  }
  let parsed: PairResp =
    serde_json::from_slice(&resp_bytes).map_err(|e| format!("解析配对响应失败: {e}"))?;

  {
    let mut g = state.inner.lock().map_err(|_| "状态锁异常")?;
    g.peer_secrets
      .insert(parsed.device_id.clone(), parsed.pairing_secret.clone());
  }

  Ok(PairedPeerInfo {
    device_id: parsed.device_id,
    device_name: parsed.device_name,
    pairing_secret: parsed.pairing_secret,
    ip,
    port,
  })
}

#[tauri::command]
pub async fn sync_ping_peer(ip: String, port: u16) -> Result<bool, String> {
  match send_http_request(&ip, port, "GET", "/sync/ping", None, "application/json", &[]).await {
    Ok((200, _)) => Ok(true),
    _ => Ok(false),
  }
}

#[tauri::command]
pub async fn sync_exchange_with_peer(
  state: State<'_, SyncState>,
  ip: String,
  port: u16,
  pairing_secret: String,
  local_payload_json: String,
) -> Result<String, String> {
  let my_id = {
    let g = state.inner.lock().map_err(|_| "状态锁异常")?;
    g.device_id.clone()
  };

  let (status, resp_bytes) = send_http_request(
    &ip,
    port,
    "POST",
    "/sync/exchange",
    Some((&my_id, &pairing_secret)),
    "application/json",
    local_payload_json.as_bytes(),
  )
  .await?;

  if status != 200 {
    let err_txt = String::from_utf8_lossy(&resp_bytes);
    return Err(format!("同步数据交换失败 ({status}): {err_txt}"));
  }
  Ok(String::from_utf8_lossy(&resp_bytes).to_string())
}

#[tauri::command]
pub async fn sync_reply_exchange(
  state: State<'_, SyncState>,
  req_id: String,
  response_json: String,
) -> Result<(), String> {
  let tx = {
    let mut g = state.inner.lock().map_err(|_| "状态锁异常")?;
    g.pending_exchanges.remove(&req_id)
  };
  if let Some(sender) = tx {
    let _ = sender.send(response_json);
  }
  Ok(())
}

#[tauri::command]
pub async fn sync_pull_file(
  app: AppHandle,
  state: State<'_, SyncState>,
  ip: String,
  port: u16,
  pairing_secret: String,
  rel_path: String,
) -> Result<bool, String> {
  let dst = resolve_safe_data_path(&app, &rel_path)?;
  if dst.is_file() {
    return Ok(false);
  }
  let my_id = {
    let g = state.inner.lock().map_err(|_| "状态锁异常")?;
    g.device_id.clone()
  };
  let target = format!("/sync/file?path={}", percent_encode_path(&rel_path));
  let (status, bytes) = send_http_request(
    &ip,
    port,
    "GET",
    &target,
    Some((&my_id, &pairing_secret)),
    "application/octet-stream",
    &[],
  )
  .await?;

  if status == 404 {
    return Ok(false);
  }
  if status != 200 {
    return Err(format!("拉取文件 {rel_path} 失败 ({status})"));
  }
  if let Some(parent) = dst.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  fs::write(&dst, &bytes).map_err(|e| format!("保存文件 {rel_path} 失败: {e}"))?;
  Ok(true)
}

#[tauri::command]
pub async fn sync_push_file(
  app: AppHandle,
  state: State<'_, SyncState>,
  ip: String,
  port: u16,
  pairing_secret: String,
  rel_path: String,
) -> Result<bool, String> {
  let src = resolve_safe_data_path(&app, &rel_path)?;
  if !src.is_file() {
    return Ok(false);
  }
  let bytes = fs::read(&src).map_err(|e| format!("读取本地文件 {rel_path} 失败: {e}"))?;
  let my_id = {
    let g = state.inner.lock().map_err(|_| "状态锁异常")?;
    g.device_id.clone()
  };
  let target = format!("/sync/file?path={}", percent_encode_path(&rel_path));
  let (status, _) = send_http_request(
    &ip,
    port,
    "POST",
    &target,
    Some((&my_id, &pairing_secret)),
    "application/octet-stream",
    &bytes,
  )
  .await?;

  if status != 200 {
    return Err(format!("推送文件 {rel_path} 失败 ({status})"));
  }
  Ok(true)
}
