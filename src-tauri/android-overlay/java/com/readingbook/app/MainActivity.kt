package com.readingbook.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import java.lang.ref.WeakReference

class MainActivity : TauriActivity() {

  companion object {
    @Volatile
    private var instanceRef: WeakReference<MainActivity>? = null

    fun dispatchTtsEvent(event: String) {
      val activity = instanceRef?.get() ?: return
      activity.runOnUiThread {
        val wv = activity.appWebView ?: return@runOnUiThread
        if (event == "play" || event == "ended" || event == "next" || event == "prev") {
          wv.onResume()
          wv.resumeTimers()
        }
        wv.evaluateJavascript(
          "window.__androidTtsEvent && window.__androidTtsEvent('$event');",
          null
        )
      }
    }
  }

  private var appWebView: WebView? = null
  private var notificationPermRequested = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    instanceRef = WeakReference(this)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    webView.addJavascriptInterface(AndroidTtsBridge(this), "AndroidTtsBridge")
  }

  override fun onPause() {
    super.onPause()
    if (TtsMediaService.keepWebViewAlive) {
      // WryActivity.onPause() calls mWebView.onPause(), which suspends WebView JS timers
      // and prevents advancing to the next TTS sentence when the screen turns off.
      appWebView?.onResume()
      appWebView?.resumeTimers()
    }
  }

  override fun onDestroy() {
    if (instanceRef?.get() === this) {
      instanceRef = null
    }
    appWebView = null
    super.onDestroy()
  }

  fun ensureNotificationPermission() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    if (notificationPermRequested) return
    val granted = ContextCompat.checkSelfPermission(
      this,
      Manifest.permission.POST_NOTIFICATIONS
    ) == PackageManager.PERMISSION_GRANTED
    if (granted) return
    notificationPermRequested = true
    runOnUiThread {
      try {
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS)) { }
      } catch (_: Throwable) {}
    }
  }
}
