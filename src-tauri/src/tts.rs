use kothok_edge_tts::{init_tls, EdgeTts, Engine, TtsEvent};
use tauri::ipc::Response;

fn voice_locale(voice: &str) -> &'static str {
  if voice.starts_with("en-US") {
    "en-US"
  } else {
    "zh-CN"
  }
}

/// Online Microsoft Edge Neural TTS synthesis via `kothok-edge-tts`
/// (tokio + rustls/ring + webpki-roots — works identically on macOS and Android
/// without platform-verifier JNI initialization or extra voice-list locks).
#[tauri::command]
pub async fn tts_synthesize(text: String, voice: String) -> Result<Response, String> {
  let trimmed = text.trim();
  if trimmed.is_empty() {
    return Err("待朗读文本为空".into());
  }

  init_tls();

  let events = EdgeTts
    .synthesize(trimmed, &voice, "+0%", voice_locale(&voice))
    .await
    .map_err(|e| format!("Edge TTS 合成失败（请检查网络/代理）: {e}"))?;

  let mut audio = Vec::<u8>::with_capacity(32 * 1024);
  for ev in events {
    if let TtsEvent::Audio(bytes) = ev {
      audio.extend_from_slice(&bytes);
    }
  }

  if audio.is_empty() {
    return Err("未收到语音音频数据".into());
  }
  Ok(Response::new(audio))
}
