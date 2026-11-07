package io.github.tinywind.norea

import android.annotation.SuppressLint
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
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

private const val TAG = "NoreaVpnUrlTest"

/** Uses the same main-process profile and exclusive route lease as all source browsers. */
class AndroidVpnUrlTestService : Service() {
  companion object {
    private var instance: AndroidVpnUrlTestService? = null

    internal fun stopLoad(ticket: Long, done: (Result<Unit>) -> Unit) {
      val service = instance
      if (service == null) AndroidSiteBrowserOwner.release("url-test:$ticket", done)
      else service.stopOwnedLoad(ticket, done)
    }
  }
  private val handler = Handler(Looper.getMainLooper())
  private val messenger = Messenger(Handler(Looper.getMainLooper()) { message -> receive(message); true })
  private var page: AndroidVpnUrlTestPage? = null
  private var loading = false
  private var destroyed = false
  private var browserOwner: String? = null

  override fun onCreate() {
    super.onCreate()
    AndroidSiteBrowserOwner.initialize(this)
    instance = this
  }

  override fun onBind(intent: Intent?): IBinder = messenger.binder

  override fun onDestroy() {
    destroyed = true
    page?.close()
    page = null
    browserOwner?.let { AndroidSiteBrowserOwner.release(it) }
    browserOwner = null
    handler.removeCallbacksAndMessages(null)
    if (instance === this) instance = null
    super.onDestroy()
  }

  private fun stopOwnedLoad(ticket: Long, done: (Result<Unit>) -> Unit) {
    val owner = "url-test:$ticket"
    if (browserOwner == owner) {
      page?.close()
      page = null
    }
    AndroidSiteBrowserOwner.release(owner) { result ->
      if (browserOwner == owner) {
        browserOwner = null
        loading = false
      }
      done(result)
    }
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
      androidVpnWorkerAppOrigin(url)
      val port = data.getInt("proxyPort")
      androidVpnLoopbackProxyUrl(port)
      val timeoutMs = data.getInt("pageTimeoutMs")
      require(timeoutMs in 1..ANDROID_VPN_URL_TEST_MAX_PAGE_TIMEOUT_MS) { "VPN URL test page timeout is invalid." }
      val hash = checkNotNull(siteBrowserProfileHash(data.getString("profileHash"))) { "VPN URL test profile hash is missing." }
      AndroidVpnUrlTestRequest(url, port, data.getString("userAgent").orEmpty(), timeoutMs.toLong(), hash,
        data.getBoolean("rotateFingerprintOnVpnChange", false))
    }.getOrElse { error ->
      send(reply, ticket, androidVpnUrlTestFailure(error.message ?: "VPN URL test browser could not start."))
      return
    }
    loading = true
    val owner = "url-test:$ticket"
    browserOwner = owner
    val done: (JSONObject) -> Unit = { observation ->
      page = null
      AndroidSiteBrowserOwner.release(owner) { released ->
        loading = false
        if (browserOwner == owner) browserOwner = null
        if (!destroyed) send(reply, ticket, released.fold({ observation }, {
          androidVpnUrlTestFailure(it.message ?: "The previous browser route could not be restored.")
        }))
      }
    }
    AndroidSiteBrowserOwner.acquire(owner, request.profileHash, request.proxyPort, request.rotateFingerprintOnVpnChange) { result ->
      if (destroyed) {
        AndroidSiteBrowserOwner.release(owner)
        return@acquire
      }
      result.fold(
        onSuccess = {
          runCatching { AndroidVpnUrlTestPage(this, request, owner, done).also { page = it }.start() }
            .onFailure { error ->
              page?.close()
              done(androidVpnUrlTestFailure(error.message ?: "VPN URL test browser could not load the page."))
            }
        },
        onFailure = { error ->
          loading = false
          browserOwner = null
          send(reply, ticket, androidVpnUrlTestFailure(error.message ?: "VPN URL test browser route is unavailable."))
        },
      )
    }
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
  val profileHash: String,
  val rotateFingerprintOnVpnChange: Boolean,
)

/** One page load: the requested URL and its server redirects, observed until the page finishes. */
private class AndroidVpnUrlTestPage(
  private val context: Context,
  private val test: AndroidVpnUrlTestRequest,
  private val browserOwner: String,
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
    WebViewCompat.setProfile(view, sharedSiteBrowserProfileName())
    webView = view
    view.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      allowFileAccess = false
      allowContentAccess = false
      // Safe Browsing lookups would add requests through the test tunnel.
      safeBrowsingEnabled = false
    }
    AndroidBrowserEnvironment.apply(view, test.userAgent)
    AndroidSiteBrowserOwner.registerView(view, browserOwner)
    view.webViewClient = client
    val metrics = context.resources.displayMetrics
    view.measure(
      View.MeasureSpec.makeMeasureSpec(metrics.widthPixels.coerceAtLeast(1), View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(metrics.heightPixels.coerceAtLeast(1), View.MeasureSpec.EXACTLY),
    )
    view.layout(0, 0, view.measuredWidth, view.measuredHeight)
    startedAt = SystemClock.elapsedRealtime()
    handler.postDelayed(timeout, test.timeoutMs)
    // Revalidate this observation without deleting the shared browser cache.
    view.loadUrl(test.url, mapOf("Cache-Control" to "no-cache", "Pragma" to "no-cache"))
  }

  fun close() {
    finished = true
    handler.removeCallbacks(timeout)
    val view = webView ?: return
    webView = null
    AndroidSiteBrowserOwner.unregisterView(view)
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
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
      AndroidSiteBrowserOwner.interceptedResponse(browserOwner)

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
