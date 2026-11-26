package io.github.tinywind.norea

import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.ServiceWorkerClient
import android.webkit.ServiceWorkerController
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebStorage
import android.webkit.WebView
import androidx.annotation.Keep
import androidx.webkit.WebStorageCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

internal const val SITE_BROWSER_FOREGROUND_OWNER = "foreground"
private const val SITE_BROWSER_SESSION_PREFERENCES = "site-browser-session"
private const val SITE_BROWSER_DIRECT_ROUTE = "direct"
private const val SITE_BROWSER_DEFAULT_PROFILE = "Default"
private const val SITE_BROWSER_TRANSITION_TIMEOUT_MS = 30_000L
private val INTERNAL_APP_BROWSER_HOSTS = setOf("tauri.localhost", "asset.localhost", "norea-media.localhost")

/** Every site browser shares WebView's default profile so it reuses the main UI renderer process. */
internal fun sharedSiteBrowserProfileName(): String = SITE_BROWSER_DEFAULT_PROFILE

internal fun legacySharedSiteBrowserProfileName(): String = androidScraperProfileName("newtoki-webtoon")

internal fun isAcceptedSiteBrowserProfileName(adopted: String?): Boolean =
  adopted == null || adopted == sharedSiteBrowserProfileName() || adopted == legacySharedSiteBrowserProfileName()

internal fun isInternalAppBrowserHost(host: String?): Boolean =
  host?.lowercase() in INTERNAL_APP_BROWSER_HOSTS

internal fun siteBrowserProfileHash(value: Any?): String? {
  if (value == null || value === JSONObject.NULL) return null
  require(value is String && value.matches(Regex("[a-f0-9]{64}"))) { "Site browser VPN profile hash is invalid." }
  return value
}

internal fun shouldResetSiteBrowserVpnSession(
  routeKnown: Boolean,
  previousIdentity: String?,
  nextIdentity: String,
  clearingCookies: Boolean,
): Boolean {
  val changed = routeKnown && previousIdentity != nextIdentity
  return changed || clearingCookies
}

/**
 * Serializes the browser's network route and data mutations. VPN tunnels may stay connected,
 * but only one owner may use the shared browser profile at a time.
 */
@Keep
internal object AndroidSiteBrowserOwner {
  private data class Route(val owner: String, val port: Int, val hash: String?, val rotate: Boolean)
  private val handler = Handler(Looper.getMainLooper())
  private val io = Executors.newSingleThreadExecutor { task ->
    Thread(task, "NoreaSiteBrowserRoute").apply { isDaemon = true }
  }
  private val cookieFlushExecutor = Executors.newSingleThreadExecutor { task ->
    Thread(task, "NoreaCookieFlush").apply { isDaemon = true }
  }
  private val cookieFlushPending = AtomicBoolean(false)
  private val bridges = linkedMapOf<AndroidScraperBridge, String>()
  private val views = linkedMapOf<WebView, String>()
  private var context: Context? = null
  private var foreground: Route? = null
  private var foregroundReady = false
  private var foregroundDeferred = false
  private var exclusiveOwner: String? = null
  @Volatile private var route: Route? = null
  @Volatile private var networkAllowed = false
  private var transitioning = false
  private var dataMutationInFlight = false
  private var transitionEpoch = 0L
  private var drainedPort: Int? = null
  private val deferredReleases = java.util.ArrayDeque<() -> Unit>()
  private val releaseCallbacks = mutableMapOf<String, MutableList<(Result<Unit>) -> Unit>>()

  @JvmStatic
  external fun closeConnections(proxyPort: Int): Boolean

  fun initialize(context: Context) {
    check(Looper.myLooper() == Looper.getMainLooper()) { "Site browser initialization requires the main thread." }
    if (Build.VERSION.SDK_INT >= 28) {
      check(Application.getProcessName() == context.packageName) { "Site browsers must use the main application process." }
    }
    if (this.context != null) return
    this.context = context.applicationContext
    val preferences = preferences()
    val adopted = preferences.getString("profile", null)
    check(isAcceptedSiteBrowserProfileName(adopted)) { "The shared site profile identity is invalid." }
    if (adopted != sharedSiteBrowserProfileName()) {
      check(preferences.edit().putString("profile", sharedSiteBrowserProfileName()).commit()) {
        "Could not preserve the shared site profile identity."
      }
    }
    setServiceWorkerNetworkBlocked(true)
  }

