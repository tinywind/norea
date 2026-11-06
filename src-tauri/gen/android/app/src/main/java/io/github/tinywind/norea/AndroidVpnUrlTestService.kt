package io.github.tinywind.norea

import android.annotation.SuppressLint
import android.app.Application
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process
import android.os.SystemClock
import android.view.View
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.util.UUID
import java.util.concurrent.Executors
import org.json.JSONObject

private const val TAG = "NoreaVpnUrlTest"

internal object AndroidVpnUrlTestProcess {
  private var initialized = false

  @Synchronized
  fun initialize() {
    check(Build.VERSION.SDK_INT >= 28) { "VPN URL tests require Android 9 or newer." }
    check(Application.getProcessName().endsWith(ANDROID_VPN_URL_TEST_PROCESS)) { "VPN URL test process is invalid." }
    if (initialized) return
    // A separate data directory keeps this WebView from sharing cookies or storage with the app,
    // the scrapers, and the VPN download workers.
    WebView.setDataDirectorySuffix(ANDROID_VPN_URL_TEST_DATA_DIRECTORY_SUFFIX)
    initialized = true
  }
}

/**
 * Loads URL test pages one at a time in the private `:vpn_url_test` process, through the test
 * tunnel's local proxy. A run uses one new WebView profile whose cookies, storage and cache are
 * cleared before every load, and every load gets a new WebView, destroyed when the load ends. An
 * idle WebView in that profile keeps its renderer process alive between loads: some Android builds
 * refuse to start a renderer for an app that is not in the foreground. The process serves a whole
 * run and exits when the main process unbinds it.
 */
