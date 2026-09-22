package io.github.tinywind.norea

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private val bridgeSession = BridgeSession()
  private val storageDocuments by lazy { AndroidStorageDocuments(this) }
  private val readerMediaCache by lazy { AndroidReaderMediaCache(this, storageDocuments) }
  private val localMediaResponder by lazy {
    AndroidLocalMediaResponder(this, storageDocuments, readerMediaCache)
  }
  private val storageRootPicker by lazy { AndroidStorageRootPicker(this) { mainWebView } }
  private val storageBridge by lazy {
    AndroidStorageBridge(this, { mainWebView }, storageRootPicker, storageDocuments, readerMediaCache)
  }
  private val taskNotificationBridge by lazy {
    AndroidTaskNotificationBridge(
      this,
      ::requestNotificationPermissionIfNeeded,
      ::resumeTaskWebViewsForBackgroundWork,
    )
  }
  private var androidScraperBridge: AndroidScraperBridge? = null
  private var scraperBackPressedCallback: OnBackPressedCallback? = null
  private var mainWebView: WebView? = null
  private var notificationPermissionRequested = false
  private var mainBackEvaluationGeneration = 0L
  private var mainBackEvaluationPending = false
  private var mainBackReplayPending = false
  @Volatile
  private var safeAreaInsetsJson = insetsJson(Insets.NONE)

  override fun onCreate(savedInstanceState: Bundle?) {
    RustlsPlatformVerifierBridge.init(applicationContext)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onPause() {
    super.onPause()
    resumeTaskWebViewsForBackgroundWork()
  }

  override fun onResume() {
    super.onResume()
    resumeTaskWebViewsForBackgroundWork()
    mainWebView?.post {
      mainWebView?.evaluateJavascript(
        "window.dispatchEvent(new Event('norea-app-resumed'));",
        null,
      )
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    resetMainBackEvaluation()
    mainWebView = webView
    val bridge = AndroidScraperBridge(webView, bridgeSession)
    androidScraperBridge = bridge
    webView.addJavascriptInterface(AndroidBridgeInfoBridge(bridgeSession), "__NoreaAndroidBridge")
    webView.addJavascriptInterface(bridge, "__NoreaAndroidScraper")
    webView.addJavascriptInterface(AndroidSafeAreaBridge { safeAreaInsetsJson }, "__NoreaAndroidSafeArea")
    webView.addJavascriptInterface(taskNotificationBridge, "__NoreaAndroidTasks")
    webView.addJavascriptInterface(AndroidUpdateInstallBridge(this, bridgeSession), "__NoreaAndroidUpdater")
    webView.addJavascriptInterface(storageBridge, "__NoreaAndroidStorage")
    webView.addJavascriptInterface(AndroidVpnProxyBridge(bridgeSession), "__NoreaAndroidVpn")
    webView.addJavascriptInterface(AndroidWindowMetricsBridge(this, webView), "__NoreaAndroidWindow")
    webView.settings.apply {
      setSupportZoom(false)
      builtInZoomControls = false
      displayZoomControls = false
      loadWithOverviewMode = false
      useWideViewPort = true
      textZoom = 100
    }
    webView.setInitialScale(100)
    installScraperBackHandler()

    ViewCompat.setOnApplyWindowInsetsListener(webView) { _, windowInsets ->
      val types = WindowInsetsCompat.Type.systemBars() or
        WindowInsetsCompat.Type.displayCutout()
      val insets = windowInsets.getInsets(types)
      safeAreaInsetsJson = insetsJson(insets)
      val script =
        "window.__noreaApplyAndroidSafeAreaInsets && window.__noreaApplyAndroidSafeAreaInsets($safeAreaInsetsJson);"
      webView.evaluateJavascript(
        script,
        null,
      )

      windowInsets
    }
    ViewCompat.requestApplyInsets(webView)
  }

  override fun onDestroy() {
    resetMainBackEvaluation()
    scraperBackPressedCallback?.remove()
    scraperBackPressedCallback = null
    androidScraperBridge?.destroy()
    androidScraperBridge = null
    storageBridge.destroy()
    super.onDestroy()
  }

  private fun installScraperBackHandler() {
    scraperBackPressedCallback?.remove()
    scraperBackPressedCallback = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (androidScraperBridge?.handleBackPressed() == true) return
        if (handleMainWebViewBackPressed()) return
        dispatchUnhandledBackPressed()
      }
    }.also { callback ->
      // Register after Tauri creates its WebView so source-browser back wins.
      onBackPressedDispatcher.addCallback(this, callback)
    }
  }

  private fun handleMainWebViewBackPressed(): Boolean {
    val webView = mainWebView ?: return false
    if (mainAppPath(webView.url) == null) return false
    if (mainBackEvaluationPending) {
      mainBackReplayPending = true
      return true
    }

    mainBackEvaluationGeneration += 1
    val requestId = mainBackEvaluationGeneration
    mainBackEvaluationPending = true
    val requestedUrl = webView.url
    webView.evaluateJavascript(
      "(() => { try { return window.__NoreaAndroidBackNavigation?.handle() === true; } catch { return false; } })();",
    ) { handled ->
      finishMainBackEvaluation(
        requestId,
        webView,
        requestedUrl,
        handled == "true",
      )
    }
    return true
  }

  private fun finishMainBackEvaluation(
    requestId: Long,
    webView: WebView,
    requestedUrl: String?,
    handled: Boolean,
  ) {
    if (!mainBackEvaluationPending || mainBackEvaluationGeneration != requestId) return

    mainBackEvaluationPending = false
    val replayBackPressed = mainBackReplayPending
    mainBackReplayPending = false

    val requestStillTargetsCurrentPage =
      mainWebView === webView && webView.url == requestedUrl
    if (
      requestStillTargetsCurrentPage &&
      !handled &&
      !handleDefaultMainWebViewBackPressed(webView)
    ) {
      dispatchUnhandledBackPressed()
    }
    if (replayBackPressed) {
      webView.post {
        if (!isFinishing && !isDestroyed && mainWebView === webView) {
          if (!handleMainWebViewBackPressed()) {
            dispatchUnhandledBackPressed()
          }
        }
      }
    }
  }

  private fun resetMainBackEvaluation() {
    mainBackEvaluationPending = false
    mainBackEvaluationGeneration += 1
    mainBackReplayPending = false
  }

  private fun handleDefaultMainWebViewBackPressed(webView: WebView): Boolean {
    if (!webView.canGoBack()) return false
    webView.goBack()
    return true
  }

  private fun dispatchUnhandledBackPressed() {
    val callback = scraperBackPressedCallback ?: return
    callback.isEnabled = false
    try {
      onBackPressedDispatcher.onBackPressed()
    } finally {
      callback.isEnabled = true
    }
  }

  private fun resumeTaskWebViewsForBackgroundWork() {
    if (!taskNotificationBridge.isForegroundServiceActive) return
    mainWebView?.post {
      mainWebView?.resumeTimers()
      mainWebView?.onResume()
      androidScraperBridge?.resumeBackgroundWorkWebViews()
    }
  }

  private fun mainAppPath(url: String?): String? {
    if (url.isNullOrBlank()) return null
    return runCatching {
      val parsed = Uri.parse(url)
      parsed.path?.takeIf { parsed.host == "tauri.localhost" }
    }.getOrNull()
  }

  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    storageRootPicker.onActivityResult(requestCode, resultCode, data)
  }

  fun androidLocalMediaResponse(uri: Uri): WebResourceResponse? =
    localMediaResponder.androidLocalMediaResponse(uri)

  private fun requestNotificationPermissionIfNeeded() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    if (notificationPermissionRequested) return
    if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
      PackageManager.PERMISSION_GRANTED
    ) {
      return
    }
    notificationPermissionRequested = true
    requestPermissions(
      arrayOf(Manifest.permission.POST_NOTIFICATIONS),
      REQUEST_POST_NOTIFICATIONS,
    )
  }

  companion object {
    private const val REQUEST_POST_NOTIFICATIONS = 1002

    private fun insetsJson(insets: Insets): String {
      return JSONObject()
        .put("top", insets.top)
        .put("right", insets.right)
        .put("bottom", insets.bottom)
        .put("left", insets.left)
        .toString()
    }
  }
}
