use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const KOKORO_MODEL_ID: &str = "kokoro-int8-multi-lang-v1_1";
const KOKORO_MODEL_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2";
const WORKER_SCRIPT: &str = include_str!("../../scripts/tts_worker.py");
const PROGRESS_EVENT: &str = "tts-progress";

struct WorkerHandle {
  child: Child,
  stdin: ChildStdin,
  stdout: BufReader<ChildStdout>,
  next_id: u64,
}

#[derive(Clone, Default)]
pub struct TtsState {
  worker: Arc<Mutex<Option<WorkerHandle>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TtsProgressEvent {
  task: String,
  percent: Option<u8>,
  stage: String,
  log: Option<String>,
}

fn emit_progress(app: &AppHandle, task: &str, percent: Option<u8>, stage: &str, log: Option<String>) {
  let _ = app.emit(
    PROGRESS_EVENT,
    TtsProgressEvent {
      task: task.to_string(),
      percent,
      stage: stage.to_string(),
      log,
    },
  );
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsStatus {
  pub runtime_ready: bool,
  pub model_ready: bool,
  pub model_id: String,
  pub model_dir: String,
  pub python_path: Option<String>,
  pub worker_running: bool,
}

#[derive(Deserialize)]
struct WorkerReadyMsg {
  ready: bool,
  error: Option<String>,
}

#[derive(Deserialize)]
struct WorkerSynthResp {
  ok: bool,
  wav_b64: Option<String>,
  sample_rate: Option<u32>,
  error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsSynthResult {
  pub wav_b64: String,
  pub sample_rate: u32,
}

fn tts_root_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
  Ok(base.join("tts"))
}

fn model_dir_path(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(tts_root_dir(app)?.join("models").join(KOKORO_MODEL_ID))
}

fn has_model_files(dir: &Path) -> bool {
  (dir.join("model.int8.onnx").is_file() || dir.join("model.onnx").is_file())
    && dir.join("voices.bin").is_file()
    && dir.join("tokens.txt").is_file()
}

fn python_has_sherpa(py: &str) -> bool {
  Command::new(py)
    .args(["-c", "import sherpa_onnx"])
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status()
    .map(|s| s.success())
    .unwrap_or(false)
}

fn python_minor_version(py: &str) -> Option<(u32, u32)> {
  let out = Command::new(py)
    .args(["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"])
    .output()
    .ok()?;
  if !out.status.success() {
    return None;
  }
  let text = String::from_utf8_lossy(&out.stdout);
  let mut parts = text.trim().split('.');
  let major = parts.next()?.parse::<u32>().ok()?;
  let minor = parts.next()?.parse::<u32>().ok()?;
  Some((major, minor))
}

fn resolve_python_with_sherpa(app: &AppHandle) -> Option<String> {
  if let Ok(root) = tts_root_dir(app) {
    let venv_py = root.join("venv").join("bin").join("python3");
    if venv_py.is_file() {
      let s = venv_py.to_string_lossy().to_string();
      if python_has_sherpa(&s) {
        return Some(s);
      }
    }
  }
  for candidate in [
    "/opt/homebrew/bin/python3.12",
    "/opt/homebrew/bin/python3.13",
    "/opt/homebrew/bin/python3.11",
    "/opt/homebrew/bin/python3.10",
    "/usr/bin/python3",
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "python3",
  ] {
    if python_has_sherpa(candidate) {
      return Some(candidate.to_string());
    }
  }
  None
}

/// Prefer Python 3.9–3.14 where sherpa-onnx publishes prebuilt wheels,
/// avoiding bleeding-edge Python 3.15+ which would trigger slow C++ source builds.
fn resolve_wheel_compatible_python() -> Result<String, String> {
  let candidates = [
    "/opt/homebrew/bin/python3.12",
    "/opt/homebrew/bin/python3.13",
    "/opt/homebrew/bin/python3.11",
    "/opt/homebrew/bin/python3.10",
    "/opt/homebrew/bin/python3.14",
    "/usr/local/bin/python3.12",
    "/usr/local/bin/python3.11",
    "/usr/bin/python3",
    "/opt/homebrew/bin/python3",
    "python3",
  ];

  let mut fallback: Option<String> = None;
  for candidate in candidates {
    if let Some((major, minor)) = python_minor_version(candidate) {
      if major == 3 && (9..=14).contains(&minor) {
        return Ok(candidate.to_string());
      }
      if fallback.is_none() {
        fallback = Some(candidate.to_string());
      }
    }
  }

  fallback.ok_or_else(|| "未找到可用的 Python 3（建议 3.9–3.13）".into())
}

fn detect_macos_proxy_url() -> Option<String> {
  for key in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
    if let Ok(val) = std::env::var(key) {
      let trimmed = val.trim();
      if !trimmed.is_empty() {
        return Some(trimmed.to_string());
      }
    }
  }
  #[cfg(target_os = "macos")]
  {
    let out = Command::new("scutil").arg("--proxy").output().ok()?;
    if !out.status.success() {
      return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut http_en = false;
    let mut http_host = String::new();
    let mut http_port = String::new();
    let mut https_en = false;
    let mut https_host = String::new();
    let mut https_port = String::new();
    let mut socks_en = false;
    let mut socks_host = String::new();
    let mut socks_port = String::new();

    for line in text.lines() {
      if let Some((k, v)) = line.trim().split_once(':') {
        let key = k.trim();
        let val = v.trim();
        match key {
          "HTTPEnable" => http_en = val == "1",
          "HTTPProxy" => http_host = val.to_string(),
          "HTTPPort" => http_port = val.to_string(),
          "HTTPSEnable" => https_en = val == "1",
          "HTTPSProxy" => https_host = val.to_string(),
          "HTTPSPort" => https_port = val.to_string(),
          "SOCKSEnable" => socks_en = val == "1",
          "SOCKSProxy" => socks_host = val.to_string(),
          "SOCKSPort" => socks_port = val.to_string(),
          _ => {}
        }
      }
    }
    if https_en && !https_host.is_empty() && !https_port.is_empty() {
      return Some(format!("http://{https_host}:{https_port}"));
    }
    if http_en && !http_host.is_empty() && !http_port.is_empty() {
      return Some(format!("http://{http_host}:{http_port}"));
    }
    if socks_en && !socks_host.is_empty() && !socks_port.is_empty() {
      return Some(format!("socks5h://{socks_host}:{socks_port}"));
    }
  }
  None
}

fn apply_proxy_env(cmd: &mut Command) -> Option<String> {
  if let Some(proxy) = detect_macos_proxy_url() {
    cmd.env("HTTP_PROXY", &proxy);
    cmd.env("HTTPS_PROXY", &proxy);
    cmd.env("http_proxy", &proxy);
    cmd.env("https_proxy", &proxy);
    return Some(proxy);
  }
  None
}

fn ensure_worker_script(app: &AppHandle) -> Result<PathBuf, String> {
  let root = tts_root_dir(app)?;
  fs::create_dir_all(&root).map_err(|e| e.to_string())?;
  let script_path = root.join("tts_worker.py");
  fs::write(&script_path, WORKER_SCRIPT.as_bytes()).map_err(|e| e.to_string())?;
  Ok(script_path)
}

fn spawn_worker(app: &AppHandle) -> Result<WorkerHandle, String> {
  let py = resolve_python_with_sherpa(app)
    .ok_or_else(|| "尚未安装离线语音运行时 sherpa-onnx，请点击「安装离线引擎」".to_string())?;
  let model_dir = model_dir_path(app)?;
  if !has_model_files(&model_dir) {
    return Err("尚未下载 Kokoro 离线语音模型，请先点击「下载语音模型」".into());
  }
  let script = ensure_worker_script(app)?;

  let mut child = Command::new(&py)
    .arg(&script)
    .arg(&model_dir)
    .arg("2")
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|e| format!("启动 TTS 引擎失败: {e}"))?;

  let stdin = child.stdin.take().ok_or("无法打开 TTS 进程标准输入")?;
  let stdout_raw = child.stdout.take().ok_or("无法打开 TTS 进程标准输出")?;
  let mut stdout = BufReader::new(stdout_raw);

  let mut ready_line = String::new();
  stdout
    .read_line(&mut ready_line)
    .map_err(|e| format!("读取 TTS 初始化状态失败: {e}"))?;
  let ready_msg: WorkerReadyMsg = serde_json::from_str(ready_line.trim())
    .map_err(|e| format!("TTS 初始化响应解析失败: {e} ({ready_line})"))?;
  if !ready_msg.ready {
    let _ = child.kill();
    return Err(ready_msg.error.unwrap_or_else(|| "TTS 模型加载失败".into()));
  }

  Ok(WorkerHandle {
    child,
    stdin,
    stdout,
    next_id: 1,
  })
}

fn parse_curl_percent(line: &str) -> Option<(u8, String)> {
  // Standard curl progress table columns:
  // % Total  % Received  % Xferd  Average Speed ...
  let parts: Vec<&str> = line.split_whitespace().collect();
  if parts.len() < 7 {
    return None;
  }
  let pct = parts[0].parse::<u8>().ok()?;
  if pct > 100 {
    return None;
  }
  let total = parts[1];
  let received = parts[3];
  let speed = parts[6];
  Some((pct, format!("{received} / {total} · {speed}/s")))
}

#[tauri::command]
pub async fn tts_status(
  app: AppHandle,
  state: State<'_, TtsState>,
) -> Result<TtsStatus, String> {
  let worker_arc = state.worker.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let model_dir = model_dir_path(&app)?;
    let py = resolve_python_with_sherpa(&app);
    let worker_running = worker_arc
      .lock()
      .map(|g| g.is_some())
      .unwrap_or(false);
    Ok(TtsStatus {
      runtime_ready: py.is_some(),
      model_ready: has_model_files(&model_dir),
      model_id: KOKORO_MODEL_ID.to_string(),
      model_dir: model_dir.to_string_lossy().to_string(),
      python_path: py,
      worker_running,
    })
  })
  .await
  .map_err(|e| format!("读取 TTS 状态任务异常: {e}"))?
}

