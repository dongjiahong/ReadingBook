package com.readingbook.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.media.app.NotificationCompat.MediaStyle
import java.io.File

class TtsMediaService : Service() {

  companion object {
    private const val TAG = "ReadingBookTts"
    private const val CHANNEL_ID = "readingbook_tts_playback"
    private const val NOTIFICATION_ID = 4108
    private const val WAKELOCK_TIMEOUT_MS = 60L * 60L * 1000L

    const val ACTION_LOAD = "com.readingbook.app.tts.LOAD"
    const val ACTION_PLAY_FILE = "com.readingbook.app.tts.PLAY_FILE"
    const val ACTION_PAUSE = "com.readingbook.app.tts.PAUSE"
    const val ACTION_RESUME = "com.readingbook.app.tts.RESUME"
    const val ACTION_TOGGLE = "com.readingbook.app.tts.TOGGLE"
    const val ACTION_PREV = "com.readingbook.app.tts.PREV"
    const val ACTION_NEXT = "com.readingbook.app.tts.NEXT"
    const val ACTION_SPEED = "com.readingbook.app.tts.SPEED"
    const val ACTION_STOP = "com.readingbook.app.tts.STOP"

    const val EXTRA_FILE_PATH = "file_path"
    const val EXTRA_SPEED = "speed"
    const val EXTRA_TITLE = "title"
    const val EXTRA_SUBTITLE = "subtitle"

    @Volatile
    var isRunning: Boolean = false
      private set

    /** True while TTS session is active (playing or buffering) so MainActivity keeps WebView JS alive. */
    @Volatile
    var keepWebViewAlive: Boolean = false
      private set
  }

  private lateinit var mediaSession: MediaSessionCompat
  private lateinit var audioManager: AudioManager
  private lateinit var notificationManager: NotificationManager
  private var wakeLock: PowerManager.WakeLock? = null
  private var audioFocusRequest: AudioFocusRequest? = null
  private var mediaPlayer: MediaPlayer? = null
  private var artworkBitmap: Bitmap? = null

  private var currentTitle: String = "ReadingBook 听书"
  private var currentSubtitle: String = "准备朗读…"
  private var currentSpeed: Float = 1.0f
  private var isPlaying: Boolean = false
  private var isBuffering: Boolean = false
  private var hasAudioLoaded: Boolean = false
  private var foregroundStarted: Boolean = false
  private var pausedByTransientLoss: Boolean = false
  private var noisyReceiverRegistered: Boolean = false

