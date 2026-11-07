package io.github.tinywind.norea

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.Context
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.view.WindowCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

internal fun bridgeAuthorityFields(payload: JSONObject): BridgeAuthorityFields {
  val wrapper = payload.optJSONObject("_bridge") ?: payload.optJSONObject("bridge")
  fun field(name: String): String? =
    wrapper?.optString(name)?.trim()?.takeIf { it.isNotEmpty() }

  return BridgeAuthorityFields(
    token = field("sessionToken") ?: field("token")
      ?: payload.optString("bridgeToken").trim().takeIf { it.isNotEmpty() },
    capability = field("capability")
      ?: payload.optString("capability").trim().takeIf { it.isNotEmpty() },
    nonce = field("nonce")
      ?: payload.optString("nonce").trim().takeIf { it.isNotEmpty() },
  )
}

internal class AndroidBridgeInfoBridge(private val bridgeSession: BridgeSession) {
  @JavascriptInterface
  fun session(): String =
    JSONObject()
      .put("version", 2)
      .put("sessionToken", bridgeSession.sessionToken)
      .put("capabilities", JSONArray(BridgeCapabilities.ALL))
      .put("legacyCallsAccepted", true)
      .toString()

  @JavascriptInterface
  fun nonce(): String = bridgeSession.newNonce()
}

internal class AndroidSafeAreaBridge(private val safeAreaInsetsJson: () -> String) {
  @JavascriptInterface
  fun getInsets(): String = safeAreaInsetsJson()
}

internal class AndroidVpnProxyBridge(private val bridgeSession: BridgeSession, private val context: Context) {
  @JavascriptInterface
  fun configure(payload: String): String =
    runCatching {
      val json = JSONObject(payload)
      bridgeSession.validateAuthenticated(
        BridgeCapabilities.VPN_PROXY_CONFIGURE,
        bridgeAuthorityFields(json),
      )
      AndroidSiteBrowserOwner.configureForeground(context, json)
    }.fold(
      onSuccess = { JSONObject().put("ok", true).toString() },
      onFailure = { error ->
        JSONObject()
          .put("ok", false)
          .put("error", error.message ?: error.toString())
          .toString()
      },
    )
}

/**
 * Battery optimization exemption for background downloads. Some vendors, such as
 * Lenovo ZUI, release a foreground service's wake lock once the screen turns off
 * unless the app is exempt.
 */
internal class AndroidBatteryOptimizationBridge(private val activity: Activity) {
  @JavascriptInterface
  fun isIgnoring(): Boolean =
    activity.getSystemService(PowerManager::class.java)
      ?.isIgnoringBatteryOptimizations(activity.packageName) == true

  /** Opens the exemption prompt, or the optimization list when the prompt is unavailable. */
  @JavascriptInterface
  fun request(): Boolean {
    val opened = CompletableFuture<Boolean>()
    activity.runOnUiThread {
      val prompt = Intent(
        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
        Uri.parse("package:${activity.packageName}"),
      )
      val list = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
      opened.complete(listOf(prompt, list).any { intent ->
        try {
          activity.startActivity(intent)
          true
        } catch (_: ActivityNotFoundException) {
          false
        }
      })
    }
    return runCatching { opened.get(2, TimeUnit.SECONDS) }.getOrDefault(false)
  }
}

internal class AndroidTaskNotificationBridge(
  private val activity: Activity,
  private val requestNotificationPermission: () -> Unit,
  private val resumeBackgroundWorkWebViews: () -> Unit,
  private val releaseBackgroundWorkWebViews: () -> Unit,
) {
  var isForegroundServiceActive = false
    private set

  @JavascriptInterface
  fun isExecutionSuspended(): Boolean = TaskBackgroundExecution.policy.suspended

  @JavascriptInterface
  fun drainActions(): String = AndroidTaskNotificationActions.drain(activity)

  fun suspendExecution() {
    isForegroundServiceActive = false
    releaseBackgroundWorkWebViews()
  }

  @JavascriptInterface
  fun update(payload: String) {
    val update = runCatching { AndroidTaskNotificationPayload.parse(payload) }.getOrNull() ?: return
    activity.runOnUiThread {
      if (update.requestPermission) {
        try {
          requestNotificationPermission()
        } catch (_: RuntimeException) {
          // Permission prompts are best-effort; task execution must continue.
        }
      }
      try {
        val active = AndroidTaskNotifications.update(activity, update)
        val changed = active != isForegroundServiceActive
        isForegroundServiceActive = active
        if (changed) {
          if (active) resumeBackgroundWorkWebViews() else releaseBackgroundWorkWebViews()
        }
      } catch (error: RuntimeException) {
        AppLog.w("NoreaTasks", "Task notification update failed", error)
      }
    }
  }

  @JavascriptInterface
  fun stop() {
    activity.runOnUiThread {
      isForegroundServiceActive = false
      releaseBackgroundWorkWebViews()
      try {
        AndroidTaskNotifications.stopRuntime(activity)
      } catch (error: RuntimeException) {
        AppLog.w("NoreaTasks", "Background execution cleanup failed", error)
      }
    }
  }
}

internal class AndroidWindowMetricsBridge(
  private val activity: Activity,
  private val webView: WebView,
) {
  @JavascriptInterface
  fun getMetrics(): String = windowMetricsJson(webView)

  @JavascriptInterface
  fun setLightSystemBars(light: Boolean) {
    webView.post {
      val controller = WindowCompat.getInsetsController(activity.window, webView)
      controller.isAppearanceLightStatusBars = light
      controller.isAppearanceLightNavigationBars = light
    }
  }

  private fun windowMetricsJson(webView: WebView): String {
    val metrics = activity.resources.displayMetrics
    val density = if (metrics.density > 0f) metrics.density else 1f
    val widthPx = if (webView.width > 0) webView.width else metrics.widthPixels
    val heightPx = if (webView.height > 0) webView.height else metrics.heightPixels

    return JSONObject()
      .put("widthPx", widthPx)
      .put("heightPx", heightPx)
      .put("density", density.toDouble())
      .put("widthDp", widthPx / density)
      .put("heightDp", heightPx / density)
      .toString()
  }
}
