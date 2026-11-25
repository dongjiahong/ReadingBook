use std::sync::OnceLock;

use edge_tts_rust::{EdgeTtsClient, SpeakOptions};
use tauri::ipc::Response;

static TTS_CLIENT: OnceLock<EdgeTtsClient> = OnceLock::new();

fn get_client() -> Result<&'static EdgeTtsClient, String> {
  if let Some(c) = TTS_CLIENT.get() {
    return Ok(c);
  }
  let created =
    EdgeTtsClient::new().map_err(|e| format!("初始化 Edge TTS 客户端失败: {e}"))?;
  Ok(TTS_CLIENT.get_or_init(|| created))
}

/// Online Microsoft Edge Neural TTS synthesis via `edge-tts-rust` (async, pooled WebSocket).
#[tauri::command]
pub async fn tts_synthesize(text: String, voice: String) -> Result<Response, String> {
  let trimmed = text.trim();
  if trimmed.is_empty() {
    return Err("待朗读文本为空".into());
  }

  let client = get_client()?;
  let result = client
    .synthesize(
      trimmed,
      SpeakOptions {
        voice,
        output_format: "audio-24khz-48kbitrate-mono-mp3".into(),
        ..SpeakOptions::default()
      },
    )
    .await
    .map_err(|e| format!("Edge TTS 合成失败（请检查网络/代理）: {e}"))?;

  if result.audio.is_empty() {
    return Err("未收到语音音频数据".into());
  }
  Ok(Response::new(result.audio))
}