class AndroidVpnUrlTestService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val proxyExecutor = Executors.newSingleThreadExecutor()
  private val messenger = Messenger(Handler(Looper.getMainLooper()) { message -> receive(message); true })
  private val createdProfiles = mutableListOf<String>()
  private var runProfile: String? = null
  private var rendererKeeper: WebView? = null
  private var page: AndroidVpnUrlTestPage? = null
  private var loading = false
  private var earlierProfilesDeleted = false
  private var proxyPort: Int? = null
  private var destroyed = false

  override fun onCreate() {
    AndroidVpnUrlTestProcess.initialize()
    super.onCreate()
  }

  override fun onBind(intent: Intent?): IBinder = messenger.binder

  override fun onDestroy() {
    destroyed = true
    page?.close()
    page = null
    rendererKeeper?.destroy()
    rendererKeeper = null
    proxyExecutor.shutdownNow()
    handler.removeCallbacksAndMessages(null)
    deleteCreatedProfiles()
    super.onDestroy()
    // Profiles that stay loaded until the process exits are deleted by the next test process.
    Process.killProcess(Process.myPid())
  }

  private fun receive(message: Message) {
    val reply = message.replyTo
    if (message.sendingUid != Process.myUid() || message.what != VPN_URL_TEST_LOAD || reply == null || destroyed) return
    val data = message.data
    val ticket = data.getLong("ticket")
    if (loading) {
      send(reply, ticket, androidVpnUrlTestFailure("Another VPN URL test page is loading."))
      return
    }
    val request = runCatching {
      val url = checkNotNull(data.getString("url")) { "VPN URL test address is missing." }
      val port = data.getInt("proxyPort")
      val timeoutMs = data.getInt("pageTimeoutMs")
      require(timeoutMs in 1..ANDROID_VPN_URL_TEST_MAX_PAGE_TIMEOUT_MS) { "VPN URL test page timeout is invalid." }
      prepareProfiles()
      AndroidVpnUrlTestRequest(url, port, data.getString("userAgent").orEmpty(), timeoutMs.toLong())
    }.getOrElse { error ->
      send(reply, ticket, androidVpnUrlTestFailure(error.message ?: "VPN URL test browser could not start."))
      return
    }
    loading = true
    val done: (JSONObject) -> Unit = { observation ->
      loading = false
      page = null
      send(reply, ticket, observation)
    }
    // The proxy override is process-wide and the tester keeps one local proxy, so it is applied once.
    if (proxyPort == request.proxyPort) {
      load(request, done)
      return
    }
    proxyExecutor.execute {
      val proxy = runCatching { configureAndroidVpnWebViewProxy(request.proxyPort) }
      handler.post {
        if (destroyed) return@post
        proxy.fold(
          onSuccess = {
            proxyPort = request.proxyPort
            load(request, done)
          },
          onFailure = { error -> done(androidVpnUrlTestFailure(error.message ?: "VPN URL test proxy configuration failed.")) },
        )
      }
    }
  }

  private fun load(request: AndroidVpnUrlTestRequest, done: (JSONObject) -> Unit) {
    val fail = { error: Throwable ->
      page?.close()
      done(androidVpnUrlTestFailure(error.message ?: "VPN URL test browser could not load the page."))
    }
    val profileName = runCatching { runProfile ?: createEmptyProfile().also(::startRun) }.getOrElse { error -> fail(error); return }
    clearProfile(profileName) { cleared ->
      if (destroyed) return@clearProfile
      cleared.mapCatching { AndroidVpnUrlTestPage(this, request, profileName, done).also { page = it }.start() }
        .onFailure(fail)
    }
  }

  private fun startRun(profileName: String) {
    runProfile = profileName
    rendererKeeper = WebView(this).also { view ->
      WebViewCompat.setProfile(view, profileName)
      view.loadUrl("about:blank")
    }
  }

  /** Removes what earlier loads of the run left in the profile, so each tunnel starts empty. */
  private fun clearProfile(profileName: String, then: (Result<Unit>) -> Unit) {
    val profile = runCatching { checkNotNull(ProfileStore.getInstance().getProfile(profileName)) { "VPN URL test profile is missing." } }
      .getOrElse { error -> then(Result.failure(error)); return }
    profile.webStorage.deleteAllData()
    profile.cookieManager.removeAllCookies {
      then(runCatching { check(!profile.cookieManager.hasCookies()) { "VPN URL test profile cookies could not be cleared." } })
    }
  }

  private fun prepareProfiles() {
    check(WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) { "VPN URL tests require WebView multi-profile support." }
    check(WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) { "VPN URL tests require WebView proxy override support." }
    val store = ProfileStore.getInstance()
    if (earlierProfilesDeleted) return
    // Profiles of an earlier test process are no longer loaded, so they can be deleted now.
    val earlier = store.allProfileNames.filter(::isAndroidVpnUrlTestProfile)
    val failures = earlier.mapNotNull { name -> runCatching { store.deleteProfile(name) }.exceptionOrNull() }
    if (failures.isNotEmpty()) {
      AppLog.w(TAG, "Could not delete ${failures.size} of ${earlier.size} earlier VPN URL test profiles", failures.first())
    }
    earlierProfilesDeleted = true
  }

  /** A profile no earlier load used, created after the proxy override is in place. */
  private fun createEmptyProfile(): String {
    val store = ProfileStore.getInstance()
    val name = androidVpnUrlTestProfileName(UUID.randomUUID().toString())
    check(store.getProfile(name) == null) { "VPN URL test profile already exists." }
    val profile = store.getOrCreateProfile(name)
    createdProfiles.add(name)
    check(!profile.cookieManager.hasCookies()) { "VPN URL test profile did not start empty." }
    return name
  }

  /** Best effort: WebView may keep a profile loaded until the process exits. */
  private fun deleteCreatedProfiles() {
    if (createdProfiles.isEmpty()) return
    val failures = runCatching {
      val store = ProfileStore.getInstance()
      createdProfiles.mapNotNull { name -> runCatching { store.deleteProfile(name) }.exceptionOrNull() }
    }.getOrElse { error -> createdProfiles.map { error } }
    if (failures.isEmpty()) {
      AppLog.d(TAG, "Deleted ${createdProfiles.size} VPN URL test profiles when the run ended")
    } else {
      AppLog.w(
        TAG,
        "Could not delete ${failures.size} of ${createdProfiles.size} VPN URL test profiles when the run ended; the next test process deletes them",
        failures.first(),
      )
    }
    createdProfiles.clear()
  }

  private fun send(reply: Messenger, ticket: Long, observation: JSONObject) {
    runCatching {
      reply.send(Message.obtain(null, VPN_URL_TEST_RESULT).apply {
        data = Bundle().apply {
          putLong("ticket", ticket)
          putString("observation", observation.toString())
        }
      })
    }.onFailure { error -> AppLog.w(TAG, "Could not deliver a VPN URL test result", error) }
  }
}

internal fun androidVpnUrlTestFailure(reason: String): JSONObject = JSONObject().put("kind", "failed").put("reason", reason)

private class AndroidVpnUrlTestRequest(
  val url: String,
  val proxyPort: Int,
  val userAgent: String,
  val timeoutMs: Long,
)