#[tauri::command]
pub async fn tts_setup_runtime(app: AppHandle) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let root = tts_root_dir(&app)?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let venv_dir = root.join("venv");
    let venv_py = venv_dir.join("bin").join("python3");

    emit_progress(&app, "runtime", Some(5), "检查本机 Python 环境…", None);

    let needs_recreate = if venv_py.is_file() {
      match python_minor_version(&venv_py.to_string_lossy()) {
        Some((3, m)) if (9..=14).contains(&m) => false,
        _ => true,
      }
    } else {
      true
    };

    if needs_recreate {
      if venv_dir.exists() {
        let _ = fs::remove_dir_all(&venv_dir);
      }
      let base_py = resolve_wheel_compatible_python()?;
      emit_progress(
        &app,
        "runtime",
        Some(15),
        "正在创建隔离虚拟环境…",
        Some(format!("使用 {base_py}")),
      );
      let output = Command::new(&base_py)
        .args(["-m", "venv", &venv_dir.to_string_lossy()])
        .output()
        .map_err(|e| format!("创建隔离虚拟环境失败 ({base_py}): {e}"))?;
      if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
          "创建隔离虚拟环境失败: {}",
          err.chars().take(240).collect::<String>()
        ));
      }
    }

    let mut pip_cmd = Command::new(&venv_py);
    pip_cmd
      .args([
        "-u",
        "-m",
        "pip",
        "install",
        "--upgrade",
        "--only-binary=:all:",
        "-i",
        "https://pypi.org/simple",
        "--default-timeout",
        "25",
        "--retries",
        "2",
        "--progress-bar",
        "off",
        "sherpa-onnx",
      ])
      .stdout(Stdio::piped())
      .stderr(Stdio::piped());
    let proxy_used = apply_proxy_env(&mut pip_cmd);

    emit_progress(
      &app,
      "runtime",
      Some(28),
      "正在连接 PyPI 获取 sherpa-onnx 预编译包…",
      proxy_used.map(|p| format!("已自动使用代理 {p}")),
    );

    let mut child = pip_cmd
      .spawn()
      .map_err(|e| format!("启动 pip 安装失败: {e}"))?;

    let stderr_handle = child.stderr.take().map(|err_pipe| {
      std::thread::spawn(move || {
        let mut buf = String::new();
        let mut reader = BufReader::new(err_pipe);
        let _ = reader.read_to_string(&mut buf);
        buf
      })
    });

    let mut pct: u8 = 30;
    if let Some(out_pipe) = child.stdout.take() {
      let reader = BufReader::new(out_pipe);
      for line in reader.lines().map_while(Result::ok) {
        let trimmed = line.trim().to_string();
        if trimmed.is_empty() {
          continue;
        }
        let stage = if trimmed.starts_with("Collecting") {
          pct = pct.max(40);
          "正在解析依赖包…"
        } else if trimmed.starts_with("Downloading") {
          pct = pct.max(60);
          "正在下载 sherpa-onnx 预编译包…"
        } else if trimmed.starts_with("Installing collected") {
          pct = pct.max(84);
          "正在安装依赖到本地隔离环境…"
        } else if trimmed.starts_with("Successfully installed") {
          pct = 98;
          "安装完成，正在校验…"
        } else {
          pct = (pct + 2).min(92);
          "正在安装 sherpa-onnx…"
        };
        emit_progress(&app, "runtime", Some(pct), stage, Some(trimmed));
      }
    }

    let status = child
      .wait()
      .map_err(|e| format!("等待 pip 结束失败: {e}"))?;
    let stderr_text = stderr_handle
      .and_then(|h| h.join().ok())
      .unwrap_or_default();

    if !status.success() {
      return Err(format!(
        "安装 sherpa-onnx 预编译包失败（建议本机安装 python@3.12 后重试）: {}",
        stderr_text.chars().take(260).collect::<String>()
      ));
    }

    emit_progress(&app, "runtime", Some(100), "离线推理引擎安装完成", None);
    Ok(venv_py.to_string_lossy().to_string())
  })
  .await
  .map_err(|e| format!("安装任务异常: {e}"))?
}

