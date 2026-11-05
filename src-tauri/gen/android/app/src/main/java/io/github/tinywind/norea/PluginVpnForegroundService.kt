package io.github.tinywind.norea

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import io.github.tinywind.norea.AppLog as Log

private const val PLUGIN_VPN_NOTIFICATION_ID = 1301
private const val PLUGIN_VPN_CHANNEL_ID = "plugin-vpn"
private const val PLUGIN_VPN_LOG_TAG = "NoreaPluginVpn"

internal data class PluginVpnKeepAliveRequest(
  val title: String,
  val body: String,
  val channelName: String,
  val channelDescription: String,
)

/** Returns the notification to show while the plugin VPN stays on, or null when the service must stop. */
internal fun pluginVpnKeepAliveRequestFromFields(field: (String) -> Any?): PluginVpnKeepAliveRequest? {
  if (field("active") != true) return null
  val title = (field("title") as? String)?.takeIf { it.isNotBlank() } ?: return null
  val channelName = (field("channelName") as? String)?.takeIf { it.isNotBlank() } ?: return null
  return PluginVpnKeepAliveRequest(
    title,
    field("body") as? String ?: "",
    channelName,
    field("channelDescription") as? String ?: "",
  )
}

// Android blocks a background app's network unless it runs a foreground service, which
// closes the in-process OpenVPN session of the plugin VPN.
class PluginVpnForegroundService : Service() {
  private var shown: PluginVpnKeepAliveRequest? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val promotion = pendingStart
    pendingStart = null
    if (intent?.action != ACTION_START || promotion == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    try {
      // startForegroundService() requires startForeground() even when a stop arrived meanwhile.
      show(desired ?: promotion)
      instance = this
    } catch (error: RuntimeException) {
      Log.w(PLUGIN_VPN_LOG_TAG, "Plugin VPN foreground execution unavailable", error)
      desired = null
      stopSelf()
      return START_NOT_STICKY
    }
    if (desired == null) stop(this)
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    if (instance === this) {
      instance = null
      desired = null
    }
    super.onDestroy()
  }

  private fun show(request: PluginVpnKeepAliveRequest) {
    if (request == shown) return
    ensureChannel(this, request)
    val notification = notification(request)
    if (shown == null) {
      startForeground(PLUGIN_VPN_NOTIFICATION_ID, notification)
    } else {
      try {
        getSystemService(NotificationManager::class.java).notify(PLUGIN_VPN_NOTIFICATION_ID, notification)
      } catch (error: SecurityException) {
        Log.w(PLUGIN_VPN_LOG_TAG, "Notification permission is unavailable", error)
      }
    }
    shown = request
  }

  private fun notification(request: PluginVpnKeepAliveRequest): Notification =
    NotificationCompat.Builder(this, PLUGIN_VPN_CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_lock_lock)
      .setContentTitle(request.title)
      .setContentText(request.body)
      .setContentIntent(
        PendingIntent.getActivity(
          this,
          0,
          Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
          },
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ),
      )
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()

  private fun stopRuntime() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    shown = null
  }

  companion object {
    private const val ACTION_START = "io.github.tinywind.norea.pluginVpn.START"
    private var instance: PluginVpnForegroundService? = null
    private var desired: PluginVpnKeepAliveRequest? = null
    private var pendingStart: PluginVpnKeepAliveRequest? = null
    private var localizedChannel: Pair<String, String>? = null

    /** Starts, updates or stops the service for [request]; repeated requests are no-ops. Call on the main thread. */
    internal fun update(context: Context, request: PluginVpnKeepAliveRequest?) {
      desired = request
      if (request == null) {
        // A pending start must reach startForeground() first; onStartCommand stops it then.
        if (pendingStart == null) stop(context)
        return
      }
      instance?.let {
        it.show(request)
        return
      }
      if (pendingStart != null) return
      pendingStart = request
      try {
        val intent = Intent(context, PluginVpnForegroundService::class.java).apply { action = ACTION_START }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
        else context.startService(intent)
      } catch (error: RuntimeException) {
        // Android 12+ throws ForegroundServiceStartNotAllowedException while the app is in the background.
        Log.w(PLUGIN_VPN_LOG_TAG, "Plugin VPN foreground service start rejected", error)
        pendingStart = null
        desired = null
      }
    }

    private fun stop(context: Context) {
      desired = null
      val active = instance ?: return
      instance = null
      active.stopRuntime()
      context.stopService(Intent(context, PluginVpnForegroundService::class.java))
    }

    private fun ensureChannel(context: Context, request: PluginVpnKeepAliveRequest) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val localized = request.channelName to request.channelDescription
      if (localized == localizedChannel) return
      context.getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(PLUGIN_VPN_CHANNEL_ID, request.channelName, NotificationManager.IMPORTANCE_LOW).apply {
          description = request.channelDescription
          setShowBadge(false)
        },
      )
      localizedChannel = localized
    }
  }
}