/** One page load: the requested URL and its server redirects, observed until the page finishes. */
private class AndroidVpnUrlTestPage(
  private val context: Context,
  private val test: AndroidVpnUrlTestRequest,
  private val profileName: String,
  private val onResult: (JSONObject) -> Unit,
) {
  private val handler = Handler(Looper.getMainLooper())
  private val timeout = Runnable { finish(JSONObject().put("kind", "timedOut")) }
  private val blockedNavigations = mutableSetOf<String>()
  private var webView: WebView? = null
  private var mainHost = Uri.parse(test.url).host
  private var startedAt = 0L
  private var httpStatus: Int? = null
  private var server: String? = null
  private var cfMitigated: String? = null
  private var probing = false
  private var finished = false

  @SuppressLint("SetJavaScriptEnabled")
  fun start() {
    val view = WebView(context)
    WebViewCompat.setProfile(view, profileName)
    webView = view
    view.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      allowFileAccess = false
      allowContentAccess = false
      // Safe Browsing lookups would add requests through the test tunnel.
      safeBrowsingEnabled = false
      if (test.userAgent.isNotEmpty()) userAgentString = test.userAgent
    }
    view.webViewClient = client
    val metrics = context.resources.displayMetrics
    view.measure(
      View.MeasureSpec.makeMeasureSpec(metrics.widthPixels.coerceAtLeast(1), View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(metrics.heightPixels.coerceAtLeast(1), View.MeasureSpec.EXACTLY),
    )
    view.layout(0, 0, view.measuredWidth, view.measuredHeight)
    startedAt = SystemClock.elapsedRealtime()
    handler.postDelayed(timeout, test.timeoutMs)
    // The run's profile is reused, so no cached response of an earlier tunnel may answer this load.
    view.clearCache(true)
    view.loadUrl(test.url)
  }

  fun close() {
    finished = true
    handler.removeCallbacks(timeout)
    val view = webView ?: return
    webView = null
    view.webViewClient = WebViewClient()
    view.stopLoading()
    view.destroy()
  }

  private fun finish(observation: JSONObject) {
    if (finished) return
    close()
    onResult(observation)
  }

  private fun networkError(url: String, description: String): JSONObject =
    JSONObject().put("kind", "networkError").put("url", url).put("description", description)

  private fun loaded(url: String, elapsedMs: Long, probe: String?) {
    val result = probe?.let { runCatching { JSONObject(it) }.getOrNull() }
    val status = httpStatus ?: result?.optInt("status", 0)?.takeIf { it > 0 }
    finish(JSONObject().apply {
      put("kind", "loaded")
      put("url", url)
      status?.let { put("status", it) }
      server?.let { put("server", it) }
      cfMitigated?.let { put("cfMitigated", it) }
      put("challengeMarkers", result?.optBoolean("challenge") == true)
      put("elapsedMs", elapsedMs)
    })
  }

  private val client = object : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
      if (androidVpnUrlTestFollowsNavigation(request.isForMainFrame, request.isRedirect, request.url.scheme)) {
        mainHost = request.url.host
        return false
      }
      if (request.isForMainFrame) blockedNavigations.add(request.url.toString())
      return true
    }

    override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
      if (!request.isForMainFrame) return
      httpStatus = errorResponse.statusCode
      server = androidVpnUrlTestHeader(errorResponse.responseHeaders, "server")
      cfMitigated = androidVpnUrlTestHeader(errorResponse.responseHeaders, "cf-mitigated")
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
      if (!request.isForMainFrame || request.url.toString() in blockedNavigations) return
      finish(
        if (error.errorCode == WebViewClient.ERROR_TIMEOUT) JSONObject().put("kind", "timedOut")
        else networkError(request.url.toString(), error.description?.toString().orEmpty().ifEmpty { "WebView error ${error.errorCode}" }),
      )
    }

    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
      handler.cancel()
      if (Uri.parse(error.url).host.equals(mainHost, ignoreCase = true)) {
        finish(networkError(error.url, androidVpnUrlTestCertificateError(error.primaryError)))
      }
    }

    override fun onPageFinished(view: WebView, url: String?) {
      if (finished || probing) return
      probing = true
      val elapsedMs = SystemClock.elapsedRealtime() - startedAt
      val finalUrl = url ?: test.url
      view.evaluateJavascript(ANDROID_VPN_URL_TEST_PROBE) { probe -> loaded(finalUrl, elapsedMs, probe) }
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
      finish(androidVpnUrlTestFailure("The test page's renderer stopped."))
      return true
    }
  }
}