#[tauri::command]
pub async fn tts_download_model(app: AppHandle) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let models_root = tts_root_dir(&app)?.join("models");
    fs::create_dir_all(&models_root).map_err(|e| e.to_string())?;
    let target_dir = models_root.join(KOKORO_MODEL_ID);
    if has_model_files(&target_dir) {
      emit_progress(&app, "model", Some(100), "Kokoro 模型已就绪", None);
      return Ok(target_dir.to_string_lossy().to_string());
    }

    let archive = models_root.join(format!("{KOKORO_MODEL_ID}.tar.bz2"));
    let mut curl_cmd = Command::new("curl");
    curl_cmd
      .args([
        "-fL",
        "--connect-timeout",
        "15",
        "--speed-limit",
        "1024",
        "--speed-time",
        "30",
        "--retry",
        "2",
        "-o",
      ])
      .arg(&archive)
      .arg(KOKORO_MODEL_URL)
      .stdout(Stdio::null())
      .stderr(Stdio::piped());
    let proxy_used = apply_proxy_env(&mut curl_cmd);

    emit_progress(
      &app,
      "model",
      Some(1),
      "正在连接 GitHub 下载 Kokoro 中英模型…",
      proxy_used.map(|p| format!("已自动使用代理 {p}")),
    );

    let mut child = curl_cmd
      .spawn()
      .map_err(|e| format!("启动模型下载失败: {e}"))?;

    let mut last_err_line = String::new();
    if let Some(mut err_pipe) = child.stderr.take() {
      let mut byte = [0u8; 1];
      let mut current = Vec::<u8>::with_capacity(128);
      while err_pipe.read(&mut byte).unwrap_or(0) == 1 {
        if byte[0] == b'\r' || byte[0] == b'\n' {
          if !current.is_empty() {
            let line = String::from_utf8_lossy(&current).trim().to_string();
            current.clear();
            if line.is_empty() {
              continue;
            }
            if let Some((raw_pct, detail)) = parse_curl_percent(&line) {
              // Map download 0..100% -> overall 2..88% (leaving 88..100% for extraction)
              let scaled = 2 + ((raw_pct as u16 * 86) / 100) as u8;
              emit_progress(
                &app,
                "model",
                Some(scaled),
                &format!("正在下载 Kokoro 模型 ({raw_pct}%)…"),
                Some(detail),
              );
            } else {
              last_err_line = line;
            }
          }
        } else {
          current.push(byte[0]);
        }
      }
    }

    let dl_status = child
      .wait()
      .map_err(|e| format!("等待模型下载结束失败: {e}"))?;
    if !dl_status.success() {
      let _ = fs::remove_file(&archive);
      return Err(format!(
        "下载 Kokoro 模型失败: {}",
        last_err_line.chars().take(200).collect::<String>()
      ));
    }

    emit_progress(
      &app,
      "model",
      Some(90),
      "下载完成，正在解压模型文件…",
      Some(format!("{KOKORO_MODEL_ID}.tar.bz2")),
    );

    let extract = Command::new("tar")
      .arg("-xjf")
      .arg(&archive)
      .arg("-C")
      .arg(&models_root)
      .output()
      .map_err(|e| format!("解压模型失败: {e}"))?;

    let _ = fs::remove_file(&archive);

    if !extract.status.success() || !has_model_files(&target_dir) {
      let err = String::from_utf8_lossy(&extract.stderr);
      return Err(format!(
        "解压 Kokoro 模型失败: {}",
        err.chars().take(200).collect::<String>()
      ));
    }

    emit_progress(&app, "model", Some(100), "Kokoro 模型已就绪", None);
    Ok(target_dir.to_string_lossy().to_string())
  })
  .await
  .map_err(|e| format!("下载模型任务异常: {e}"))?
}

