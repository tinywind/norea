package io.github.tinywind.norea

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat

class TaskForegroundService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    ensureChannels()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_UPDATE -> {
        if (TaskBackgroundExecution.policy.suspended) {
          stopSelf()
          return START_NOT_STICKY
        }
        val title = intent.getStringExtra(EXTRA_TITLE) ?: DEFAULT_TITLE
        val body = intent.getStringExtra(EXTRA_BODY) ?: ""
        val current = intent.getIntExtra(EXTRA_CURRENT, -1)
        val total = intent.getIntExtra(EXTRA_TOTAL, -1)
        val quiet = intent.getBooleanExtra(EXTRA_QUIET, false)
        try {
          val notification = buildNotification(title, body, current, total, quiet)
          acquireWakeLock()
          startForeground(NOTIFICATION_ID, notification)
        } catch (error: RuntimeException) {
          Log.w("NoreaTasks", "Foreground execution unavailable", error)
          TaskBackgroundExecution.suspend()
          releaseWakeLock()
          stopSelf()
        }
      }
      ACTION_STOP -> {
        stopForegroundCompat()
        releaseWakeLock()
        stopSelf()
      }
    }
    return START_NOT_STICKY
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    // Android 15+ dataSync quota: preserve tasks and stop promptly, never restart in a loop.
    Log.w("NoreaTasks", "Android foreground execution quota exhausted; queued work is preserved")
    try {
      TaskBackgroundExecution.suspend()
    } finally {
      try {
        stopForegroundCompat()
        releaseWakeLock()
      } finally {
        stopSelf()
      }
    }
  }

  override fun onDestroy() {
    releaseWakeLock()
    super.onDestroy()
  }

  private fun ensureChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      CHANNEL_NAME,
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = CHANNEL_DESCRIPTION
      setShowBadge(false)
    }
    val quietChannel = NotificationChannel(
      QUIET_CHANNEL_ID,
      QUIET_CHANNEL_NAME,
      NotificationManager.IMPORTANCE_MIN,
    ).apply {
      description = QUIET_CHANNEL_DESCRIPTION
      setShowBadge(false)
    }
    notificationManager().createNotificationChannels(listOf(channel, quietChannel))
  }

  private fun buildNotification(
    title: String,
    body: String,
    current: Int,
    total: Int,
    quiet: Boolean,
  ): Notification {
    val pendingIntent = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      },
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val builder = NotificationCompat.Builder(this, if (quiet) QUIET_CHANNEL_ID else CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(title)
      .setContentText(body)
      .setContentIntent(pendingIntent)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(if (quiet) NotificationCompat.PRIORITY_MIN else NotificationCompat.PRIORITY_LOW)
    if (!quiet) {
      val hasProgress = total > 0 && current >= 0
      builder.setProgress(
        if (hasProgress) total else 0,
        if (hasProgress) current.coerceIn(0, total) else 0,
        !hasProgress,
      )
    }
    return builder.build()
  }

  private fun notificationManager(): NotificationManager =
    getSystemService(NotificationManager::class.java)

  @SuppressLint("WakelockTimeout")
  private fun acquireWakeLock() {
    val current = wakeLock
    if (current?.isHeld == true) return

    wakeLock = getSystemService(PowerManager::class.java)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:TaskForegroundService")
      .apply {
        setReferenceCounted(false)
        acquire()
      }
  }

  private fun releaseWakeLock() {
    wakeLock?.let { lock ->
      if (lock.isHeld) {
        lock.release()
      }
    }
    wakeLock = null
  }

  private fun stopForegroundCompat() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
  }

  companion object {
    private const val ACTION_UPDATE = "io.github.tinywind.norea.task.UPDATE"
    private const val ACTION_STOP = "io.github.tinywind.norea.task.STOP"
    private const val CHANNEL_DESCRIPTION = "Progress for downloads and library tasks."
    private const val CHANNEL_ID = "task-progress"
    private const val CHANNEL_NAME = "Task progress"
    private const val DEFAULT_TITLE = "Norea tasks"
    private const val EXTRA_BODY = "body"
    private const val EXTRA_CURRENT = "current"
    private const val EXTRA_QUIET = "quiet"
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_TOTAL = "total"
    private const val NOTIFICATION_ID = 1001
    private const val QUIET_CHANNEL_DESCRIPTION =
      "Keeps downloads and library tasks running while task progress notifications are off."
    private const val QUIET_CHANNEL_ID = "task-background"
    private const val QUIET_CHANNEL_NAME = "Background tasks"

    fun update(
      context: Context,
      title: String,
      body: String,
      current: Int?,
      total: Int?,
      quiet: Boolean,
    ) {
      val intent = Intent(context, TaskForegroundService::class.java).apply {
        action = ACTION_UPDATE
        putExtra(EXTRA_TITLE, title)
        putExtra(EXTRA_BODY, body)
        putExtra(EXTRA_CURRENT, current ?: -1)
        putExtra(EXTRA_TOTAL, total ?: -1)
        putExtra(EXTRA_QUIET, quiet)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      // A stop request must not start a new background service.
      context.stopService(Intent(context, TaskForegroundService::class.java))
    }
  }
}