  private val becomingNoisyReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY && isPlaying) {
        pausePlayback(notifyJs = true)
      }
    }
  }

  private val audioFocusListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
    when (focusChange) {
      AudioManager.AUDIOFOCUS_LOSS -> {
        pausedByTransientLoss = false
        if (isPlaying) pausePlayback(notifyJs = true)
      }
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
        if (isPlaying) {
          pausedByTransientLoss = true
          pausePlayback(notifyJs = true)
        }
      }
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
        try {
          mediaPlayer?.setVolume(0.25f, 0.25f)
        } catch (_: Throwable) {}
      }
      AudioManager.AUDIOFOCUS_GAIN -> {
        try {
          mediaPlayer?.setVolume(1.0f, 1.0f)
        } catch (_: Throwable) {}
        if (pausedByTransientLoss) {
          pausedByTransientLoss = false
          resumePlayback(notifyJs = true)
        }
      }
    }
  }

  override fun onCreate() {
    super.onCreate()
    isRunning = true
    audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
    notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ReadingBook:TtsPlayback").apply {
      setReferenceCounted(false)
    }

    artworkBitmap = loadLauncherBitmap()
    createNotificationChannel()

    mediaSession = MediaSessionCompat(this, "ReadingBookTtsSession").apply {
      setCallback(object : MediaSessionCompat.Callback() {
        override fun onPlay() {
          resumePlayback(notifyJs = true)
        }

        override fun onPause() {
          pausePlayback(notifyJs = true)
        }

        override fun onSkipToNext() {
          MainActivity.dispatchTtsEvent("next")
        }

        override fun onSkipToPrevious() {
          MainActivity.dispatchTtsEvent("prev")
        }

        override fun onStop() {
          MainActivity.dispatchTtsEvent("stop")
          stopServiceCleanly()
        }
      })
      isActive = true
    }

    ContextCompat.registerReceiver(
      this,
      becomingNoisyReceiver,
      IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
      ContextCompat.RECEIVER_NOT_EXPORTED
    )
    noisyReceiverRegistered = true
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action ?: return START_NOT_STICKY

    when (action) {
      ACTION_LOAD -> {
        updateMetadataFields(intent)
        isBuffering = true
        keepWebViewAlive = true
        acquireWakeLock()
        updateMediaSession()
        promoteOrUpdateForeground()
      }

      ACTION_PLAY_FILE -> {
        updateMetadataFields(intent)
        val path = intent.getStringExtra(EXTRA_FILE_PATH)
        val speed = intent.getFloatExtra(EXTRA_SPEED, currentSpeed)
        currentSpeed = speed.coerceIn(0.5f, 3.0f)
        if (!path.isNullOrBlank()) {
          playAudioFile(path)
        } else {
          promoteOrUpdateForeground()
        }
      }

      ACTION_PAUSE -> {
        pausePlayback(notifyJs = false)
      }

      ACTION_RESUME -> {
        resumePlayback(notifyJs = false)
      }

      ACTION_TOGGLE -> {
        if (isPlaying) {
          pausePlayback(notifyJs = true)
        } else {
          resumePlayback(notifyJs = true)
        }
      }

      ACTION_PREV -> {
        MainActivity.dispatchTtsEvent("prev")
      }

      ACTION_NEXT -> {
        MainActivity.dispatchTtsEvent("next")
      }

      ACTION_SPEED -> {
        val speed = intent.getFloatExtra(EXTRA_SPEED, currentSpeed).coerceIn(0.5f, 3.0f)
        currentSpeed = speed
        if (isPlaying) {
          applyPlaybackSpeed(mediaPlayer, currentSpeed)
          updateMediaSession()
        }
      }

      ACTION_STOP -> {
        MainActivity.dispatchTtsEvent("stop")
        stopServiceCleanly()
      }
    }

    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onTaskRemoved(rootIntent: Intent?) {
    super.onTaskRemoved(rootIntent)
    if (!isPlaying && !isBuffering) {
      stopServiceCleanly()
    }
  }

  override fun onDestroy() {
    isRunning = false
    keepWebViewAlive = false
    isPlaying = false
    isBuffering = false
    foregroundStarted = false
    releasePlayer()
    abandonAudioFocus()
    releaseWakeLock()
    if (noisyReceiverRegistered) {
      try {
        unregisterReceiver(becomingNoisyReceiver)
      } catch (_: Throwable) {}
      noisyReceiverRegistered = false
    }
    try {
      mediaSession.isActive = false
      mediaSession.release()
    } catch (_: Throwable) {}
    super.onDestroy()
  }

  private fun updateMetadataFields(intent: Intent) {
    intent.getStringExtra(EXTRA_TITLE)?.takeIf { it.isNotBlank() }?.let {
      currentTitle = it
    }
    intent.getStringExtra(EXTRA_SUBTITLE)?.takeIf { it.isNotBlank() }?.let {
      currentSubtitle = it
    }
  }

  private fun playAudioFile(path: String) {
    val file = File(path)
    if (!file.exists() || file.length() == 0L) {
      Log.e(TAG, "Audio file missing or empty: $path")
      isPlaying = false
      isBuffering = false
      updateMediaSession()
      promoteOrUpdateForeground()
      MainActivity.dispatchTtsEvent("error")
      return
    }

    keepWebViewAlive = true
    isBuffering = true
    acquireWakeLock()
    promoteOrUpdateForeground()

    if (!requestAudioFocus()) {
      Log.w(TAG, "AudioFocus denied; pausing")
      isPlaying = false
      isBuffering = false
      updateMediaSession()
      promoteOrUpdateForeground()
      MainActivity.dispatchTtsEvent("pause")
      return
    }

    releasePlayer()

    val player = MediaPlayer()
    try {
      player.setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      )
      player.setDataSource(path)
      player.setOnCompletionListener {
        isPlaying = false
        isBuffering = true
        // Keep session active & wakeLock held while JS hands off next sentence.
        updateMediaSession()
        promoteOrUpdateForeground()
        MainActivity.dispatchTtsEvent("ended")
      }
      player.setOnErrorListener { _, what, extra ->
        Log.e(TAG, "MediaPlayer error: what=$what extra=$extra")
        isPlaying = false
        isBuffering = false
        hasAudioLoaded = false
        updateMediaSession()
        promoteOrUpdateForeground()
        MainActivity.dispatchTtsEvent("error")
        true
      }
      player.prepare()
      applyPlaybackSpeed(player, currentSpeed)
      player.start()

      mediaPlayer = player
      hasAudioLoaded = true
      isPlaying = true
      isBuffering = false
      pausedByTransientLoss = false
      updateMediaSession()
      promoteOrUpdateForeground()
    } catch (t: Throwable) {
      Log.e(TAG, "Failed to start MediaPlayer", t)
      try {
        player.release()
      } catch (_: Throwable) {}
      mediaPlayer = null
      hasAudioLoaded = false
      isPlaying = false
      isBuffering = false
      updateMediaSession()
      promoteOrUpdateForeground()
      MainActivity.dispatchTtsEvent("error")
    }
  }

  private fun pausePlayback(notifyJs: Boolean) {
    try {
      mediaPlayer?.let {
        if (it.isPlaying) it.pause()
      }
    } catch (_: Throwable) {}
    isPlaying = false
    isBuffering = false
    keepWebViewAlive = false
    releaseWakeLock()
    updateMediaSession()
    if (foregroundStarted) {
      promoteOrUpdateForeground()
    }
    if (notifyJs) {
      MainActivity.dispatchTtsEvent("pause")
    }
  }

  private fun resumePlayback(notifyJs: Boolean) {
    val player = mediaPlayer
    if (player != null && hasAudioLoaded) {
      if (!requestAudioFocus()) {
        if (notifyJs) MainActivity.dispatchTtsEvent("pause")
        return
      }
      try {
        keepWebViewAlive = true
        acquireWakeLock()
        applyPlaybackSpeed(player, currentSpeed)
        player.start()
        isPlaying = true
        isBuffering = false
        pausedByTransientLoss = false
        updateMediaSession()
        promoteOrUpdateForeground()
        if (notifyJs) {
          MainActivity.dispatchTtsEvent("play")
        }
        return
      } catch (t: Throwable) {
        Log.w(TAG, "Resume failed, delegating to JS play()", t)
      }
    }
    // No loaded MediaPlayer instance — ask JS to start/play current chunk.
    keepWebViewAlive = true
    acquireWakeLock()
    promoteOrUpdateForeground()
    MainActivity.dispatchTtsEvent("play")
  }

  private fun applyPlaybackSpeed(player: MediaPlayer?, speed: Float) {
    if (player == null) return
    try {
      val params = player.playbackParams
      params.speed = speed.coerceIn(0.5f, 3.0f)
      player.playbackParams = params
    } catch (t: Throwable) {
      Log.w(TAG, "Failed to apply speed=$speed", t)
    }
  }

  private fun stopServiceCleanly() {
    keepWebViewAlive = false
    isPlaying = false
    isBuffering = false
    hasAudioLoaded = false
    releasePlayer()
    abandonAudioFocus()
    releaseWakeLock()
    try {
      mediaSession.setPlaybackState(
        PlaybackStateCompat.Builder()
          .setState(PlaybackStateCompat.STATE_STOPPED, 0L, 1.0f)
          .build()
      )
      mediaSession.isActive = false
    } catch (_: Throwable) {}
    try {
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    } catch (_: Throwable) {}
    foregroundStarted = false
    stopSelf()
  }

  private fun releasePlayer() {
    mediaPlayer?.let { p ->
      try {
        p.setOnCompletionListener(null)
        p.setOnErrorListener(null)
        if (p.isPlaying) p.stop()
        p.release()
      } catch (_: Throwable) {}
    }
    mediaPlayer = null
    hasAudioLoaded = false
  }

  private fun requestAudioFocus(): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        )
        .setAcceptsDelayedFocusGain(false)
        .setWillPauseWhenDucked(false)
        .setOnAudioFocusChangeListener(audioFocusListener)
        .build()
      audioFocusRequest = req
      audioManager.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    } else {
      @Suppress("DEPRECATION")
      audioManager.requestAudioFocus(
        audioFocusListener,
        AudioManager.STREAM_MUSIC,
        AudioManager.AUDIOFOCUS_GAIN
      ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }
  }

  private fun abandonAudioFocus() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      audioFocusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
      audioFocusRequest = null
    } else {
      @Suppress("DEPRECATION")
      audioManager.abandonAudioFocus(audioFocusListener)
    }
  }

  private fun acquireWakeLock() {
    try {
      wakeLock?.let { wl ->
        if (!wl.isHeld) {
          wl.acquire(WAKELOCK_TIMEOUT_MS)
        }
      }
    } catch (_: Throwable) {}
  }

  private fun releaseWakeLock() {
    try {
      wakeLock?.let { wl ->
        if (wl.isHeld) wl.release()
      }
    } catch (_: Throwable) {}
  }

  private fun updateMediaSession() {
    val durationMs = try {
      mediaPlayer?.takeIf { hasAudioLoaded }?.duration?.toLong()?.takeIf { it > 0 } ?: -1L
    } catch (_: Throwable) {
      -1L
    }
    val positionMs = try {
      mediaPlayer?.takeIf { hasAudioLoaded }?.currentPosition?.toLong()?.coerceAtLeast(0L) ?: 0L
    } catch (_: Throwable) {
      0L
    }

    val metadataBuilder = MediaMetadataCompat.Builder()
      .putString(MediaMetadataCompat.METADATA_KEY_TITLE, currentTitle)
      .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, currentSubtitle)
      .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, "ReadingBook 听书")
      .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs)

    artworkBitmap?.let { bmp ->
      metadataBuilder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, bmp)
      metadataBuilder.putBitmap(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON, bmp)
    }

    mediaSession.setMetadata(metadataBuilder.build())

    val state = when {
      isPlaying -> PlaybackStateCompat.STATE_PLAYING
      isBuffering -> PlaybackStateCompat.STATE_BUFFERING
      else -> PlaybackStateCompat.STATE_PAUSED
    }

    val actions = PlaybackStateCompat.ACTION_PLAY or
      PlaybackStateCompat.ACTION_PAUSE or
      PlaybackStateCompat.ACTION_PLAY_PAUSE or
      PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
      PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
      PlaybackStateCompat.ACTION_STOP

    mediaSession.setPlaybackState(
      PlaybackStateCompat.Builder()
        .setActions(actions)
        .setState(state, positionMs, if (isPlaying) currentSpeed else 0f)
        .build()
    )
    mediaSession.isActive = true
  }

  private fun promoteOrUpdateForeground() {
    val notification = buildNotification()
    if (!foregroundStarted) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        ServiceCompat.startForeground(
          this,
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      foregroundStarted = true
    } else {
      notificationManager.notify(NOTIFICATION_ID, notification)
    }
  }

  private fun buildNotification(): Notification {
    val openAppIntent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val contentPi = PendingIntent.getActivity(
      this,
      100,
      openAppIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    val prevPi = serviceActionPendingIntent(ACTION_PREV, 101)
    val togglePi = serviceActionPendingIntent(ACTION_TOGGLE, 102)
    val nextPi = serviceActionPendingIntent(ACTION_NEXT, 103)
    val stopPi = serviceActionPendingIntent(ACTION_STOP, 104)

    val playPauseIcon = if (isPlaying || isBuffering) {
      R.drawable.ic_media_pause
    } else {
      R.drawable.ic_media_play
    }
    val playPauseLabel = if (isPlaying || isBuffering) "暂停" else "播放"

    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_headphones)
      .setContentTitle(currentTitle)
      .setContentText(currentSubtitle)
      .setContentIntent(contentPi)
      .setDeleteIntent(stopPi)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setOngoing(isPlaying || isBuffering)
      .addAction(R.drawable.ic_media_prev, "上一段", prevPi)
      .addAction(playPauseIcon, playPauseLabel, togglePi)
      .addAction(R.drawable.ic_media_next, "下一段", nextPi)
      .addAction(R.drawable.ic_media_close, "关闭", stopPi)
      .setStyle(
        MediaStyle()
          .setMediaSession(mediaSession.sessionToken)
          .setShowActionsInCompactView(0, 1, 2)
      )

    artworkBitmap?.let { builder.setLargeIcon(it) }
    return builder.build()
  }

  private fun serviceActionPendingIntent(action: String, requestCode: Int): PendingIntent {
    val intent = Intent(this, TtsMediaService::class.java).apply {
      this.action = action
    }
    return PendingIntent.getService(
      this,
      requestCode,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "听书后台播放",
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "锁屏、状态栏与通知栏听书播放控制"
        setShowBadge(false)
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      }
      notificationManager.createNotificationChannel(channel)
    }
  }

  private fun loadLauncherBitmap(): Bitmap? {
    return try {
      val drawable = ContextCompat.getDrawable(this, R.mipmap.ic_launcher) ?: return null
      val size = 192
      val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
      val canvas = Canvas(bmp)
      drawable.setBounds(0, 0, size, size)
      drawable.draw(canvas)
      bmp
    } catch (_: Throwable) {
      null
    }
  }
}
