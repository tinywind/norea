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
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.roundToInt
import org.json.JSONObject

private const val BLANK_PAGE_URL = "about:blank"

internal fun deleteLegacyChapterPageCache(directory: File) {
  if (directory.exists() && !directory.deleteRecursively()) {
    throw IOException("Could not delete legacy chapter page cache: ${directory.absolutePath}")
  }
}

internal data class AndroidScraperSurfaceSize(
  val width: Int,
  val height: Int,
)

internal fun androidBackgroundScraperSurfaceSize(
  mainWidth: Int,
  mainHeight: Int,
  displayWidth: Int,
  displayHeight: Int,
): AndroidScraperSurfaceSize = AndroidScraperSurfaceSize(
  width = mainWidth.takeIf { it > 1 } ?: displayWidth.coerceAtLeast(1),
  height = mainHeight.takeIf { it > 1 } ?: displayHeight.coerceAtLeast(1),
)

internal fun androidScraperSurfaceIsForeground(
  browserVisible: Boolean,
  isImmediateWebView: Boolean,
  surfaceVisible: Boolean,
  alpha: Float,
  clickable: Boolean,
): Boolean =
  browserVisible && isImmediateWebView && surfaceVisible && alpha > 0f && clickable

internal fun androidBackgroundScraperSurfaceIsReady(width: Int, height: Int): Boolean =
  width > 1 && height > 1