  fun cookieManager(): CookieManager = CookieManager.getInstance()

  /** Persists cookies off the UI thread so synchronous Chromium DB waits cannot trigger ANRs. */
  fun flushCookiesAsync(onComplete: (() -> Unit)? = null) {
    if (onComplete == null) {
      if (!cookieFlushPending.compareAndSet(false, true)) return
      runCatching {
        cookieFlushExecutor.execute {
          cookieFlushPending.set(false)
          runCatching { cookieManager().flush() }
        }
      }.onFailure { cookieFlushPending.set(false) }
      return
    }
    runCatching {
      cookieFlushExecutor.execute {
        runCatching { cookieManager().flush() }
        onComplete()
      }
    }.onFailure { onComplete() }
  }

  fun register(bridge: AndroidScraperBridge, owner: String, context: Context) {
    initialize(context)
    bridges[bridge] = owner
  }

  fun unregister(bridge: AndroidScraperBridge) {
    bridges.remove(bridge)
  }

  fun registerView(view: WebView, owner: String) {
    views[view] = owner
    view.settings.blockNetworkLoads = !canLoad(owner)
  }

  fun unregisterView(view: WebView) {
    views.remove(view)
  }

  fun canLoad(owner: String): Boolean = networkAllowed && route?.owner == owner

  fun interceptedResponse(owner: String): WebResourceResponse? =
    if (canLoad(owner)) null else blockedResponse()

