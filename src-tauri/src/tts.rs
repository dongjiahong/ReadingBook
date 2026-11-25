use std::sync::{Mutex, OnceLock};

use msedge_tts::tts::client::connect;
use msedge_tts::tts::SpeechConfig;
use msedge_tts::voice::{get_voices_list, Voice};
use tauri::ipc::Response;

static VOICE_CACHE: OnceLock<Mutex<Option<Vec<Voice>>>> = OnceLock::new();

fn resolve_speech_config(voice_short_name: &str) -> Result<SpeechConfig, String> {
  let cache = VOICE_CACHE.get_or_init(|| Mutex::new(None));
  let mut guard = cache
    .lock()
    .map_err(|_| "语音列表锁异常".to_string())?;

  if guard.is_none() {
    let voices = get_voices_list()
      .map_err(|e| format!("获取 Edge 语音列表失败（请检查网络/代理）: {e}"))?;
    *guard = Some(voices);
  }

  let voices = guard.as_ref().ok_or("语音列表为空")?;
  let matched = voices
    .iter()
    .find(|v| v.name.contains(voice_short_name))
    .or_else(|| voices.iter().find(|v| v.name.contains("XiaoxiaoNeural")))
    .or_else(|| voices.first())
    .ok_or_else(|| format!("未找到音色: {voice_short_name}"))?;

  Ok(SpeechConfig::from(matched))
}

/// Online Microsoft Edge Neural TTS synthesis (via `msedge-tts`).
/// Runs on a background blocking thread and returns raw MP3 bytes via Tauri binary IPC.
#[tauri::command]
pub async fn tts_synthesize(
  text: String,
  voice: String,
) -> Result<Response, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let trimmed = text.trim();
    if trimmed.is_empty() {
      return Err("待朗读文本为空".into());
    }

    let config = resolve_speech_config(&voice)?;
    let mut client = connect()
      .map_err(|e| format!("连接 Edge TTS 服务失败（请检查网络/代理）: {e}"))?;
    let audio = client
      .synthesize(trimmed, &config)
      .map_err(|e| format!("语音合成失败: {e}"))?;

    if audio.audio_bytes.is_empty() {
      return Err("未收到语音音频数据".into());
    }
    Ok(Response::new(audio.audio_bytes))
  })
  .await
  .map_err(|e| format!("语音合成任务异常: {e}"))?
}
