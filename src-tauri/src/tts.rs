use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

const KOKORO_MODEL_ID: &str = "kokoro-int8-multi-lang-v1_1";
const KOKORO_MODEL_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2";
const WORKER_SCRIPT: &str = include_str!("../../scripts/tts_worker.py");

struct WorkerHandle {
  child: Child,
  stdin: ChildStdin,
  stdout: BufReader<ChildStdout>,
  next_id: u64,
}

#[derive(Default)]
pub struct TtsState {
  worker: Mutex<Option<WorkerHandle>>,
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
  for candidate in ["python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"] {
    if python_has_sherpa(candidate) {
      return Some(candidate.to_string());
    }
  }
  None
}

fn resolve_base_python() -> Result<String, String> {
  for candidate in ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "python3"] {
    if Command::new(candidate)
      .arg("--version")
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .status()
      .map(|s| s.success())
      .unwrap_or(false)
    {
      return Ok(candidate.to_string());
    }
  }
  Err("未找到 python3，请先安装 Python 3".into())
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

#[tauri::command]
pub fn tts_status(app: AppHandle, state: State<'_, TtsState>) -> Result<TtsStatus, String> {
  let model_dir = model_dir_path(&app)?;
  let py = resolve_python_with_sherpa(&app);
  let worker_running = state
    .worker
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
}

#[tauri::command]
pub fn tts_setup_runtime(app: AppHandle) -> Result<String, String> {
  let root = tts_root_dir(&app)?;
  fs::create_dir_all(&root).map_err(|e| e.to_string())?;
  let venv_dir = root.join("venv");
  let venv_py = venv_dir.join("bin").join("python3");

  if !venv_py.is_file() {
    let base_py = resolve_base_python()?;
    let status = Command::new(&base_py)
      .args(["-m", "venv", &venv_dir.to_string_lossy()])
      .status()
      .map_err(|e| format!("创建隔离虚拟环境失败: {e}"))?;
    if !status.success() {
      return Err("创建隔离虚拟环境失败".into());
    }
  }

  let output = Command::new(&venv_py)
    .args(["-m", "pip", "install", "--upgrade", "sherpa-onnx"])
    .output()
    .map_err(|e| format!("安装 sherpa-onnx 失败: {e}"))?;

  if !output.status.success() {
    let err = String::from_utf8_lossy(&output.stderr);
    return Err(format!("安装 sherpa-onnx 失败: {}", err.chars().take(240).collect::<String>()));
  }

  Ok(venv_py.to_string_lossy().to_string())
}

#[tauri::command]
pub fn tts_download_model(app: AppHandle) -> Result<String, String> {
  let models_root = tts_root_dir(&app)?.join("models");
  fs::create_dir_all(&models_root).map_err(|e| e.to_string())?;
  let target_dir = models_root.join(KOKORO_MODEL_ID);
  if has_model_files(&target_dir) {
    return Ok(target_dir.to_string_lossy().to_string());
  }

  let archive = models_root.join(format!("{KOKORO_MODEL_ID}.tar.bz2"));
  let dl = Command::new("curl")
    .args(["-fSL", "--retry", "2", "-o"])
    .arg(&archive)
    .arg(KOKORO_MODEL_URL)
    .output()
    .map_err(|e| format!("下载模型失败: {e}"))?;

  if !dl.status.success() {
    let _ = fs::remove_file(&archive);
    let err = String::from_utf8_lossy(&dl.stderr);
    return Err(format!("下载 Kokoro 模型失败: {}", err.chars().take(200).collect::<String>()));
  }

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
    return Err(format!("解压 Kokoro 模型失败: {}", err.chars().take(200).collect::<String>()));
  }

  Ok(target_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn tts_synthesize(
  app: AppHandle,
  state: State<'_, TtsState>,
  text: String,
  sid: u32,
  speed: f32,
) -> Result<TtsSynthResult, String> {
  let trimmed = text.trim();
  if trimmed.is_empty() {
    return Err("待合成文本为空".into());
  }

  let mut guard = state.worker.lock().map_err(|_| "TTS 状态锁异常".to_string())?;
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
}

#[tauri::command]
pub fn tts_stop_worker(state: State<'_, TtsState>) -> Result<(), String> {
  let mut guard = state.worker.lock().map_err(|_| "TTS 状态锁异常".to_string())?;
  if let Some(mut handle) = guard.take() {
    let _ = writeln!(handle.stdin, r#"{{"cmd":"quit"}}"#);
    let _ = handle.stdin.flush();
    let _ = handle.child.kill();
    let _ = handle.child.wait();
  }
  Ok(())
}
