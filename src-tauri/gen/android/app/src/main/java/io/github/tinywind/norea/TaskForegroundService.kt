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
import androidx.core.app.NotificationCompat

class TaskForegroundService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    ensureChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_UPDATE -> {
        val title = intent.getStringExtra(EXTRA_TITLE) ?: DEFAULT_TITLE
        val body = intent.getStringExtra(EXTRA_BODY) ?: ""
        val current = intent.getIntExtra(EXTRA_CURRENT, -1)
        val total = intent.getIntExtra(EXTRA_TOTAL, -1)
        val notification = buildNotification(title, body, current, total)
        acquireWakeLock()
        startForeground(NOTIFICATION_ID, notification)
      }
      ACTION_STOP -> {
        stopForegroundCompat()
        releaseWakeLock()
        stopSelf()
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    releaseWakeLock()
    super.onDestroy()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      CHANNEL_NAME,
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = CHANNEL_DESCRIPTION
      setShowBadge(false)
    }
    notificationManager().createNotificationChannel(channel)
  }

  private fun buildNotification(
    title: String,
    body: String,
    current: Int,
    total: Int,
  ): Notification {
    val pendingIntent = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      },
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val hasProgress = total > 0 && current >= 0
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(title)
      .setContentText(body)
      .setContentIntent(pendingIntent)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setProgress(
        if (hasProgress) total else 0,
        if (hasProgress) current.coerceIn(0, total) else 0,
        !hasProgress,
      )
      .build()
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
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_TOTAL = "total"
    private const val NOTIFICATION_ID = 1001

    fun update(
      context: Context,
      title: String,
      body: String,
      current: Int?,
      total: Int?,
    ) {
      val intent = Intent(context, TaskForegroundService::class.java).apply {
        action = ACTION_UPDATE
        putExtra(EXTRA_TITLE, title)
        putExtra(EXTRA_BODY, body)
        putExtra(EXTRA_CURRENT, current ?: -1)
        putExtra(EXTRA_TOTAL, total ?: -1)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      val intent = Intent(context, TaskForegroundService::class.java).apply {
        action = ACTION_STOP
      }
      context.startService(intent)
    }
  }
}