internal fun shouldCollapseAndroidScraperSurface(
  activeExtractId: String?,
  completedId: String,
  foreground: Boolean,
): Boolean = activeExtractId == completedId && !foreground

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

  private val mainHandler = Handler(Looper.getMainLooper())
  private val parserExecutor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "NoreaScraperBridgeParser").apply { isDaemon = true }
  }
  private val cacheCleanupExecutor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "NoreaScraperBridgeCacheCleanup").apply { isDaemon = true }
  }
  private val legacyChapterPageCache =
    File(mainWebView.context.cacheDir, LEGACY_CHAPTER_PAGE_CACHE_DIRECTORY)
  private val scripts = AndroidScraperScripts(mainWebView.resources)
  private val queues = mutableMapOf(IMMEDIATE_EXECUTOR to AndroidScraperState(IMMEDIATE_EXECUTOR))
  @Volatile
  private var closed = false
  private var browserVisible = false
  private var bounds = CssBounds(0.0, 0.0, 1.0, 1.0, 1.0, 1.0)

  init {
    runCatching {
      cacheCleanupExecutor.execute {
        runCatching { deleteLegacyChapterPageCache(legacyChapterPageCache) }
          .onFailure { error ->
            Log.w(TAG, "Could not remove legacy chapter page cache", error)
          }
      }
    }.onFailure { error ->
      Log.w(TAG, "Could not schedule legacy chapter page cache cleanup", error)
    }
  }

  private fun cookieSummary(state: AndroidScraperState, url: String?): String {
    if (url.isNullOrBlank()) return "<none>"
    val cookieManager = state.webView?.let(::profileCookieManager) ?: return "<unavailable>"
    val header = cookieManager.getCookie(url) ?: return "<empty>"
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

  private fun logState(state: AndroidScraperState, message: String, url: String? = null) {
    requireMainThread()
    // Cookie summaries cost two synchronous cookie-store calls per line, so they
    // stay behind `setprop log.tag.NoreaScraper VERBOSE`.
    val cookies = if (Log.isLoggable(TAG, Log.VERBOSE)) {
      " currentCookies=${cookieSummary(state, state.currentUrl)} " +
        "targetCookies=${cookieSummary(state, url)}"
    } else {
      ""
    }
    Log.d(
      TAG,
      "[${state.key}] ${redactUrlsForLog(message)} busy=${state.busy} queue=${state.queue.size} " +
        "browserVisible=$browserVisible currentUrl=${urlForLog(state.currentUrl)} " +
        "knownQueues=${queues.keys.joinToString(",")} " +
        "webViews=${queues.values.count { it.webView != null }} " +
        "targetUrl=${urlForLog(url)}$cookies",
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
      cancelConcurrentFetches(state, message)
      if (state.busy) cancelActive(state, message)
    }
  }

  @JavascriptInterface
  fun clearCache(payload: String) {
    parseCommand(payload, BridgeCapabilities.SCRAPER_CLEAR_CACHE) { json ->
      val id = json.getString("id")
      runCatching {
        cacheCleanupExecutor.execute {
          val cleanup = runCatching {
            deleteLegacyChapterPageCache(legacyChapterPageCache)
          }
          mainHandler.post {
            if (closed) return@post
            cleanup.fold(
              onSuccess = {
                mainWebView.clearCache(true)
                sendSuccess(id, true)
              },
              onFailure = { error ->
                sendError(id, "scraper: cache clear failed: ${error.message}")
              },
            )
          }
        }
      }.onFailure { error ->
        sendError(id, "scraper: cache clear failed: ${error.message}")
      }
    }
  }

  @JavascriptInterface
  fun clearCookies(payload: String) {
    parseCommand(payload, BridgeCapabilities.SCRAPER_CLEAR_COOKIES) { json ->
      val id = json.getString("id")
      val url = json.getString("url")
      val sourceId = sourceIdFromPayload(json, id) ?: return@parseCommand
      val parsed = Uri.parse(url)
      if (
        parsed.scheme !in setOf("http", "https") ||
        parsed.host.isNullOrBlank()
      ) {
        sendError(id, "scraper: expected an HTTP(S) plugin url")
        return@parseCommand
      }
      val state = queueState(executorFromPayload(json))
      enqueue(
        state,
        AndroidScraperQueuedAction(
          id = id,
          sourceId = sourceId,
          priority = PRIORITY_USER,
          browserAction = false,
          run = { runClearCookies(it, json) },
        ),
      )
    }
  }

  @JavascriptInterface
  fun currentOrigin(payload: String) {
    parseCommand(payload, BridgeCapabilities.SCRAPER_CURRENT_ORIGIN) { json ->
      val id = json.getString("id")
      val sourceId = sourceIdFromPayload(json, id) ?: return@parseCommand
      val state = queueState(IMMEDIATE_EXECUTOR)
      val origin = state.webView
        ?.takeIf { webView ->
          browserVisible && state.sourceId == sourceId && isForegroundBrowser(webView)
        }
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
      val id = json.getString("id")
      val sourceId = sourceIdFromPayload(json, id) ?: return@parseCommand
      val state = queueState(executorFromPayload(json))
      enqueue(
        state,
        AndroidScraperQueuedAction(
          id = id,
          sourceId = sourceId,
          priority = payloadPriority(json),
          browserAction = false,
          run = { runFetch(it, json) },
          fetchPayload = json,
        ),
      )
    }
  }

  @JavascriptInterface
  fun extract(payload: String) {
    parseCommand(payload, BridgeCapabilities.SCRAPER_EXTRACT) { json ->
      val id = json.getString("id")
      val sourceId = sourceIdFromPayload(json, id) ?: return@parseCommand
      val state = queueState(executorFromPayload(json))
      enqueue(
        state,
        AndroidScraperQueuedAction(
          id = id,
          sourceId = sourceId,
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
      val id = json.getString("id")
      val sourceId = sourceIdFromPayload(json, id) ?: return@parseCommand
      val state = queueState(IMMEDIATE_EXECUTOR)
      enqueue(
        state,
        AndroidScraperQueuedAction(
          id = id,
          sourceId = sourceId,
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
      val id = json.optString("id")
      val sourceId = sourceIdFromPayload(json, id) ?: return@parseCommand
      val state = queueState(IMMEDIATE_EXECUTOR)
      state.userAgent = payloadUserAgent(json)
      if (browserVisible && state.sourceId == sourceId) showScraper()
    }
  }

  @JavascriptInterface
  fun hide() {
    mainHandler.post { hideScraper(emitHiddenEvent = false) }
  }

  fun destroy() {
    closed = true
    parserExecutor.shutdownNow()
    cacheCleanupExecutor.shutdownNow()
    val cleanup = Runnable {
      queues.values.forEach { state ->
        clearTimeout(state)
        state.webView?.let { webView ->
          destroyScraperWebView(state, webView, "bridge shutdown")
        }
        state.sourceId = null
        state.queue.clear()
        state.activeAction = null
        state.activeExtractId = null
        state.activeFetchId = null
        state.activeResultNonce = null
        state.blankBeforeNextAction = false
        state.blankNavigationInProgress = false
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

  fun handleBackPressed(): Boolean {
    if (Looper.myLooper() != Looper.getMainLooper()) return false
    val state = queueState(IMMEDIATE_EXECUTOR)
    val webView = state.webView
    val hasPendingBrowserAction =
      state.activeAction?.browserAction == true || state.queue.hasBrowserAction
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
    return androidScraperSurfaceIsForeground(
      browserVisible = browserVisible,
      isImmediateWebView = queues[IMMEDIATE_EXECUTOR]?.webView === webView,
      surfaceVisible = webView.visibility == View.VISIBLE,
      alpha = webView.alpha,
      clickable = webView.isClickable,
    )
  }

  private fun executorFromPayload(payload: JSONObject): String {
    val value = payload.optString("queue", IMMEDIATE_EXECUTOR).trim()
    if (value == "mainForeground") return IMMEDIATE_EXECUTOR
    if (value == IMMEDIATE_EXECUTOR) return value
    if (Regex("^pool:\\d+$").matches(value)) return value
    return IMMEDIATE_EXECUTOR
  }

  private fun sourceIdFromPayload(payload: JSONObject, requestId: String): String? {
    val sourceId = payload.optString("sourceId")
    val error = when {
      sourceId.trim().isEmpty() ->
        "scraper: source id is required for browser profile isolation"
      sourceId.toByteArray(Charsets.UTF_8).size > MAX_SOURCE_ID_BYTES ->
        "scraper: source id exceeds the 512-byte limit"
      else -> null
    }
    if (error != null) {
      if (requestId.isNotEmpty()) sendError(requestId, error)
      return null
    }
    return sourceId
  }

  private fun queueState(key: String): AndroidScraperState {
    requireMainThread()
    return queues.getOrPut(key) { AndroidScraperState(key) }
  }

  private fun enqueue(state: AndroidScraperState, action: AndroidScraperQueuedAction) {
    requireMainThread()
    logState(
      state,
      "enqueue id=${action.id} priority=${action.priority} browserAction=${action.browserAction}",
    )
    state.queue.enqueue(action)
    runNext(state)
    if (state.busy || state.concurrentFetches.isNotEmpty()) startConcurrentFetches(state)
  }

  private fun requireMainThread() {
    check(Looper.myLooper() == Looper.getMainLooper()) {
      "Android scraper state must be accessed on the main thread."
    }
  }

  private fun runNext(state: AndroidScraperState) {
    requireMainThread()
    if (
      !canStartQueuedAction(
        state.busy,
        state.blankBeforeNextAction,
        state.blankNavigationInProgress,
      ) || state.queue.isEmpty()
    ) {
      return
    }
    if (state.concurrentFetches.isNotEmpty()) {
      startConcurrentFetches(state)
      return
    }
    val action = state.queue.takeNext(
      browserExclusive = state.key == IMMEDIATE_EXECUTOR && browserVisible,
    ) ?: return
    state.busy = true
    state.activeAction = action
    logState(
      state,
      "runNext id=${action.id} priority=${action.priority} browserAction=${action.browserAction}",
    )
    try {
      activateSource(state, action.sourceId)
      action.run(state)
    } catch (error: Throwable) {
      clearTimeout(state)
      clearBackgroundScraperLayoutWait(state)
      state.webView?.let { webView ->
        if (
          shouldCollapseAndroidScraperSurface(
            activeExtractId = state.activeExtractId,
            completedId = action.id,
            foreground = isForegroundBrowser(webView),
          )
        ) {
          collapseBackgroundScraperSurface(webView)
        }
      }
      state.activeFetchId = null
      state.activeExtractId = null
      state.activeResultNonce = null
      state.activeAction = null
      state.busy = false
      state.fetchInFlight = false
      sendError(action.id, "scraper: ${error.message ?: error.toString()}")
      runNextAfterPendingBlank(state)
    }
  }

  private fun canStartConcurrentFetch(
    state: AndroidScraperState,
    action: AndroidScraperQueuedAction,
  ): Boolean {
    val payload = action.fetchPayload ?: return false
    if (action.sourceId != state.sourceId) return false
    if (payloadUserAgent(payload) != state.userAgent) return false
    val url = payload.optString("url")
    val contextUrl = payload.optString("contextUrl").takeIf { it.isNotBlank() }
    val fetchContextUrl = fetchContextUrl(url, contextUrl) ?: return true
    return sameOrigin(state.currentUrl, fetchContextUrl)
  }

  // Plain fetches share the current document, so independent requests that
  // need no context navigation run side by side; navigation, extraction, and
  // parking stay exclusive until every in-flight fetch has settled.
  private fun startConcurrentFetches(state: AndroidScraperState) {
    requireMainThread()
    val webView = state.webView ?: return
    if (
      !canStartConcurrentScraperFetches(
        blankBeforeNextAction = state.blankBeforeNextAction,
        blankNavigationInProgress = state.blankNavigationInProgress,
        exclusiveActionActive = state.activeAction != null && !state.fetchInFlight,
        foregroundBrowser = state.key == IMMEDIATE_EXECUTOR && browserVisible,
      )
    ) {
      return
    }
    while (
      availableScraperFetchSlots(
        FETCH_CONCURRENCY,
        state.fetchInFlight,
        state.concurrentFetches.size,
      ) > 0
    ) {
      val action = state.queue.takeMatching { canStartConcurrentFetch(state, it) } ?: return
      runCatching { startConcurrentFetch(state, webView, action) }
        .onFailure { error ->
          state.concurrentFetches.remove(action.id)?.let { mainHandler.removeCallbacks(it.timeout) }
          sendError(action.id, "scraper: ${error.message ?: error.toString()}")
        }
    }
  }

  private fun startConcurrentFetch(
    state: AndroidScraperState,
    webView: WebView,
    action: AndroidScraperQueuedAction,
  ) {
    val payload = action.fetchPayload ?: return
    val id = action.id
    val url = payload.getString("url")
    val init = payload.optJSONObject("init") ?: JSONObject()
    val timeoutMs = payload.optLong("timeoutMs", 60_000L).coerceAtLeast(1L)
    val nonce = bridgeSession.newNonce()
    val timeout = Runnable {
      abortActiveFetch(state, id)
      finishConcurrentFetch(
        state,
        id,
        JSONObject()
          .put("ok", false)
          .put("error", redactUrlsForLog("scraper: browser fetch to $url timed out after ${timeoutMs}ms")),
      )
    }
    state.concurrentFetches[id] = AndroidScraperConcurrentFetch(nonce, timeout)
    mainHandler.postDelayed(timeout, timeoutMs)
    logState(state, "runFetch concurrent id=$id url=$url inFlight=${state.concurrentFetches.size}", url)
    val request = JSONObject()
      .put("url", url)
      .put("init", init)
    webView.evaluateJavascript(scripts.fetch(id, nonce, request), null)
  }

  private fun finishConcurrentFetch(state: AndroidScraperState, id: String, envelope: JSONObject) {
    val entry = state.concurrentFetches.remove(id) ?: return
    mainHandler.removeCallbacks(entry.timeout)
    logState(state, "finish concurrent id=$id envelope=${envelopeForLog(envelope)}")
    sendResult(id, envelope)
    if (state.concurrentFetches.isEmpty() && !state.busy) {
      runNextAfterPendingBlank(state)
    } else {
      startConcurrentFetches(state)
    }
  }

  private fun cancelConcurrentFetches(state: AndroidScraperState, message: String) {
    for (id in state.concurrentFetches.keys.toList()) {
      abortActiveFetch(state, id)
      finishConcurrentFetch(
        state,
        id,
        JSONObject()
          .put("ok", false)
          .put("error", redactUrlsForLog(message)),
      )
    }
  }

  private fun runNextAfterPendingBlank(state: AndroidScraperState) {
    requireMainThread()
    if (state.busy) return
    if (state.blankBeforeNextAction) {
      loadBlankThenRunNext(state)
      return
    }
    runNext(state)
  }

  private fun activateSource(state: AndroidScraperState, sourceId: String) {
    requireMainThread()
    if (state.sourceId == sourceId) return
    state.webView?.let { existing ->
      logState(state, "switch source profile sourceId=$sourceId")
      destroyScraperWebView(state, existing, "source profile switch")
    }
    state.sourceId = sourceId
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

  private fun sourceProfileName(sourceId: String): String {
    val digest = MessageDigest.getInstance("SHA-256")
      .digest(sourceId.toByteArray(Charsets.UTF_8))
    val hex = buildString(digest.size * 2) {
      for (byte in digest) {
        append(HEX_DIGITS[(byte.toInt() ushr 4) and 0x0f])
        append(HEX_DIGITS[byte.toInt() and 0x0f])
      }
    }
    return "norea-source-$hex"
  }

  private fun profileCookieManager(webView: WebView): CookieManager {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
      throw UnsupportedOperationException(
        "Source profile isolation requires an updated Android System WebView",
      )
    }
    return WebViewCompat.getProfile(webView).cookieManager
  }

  private fun destroyScraperWebView(
    state: AndroidScraperState,
    webView: WebView,
    reason: String,
  ) {
    webView.webViewClient = WebViewClient()
    state.pendingSurfaceLayoutListener?.let(webView::removeOnLayoutChangeListener)
    state.pendingSurfaceLayoutListener = null
    state.pendingDocumentReady = null
    clearExtractScript(state)
    cancelConcurrentFetches(state, "scraper: webview closed during $reason")
    webView.stopLoading()
    runCatching { profileCookieManager(webView).flush() }
      .onFailure { error ->
        Log.w(TAG, "[${state.key}] could not flush source profile before $reason", error)
      }
    scraperContainer().removeView(webView)
    webView.destroy()
    if (state.webView === webView) {
      state.webView = null
      state.currentUrl = null
      state.documentStartScriptEnabled = false
    }
  }

  private fun scraper(state: AndroidScraperState, userAgent: String?): WebView {
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

  @SuppressLint("SetJavaScriptEnabled")
  private fun createScraperWebView(
    state: AndroidScraperState,
    userAgent: String?,
  ): WebView {
    val sourceId = state.sourceId
      ?: throw IllegalStateException("Source profile was not assigned before WebView creation")
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
      throw UnsupportedOperationException(
        "Source profile isolation requires an updated Android System WebView",
      )
    }
    val webView = WebView(mainWebView.context)
    WebViewCompat.setProfile(webView, sourceProfileName(sourceId))
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
    profileCookieManager(webView).apply {
      setAcceptCookie(true)
      setAcceptThirdPartyCookies(webView, true)
    }

    webView.addJavascriptInterface(ResultBridge(this, state), "AndroidScraper")
    state.documentStartScriptEnabled =
      WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
    if (state.documentStartScriptEnabled) {
      WebViewCompat.addDocumentStartJavaScript(webView, scripts.init, setOf("*"))
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

  private fun backgroundLayoutParams(): FrameLayout.LayoutParams {
    val metrics = mainWebView.resources.displayMetrics
    val size = androidBackgroundScraperSurfaceSize(
      mainWidth = mainWebView.width,
      mainHeight = mainWebView.height,
      displayWidth = metrics.widthPixels,
      displayHeight = metrics.heightPixels,
    )
    return FrameLayout.LayoutParams(size.width, size.height).apply {
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
    when (foregroundBlankTiming(state.activeAction?.browserAction)) {
      ForegroundBlankTiming.BEFORE_NEXT_ACTION -> {
        state.blankBeforeNextAction = true
        if (state.activeAction?.browserAction == true) {
          cancelActive(state, "scraper: site browser closed")
        }
      }
      ForegroundBlankTiming.AFTER_ACTIVE_ACTION -> {
        state.blankBeforeNextAction = true
      }
    }
    hideScraperSurface(state)
    state.webView?.let { profileCookieManager(it).flush() }
    if (emitHiddenEvent) emitSiteBrowserHidden()
    logState(state, "hideScraper after")
    runNextAfterPendingBlank(state)
  }

  private fun hideScraperSurface(state: AndroidScraperState) {
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

  private fun clearBackgroundScraperLayoutWait(state: AndroidScraperState) {
    val listener = state.pendingSurfaceLayoutListener ?: return
    state.pendingSurfaceLayoutListener = null
    state.webView?.removeOnLayoutChangeListener(listener)
  }

  private fun showBackgroundScraperSurface(
    state: AndroidScraperState,
    webView: WebView,
    onReady: () -> Unit,
  ) {
    clearBackgroundScraperLayoutWait(state)
    webView.layoutParams = backgroundLayoutParams()
    webView.alpha = 1f
    webView.translationX = 0f
    webView.translationY = 0f
    webView.translationZ = 0f
    webView.elevation = 0f
    webView.visibility = View.VISIBLE
    webView.isClickable = false
    webView.isFocusable = false
    webView.isFocusableInTouchMode = false
    webView.requestLayout()
    webView.invalidate()
    if (androidBackgroundScraperSurfaceIsReady(webView.width, webView.height)) {
      onReady()
      return
    }
    val listener = object : View.OnLayoutChangeListener {
      override fun onLayoutChange(
        view: View,
        left: Int,
        top: Int,
        right: Int,
        bottom: Int,
        oldLeft: Int,
        oldTop: Int,
        oldRight: Int,
        oldBottom: Int,
      ) {
        if (!androidBackgroundScraperSurfaceIsReady(right - left, bottom - top)) return
        view.removeOnLayoutChangeListener(this)
        if (state.pendingSurfaceLayoutListener === this) {
          state.pendingSurfaceLayoutListener = null
        }
        onReady()
      }
    }
    state.pendingSurfaceLayoutListener = listener
    webView.addOnLayoutChangeListener(listener)
  }

  private fun collapseBackgroundScraperSurface(webView: WebView) {
    webView.layoutParams = hiddenLayoutParams()
    webView.alpha = 0f
    webView.translationX = -10000f
    webView.translationY = -10000f
    webView.requestLayout()
  }

  private fun loadBlankThenRunNext(state: AndroidScraperState) {
    requireMainThread()
    if (state.busy || !state.blankBeforeNextAction || state.blankNavigationInProgress) return
    if (state.concurrentFetches.isNotEmpty()) return
    val webView = state.webView
    if (webView == null) {
      state.blankBeforeNextAction = false
      runNext(state)
      return
    }

    state.blankNavigationInProgress = true
    val parkingUrl = scraperParkingUrl(state.currentUrl)
    val expectedUrl = parkingUrl ?: BLANK_PAGE_URL
    webView.stopLoading()
    webView.webViewClient = makeClient(state) { finishedUrl ->
      if (!shouldCompleteBlankNavigation(
          blankNavigationInProgress = state.blankNavigationInProgress,
          isCurrentWebView = state.webView === webView,
          finishedUrl = finishedUrl,
          timeoutElapsed = false,
          expectedUrl = expectedUrl,
        )) {
        return@makeClient
      }
      finishBlankNavigation(state, webView, recreateWebView = false)
    }
    clearTimeout(state)
    val timeout = Runnable {
      if (!shouldCompleteBlankNavigation(
          blankNavigationInProgress = state.blankNavigationInProgress,
          isCurrentWebView = state.webView === webView,
          finishedUrl = null,
          timeoutElapsed = true,
        )) {
        return@Runnable
      }
      Log.w(TAG, "[${state.key}] blank navigation timed out; recreating scraper WebView")
      finishBlankNavigation(state, webView, recreateWebView = true)
    }
    state.activeTimeout = timeout
    mainHandler.postDelayed(timeout, BLANK_NAVIGATION_TIMEOUT_MS)
    if (parkingUrl != null) {
      logState(state, "park idle webview", parkingUrl)
      webView.loadDataWithBaseURL(parkingUrl, PARKED_PAGE_HTML, "text/html", "utf-8", parkingUrl)
    } else {
      webView.loadUrl(BLANK_PAGE_URL)
    }
  }

  private fun finishBlankNavigation(
    state: AndroidScraperState,
    webView: WebView,
    recreateWebView: Boolean,
  ) {
    clearTimeout(state)
    webView.webViewClient = makeClient(state, null)
    if (recreateWebView) {
      destroyScraperWebView(state, webView, "blank navigation timeout")
    }
    state.blankNavigationInProgress = false
    state.blankBeforeNextAction = false
    runNext(state)
  }

  private fun emitSiteBrowserHidden() {
    mainWebView.evaluateJavascript(
      "window.dispatchEvent(new CustomEvent('norea-site-browser-hidden'));",
      null,
    )
  }

  private fun makeClient(
    state: AndroidScraperState,
    onStarted: ((String) -> Unit)? = null,
    onFinished: ((String) -> Unit)? = null,
  ): WebViewClient {
    return object : WebViewClient() {
      override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
        state.currentUrl = url
        logState(state, "pageStarted url=$url", url)
        if (!state.documentStartScriptEnabled) {
          view.evaluateJavascript(scripts.init, null)
        }
        onStarted?.invoke(url)
      }

      override fun onPageFinished(view: WebView, url: String) {
        state.currentUrl = url
        profileCookieManager(view).flush()
        logState(state, "pageFinished url=$url", url)
        onFinished?.invoke(url)
      }
    }
  }

  private fun runClearCookies(state: AndroidScraperState, payload: JSONObject) {
    val id = payload.getString("id")
    val url = payload.getString("url")
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.GET_COOKIE_INFO)) {
      finishError(
        state,
        id,
        "scraper: per-site cookie clearing requires an updated Android System WebView",
      )
      return
    }

    val cookieManager = profileCookieManager(scraper(state, payloadUserAgent(payload)))
    val expiredHeaders = runCatching {
      CookieManagerCompat.getCookieInfo(cookieManager, url)
        .mapNotNull(::expiredCookieHeader)
    }.getOrElse { error ->
      finishError(state, id, "scraper: read cookies: ${error.message ?: error.toString()}")
      return
    }
    if (expiredHeaders.isEmpty()) {
      finishSuccess(state, id, 0)
      return
    }

    setTimeout(state, id, 10_000L, "scraper: cookie clearing timed out")
    var remaining = expiredHeaders.size
    var deleted = 0
    var rejected = false
    expiredHeaders.forEach { header ->
      cookieManager.setCookie(url, header) { accepted ->
        if (closed || state.activeAction?.id != id) return@setCookie
        if (accepted) {
          deleted += 1
        } else {
          rejected = true
        }
        remaining -= 1
        if (remaining == 0) {
          cookieManager.flush()
          if (rejected) {
            finishError(state, id, "scraper: one or more cookies could not be deleted")
          } else {
            finishSuccess(state, id, deleted)
          }
        }
      }
    }
  }

  private fun runFetch(state: AndroidScraperState, payload: JSONObject) {
    val id = payload.getString("id")
    val url = payload.getString("url")
    val contextUrl = payload.optString("contextUrl").takeIf { it.isNotBlank() }
    val fetchContextUrl = fetchContextUrl(url, contextUrl)
    // A context derived from the request origin (cross-origin media such as a
    // cover CDN) only needs a same-origin document, not the origin's root page.
    val syntheticContext = fetchContextUrl != null && fetchContextUrl != contextUrl
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

    prepareContext(state, webView, id, fetchContextUrl, url, syntheticContext) { preparedFetchUrl ->
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
      webView.evaluateJavascript(scripts.fetch(id, resultNonce, request), null)
      state.fetchInFlight = true
      startConcurrentFetches(state)
    }
  }

  private fun runExtract(state: AndroidScraperState, payload: JSONObject) {
    val id = payload.getString("id")
    val url = payload.getString("url")
    val beforeScript = payload.optString("beforeScript").takeIf { it.isNotEmpty() }
    val timeoutMs = payload.optLong("timeoutMs", 30_000L)
    val resultNonce = beforeScript?.let { bridgeSession.newNonce() }
    val webView = scraper(state, payloadUserAgent(payload))
    // Page CSP applies to the eval fallback in norea_scraper_init.js but not to embedder
    // document-start scripts, so a per-request script scoped to the page origin
    // keeps captures working on sites that forbid 'unsafe-eval'.
    val extractOriginRule = originUrl(Uri.parse(url))
      ?.takeIf { beforeScript != null && state.documentStartScriptEnabled }
    val targetUrl = if (beforeScript != null && extractOriginRule == null) {
      val base = url.substringBefore("#")
      "$base#__norea_script__=${Uri.encode(beforeScript)}" +
        "&__norea_request_id__=${Uri.encode(id)}" +
        "&__norea_nonce__=${Uri.encode(resultNonce.orEmpty())}"
    } else {
      url
    }

    state.activeExtractId = id
    state.activeResultNonce = resultNonce
    logState(
      state,
      "runExtract start id=$id url=$url timeoutMs=$timeoutMs beforeScriptLength=${beforeScript?.length ?: 0} " +
        "documentStartScript=${extractOriginRule != null}",
      url,
    )
    setTimeout(state, id, timeoutMs, "webview_extract: timeout after ${timeoutMs}ms")
    clearExtractScript(state)
    if (beforeScript != null && extractOriginRule != null) {
      state.activeExtractScript = WebViewCompat.addDocumentStartJavaScript(
        webView,
        scripts.extractStart(id, resultNonce.orEmpty(), beforeScript),
        setOf(extractOriginRule),
      )
    }
    val loadTarget = {
      if (state.activeExtractId == id && state.activeAction?.id == id) {
        runCatching { webView.loadUrl(targetUrl) }
          .onFailure { error ->
            finishError(
              state,
              id,
              "webview_extract: navigation failed: ${error.message ?: error.toString()}",
            )
          }
      }
    }
    if (isForegroundBrowser(webView)) {
      loadTarget()
    } else {
      showBackgroundScraperSurface(state, webView, loadTarget)
    }
  }

  private fun runNavigate(state: AndroidScraperState, payload: JSONObject) {
    val id = payload.getString("id")
    val url = payload.getString("url")
    val timeoutMs = payload.optLong("timeoutMs", 30_000L).coerceAtLeast(1L)
    val userAgent = payloadUserAgent(payload)
    val webView = scraper(state, userAgent)
    logState(
      state,
      "runNavigate start id=$id url=$url timeoutMs=$timeoutMs",
      url,
    )
    hideScraperSurface(state)
    webView.stopLoading()
    webView.webViewClient = makeClient(state) {
      if (state.activeAction?.id != id) return@makeClient
      webView.clearHistory()
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
    state: AndroidScraperState,
    webView: WebView,
    id: String,
    contextUrl: String?,
    fallbackContextUrl: String?,
    syntheticContext: Boolean,
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
    logState(
      state,
      "prepareContext navigate id=$id contextUrl=$contextUrl synthetic=$syntheticContext",
      contextUrl,
    )

    var finished = false
    var navigationStarted = false
    var fallbackAttempted = false
    var activeFallbackUrl: String? = null
    val timeout = Runnable {
      if (finished) return@Runnable
      finished = true
      state.pendingDocumentReady = null
      webView.stopLoading()
      webView.webViewClient = makeClient(state, null)
      logState(state, "prepareContext timeout id=$id contextUrl=$contextUrl", contextUrl)
      finishError(state, id, "scraper: timed out preparing fetch context $contextUrl")
    }
    state.activeTimeout = timeout
    mainHandler.postDelayed(timeout, 15_000L)
    // A browser fetch only needs a same-origin document whose HTML has been
    // parsed, so the main-frame DOMContentLoaded notification from norea_scraper_init.js
    // completes the preparation without waiting for images, ads, or trackers.
    // onPageFinished stays as the fallback for documents that never post it.
    fun onContextDocument(documentUrl: String, event: String) {
      if (finished || !navigationStarted) return
      if (!sameOrigin(documentUrl, contextUrl)) {
        val fallbackUrl = fallbackContextUrl?.takeIf { it != contextUrl }
        if (!fallbackAttempted && fallbackUrl != null) {
          fallbackAttempted = true
          activeFallbackUrl = fallbackUrl
          logState(
            state,
            "prepareContext fallback id=$id contextUrl=$contextUrl finishedUrl=$documentUrl fallbackUrl=$fallbackUrl event=$event",
            fallbackUrl,
          )
          webView.loadUrl(fallbackUrl)
          return
        }
        if (fallbackAttempted && activeFallbackUrl != null && isHttpUrl(documentUrl)) {
          finished = true
          state.pendingDocumentReady = null
          clearTimeout(state)
          webView.webViewClient = makeClient(state, null)
          logState(
            state,
            "prepareContext ready fallback id=$id contextUrl=$contextUrl finishedUrl=$documentUrl event=$event",
            documentUrl,
          )
          ready(documentUrl)
          return
        }
        logState(
          state,
          "prepareContext waiting origin id=$id contextUrl=$contextUrl finishedUrl=$documentUrl event=$event",
          contextUrl,
        )
        return
      }
      finished = true
      state.pendingDocumentReady = null
      clearTimeout(state)
      webView.webViewClient = makeClient(state, null)
      logState(state, "prepareContext ready id=$id contextUrl=$contextUrl event=$event", contextUrl)
      ready(null)
    }
    state.pendingDocumentReady = { documentUrl -> onContextDocument(documentUrl, "documentReady") }
    webView.webViewClient = makeClient(
      state,
      onFinished = { finishedUrl -> onContextDocument(finishedUrl, "pageFinished") },
      onStarted = { navigationStarted = true },
    )
    if (syntheticContext) {
      val documentUrl = "${contextUrl.trimEnd('/')}/"
      webView.loadDataWithBaseURL(documentUrl, PARKED_PAGE_HTML, "text/html", "utf-8", documentUrl)
    } else {
      webView.loadUrl(contextUrl)
    }
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

  private fun setTimeout(
    state: AndroidScraperState,
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

  private fun clearTimeout(state: AndroidScraperState) {
    state.activeTimeout?.let { mainHandler.removeCallbacks(it) }
    state.activeTimeout = null
  }

  private fun finishSuccess(state: AndroidScraperState, id: String, result: Any) {
    finish(
      state,
      id,
      JSONObject()
        .put("ok", true)
        .put("result", result),
    )
  }

  private fun finishError(state: AndroidScraperState, id: String, message: String) {
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
    state: AndroidScraperState,
    message: String,
    shouldCancel: (AndroidScraperQueuedAction) -> Boolean,
  ) {
    state.queue.removeWhere(shouldCancel).forEach { action ->
      sendError(action.id, message)
    }
  }

  private fun cancelById(id: String, message: String) {
    for (state in queues.values) {
      val cancelled = state.queue.removeWhere { it.id == id }
      if (cancelled.isNotEmpty()) {
        cancelled.forEach { action -> sendError(action.id, message) }
        return
      }
      if (state.concurrentFetches.containsKey(id)) {
        abortActiveFetch(state, id)
        finishConcurrentFetch(
          state,
          id,
          JSONObject()
            .put("ok", false)
            .put("error", redactUrlsForLog(message)),
        )
        return
      }
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

  private fun cancelActive(state: AndroidScraperState, message: String) {
    val browserAction = state.activeAction?.browserAction == true
    val fetchId = state.activeFetchId
    val id = fetchId ?: state.activeExtractId ?: state.activeAction?.id
    if (fetchId != null) abortActiveFetch(state, fetchId)
    state.webView?.webViewClient = makeClient(state, null)
    state.webView?.stopLoading()
    if (browserAction) state.blankBeforeNextAction = true
    if (id == null) {
      clearTimeout(state)
      state.pendingDocumentReady = null
      state.activeResultNonce = null
      state.activeAction = null
      state.busy = false
      state.fetchInFlight = false
      runNextAfterPendingBlank(state)
      return
    }
    finishError(state, id, message)
  }

  private fun abortActiveFetch(state: AndroidScraperState, id: String) {
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

  private fun sendSuccess(id: String, result: Any) {
    sendResult(
      id,
      JSONObject()
        .put("ok", true)
        .put("result", result),
    )
  }

  private fun finish(state: AndroidScraperState, id: String, envelope: JSONObject) {
    clearTimeout(state)
    clearBackgroundScraperLayoutWait(state)
    state.pendingDocumentReady = null
    logState(state, "finish id=$id envelope=${envelopeForLog(envelope)}")
    state.webView?.let { webView ->
      if (state.activeExtractId == id) {
        clearExtractScript(state)
        webView.evaluateJavascript(scripts.clearExtractBridge, null)
      }
      if (
        shouldCollapseAndroidScraperSurface(
          activeExtractId = state.activeExtractId,
          completedId = id,
          foreground = isForegroundBrowser(webView),
        )
      ) {
        collapseBackgroundScraperSurface(webView)
      }
    }
    state.activeFetchId = null
    state.activeExtractId = null
    state.activeResultNonce = null
    state.activeAction = null
    state.fetchInFlight = false
    sendResult(id, envelope)
    state.busy = false
    runNextAfterPendingBlank(state)
  }

  private fun sendResult(id: String, envelope: JSONObject) {
    val script =
      "window.__noreaAndroidScraperResolve(${JSONObject.quote(id)}, ${JSONObject.quote(envelope.toString())});"
    mainWebView.evaluateJavascript(script, null)
  }

  private fun parseFetchResult(
    state: AndroidScraperState,
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
              failFetchResult(state, id, "scraper: invalid browser fetch result: ${error.message}")
            },
          )
        }
      }
    }.onFailure { error ->
      mainHandler.post {
        failFetchResult(state, id, "scraper: invalid browser fetch result: ${error.message}")
      }
    }
  }

  private fun failFetchResult(state: AndroidScraperState, id: String, message: String) {
    if (state.activeFetchId == id) {
      finishError(state, id, message)
    } else if (state.concurrentFetches.containsKey(id)) {
      finishConcurrentFetch(
        state,
        id,
        JSONObject()
          .put("ok", false)
          .put("error", redactUrlsForLog(message)),
      )
    }
  }

  private fun onFetchResult(
    state: AndroidScraperState,
    id: String,
    nonce: String,
    result: JSONObject,
    logSummary: String,
  ) {
    state.concurrentFetches[id]?.let { entry ->
      if (nonce != entry.nonce) {
        failFetchResult(state, id, "scraper: browser result authority mismatch")
        return
      }
      logState(state, "onFetchResult concurrent id=$id $logSummary")
      if (!result.optBoolean("success", false)) {
        failFetchResult(state, id, result.optString("error", "unknown browser fetch error"))
        return
      }
      result.remove("success")
      finishConcurrentFetch(
        state,
        id,
        JSONObject()
          .put("ok", true)
          .put("result", result),
      )
      return
    }
    if (state.activeFetchId != id) return
    if (!isExpectedResultNonce(state, id, nonce)) return
    state.webView?.let { profileCookieManager(it).flush() }
    logState(state, "onFetchResult id=$id $logSummary")
    if (!result.optBoolean("success", false)) {
      finishError(state, id, result.optString("error", "unknown browser fetch error"))
      return
    }
    result.remove("success")
    finishSuccess(state, id, result)
  }

  private fun clearExtractScript(state: AndroidScraperState) {
    state.activeExtractScript?.remove()
    state.activeExtractScript = null
  }

  private fun onDocumentReady(state: AndroidScraperState, url: String) {
    if (closed) return
    val listener = state.pendingDocumentReady ?: return
    listener(url)
  }

  private fun onExtractResult(state: AndroidScraperState, id: String?, nonce: String?, payload: String) {
    val activeId = state.activeExtractId ?: return
    if (id != null && id != activeId) return
    if (!isExpectedResultNonce(state, activeId, nonce.orEmpty())) return
    state.webView?.let { profileCookieManager(it).flush() }
    logState(state, "onExtractResult id=$activeId payloadLength=${payload.length}")
    clearTimeout(state)
    state.blankBeforeNextAction = true
    finishSuccess(state, activeId, payload)
  }

  private fun isExpectedResultNonce(state: AndroidScraperState, id: String, nonce: String): Boolean {
    val expected = state.activeResultNonce ?: return true
    if (nonce == expected) return true
    finishError(state, id, "scraper: browser result authority mismatch")
    return false
  }

  private class ResultBridge(
    private val owner: AndroidScraperBridge,
    private val state: AndroidScraperState,
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
    fun postDocumentReady(url: String) {
      owner.mainHandler.post { owner.onDocumentReady(state, url) }
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

  companion object {
    private const val TAG = SCRAPER_LOG_TAG
    private const val BLANK_NAVIGATION_TIMEOUT_MS = 5_000L
    private const val FETCH_CONCURRENCY = 4
    private const val HEX_DIGITS = "0123456789abcdef"
    private const val IMMEDIATE_EXECUTOR = "immediate"
    private const val LEGACY_CHAPTER_PAGE_CACHE_DIRECTORY = "scraper-chapter-pages"
    private const val MAX_SOURCE_ID_BYTES = 512
    private const val PARKED_PAGE_HTML = "<!doctype html><title></title>"
    private const val PRIORITY_INTERACTIVE = 0
    private const val PRIORITY_USER = 1
    private const val PRIORITY_NORMAL = 2
    private const val PRIORITY_DEFERRED = 3
    private const val PRIORITY_BACKGROUND = 4
  }
}
