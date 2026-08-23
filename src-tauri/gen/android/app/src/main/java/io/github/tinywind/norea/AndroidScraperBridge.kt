package io.github.tinywind.norea

import android.annotation.SuppressLint
import android.app.Activity
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.webkit.CookieManagerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.roundToInt
import org.json.JSONObject

class AndroidScraperBridge(
  private val mainWebView: WebView,
  private val bridgeSession: BridgeSession,
) {
  private data class CssBounds(
    val x: Double,
    val y: Double,
    val width: Double,
    val height: Double,
    val viewportWidth: Double,
    val viewportHeight: Double,
  )

  private data class NativeBounds(
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
  )

  private data class QueuedAction(
    val id: String,
    val priority: Int,
    val browserAction: Boolean,
    val run: (QueueState) -> Unit,
    val sequence: Long = 0,
  )

  private class QueueState(val key: String) {
    val queue: MutableList<QueuedAction> = mutableListOf()
    var activeAction: QueuedAction? = null
    var activeExtractId: String? = null
    var activeFetchId: String? = null
    var activeResultNonce: String? = null
    var activeTimeout: Runnable? = null
    var busy = false
    var currentUrl: String? = null
    var documentStartScriptEnabled = false
    var nextSequence = 0L
    var userAgent: String? = null
    var webView: WebView? = null
  }

  private val mainHandler = Handler(Looper.getMainLooper())
  private val parserExecutor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "NoreaScraperBridgeParser").apply { isDaemon = true }
  }
  private val queues = mutableMapOf(IMMEDIATE_EXECUTOR to QueueState(IMMEDIATE_EXECUTOR))
  @Volatile
  private var closed = false
  private var browserVisible = false
  private var bounds = CssBounds(0.0, 0.0, 1.0, 1.0, 1.0, 1.0)

  private fun cookieSummary(url: String?): String {
    if (url.isNullOrBlank()) return "<none>"
    val header = CookieManager.getInstance().getCookie(url) ?: return "<empty>"
    val names = header.split(";")
      .mapNotNull { cookie -> cookie.substringBefore("=").trim().takeIf { it.isNotEmpty() } }
    return "count=${names.size} names=${names.joinToString(",")}"
  }

  private fun expiredCookieHeader(cookieInfo: String): String? {
    val parts = cookieInfo.split(";").map { it.trim() }.filter { it.isNotEmpty() }
    val name = parts.firstOrNull()?.substringBefore("=")?.trim()
      ?.takeIf { it.isNotEmpty() }
      ?: return null
    val identityAttributes = parts.drop(1).filter { attribute ->
      val attributeName = attribute.substringBefore("=").trim().lowercase()
      attributeName == "domain" ||
        attributeName == "path" ||
        attributeName == "secure" ||
        attributeName == "partitioned"
    }
    return buildList {
      add("$name=")
      add("Expires=Thu, 01 Jan 1970 00:00:00 GMT")
      add("Max-Age=0")
      addAll(identityAttributes)
    }.joinToString("; ")
  }

  private fun jsonKeysForLog(json: JSONObject?): String {
    if (json == null) return "<none>"
    val names = mutableListOf<String>()
    val keys = json.keys()
    while (keys.hasNext()) {
      names.add(keys.next())
    }
    return "count=${names.size} names=${names.joinToString(",")}"
  }

  private fun fetchInitForLog(init: JSONObject): String {
    val body = init.optString("body").takeIf { init.has("body") }
    return "method=${init.opt("method")} headers=${jsonKeysForLog(init.optJSONObject("headers"))} " +
      "bodyLength=${body?.length ?: 0}"
  }

  private fun urlForLog(url: String?): String {
    if (url.isNullOrBlank()) return "<none>"
    val parsed = runCatching { Uri.parse(url) }.getOrNull()
    val scheme = parsed?.scheme?.lowercase()
    if (scheme == "http" || scheme == "https") {
      val origin = parsed?.let(::originUrl)
      if (origin != null) {
        return origin
      }
    }
    if (!scheme.isNullOrBlank()) return "<$scheme-url>"

    val secretBoundary = listOf(url.indexOf('?'), url.indexOf('#'))
      .filter { it >= 0 }
      .minOrNull()
    val withoutSecrets = if (secretBoundary == null) url else url.substring(0, secretBoundary)
    return MALFORMED_URL_USER_INFO.replaceFirst(withoutSecrets, "\$1")
  }

  private fun redactUrlsForLog(message: String): String {
    return HTTP_URL_IN_LOG_MESSAGE.replace(message) { match -> urlForLog(match.value) }
  }

  private fun logState(state: QueueState, message: String, url: String? = null) {
    requireMainThread()
    Log.d(
      TAG,
      "[${state.key}] ${redactUrlsForLog(message)} busy=${state.busy} queue=${state.queue.size} " +
        "browserVisible=$browserVisible currentUrl=${urlForLog(state.currentUrl)} " +
        "knownQueues=${queues.keys.joinToString(",")} " +
        "webViews=${queues.values.count { it.webView != null }} " +
        "targetUrl=${urlForLog(url)} currentCookies=${cookieSummary(state.currentUrl)} " +
        "targetCookies=${cookieSummary(url)}",
    )
  }

  private fun fetchResultForLog(result: JSONObject, payloadLength: Int): String {
    val body = result.optString("body").takeIf { result.has("body") }
    val bodyBase64 = result.optString("bodyBase64").takeIf { result.has("bodyBase64") }
    return "success=${result.optBoolean("success", false)} " +
      "status=${result.opt("status")} statusText=${result.opt("statusText")} " +
      "finalUrl=${urlForLog(result.optString("finalUrl").takeIf { result.has("finalUrl") })} " +
      "headers=${jsonKeysForLog(result.optJSONObject("headers"))} " +
      "errorLength=${result.optString("error").length} bodyLength=${body?.length ?: 0} " +
      "bodyBase64Length=${bodyBase64?.length ?: 0} payloadLength=$payloadLength"
  }

  private fun envelopeForLog(envelope: JSONObject): String {
    val result = envelope.opt("result")
    if (result is JSONObject) {
      val body = result.optString("body").takeIf { result.has("body") }
      val bodyBase64 = result.optString("bodyBase64").takeIf { result.has("bodyBase64") }
      return "ok=${envelope.optBoolean("ok", false)} " +
        "status=${result.opt("status")} statusText=${result.opt("statusText")} " +
        "finalUrl=${urlForLog(result.optString("finalUrl").takeIf { result.has("finalUrl") })} " +
        "headers=${jsonKeysForLog(result.optJSONObject("headers"))} " +
        "errorLength=${envelope.optString("error").length} bodyLength=${body?.length ?: 0} " +
        "bodyBase64Length=${bodyBase64?.length ?: 0}"
    }
    return "ok=${envelope.optBoolean("ok", false)} errorLength=${envelope.optString("error").length} " +
      "resultType=${result?.javaClass?.name ?: "null"}"
  }

  @JavascriptInterface
  fun cancel(payload: String) {
    parseCommand(payload, BridgeCapabilities.SCRAPER_CANCEL) { json ->
      val id = json.getString("id")
      val message = json.optString("message", "scraper: cancelled")
      cancelById(id, message)
    }
  }

  @JavascriptInterface
  fun cancelBackground(payload: String) {
    parseCommand(payload, BridgeCapabilities.SCRAPER_CANCEL) { json ->
      val message = json.optString("message", "scraper: background work cancelled")
      val state = queueState(executorFromPayload(json))
      cancelQueuedWhere(state, message) { true }
      if (state.busy) cancelActive(state, message)
    }
  }

  @JavascriptInterface
  fun clearCookies(payload: String) {
    parseCommand(payload, BridgeCapabilities.SCRAPER_CLEAR_COOKIES) { json ->
      val id = json.getString("id")
      val url = json.getString("url")
      val parsed = Uri.parse(url)
      if (
        parsed.scheme !in setOf("http", "https") ||
        parsed.host.isNullOrBlank()
      ) {
        sendError(id, "scraper: expected an HTTP(S) plugin url")
        return@parseCommand
      }
      if (!WebViewFeature.isFeatureSupported(WebViewFeature.GET_COOKIE_INFO)) {
        sendError(
          id,
          "scraper: per-site cookie clearing requires an updated Android System WebView",
        )
        return@parseCommand
      }

      val cookieManager = CookieManager.getInstance()
      val expiredHeaders = runCatching {
        CookieManagerCompat.getCookieInfo(cookieManager, url)
          .mapNotNull(::expiredCookieHeader)
      }.getOrElse { error ->
        sendError(id, "scraper: read cookies: ${error.message ?: error.toString()}")
        return@parseCommand
      }
      if (expiredHeaders.isEmpty()) {
        sendResult(id, JSONObject().put("ok", true).put("result", 0))
        return@parseCommand
      }

      var remaining = expiredHeaders.size
      var deleted = 0
      var rejected = false
      expiredHeaders.forEach { header ->
        cookieManager.setCookie(url, header) { accepted ->
          if (closed) return@setCookie
          if (accepted) {
            deleted += 1
          } else {
            rejected = true
          }
          remaining -= 1
          if (remaining == 0) {
            cookieManager.flush()
            if (rejected) {
              sendError(id, "scraper: one or more cookies could not be deleted")
            } else {
              sendResult(id, JSONObject().put("ok", true).put("result", deleted))
            }
          }
        }
      }
    }
  }

  @JavascriptInterface
  fun currentOrigin(payload: String) {
    parseCommand(payload, BridgeCapabilities.SCRAPER_CURRENT_ORIGIN) { json ->
      val id = json.getString("id")
      val origin = queueState(IMMEDIATE_EXECUTOR).webView
        ?.takeIf { webView -> browserVisible && isForegroundBrowser(webView) }
        ?.url
        ?.let { url -> runCatching { originUrl(Uri.parse(url)) }.getOrNull() }
      sendResult(
        id,
        JSONObject()
          .put("ok", true)
          .put("result", origin ?: JSONObject.NULL),
      )
    }
  }

  @JavascriptInterface
  fun fetch(payload: String) {
    parseCommand(payload, BridgeCapabilities.SCRAPER_FETCH) { json ->
      val state = queueState(executorFromPayload(json))
      enqueue(
        state,
        QueuedAction(
          id = json.getString("id"),
          priority = payloadPriority(json),
          browserAction = false,
          run = { runFetch(it, json) },
        ),
      )
    }
  }

  @JavascriptInterface
  fun extract(payload: String) {
    parseCommand(payload, BridgeCapabilities.SCRAPER_EXTRACT) { json ->
      val state = queueState(executorFromPayload(json))
      enqueue(
        state,
        QueuedAction(
          id = json.getString("id"),
          priority = payloadPriority(json),
          browserAction = false,
          run = { runExtract(it, json) },
        ),
      )
    }
  }

  @JavascriptInterface
  fun navigate(payload: String) {
    parseCommand(payload, BridgeCapabilities.SCRAPER_NAVIGATE) { json ->
      val state = queueState(IMMEDIATE_EXECUTOR)
      enqueue(
        state,
        QueuedAction(
          id = json.getString("id"),
          priority = PRIORITY_INTERACTIVE,
          browserAction = true,
          run = { runNavigate(it, json) },
        ),
      )
    }
  }

  @JavascriptInterface
  fun setBounds(payload: String) {
    parseCommand(payload, BridgeCapabilities.SCRAPER_BOUNDS) { json ->
      bounds = CssBounds(
        x = json.optDouble("x", 0.0),
        y = json.optDouble("y", 0.0),
        width = json.optDouble("width", 1.0).coerceAtLeast(1.0),
        height = json.optDouble("height", 1.0).coerceAtLeast(1.0),
        viewportWidth = json.optDouble("viewportWidth", 1.0).coerceAtLeast(1.0),
        viewportHeight = json.optDouble("viewportHeight", 1.0).coerceAtLeast(1.0),
      )
      queueState(IMMEDIATE_EXECUTOR).userAgent = payloadUserAgent(json)
      if (browserVisible) showScraper()
    }
  }

  @JavascriptInterface
  fun hide() {
    mainHandler.post { hideScraper(emitHiddenEvent = false) }
  }

  fun destroy() {
    closed = true
    parserExecutor.shutdownNow()
    val cleanup = Runnable {
      queues.values.forEach { state ->
        clearTimeout(state)
        state.webView?.let { webView ->
          webView.stopLoading()
          webView.webViewClient = WebViewClient()
          scraperContainer().removeView(webView)
          webView.destroy()
        }
        state.webView = null
        state.queue.clear()
        state.activeAction = null
        state.activeExtractId = null
        state.activeFetchId = null
        state.activeResultNonce = null
        state.busy = false
      }
    }
    if (Looper.myLooper() == Looper.getMainLooper()) {
      cleanup.run()
    } else {
      mainHandler.post(cleanup)
    }
  }

  fun resumeBackgroundWorkWebViews() {
    val resume = Runnable {
      queues.values.forEach { state ->
        state.webView?.let { webView ->
          webView.resumeTimers()
          webView.onResume()
        }
      }
    }
    if (Looper.myLooper() == Looper.getMainLooper()) {
      resume.run()
    } else {
      mainHandler.post(resume)
    }
  }

  private fun parseCommand(
    payload: String,
    capability: String,
    onParsed: (JSONObject) -> Unit,
  ) {
    if (closed) return
    runCatching {
      parserExecutor.execute {
        val parsed = runCatching {
          val json = JSONObject(payload)
          bridgeSession.validate(capability, bridgeAuthorityFields(json))
          json
        }
        val fallbackId = if (parsed.isFailure) requestIdForError(payload) else null
        mainHandler.post {
          if (closed) return@post
          parsed.fold(
            onSuccess = onParsed,
            onFailure = { error ->
              fallbackId?.let { id ->
                sendError(id, "scraper: ${error.message ?: error.toString()}")
              }
            },
          )
        }
      }
    }.onFailure { error ->
      requestIdForError(payload)?.let { id ->
        mainHandler.post {
          sendError(id, "scraper: ${error.message ?: error.toString()}")
        }
      }
    }
  }

  private fun requestIdForError(payload: String): String? =
    runCatching {
      JSONObject(payload).optString("id").trim().takeIf { it.isNotEmpty() }
    }.getOrNull()

  private fun bridgeAuthorityFields(payload: JSONObject): BridgeAuthorityFields {
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

  fun handleBackPressed(): Boolean {
    if (Looper.myLooper() != Looper.getMainLooper()) return false
    val state = queueState(IMMEDIATE_EXECUTOR)
    val webView = state.webView
    val hasPendingBrowserAction =
      state.activeAction?.browserAction == true || state.queue.any { it.browserAction }
    if (
      !browserVisible &&
      (webView == null || !isForegroundBrowser(webView)) &&
      !hasPendingBrowserAction
    ) {
      return false
    }
    if (!browserVisible && hasPendingBrowserAction) {
      hideScraper()
      return true
    }
    if (webView == null) {
      hideScraper()
      return true
    }
    if (browserVisible && !isForegroundBrowser(webView)) {
      hideScraper()
      return true
    }
    webView.stopLoading()
    if (webView.canGoBack()) {
      webView.goBack()
      return true
    }
    hideScraper()
    return true
  }

  private fun isForegroundBrowser(webView: WebView): Boolean {
    return webView.visibility == View.VISIBLE &&
      webView.alpha > 0f &&
      webView.isClickable
  }

  private fun executorFromPayload(payload: JSONObject): String {
    val value = payload.optString("queue", IMMEDIATE_EXECUTOR).trim()
    if (value == "mainForeground") return IMMEDIATE_EXECUTOR
    if (value == IMMEDIATE_EXECUTOR) return value
    if (Regex("^pool:\\d+$").matches(value)) return value
    return IMMEDIATE_EXECUTOR
  }

  private fun queueState(key: String): QueueState {
    requireMainThread()
    return queues.getOrPut(key) { QueueState(key) }
  }

  private fun enqueue(state: QueueState, action: QueuedAction) {
    requireMainThread()
    logState(
      state,
      "enqueue id=${action.id} priority=${action.priority} browserAction=${action.browserAction}",
    )
    state.queue.add(action.copy(sequence = state.nextSequence))
    state.nextSequence += 1
    runNext(state)
  }

  private fun requireMainThread() {
    check(Looper.myLooper() == Looper.getMainLooper()) {
      "Android scraper state must be accessed on the main thread."
    }
  }

  private fun runNext(state: QueueState) {
    requireMainThread()
    if (state.busy || state.queue.isEmpty()) return
    val index = takeNextActionIndex(state) ?: return
    val action = state.queue.removeAt(index)
    state.busy = true
    state.activeAction = action
    logState(
      state,
      "runNext id=${action.id} priority=${action.priority} browserAction=${action.browserAction}",
    )
    try {
      action.run(state)
    } catch (error: Throwable) {
      state.activeFetchId = null
      state.activeExtractId = null
      state.activeResultNonce = null
      state.activeAction = null
      state.busy = false
      sendError(action.id, "scraper: ${error.message ?: error.toString()}")
      runNext(state)
    }
  }

  private fun takeNextActionIndex(state: QueueState): Int? {
    var selectedIndex: Int? = null
    for (index in state.queue.indices) {
      val candidate = state.queue[index]
      if (
        state.key == IMMEDIATE_EXECUTOR &&
        browserVisible &&
        !candidate.browserAction
      ) {
        continue
      }
      val selected = selectedIndex?.let { state.queue[it] }
      if (
        selected == null ||
        candidate.priority < selected.priority ||
        (candidate.priority == selected.priority && candidate.sequence < selected.sequence)
      ) {
        selectedIndex = index
      }
    }
    return selectedIndex
  }

  private fun payloadUserAgent(payload: JSONObject): String? {
    val requested =
      if (payload.isNull("userAgent")) "" else payload.optString("userAgent")
    return requested.trim().ifEmpty { mainWebView.settings.userAgentString }
  }

  private fun payloadPriority(payload: JSONObject): Int {
    return when (payload.optString("priority", "normal").lowercase()) {
      "interactive" -> PRIORITY_INTERACTIVE
      "user" -> PRIORITY_USER
      "deferred" -> PRIORITY_DEFERRED
      "background" -> PRIORITY_BACKGROUND
      else -> PRIORITY_NORMAL
    }
  }

  private fun scraper(state: QueueState, userAgent: String?): WebView {
    val existing = state.webView
    if (existing != null) {
      if (!userAgent.isNullOrBlank() && state.userAgent != userAgent) {
        logState(state, "update userAgent userAgent=$userAgent")
        existing.settings.userAgentString = userAgent
        state.userAgent = userAgent
      }
      return existing
    }

    val webView = createScraperWebView(state, userAgent)
    state.webView = webView
    state.userAgent = userAgent
    logState(state, "created scraper webview userAgent=$userAgent")
    return webView
  }

  private fun resetScraperWebView(state: QueueState, userAgent: String?): WebView {
    state.webView?.let { existing ->
      logState(state, "reset scraper webview")
      existing.stopLoading()
      existing.webViewClient = WebViewClient()
      scraperContainer().removeView(existing)
      existing.destroy()
    }
    state.webView = null
    state.currentUrl = null
    state.documentStartScriptEnabled = false
    return scraper(state, userAgent)
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun createScraperWebView(
    state: QueueState,
    userAgent: String?,
  ): WebView {
    val webView = WebView(mainWebView.context)
    webView.settings.apply {
      if (!userAgent.isNullOrBlank()) {
        userAgentString = userAgent
      }
      javaScriptEnabled = true
      javaScriptCanOpenWindowsAutomatically = true
      domStorageEnabled = true
      databaseEnabled = true
      mediaPlaybackRequiresUserGesture = false
      mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
      setSupportZoom(false)
      builtInZoomControls = false
      displayZoomControls = false
      textZoom = 100
    }
    CookieManager.getInstance().setAcceptCookie(true)
    CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

    webView.addJavascriptInterface(ResultBridge(this, state), "AndroidScraper")
    state.documentStartScriptEnabled =
      WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
    if (state.documentStartScriptEnabled) {
      WebViewCompat.addDocumentStartJavaScript(webView, INIT_SCRIPT, setOf("*"))
    }
    webView.webViewClient = makeClient(state, null)
    webView.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS

    scraperContainer().addView(webView, hiddenLayoutParams())
    return webView
  }

  private fun scraperContainer(): ViewGroup {
    val activity = mainWebView.context as? Activity
    return activity?.findViewById(android.R.id.content)
      ?: (mainWebView.parent as? ViewGroup)
      ?: throw IllegalStateException("Android scraper container is unavailable")
  }

  private fun hiddenLayoutParams(): FrameLayout.LayoutParams {
    return FrameLayout.LayoutParams(1, 1).apply {
      leftMargin = -10000
      topMargin = -10000
    }
  }

  private fun visibleLayoutParams(): FrameLayout.LayoutParams {
    val nativeBounds = nativeBounds()
    return FrameLayout.LayoutParams(nativeBounds.width, nativeBounds.height).apply {
      leftMargin = nativeBounds.x
      topMargin = nativeBounds.y
    }
  }

  private fun nativeBounds(): NativeBounds {
    val container = scraperContainer()
    val mainLocation = IntArray(2)
    val containerLocation = IntArray(2)
    mainWebView.getLocationInWindow(mainLocation)
    container.getLocationInWindow(containerLocation)

    val contentWidth =
      (mainWebView.width - mainWebView.paddingLeft - mainWebView.paddingRight).coerceAtLeast(1)
    val contentHeight =
      (mainWebView.height - mainWebView.paddingTop - mainWebView.paddingBottom).coerceAtLeast(1)
    val scaleX = contentWidth / bounds.viewportWidth
    val scaleY = contentHeight / bounds.viewportHeight
    val contentLeft = mainLocation[0] - containerLocation[0] + mainWebView.paddingLeft
    val contentTop = mainLocation[1] - containerLocation[1] + mainWebView.paddingTop

    return NativeBounds(
      x = contentLeft + (bounds.x * scaleX).roundToInt(),
      y = contentTop + (bounds.y * scaleY).roundToInt(),
      width = (bounds.width * scaleX).roundToInt().coerceAtLeast(1),
      height = (bounds.height * scaleY).roundToInt().coerceAtLeast(1),
    )
  }

  private fun showScraper() {
    val state = queueState(IMMEDIATE_EXECUTOR)
    logState(state, "showScraper before")
    val webView = scraper(
      state,
      state.userAgent ?: mainWebView.settings.userAgentString,
    )
    val container = scraperContainer()
    browserVisible = true
    webView.layoutParams = visibleLayoutParams()
    webView.alpha = 1f
    webView.translationX = 0f
    webView.translationY = 0f
    webView.translationZ = 10_000f
    webView.elevation = 10_000f
    webView.visibility = View.VISIBLE
    webView.isClickable = true
    webView.isFocusable = true
    webView.isFocusableInTouchMode = true
    container.bringChildToFront(webView)
    webView.bringToFront()
    webView.requestLayout()
    webView.invalidate()
    logState(state, "showScraper after")
  }

  private fun hideScraper(emitHiddenEvent: Boolean = true) {
    val state = queueState(IMMEDIATE_EXECUTOR)
    logState(state, "hideScraper before")
    cancelQueuedWhere(state, "scraper: site browser closed") { it.browserAction }
    if (state.activeAction?.browserAction == true) {
      cancelActive(state, "scraper: site browser closed")
    } else if (state.activeAction == null) {
      state.webView?.stopLoading()
    }
    hideScraperSurface(state)
    CookieManager.getInstance().flush()
    if (emitHiddenEvent) emitSiteBrowserHidden()
    logState(state, "hideScraper after")
    runNext(state)
  }

  private fun hideScraperSurface(state: QueueState) {
    val webView = state.webView
    browserVisible = false
    if (webView == null) return
    webView.layoutParams = hiddenLayoutParams()
    webView.alpha = 0f
    webView.translationX = -10000f
    webView.translationY = -10000f
    webView.translationZ = 0f
    webView.isClickable = false
    webView.isFocusable = false
    webView.isFocusableInTouchMode = false
    webView.requestLayout()
  }

  private fun emitSiteBrowserHidden() {
    mainWebView.evaluateJavascript(
      "window.dispatchEvent(new CustomEvent('norea-site-browser-hidden'));",
      null,
    )
  }

  private fun makeClient(
    state: QueueState,
    onFinished: ((String) -> Unit)?,
  ): WebViewClient {
    return object : WebViewClient() {
      override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
        state.currentUrl = url
        logState(state, "pageStarted url=$url", url)
        if (!state.documentStartScriptEnabled) {
          view.evaluateJavascript(INIT_SCRIPT, null)
        }
      }

      override fun onPageFinished(view: WebView, url: String) {
        state.currentUrl = url
        CookieManager.getInstance().flush()
        logState(state, "pageFinished url=$url", url)
        onFinished?.invoke(url)
      }
    }
  }

  private fun runFetch(state: QueueState, payload: JSONObject) {
    val id = payload.getString("id")
    val url = payload.getString("url")
    val contextUrl = payload.optString("contextUrl").takeIf { it.isNotBlank() }
    val fetchContextUrl = fetchContextUrl(url, contextUrl)
    val init = payload.optJSONObject("init") ?: JSONObject()
    val timeoutMs = payload.optLong("timeoutMs", 60_000L).coerceAtLeast(1L)
    val webView = scraper(state, payloadUserAgent(payload))
    val resultNonce = bridgeSession.newNonce()
    state.activeFetchId = id
    state.activeResultNonce = resultNonce
    logState(
      state,
      "runFetch start id=$id url=$url contextUrl=$contextUrl fetchContextUrl=$fetchContextUrl timeoutMs=$timeoutMs init=${fetchInitForLog(init)}",
      url,
    )

    prepareContext(state, webView, id, fetchContextUrl, url) { preparedFetchUrl ->
      if (state.activeFetchId != id) return@prepareContext
      val fetchUrl = fetchUrlAfterPreparedContext(url, preparedFetchUrl, init)
      logState(
        state,
        "runFetch prepared id=$id url=$url fetchContextUrl=$fetchContextUrl preparedFetchUrl=$preparedFetchUrl fetchUrl=$fetchUrl",
        fetchUrl,
      )
      setTimeout(
        state,
        id,
        timeoutMs,
        "scraper: browser fetch to $url timed out after ${timeoutMs}ms",
      )
      val request = JSONObject()
        .put("url", fetchUrl)
        .put("init", init)
      webView.evaluateJavascript(buildFetchScript(id, resultNonce, request), null)
    }
  }

  private fun runExtract(state: QueueState, payload: JSONObject) {
    val id = payload.getString("id")
    val url = payload.getString("url")
    val beforeScript = payload.optString("beforeScript").takeIf { it.isNotEmpty() }
    val timeoutMs = payload.optLong("timeoutMs", 30_000L)
    val resultNonce = beforeScript?.let { bridgeSession.newNonce() }
    val targetUrl = if (beforeScript != null) {
      val base = url.substringBefore("#")
      "$base#__lnr_script__=${Uri.encode(beforeScript)}" +
        "&__lnr_request_id__=${Uri.encode(id)}" +
        "&__lnr_nonce__=${Uri.encode(resultNonce.orEmpty())}"
    } else {
      url
    }

    state.activeExtractId = id
    state.activeResultNonce = resultNonce
    logState(
      state,
      "runExtract start id=$id url=$url timeoutMs=$timeoutMs beforeScriptLength=${beforeScript?.length ?: 0}",
      url,
    )
    setTimeout(state, id, timeoutMs, "webview_extract: timeout after ${timeoutMs}ms")
    scraper(state, payloadUserAgent(payload)).loadUrl(targetUrl)
  }

  private fun runNavigate(state: QueueState, payload: JSONObject) {
    val id = payload.getString("id")
    val url = payload.getString("url")
    val resetHistory = payload.optBoolean("resetHistory", false)
    val timeoutMs = payload.optLong("timeoutMs", 30_000L).coerceAtLeast(1L)
    val userAgent = payloadUserAgent(payload)
    val webView = if (resetHistory) {
      resetScraperWebView(state, userAgent)
    } else {
      scraper(state, userAgent)
    }
    logState(
      state,
      "runNavigate start id=$id url=$url resetHistory=$resetHistory timeoutMs=$timeoutMs",
      url,
    )
    hideScraperSurface(state)
    webView.stopLoading()
    webView.webViewClient = makeClient(state) {
      if (state.activeAction?.id != id) return@makeClient
      webView.webViewClient = makeClient(state, null)
      browserVisible = true
      finishSuccess(state, id, true)
    }
    setTimeout(
      state,
      id,
      timeoutMs,
      "scraper: browser navigation to $url timed out after ${timeoutMs}ms",
    )
    webView.loadUrl(url)
  }

  private fun prepareContext(
    state: QueueState,
    webView: WebView,
    id: String,
    contextUrl: String?,
    fallbackContextUrl: String?,
    ready: (String?) -> Unit,
  ) {
    if (contextUrl == null || sameOrigin(state.currentUrl, contextUrl)) {
      logState(
        state,
        "prepareContext skipped id=$id contextUrl=$contextUrl sameOrigin=${contextUrl != null}",
        contextUrl,
      )
      ready(null)
      return
    }
    logState(state, "prepareContext navigate id=$id contextUrl=$contextUrl", contextUrl)

    var finished = false
    var fallbackAttempted = false
    var activeFallbackUrl: String? = null
    val timeout = Runnable {
      if (finished) return@Runnable
      finished = true
      webView.stopLoading()
      webView.webViewClient = makeClient(state, null)
      logState(state, "prepareContext timeout id=$id contextUrl=$contextUrl", contextUrl)
      finishError(state, id, "scraper: timed out preparing fetch context $contextUrl")
    }
    state.activeTimeout = timeout
    mainHandler.postDelayed(timeout, 15_000L)
    webView.webViewClient = makeClient(state) { finishedUrl ->
      if (finished) return@makeClient
      if (!sameOrigin(finishedUrl, contextUrl)) {
        val fallbackUrl = fallbackContextUrl?.takeIf { it != contextUrl }
        if (!fallbackAttempted && fallbackUrl != null) {
          fallbackAttempted = true
          activeFallbackUrl = fallbackUrl
          logState(
            state,
            "prepareContext fallback id=$id contextUrl=$contextUrl finishedUrl=$finishedUrl fallbackUrl=$fallbackUrl",
            fallbackUrl,
          )
          webView.loadUrl(fallbackUrl)
          return@makeClient
        }
        if (fallbackAttempted && activeFallbackUrl != null && isHttpUrl(finishedUrl)) {
          finished = true
          clearTimeout(state)
          webView.webViewClient = makeClient(state, null)
          logState(
            state,
            "prepareContext ready fallback id=$id contextUrl=$contextUrl finishedUrl=$finishedUrl",
            finishedUrl,
          )
          ready(finishedUrl)
          return@makeClient
        }
        logState(
          state,
          "prepareContext waiting origin id=$id contextUrl=$contextUrl finishedUrl=$finishedUrl",
          contextUrl,
        )
        return@makeClient
      }
      finished = true
      clearTimeout(state)
      webView.webViewClient = makeClient(state, null)
      logState(state, "prepareContext ready id=$id contextUrl=$contextUrl", contextUrl)
      ready(null)
    }
    webView.loadUrl(contextUrl)
  }

  private fun fetchUrlAfterPreparedContext(
    url: String,
    preparedFetchUrl: String?,
    init: JSONObject,
  ): String {
    if (preparedFetchUrl == null || !isSafeFetchMethod(init) || !isHttpUrl(preparedFetchUrl)) {
      return url
    }
    return preparedFetchUrl
  }

  private fun isSafeFetchMethod(init: JSONObject): Boolean {
    val method = init.optString("method", "GET").ifBlank { "GET" }
    return method.equals("GET", ignoreCase = true) ||
      method.equals("HEAD", ignoreCase = true)
  }

  private fun isHttpUrl(url: String): Boolean {
    val uri = Uri.parse(url)
    return uri.scheme == "http" || uri.scheme == "https"
  }

  private fun fetchContextUrl(url: String, contextUrl: String?): String? {
    val requestUri = Uri.parse(url)
    val requestOrigin = originUrl(requestUri) ?: return contextUrl
    if (contextUrl == null) return requestOrigin
    val configuredContextUri = Uri.parse(contextUrl)
    return if (sameOrigin(requestUri, configuredContextUri)) {
      contextUrl
    } else {
      requestOrigin
    }
  }

  private fun originUrl(uri: Uri): String? {
    val scheme = uri.scheme?.lowercase() ?: return null
    if (scheme != "http" && scheme != "https") return null
    val host = uri.host?.lowercase()?.takeIf { it.isNotBlank() } ?: return null
    val defaultPort = effectivePortForScheme(scheme)
    val port = uri.port
    if (port < -1 || port > 65_535) return null
    val portPart = if (port != -1 && port != defaultPort) ":$port" else ""
    val serializedHost = if (host.contains(':')) {
      "[${host.removePrefix("[").removeSuffix("]")}]"
    } else {
      host
    }
    return "$scheme://$serializedHost$portPart"
  }

  private fun sameOrigin(left: String?, right: String): Boolean {
    if (left == null) return false
    return sameOrigin(Uri.parse(left), Uri.parse(right))
  }

  private fun sameOrigin(leftUri: Uri, rightUri: Uri): Boolean {
    return leftUri.scheme == rightUri.scheme &&
      leftUri.host.equals(rightUri.host, ignoreCase = true) &&
      effectivePort(leftUri) == effectivePort(rightUri)
  }

  private fun effectivePort(uri: Uri): Int {
    if (uri.port != -1) return uri.port
    return effectivePortForScheme(uri.scheme)
  }

  private fun effectivePortForScheme(scheme: String?): Int {
    return when (scheme) {
      "http" -> 80
      "https" -> 443
      else -> -1
    }
  }

  private fun setTimeout(
    state: QueueState,
    id: String,
    timeoutMs: Long,
    message: String,
  ) {
    clearTimeout(state)
    val timeout = Runnable {
      if (state.activeFetchId == id) abortActiveFetch(state, id)
      if (state.activeExtractId == id) state.webView?.stopLoading()
      if (
        state.activeAction?.id == id &&
        state.activeAction?.browserAction == true
      ) {
        state.webView?.webViewClient = makeClient(state, null)
        state.webView?.stopLoading()
        hideScraperSurface(state)
      }
      finishError(state, id, message)
    }
    state.activeTimeout = timeout
    mainHandler.postDelayed(timeout, timeoutMs)
  }

  private fun clearTimeout(state: QueueState) {
    state.activeTimeout?.let { mainHandler.removeCallbacks(it) }
    state.activeTimeout = null
  }

  private fun finishSuccess(state: QueueState, id: String, result: Any) {
    finish(
      state,
      id,
      JSONObject()
        .put("ok", true)
        .put("result", result),
    )
  }

  private fun finishError(state: QueueState, id: String, message: String) {
    val safeMessage = redactUrlsForLog(message)
    logState(state, "finishError id=$id message=$safeMessage")
    finish(
      state,
      id,
      JSONObject()
        .put("ok", false)
        .put("error", safeMessage),
    )
  }

  private fun cancelQueuedWhere(
    state: QueueState,
    message: String,
    shouldCancel: (QueuedAction) -> Boolean,
  ) {
    val iterator = state.queue.iterator()
    while (iterator.hasNext()) {
      val action = iterator.next()
      if (shouldCancel(action)) {
        iterator.remove()
        sendError(action.id, message)
      }
    }
  }

  private fun cancelById(id: String, message: String) {
    for (state in queues.values) {
      var cancelledQueued = false
      val iterator = state.queue.iterator()
      while (iterator.hasNext()) {
        val action = iterator.next()
        if (action.id == id) {
          cancelledQueued = true
          iterator.remove()
          sendError(action.id, message)
        }
      }
      if (cancelledQueued) return
      if (
        state.activeFetchId == id ||
        state.activeExtractId == id ||
        state.activeAction?.id == id
      ) {
        cancelActive(state, message)
        return
      }
    }
  }

  private fun cancelActive(state: QueueState, message: String) {
    val fetchId = state.activeFetchId
    val id = fetchId ?: state.activeExtractId ?: state.activeAction?.id
    if (fetchId != null) abortActiveFetch(state, fetchId)
    state.webView?.webViewClient = makeClient(state, null)
    state.webView?.stopLoading()
    if (id == null) {
      clearTimeout(state)
      state.activeResultNonce = null
      state.activeAction = null
      state.busy = false
      runNext(state)
      return
    }
    finishError(state, id, message)
  }

  private fun abortActiveFetch(state: QueueState, id: String) {
    val quotedId = JSONObject.quote(id)
    state.webView?.evaluateJavascript(
      "window.__noreaAndroidFetchControllers && window.__noreaAndroidFetchControllers[$quotedId] && window.__noreaAndroidFetchControllers[$quotedId].abort();",
      null,
    )
  }

  private fun sendError(id: String, message: String) {
    val safeMessage = redactUrlsForLog(message)
    Log.d(TAG, "sendError id=$id message=$safeMessage")
    sendResult(
      id,
      JSONObject()
        .put("ok", false)
        .put("error", safeMessage),
    )
  }

  private fun finish(state: QueueState, id: String, envelope: JSONObject) {
    clearTimeout(state)
    logState(state, "finish id=$id envelope=${envelopeForLog(envelope)}")
    state.activeFetchId = null
    state.activeExtractId = null
    state.activeResultNonce = null
    state.activeAction = null
    sendResult(id, envelope)
    state.busy = false
    runNext(state)
  }

  private fun sendResult(id: String, envelope: JSONObject) {
    val script =
      "window.__lnrAndroidScraperResolve(${JSONObject.quote(id)}, ${JSONObject.quote(envelope.toString())});"
    mainWebView.evaluateJavascript(script, null)
  }

  private fun parseFetchResult(
    state: QueueState,
    id: String,
    nonce: String,
    payload: String,
  ) {
    if (closed) return
    runCatching {
      parserExecutor.execute {
        val parsed = runCatching {
          val result = JSONObject(payload)
          Pair(result, fetchResultForLog(result, payload.length))
        }
        mainHandler.post {
          if (closed) return@post
          parsed.fold(
            onSuccess = { (result, summary) ->
              onFetchResult(state, id, nonce, result, summary)
            },
            onFailure = { error ->
              if (state.activeFetchId == id) {
                finishError(state, id, "scraper: invalid browser fetch result: ${error.message}")
              }
            },
          )
        }
      }
    }.onFailure { error ->
      mainHandler.post {
        if (state.activeFetchId == id) {
          finishError(state, id, "scraper: invalid browser fetch result: ${error.message}")
        }
      }
    }
  }

  private fun onFetchResult(
    state: QueueState,
    id: String,
    nonce: String,
    result: JSONObject,
    logSummary: String,
  ) {
    if (state.activeFetchId != id) return
    if (!isExpectedResultNonce(state, id, nonce)) return
    CookieManager.getInstance().flush()
    logState(state, "onFetchResult id=$id $logSummary")
    if (!result.optBoolean("success", false)) {
      finishError(state, id, result.optString("error", "unknown browser fetch error"))
      return
    }
    result.remove("success")
    finishSuccess(state, id, result)
  }

  private fun onExtractResult(state: QueueState, id: String?, nonce: String?, payload: String) {
    val activeId = state.activeExtractId ?: return
    if (id != null && id != activeId) return
    if (!isExpectedResultNonce(state, activeId, nonce.orEmpty())) return
    CookieManager.getInstance().flush()
    logState(state, "onExtractResult id=$activeId payloadLength=${payload.length}")
    state.webView?.loadUrl("about:blank")
    finishSuccess(state, activeId, payload)
  }

  private fun isExpectedResultNonce(state: QueueState, id: String, nonce: String): Boolean {
    val expected = state.activeResultNonce ?: return true
    if (nonce == expected) return true
    finishError(state, id, "scraper: browser result authority mismatch")
    return false
  }

  private class ResultBridge(
    private val owner: AndroidScraperBridge,
    private val state: QueueState,
  ) {
    @JavascriptInterface
    fun postFetchResult(id: String, payload: String) {
      owner.parseFetchResult(state, id, "", payload)
    }

    @JavascriptInterface
    fun postFetchResultWithNonce(id: String, nonce: String, payload: String) {
      owner.parseFetchResult(state, id, nonce, payload)
    }

    @JavascriptInterface
    fun postExtractResult(payload: String) {
      owner.mainHandler.post { owner.onExtractResult(state, null, null, payload) }
    }

    @JavascriptInterface
    fun postExtractResultWithNonce(id: String, nonce: String, payload: String) {
      owner.mainHandler.post { owner.onExtractResult(state, id, nonce, payload) }
    }
  }

  private fun buildFetchScript(id: String, nonce: String, request: JSONObject): String {
    return """
      (function () {
        const request = ${request};
        const requestId = ${JSONObject.quote(id)};
        const requestNonce = ${JSONObject.quote(nonce)};
        const blockedHeaders = new Set([
          "accept-charset", "accept-encoding", "access-control-request-headers",
          "access-control-request-method", "connection", "content-length", "cookie",
          "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin",
          "referer", "te", "trailer", "transfer-encoding", "upgrade", "via",
          "user-agent"
        ]);
        (async function () {
          try {
            const init = request.init || {};
            const controllers = window.__noreaAndroidFetchControllers || (window.__noreaAndroidFetchControllers = {});
            const controller = new AbortController();
            controllers[requestId] = controller;
            const headers = new Headers();
            for (const key of Object.keys(init.headers || {})) {
              if (!blockedHeaders.has(key.toLowerCase())) {
                headers.set(key, String(init.headers[key]));
              }
            }
            const fetchInit = {
              method: init.method || "GET",
              headers,
              credentials: "include",
              redirect: "follow",
              signal: controller.signal
            };
            if (init.body !== undefined && init.body !== null) {
              fetchInit.body = init.body;
            }
            const response = await fetch(request.url, fetchInit);
            const responseHeaders = {};
            response.headers.forEach(function (value, key) {
              responseHeaders[key] = value;
            });
            const responseBytes = new Uint8Array(await response.arrayBuffer());
            const responseChunks = [];
            const chunkSize = 0x8000;
            for (let offset = 0; offset < responseBytes.length; offset += chunkSize) {
              const chunk = responseBytes.subarray(offset, offset + chunkSize);
              responseChunks.push(String.fromCharCode.apply(null, Array.from(chunk)));
            }
            const bodyBase64 = btoa(responseChunks.join(""));
            AndroidScraper.postFetchResultWithNonce(requestId, requestNonce, JSON.stringify({
              success: true,
              status: response.status,
              statusText: response.statusText || "",
              bodyBase64,
              headers: responseHeaders,
              finalUrl: response.url || request.url
            }));
          } catch (error) {
            const message = (error && (error.message || error.toString())) || String(error);
            AndroidScraper.postFetchResultWithNonce(requestId, requestNonce, JSON.stringify({
              success: false,
              error: "scraper: browser fetch failed: " + message
            }));
          } finally {
            try {
              delete window.__noreaAndroidFetchControllers[requestId];
            } catch (e) {}
          }
        })();
      })();
    """.trimIndent()
  }

  companion object {
    private const val TAG = "NoreaScraper"
    private const val IMMEDIATE_EXECUTOR = "immediate"
    private const val PRIORITY_INTERACTIVE = 0
    private const val PRIORITY_USER = 1
    private const val PRIORITY_NORMAL = 2
    private const val PRIORITY_DEFERRED = 3
    private const val PRIORITY_BACKGROUND = 4
    private val HTTP_URL_IN_LOG_MESSAGE = Regex("""(?i)\bhttps?://[^\s"'<>]+""")
    private val MALFORMED_URL_USER_INFO = Regex("""(?i)^([a-z][a-z\d+.-]*://)[^/@\s]+@""")

    private val INIT_SCRIPT = """
      (function () {
        function parseHashParams() {
          var params = {};
          var hash = location.hash || "";
          if (hash.charAt(0) === "#") {
            hash = hash.substring(1);
          }
          if (!hash) return params;
          var parts = hash.split("&");
          for (var index = 0; index < parts.length; index += 1) {
            var part = parts[index];
            var equals = part.indexOf("=");
            var key = equals === -1 ? part : part.substring(0, equals);
            var value = equals === -1 ? "" : part.substring(equals + 1);
            try {
              params[decodeURIComponent(key)] = decodeURIComponent(value);
            } catch (e) {
              params[key] = value;
            }
          }
          return params;
        }
        var params = parseHashParams();
        var bridgeRequestId = params.__lnr_request_id__ || "";
        var bridgeNonce = params.__lnr_nonce__ || "";
        window.ReactNativeWebView = window.ReactNativeWebView || {};
        window.ReactNativeWebView.postMessage = function (payload) {
          try {
            if (bridgeRequestId && bridgeNonce && AndroidScraper.postExtractResultWithNonce) {
              AndroidScraper.postExtractResultWithNonce(
                bridgeRequestId,
                bridgeNonce,
                String(payload)
              );
            } else {
              AndroidScraper.postExtractResult(String(payload));
            }
          } catch (e) {}
        };
        try {
          if (params.__lnr_script__) {
            var script = params.__lnr_script__;
            try {
              history.replaceState(null, "", location.pathname + location.search);
            } catch (e) {}
            try {
              (0, eval)(script);
            } catch (e) {
              var msg = (e && e.message) || String(e);
              try {
                window.ReactNativeWebView.postMessage(JSON.stringify({
                  ok: false,
                  error: "before-script error: " + msg
                }));
              } catch (e2) {}
            }
          }
        } catch (e) {}
      })();
    """.trimIndent()
  }
}
