package io.github.tinywind.norea

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log

class TaskForegroundService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var anchorId: Int? = null
  private var stopping = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
    AndroidTaskNotifications.ensureChannels(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    instance = this
    val request = desired
    if (intent?.action != ACTION_START || request == null || TaskBackgroundExecution.policy.suspended) {
      stop(this)
      return START_NOT_STICKY
    }
    try {
      stopping = false
      applyRequest(request)
    } catch (error: RuntimeException) {
      Log.w("NoreaTasks", "Foreground execution unavailable", error)
      TaskBackgroundExecution.suspend()
      stop(this)
    }
    return START_NOT_STICKY
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    // Android 15+ dataSync quota: preserve tasks and stop promptly, never restart in a loop.
    Log.w("NoreaTasks", "Android foreground execution quota exhausted; queued work is preserved")
    try {
      TaskBackgroundExecution.suspend()
    } finally {
      stop(this)
    }
  }

  override fun onDestroy() {
    if (instance === this) {
      instance = null
      startRequested = false
      val unexpectedlyStopped = !stopping && desired != null
      desired = null
      if (unexpectedlyStopped) TaskBackgroundExecution.suspend()
    }
    releaseWakeLock()
    super.onDestroy()
  }

  private fun applyRequest(request: ExecutionRequest) {
    val previous = anchorId
    if (previous != request.anchorId) {
      startForeground(request.anchorId, request.notification)
      anchorId = request.anchorId
      if (previous != null) {
        val retained = request.groups[previous]
        if (retained == null) notificationManager().cancel(previous)
        else updateNotification(previous, retained)
      }
    } else {
      updateNotification(request.anchorId, request.notification)
    }
    if (request.working) acquireWakeLock() else releaseWakeLock()
  }

  private fun updateNotification(id: Int, notification: Notification) {
    try {
      notificationManager().notify(id, notification)
    } catch (error: SecurityException) {
      Log.w("NoreaTasks", "Notification permission is unavailable", error)
    }
  }

  private fun stopRuntime() {
    stopping = true
    stopForegroundCompat()
    anchorId = null
    releaseWakeLock()
  }

  private fun notificationManager(): NotificationManager = getSystemService(NotificationManager::class.java)

  @SuppressLint("WakelockTimeout")
  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    wakeLock = getSystemService(PowerManager::class.java)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:TaskForegroundService")
      .apply {
        setReferenceCounted(false)
        acquire()
      }
  }

  private fun releaseWakeLock() {
    wakeLock?.let { if (it.isHeld) it.release() }
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

  private data class ExecutionRequest(
    val anchorId: Int,
    val notification: Notification,
    val working: Boolean,
    val groups: Map<Int, Notification>,
  )

  companion object {
    private const val ACTION_START = "io.github.tinywind.norea.task.START"
    private var instance: TaskForegroundService? = null
    private var desired: ExecutionRequest? = null
    private var startRequested = false

    internal fun isExecutionAnchored(): Boolean =
      desired != null && !TaskBackgroundExecution.policy.suspended &&
        instance?.let { !it.stopping && it.anchorId != null } == true

    internal fun update(
      context: Context,
      anchorId: Int,
      notification: Notification,
      working: Boolean,
      groups: Map<Int, Notification>,
    ) {
      val request = ExecutionRequest(anchorId, notification, working, groups)
      desired = request
      instance?.takeUnless { it.stopping }?.let {
        it.applyRequest(request)
        return
      }
      if (startRequested) return
      startRequested = true
      try {
        val intent = Intent(context, TaskForegroundService::class.java).apply { action = ACTION_START }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
        else context.startService(intent)
      } catch (error: RuntimeException) {
        startRequested = false
        desired = null
        throw error
      }
    }

    fun stop(context: Context) {
      if (desired == null && instance == null && !startRequested) return
      desired = null
      startRequested = false
      val active = instance
      instance = null
      active?.stopRuntime()
      // A stop request must not start a new background service.
      context.stopService(Intent(context, TaskForegroundService::class.java))
    }
  }
}
