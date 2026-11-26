package com.readingbook.app

import android.content.Intent
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import androidx.annotation.Keep
import androidx.core.content.ContextCompat
import java.io.File

@Keep
class AndroidTtsBridge(private val activity: MainActivity) {

  companion object {
    private const val TAG = "AndroidTtsBridge"
  }

  private var slotToggle = false

  @JavascriptInterface
  fun isAvailable(): Boolean = true

  @JavascriptInterface
  fun setLoading(title: String?, subtitle: String?) {
    activity.ensureNotificationPermission()
    val intent = Intent(activity, TtsMediaService::class.java).apply {
      action = TtsMediaService.ACTION_LOAD
      putExtra(TtsMediaService.EXTRA_TITLE, title ?: "ReadingBook 听书")
      putExtra(TtsMediaService.EXTRA_SUBTITLE, subtitle ?: "正在加载语音…")
    }
    try {
      ContextCompat.startForegroundService(activity, intent)
    } catch (t: Throwable) {
      Log.e(TAG, "Failed to start foreground service for loading", t)
    }
  }

  @JavascriptInterface
  fun playAudio(
    base64Mp3: String,
    speed: Float,
    title: String?,
    subtitle: String?
  ) {
    activity.ensureNotificationPermission()
    try {
      val bytes = Base64.decode(base64Mp3, Base64.DEFAULT)
      slotToggle = !slotToggle
      val fileName = if (slotToggle) "tts_chunk_a.mp3" else "tts_chunk_b.mp3"
      val outFile = File(activity.cacheDir, fileName)
      outFile.writeBytes(bytes)

      val intent = Intent(activity, TtsMediaService::class.java).apply {
        action = TtsMediaService.ACTION_PLAY_FILE
        putExtra(TtsMediaService.EXTRA_FILE_PATH, outFile.absolutePath)
        putExtra(TtsMediaService.EXTRA_SPEED, speed)
        putExtra(TtsMediaService.EXTRA_TITLE, title ?: "ReadingBook 听书")
        putExtra(TtsMediaService.EXTRA_SUBTITLE, subtitle ?: "")
      }
      ContextCompat.startForegroundService(activity, intent)
    } catch (t: Throwable) {
      Log.e(TAG, "Failed to decode/play TTS audio", t)
      MainActivity.dispatchTtsEvent("error")
    }
  }

  @JavascriptInterface
  fun pause() {
    if (!TtsMediaService.isRunning) return
    val intent = Intent(activity, TtsMediaService::class.java).apply {
      action = TtsMediaService.ACTION_PAUSE
    }
    try {
      activity.startService(intent)
    } catch (t: Throwable) {
      Log.w(TAG, "Failed to send pause to service", t)
    }
  }

  @JavascriptInterface
  fun resume() {
    activity.ensureNotificationPermission()
    val intent = Intent(activity, TtsMediaService::class.java).apply {
      action = TtsMediaService.ACTION_RESUME
    }
    try {
      ContextCompat.startForegroundService(activity, intent)
    } catch (t: Throwable) {
      Log.w(TAG, "Failed to send resume to service", t)
    }
  }

  @JavascriptInterface
  fun setSpeed(speed: Float) {
    if (!TtsMediaService.isRunning) return
    val intent = Intent(activity, TtsMediaService::class.java).apply {
      action = TtsMediaService.ACTION_SPEED
      putExtra(TtsMediaService.EXTRA_SPEED, speed)
    }
    try {
      activity.startService(intent)
    } catch (t: Throwable) {
      Log.w(TAG, "Failed to send speed to service", t)
    }
  }

  @JavascriptInterface
  fun stop() {
    if (!TtsMediaService.isRunning) return
    val intent = Intent(activity, TtsMediaService::class.java).apply {
      action = TtsMediaService.ACTION_STOP
    }
    try {
      activity.startService(intent)
    } catch (t: Throwable) {
      Log.w(TAG, "Failed to stop service", t)
    }
  }
}
