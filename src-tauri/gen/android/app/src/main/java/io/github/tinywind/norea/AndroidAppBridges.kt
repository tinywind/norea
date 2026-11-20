package io.github.tinywind.norea

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
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

/**
 * All files access. With it the storage folder is read and written as plain files; without it every
 * lookup goes through the document provider, which makes merges, recoveries and deletions slow.
 */
internal class AndroidAllFilesAccessBridge(private val activity: Activity) {
  @JavascriptInterface
  fun isSupported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R

  @JavascriptInterface
  fun isGranted(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager()

  /** Opens Norea's All files access screen, or the list of apps when that screen is unavailable. */
  @JavascriptInterface
  fun request(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
    val opened = CompletableFuture<Boolean>()
    activity.runOnUiThread {
      val app = Intent(
        Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
        Uri.parse("package:${activity.packageName}"),
      )
      val list = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
      opened.complete(listOf(app, list).any { intent ->
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
  private val isActivityActive: () -> Boolean,
  private val requestNotificationPermission: () -> Unit,
  private val resumeBackgroundWorkWebViews: () -> Unit,
  private val releaseBackgroundWorkWebViews: () -> Unit,
) {
  @Volatile
  private var destroyed = false
  @Volatile
  private var pendingBackgroundUpload = false
  @Volatile
  private var lastTitle = "Norea tasks"
  var isForegroundServiceActive = false
    private set
  var requiresScraperWebViews = false
    private set
  private var preemptiveAnchorActive = false
  private var hasActiveChallengesOrRanges = false
  private val mainHandler = Handler(Looper.getMainLooper())
  private val preemptiveAnchorTimeout = Runnable { releasePreemptiveAnchorIfUnused() }

  @JavascriptInterface
  fun isAppActive(): Boolean = isActivityActive()

  @JavascriptInterface
  fun setPendingBackgroundUpload(pending: Boolean) {
    pendingBackgroundUpload = pending
    if (!pending) {
      mainHandler.post {
        if (!pendingBackgroundUpload && preemptiveAnchorActive) {
          releasePreemptiveAnchorIfUnused()
        }
      }
    }
  }

  @JavascriptInterface
  fun isExecutionSuspended(): Boolean = TaskBackgroundExecution.policy.suspended

  @JavascriptInterface
  fun drainActions(): String = AndroidTaskNotificationActions.drain(activity)

  fun prepareBackgroundUploadAnchorIfNeeded() {
    if (destroyed || activity.isFinishing || activity.isDestroyed) return
    if (isForegroundServiceActive || !pendingBackgroundUpload) return
    if (TaskBackgroundExecution.policy.suspended || !AndroidNetworkState.isConnected()) return
    if (AndroidTaskNotifications.startPreemptiveSyncAnchor(activity, lastTitle)) {
      isForegroundServiceActive = true
      requiresScraperWebViews = false
      preemptiveAnchorActive = true
      mainHandler.removeCallbacks(preemptiveAnchorTimeout)
      mainHandler.postDelayed(preemptiveAnchorTimeout, PREEMPTIVE_ANCHOR_TIMEOUT_MS)
    }
  }

  fun clearPreemptiveAnchorIfIdle() {
    if (preemptiveAnchorActive) {
      releasePreemptiveAnchorIfUnused()
    }
  }

  private fun releasePreemptiveAnchorIfUnused() {
    if (!preemptiveAnchorActive) return
    preemptiveAnchorActive = false
    mainHandler.removeCallbacks(preemptiveAnchorTimeout)
    isForegroundServiceActive = false
    requiresScraperWebViews = false
    releaseBackgroundWorkWebViews()
    try {
      AndroidTaskNotifications.stopRuntime(activity.applicationContext)
    } catch (error: RuntimeException) {
      AppLog.w("NoreaTasks", "Preemptive background sync cleanup failed", error)
    }
  }

  fun suspendExecution() {
    preemptiveAnchorActive = false
    mainHandler.removeCallbacks(preemptiveAnchorTimeout)
    isForegroundServiceActive = false
    requiresScraperWebViews = false
    releaseBackgroundWorkWebViews()
  }

  @JavascriptInterface
  fun update(payload: String) {
    if (destroyed) return
    val update = runCatching { AndroidTaskNotificationPayload.parse(payload) }.getOrNull() ?: return
    activity.runOnUiThread {
      if (destroyed || activity.isDestroyed) return@runOnUiThread
      lastTitle = update.title
      if (update.requestPermission) {
        try {
          requestNotificationPermission()
        } catch (_: RuntimeException) {
          // Permission prompts are best-effort; task execution must continue.
        }
      }
      val decision = decideBackgroundUploadAnchor(
        executionActive = update.executionActive,
        hasTransientNotices =
          update.completions.isNotEmpty() ||
            update.cancelledCompletions.isNotEmpty() ||
            update.challenges.isNotEmpty() ||
            update.ranges.isNotEmpty() ||
            hasActiveChallengesOrRanges,
        preemptiveAnchorActive = preemptiveAnchorActive,
        isForegroundServiceActive = isForegroundServiceActive,
        pendingBackgroundUpload = pendingBackgroundUpload,
        activityActive = isActivityActive(),
        executionSuspended = TaskBackgroundExecution.policy.suspended,
        networkConnected = AndroidNetworkState.isConnected(),
      )
      if (decision.action == BackgroundUploadAnchorAction.KEEP_EXISTING_NOOP) {
        // Keep the preemptive FGS anchor alive while JS finishes flushing before background upload.
        return@runOnUiThread
      }
      val effectiveUpdate = if (decision.action == BackgroundUploadAnchorAction.HOLD_SYNC_ANCHOR) {
        // Hold or convert the active FGS onto the bounded quiet sync anchor until background upload starts.
        update.copy(
          quiet = true,
          executionActive = true,
          working = true,
          requiresScraperWebViews = false,
          groups = emptyList(),
          syncQuietAnchor = true,
        )
      } else {
        if (preemptiveAnchorActive) {
          preemptiveAnchorActive = false
          mainHandler.removeCallbacks(preemptiveAnchorTimeout)
        }
        update
      }
      try {
        val active = AndroidTaskNotifications.update(activity, effectiveUpdate)
        hasActiveChallengesOrRanges =
          effectiveUpdate.challenges.isNotEmpty() || effectiveUpdate.ranges.isNotEmpty()
        if (active && decision.action == BackgroundUploadAnchorAction.HOLD_SYNC_ANCHOR) {
          if (decision.armTimeout) {
            preemptiveAnchorActive = true
            mainHandler.removeCallbacks(preemptiveAnchorTimeout)
            mainHandler.postDelayed(preemptiveAnchorTimeout, PREEMPTIVE_ANCHOR_TIMEOUT_MS)
          }
        } else if (!active && preemptiveAnchorActive) {
          preemptiveAnchorActive = false
          mainHandler.removeCallbacks(preemptiveAnchorTimeout)
        }
        val nextRequiresScraper = active && effectiveUpdate.requiresScraperWebViews
        val changed = active != isForegroundServiceActive || nextRequiresScraper != requiresScraperWebViews
        isForegroundServiceActive = active
        requiresScraperWebViews = nextRequiresScraper
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
      stopRuntime()
    }
  }

  fun destroy() {
    destroyed = true
    stopRuntime()
  }

  private fun stopRuntime() {
    preemptiveAnchorActive = false
    mainHandler.removeCallbacks(preemptiveAnchorTimeout)
    isForegroundServiceActive = false
    requiresScraperWebViews = false
    releaseBackgroundWorkWebViews()
    try {
      AndroidTaskNotifications.stopRuntime(activity.applicationContext)
    } catch (error: RuntimeException) {
      AppLog.w("NoreaTasks", "Background execution cleanup failed", error)
    }
  }

  companion object {
    // Exceeds runBeforeAppSuspend()'s 2x3s flush/drain ceiling plus debounce/IPC handoff.
    private const val PREEMPTIVE_ANCHOR_TIMEOUT_MS = 10_000L
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