  private fun blockedResponse(): WebResourceResponse = WebResourceResponse(
    "text/plain", "utf-8", 503, "Browser route unavailable",
    mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0)),
  )

  fun configureForeground(context: Context, payload: JSONObject) {
    check(Looper.myLooper() != Looper.getMainLooper()) { "Site browser route configuration must not block the main thread." }
    val port = checkedPort(payload.opt("port"))
    val hasHash = payload.has("profileHash")
    val hash = if (hasHash) siteBrowserProfileHash(payload.opt("profileHash")) else null
    val completion = CountDownLatch(1)
    var failure: Throwable? = null
    handler.post {
      runCatching {
        initialize(context)
        val rotate = if (payload.has("rotateFingerprintOnVpnChange")) {
          require(payload.opt("rotateFingerprintOnVpnChange") is Boolean) { "Browser environment policy is invalid." }
          payload.getBoolean("rotateFingerprintOnVpnChange")
        } else AndroidBrowserEnvironment.rotationEnabled(context)
        if (rotate) check(AndroidBrowserEnvironment.isSupported()) { "Browser environment rotation is unavailable." }
        AndroidBrowserEnvironment.configure(context, rotate, changedRoute = false)
        val previousForeground = foreground
        val previouslyReady = foregroundReady
        foregroundReady = hasHash
        if (hasHash) foreground = Route(SITE_BROWSER_FOREGROUND_OWNER, port, hash, rotate)
        else foreground = foreground?.copy(port = port, rotate = rotate)
        if (exclusiveOwner != null) {
          completion.countDown()
        } else if (hasHash && foregroundDeferred && previouslyReady &&
          previousForeground?.copy(rotate = rotate) == foreground) {
          // An unchanged status poll does not turn a worker release into a direct-route visit.
          completion.countDown()
        } else if (hasHash) {
          transition(checkNotNull(foreground)) { result ->
            if (result.isSuccess) foregroundDeferred = false
            failure = result.exceptionOrNull()
            completion.countDown()
          }
        } else {
          quiesce(resetVpnSession = false) { result ->
            failure = result.exceptionOrNull()
            completion.countDown()
          }
        }
      }.onFailure { failure = it; completion.countDown() }
    }
    check(completion.await(35, TimeUnit.SECONDS)) { "Site browser route configuration timed out." }
    failure?.let { throw it }
  }

  fun acquire(
    owner: String, profileHash: String, proxyPort: Int,
    rotateFingerprintOnVpnChange: Boolean, done: (Result<Unit>) -> Unit,
  ) {
    requireMainThread()
    checkNotNull(context) { "The shared site browser is not initialized." }
    val validated = siteBrowserProfileHash(profileHash)
    runCatching {
      check(owner != SITE_BROWSER_FOREGROUND_OWNER) { "A VPN owner identity is required." }
      check(exclusiveOwner == null || exclusiveOwner == owner) { "Another site browser route is active." }
      check(bridges.none { (bridge, identity) -> identity != owner && bridge.hasActiveSiteWork() }) {
        "The current site browser task must finish before changing VPN routes."
      }
      checkedPort(proxyPort)
      if (rotateFingerprintOnVpnChange) check(AndroidBrowserEnvironment.isSupported()) { "Browser environment rotation is unavailable." }
      AndroidBrowserEnvironment.configure(checkNotNull(context), rotateFingerprintOnVpnChange, changedRoute = false)
      exclusiveOwner = owner
    }.onFailure { done(Result.failure(it)); return }
    transition(Route(owner, proxyPort, validated, rotateFingerprintOnVpnChange)) { result ->
      if (result.isFailure && exclusiveOwner == owner) exclusiveOwner = null
      done(result)
    }
  }

  fun release(owner: String, done: (Result<Unit>) -> Unit = {}) {
    requireMainThread()
    releaseCallbacks[owner]?.let { it.add(done); return }
    if (exclusiveOwner != owner) { done(Result.success(Unit)); return }
    releaseCallbacks[owner] = mutableListOf(done)
    val release = {
      exclusiveOwner = null
      foregroundDeferred = true
      // Releasing a worker is not a visit to the foreground route. This keeps
      // same-profile reconnects from becoming A -> direct -> A cookie resets.
      quiesce(resetVpnSession = false) { result -> releaseCallbacks.remove(owner)?.forEach { it(result) } }
    }
    if (transitioning) deferredReleases.addLast(release) else release()
  }

  private fun finishDeferredReleases() {
    while (!transitioning && deferredReleases.isNotEmpty()) deferredReleases.removeFirst().invoke()
  }

  fun prepareCommand(owner: String, done: (Result<Unit>) -> Unit) {
    requireMainThread()
    if (canLoad(owner)) { done(Result.success(Unit)); return }
    val next = foreground
    if (owner != SITE_BROWSER_FOREGROUND_OWNER || exclusiveOwner != null ||
      !foregroundReady || !foregroundDeferred || next == null) {
      done(Result.failure(IllegalStateException("The site browser route is unavailable or owned by another task.")))
      return
    }
    transition(next.copy(rotate = AndroidBrowserEnvironment.rotationEnabled(checkNotNull(context)))) { result ->
      if (result.isSuccess) foregroundDeferred = false
      done(result)
    }
  }

  fun requireCommand(owner: String) {
    requireMainThread()
    check(canLoad(owner)) { "The site browser route is unavailable or owned by another task." }
  }

  fun quiesceForeground(done: (Result<Unit>) -> Unit) {
    requireMainThread()
    // A foreground tunnel reconnect must not change a download worker's active route.
    if (exclusiveOwner != null) { done(Result.success(Unit)); return }
    // This is an explicit foreground configuration/reconnect boundary.
    foregroundDeferred = false
    quiesce(resetVpnSession = true, done = done)
  }

  fun canResetSiteData(): Boolean =
    WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)

  fun resetSiteData(url: String, done: (Result<Unit>) -> Unit) {
    requireMainThread()
    runCatching {
      check(canResetSiteData()) { "Resetting site data requires an updated Android System WebView." }
      check(!dataMutationInFlight) { "A previous site data mutation has not completed." }
      val origin = java.net.URI(url)
      require(origin.scheme?.lowercase() in setOf("http", "https") &&
        !origin.host.isNullOrBlank() && origin.rawUserInfo == null &&
        !isInternalAppBrowserHost(origin.host)) {
        "A source website address is required to reset its data."
      }
      check(bridges.keys.none { it.hasActiveSiteWork() }) { "Pause the active site browser task before resetting site data." }
    }.onFailure { done(Result.failure(it)); return }
    val previous = route
    quiesce(resetVpnSession = true) { settled ->
      if (settled.isFailure) { done(settled); return@quiesce }
      val epoch = ++transitionEpoch
      transitioning = true
      var completed = false
      lateinit var timeout: Runnable
      val finish: (Result<Unit>) -> Unit = { result ->
        if (!completed && epoch == transitionEpoch) {
          completed = true
          handler.removeCallbacks(timeout)
          transitioning = false
          if (result.isSuccess && previous != null) {
            transition(previous, done)
          } else {
            done(result)
          }
          finishDeferredReleases()
        }
      }
      timeout = Runnable { finish(Result.failure(IllegalStateException("Site data reset timed out."))) }
      handler.postDelayed(timeout, SITE_BROWSER_TRANSITION_TIMEOUT_MS)
      dataMutationInFlight = true
      runCatching {
        WebStorageCompat.deleteBrowsingDataForSite(WebStorage.getInstance(), url) {
          // A timeout reports failure but cannot cancel WebView's asynchronous deletion.
          // Do not reopen a route until this actual completion callback has arrived.
          dataMutationInFlight = false
          if (completed || epoch != transitionEpoch) return@deleteBrowsingDataForSite
          io.execute {
            val flushed = runCatching { cookieManager().flush() }
            handler.post {
              if (completed || epoch != transitionEpoch) return@post
              finish(flushed)
            }
          }
        }
      }.onFailure {
        dataMutationInFlight = false
        finish(Result.failure(it))
      }
    }
  }

  private fun quiesce(resetVpnSession: Boolean, done: (Result<Unit>) -> Unit) {
    requireMainThread()
    if (transitioning) { done(Result.failure(IllegalStateException("A site browser transition is already running."))); return }
    val epoch = ++transitionEpoch
    transitioning = true
    runCatching { blockAndRetire(resetVpnSession) }.onFailure {
      transitioning = false
      done(Result.failure(it))
      finishDeferredReleases()
      return
    }
    val oldPort = route?.port?.takeUnless { it == drainedPort }
    io.execute {
      val result = runCatching { drain(oldPort) }
      handler.post {
        if (epoch != transitionEpoch) return@post
        transitioning = false
        if (result.isSuccess) drainedPort = route?.port
        done(result)
        finishDeferredReleases()
      }
    }
  }

  private fun transition(next: Route, done: (Result<Unit>) -> Unit) {
    requireMainThread()
    if (dataMutationInFlight) { done(Result.failure(IllegalStateException("A previous site data mutation has not completed."))); return }
    if (transitioning) { done(Result.failure(IllegalStateException("A site browser transition is already running."))); return }
    if (route?.copy(rotate = next.rotate) == next && networkAllowed) {
      route = next
      done(Result.success(Unit))
      return
    }
    val epoch = ++transitionEpoch
    transitioning = true
    val settings = preferences()
    val identity = next.hash ?: SITE_BROWSER_DIRECT_ROUTE
    val routeKnown = settings.getBoolean("routeKnown", false)
    val previousIdentity = settings.getString("routeHash", null)
    val changed = routeKnown && previousIdentity != identity
    val clearingCookies = settings.getBoolean("clearingCookies", false)
    val clearCookies = changed || clearingCookies
    val resetVpnSession = shouldResetSiteBrowserVpnSession(
      routeKnown = routeKnown,
      previousIdentity = previousIdentity,
      nextIdentity = identity,
      clearingCookies = clearingCookies,
    )
    val oldPort = route?.port?.takeUnless { it == drainedPort }
    var completed = false
    lateinit var timeout: Runnable
    val finish: (Result<Unit>) -> Unit = { result ->
      if (!completed && epoch == transitionEpoch) {
        completed = true
        handler.removeCallbacks(timeout)
        transitioning = false
        if (result.isFailure) networkAllowed = false
        done(result)
        finishDeferredReleases()
      }
    }
    timeout = Runnable { finish(Result.failure(IllegalStateException("Site browser transition timed out."))) }
    handler.postDelayed(timeout, SITE_BROWSER_TRANSITION_TIMEOUT_MS)
    runCatching {
      blockAndRetire(resetVpnSession)
      if (clearCookies) check(settings.edit().putBoolean("clearingCookies", true).commit()) {
        "Could not preserve the pending browser cookie reset."
      }
    }.onFailure { finish(Result.failure(it)); return }
    io.execute {
      val drained = runCatching { drain(oldPort) }
      handler.post {
        if (completed || epoch != transitionEpoch) return@post
        if (drained.isFailure) { finish(drained); return@post }
        drainedPort = route?.port
        val afterCookies: () -> Unit = {
          if (!completed && epoch == transitionEpoch) {
            runCatching {
              AndroidBrowserEnvironment.configure(checkNotNull(context), next.rotate, changed, identity)
            }.fold(
              onSuccess = {
                io.execute {
                  val configured = runCatching {
                    cookieManager().flush()
                    configureAndroidVpnWebViewProxy(next.port)
                  }
                  handler.post {
                    if (completed || epoch != transitionEpoch) return@post
                    configured.fold(
                      onSuccess = {
                        runCatching {
                          check(settings.edit().putBoolean("routeKnown", true).putString("routeHash", identity)
                            .putBoolean("clearingCookies", false).commit()) { "Could not preserve the browser route identity." }
                          route = next
                          setServiceWorkerNetworkBlocked(false)
                          networkAllowed = true
                          drainedPort = null
                        }.fold(onSuccess = { finish(Result.success(Unit)) }, onFailure = { finish(Result.failure(it)) })
                      },
                      onFailure = { finish(Result.failure(it)) },
                    )
                  }
                }
              },
              onFailure = { finish(Result.failure(it)) },
            )
          }
        }
        if (clearCookies) {
          dataMutationInFlight = true
          runCatching {
            cookieManager().removeAllCookies {
              dataMutationInFlight = false
              if (!completed && epoch == transitionEpoch) {
                if (cookieManager().hasCookies()) finish(Result.failure(IllegalStateException("Site browser cookies could not be cleared.")))
                else afterCookies()
              }
            }
          }.onFailure {
            dataMutationInFlight = false
            finish(Result.failure(it))
          }
        } else afterCookies()
      }
    }
  }

  private fun blockAndRetire(resetVpnSession: Boolean) {
    networkAllowed = false
    setServiceWorkerNetworkBlocked(true)
    views.keys.toList().forEach { view -> runCatching { view.settings.blockNetworkLoads = true; view.stopLoading() } }
    bridges.keys.toList().forEach { it.retireSiteDocuments(resetVpnSession) }
    // URL-test pages are not scraper bridges.
    views.keys.toList().forEach { view ->
      runCatching { view.stopLoading(); view.destroy() }
      views.remove(view)
    }
  }

  private fun setServiceWorkerNetworkBlocked(blocked: Boolean) {
    val controller = ServiceWorkerController.getInstance()
    controller.serviceWorkerWebSettings.blockNetworkLoads = blocked
    controller.setServiceWorkerClient(object : ServiceWorkerClient() {
      override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse? =
        if (isInternalAppBrowserHost(request.url?.host) || networkAllowed) null else blockedResponse()
    })
  }

  private fun preferences() = checkNotNull(context).getSharedPreferences(SITE_BROWSER_SESSION_PREFERENCES, Context.MODE_PRIVATE)

  private fun drain(port: Int?) {
    if (port != null) check(closeConnections(port)) { "Previous site browser connections could not be closed." }
  }

  private fun checkedPort(value: Any?): Int {
    androidVpnLoopbackProxyUrl(value)
    return (value as Number).toInt()
  }

  private fun requireMainThread() {
    check(Looper.myLooper() == Looper.getMainLooper()) { "Site browser ownership requires the main thread." }
  }
}