#[tauri::command]
pub async fn tts_synthesize(
  app: AppHandle,
  state: State<'_, TtsState>,
  text: String,
  sid: u32,
  speed: f32,
) -> Result<TtsSynthResult, String> {
  let worker_arc = state.worker.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let trimmed = text.trim();
    if trimmed.is_empty() {
      return Err("待合成文本为空".into());
    }

    let mut guard = worker_arc.lock().map_err(|_| "TTS 状态锁异常".to_string())?;
    if guard.is_none() {
      *guard = Some(spawn_worker(&app)?);
    }

    let handle = guard.as_mut().ok_or("TTS 进程未就绪")?;
    let req_id = handle.next_id;
    handle.next_id += 1;

    let req_json = serde_json::json!({
      "id": req_id,
      "text": trimmed,
      "sid": sid,
      "speed": speed,
    });

    if let Err(err) = writeln!(handle.stdin, "{req_json}").and_then(|_| handle.stdin.flush()) {
      let _ = handle.child.kill();
      *guard = None;
      return Err(format!("写入 TTS 请求失败: {err}"));
    }

    let mut resp_line = String::new();
    if let Err(err) = handle.stdout.read_line(&mut resp_line) {
      let _ = handle.child.kill();
      *guard = None;
      return Err(format!("读取 TTS 音频失败: {err}"));
    }

    if resp_line.trim().is_empty() {
      let _ = handle.child.kill();
      *guard = None;
      return Err("TTS 进程意外退出，请重试".into());
    }

    let resp: WorkerSynthResp = serde_json::from_str(resp_line.trim())
      .map_err(|e| format!("解析 TTS 响应失败: {e}"))?;
    if !resp.ok {
      return Err(resp.error.unwrap_or_else(|| "语音合成失败".into()));
    }

    Ok(TtsSynthResult {
      wav_b64: resp.wav_b64.unwrap_or_default(),
      sample_rate: resp.sample_rate.unwrap_or(24000),
    })
  })
  .await
  .map_err(|e| format!("语音合成任务异常: {e}"))?
}

#[tauri::command]
pub async fn tts_stop_worker(state: State<'_, TtsState>) -> Result<(), String> {
  let worker_arc = state.worker.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let mut guard = worker_arc.lock().map_err(|_| "TTS 状态锁异常".to_string())?;
    if let Some(mut handle) = guard.take() {
      let _ = writeln!(handle.stdin, r#"{{"cmd":"quit"}}"#);
      let _ = handle.stdin.flush();
      let _ = handle.child.kill();
      let _ = handle.child.wait();
    }
    Ok(())
  })
  .await
  .map_err(|e| format!("停止 TTS 任务异常: {e}"))?
}
