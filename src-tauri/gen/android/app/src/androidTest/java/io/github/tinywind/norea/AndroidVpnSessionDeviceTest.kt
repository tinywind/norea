package io.github.tinywind.norea

import android.app.ActivityOptions
import android.content.Intent
import android.graphics.Rect
import android.os.SystemClock
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.CookieManagerCompat
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.Closeable
import java.net.InetAddress
import java.net.ServerSocket
import java.net.SocketException
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidVpnSessionDeviceTest {
  private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
  private val context get() = instrumentation.targetContext

  private data class Request(val path: String, val cookies: String, val cacheControl: String)

  private class Fixture : Closeable {
    private val server = ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"))
    val origin = "http://127.0.0.1:${server.localPort}"
    val requests = CopyOnWriteArrayList<Request>()
    @Volatile var fresh = false
    private val thread = Thread({
      while (!server.isClosed) {
        try {
          server.accept().use { socket ->
            socket.soTimeout = 10_000
            val input = socket.getInputStream().bufferedReader()
            val line = input.readLine() ?: return@use
            val path = line.split(" ")[1]
            val headers = mutableMapOf<String, String>()
            while (true) {
              val header = input.readLine()?.takeIf { it.isNotEmpty() } ?: break
              headers[header.substringBefore(":").lowercase()] = header.substringAfter(":").trim()
            }
            requests.add(Request(path, headers["cookie"].orEmpty(), headers["cache-control"].orEmpty()))
            val route = path.substringBefore("?")
            val status = when (route) {
              "/forbidden", "/forbidden-image", "/interactive-forbidden" -> "403 Forbidden"
              "/interactive-next" -> if (fresh) "200 OK" else "403 Forbidden"
              "/status/401" -> "401 Unauthorized"
              "/status/404" -> "404 Not Found"
              "/status/429" -> "429 Too Many Requests"
              "/status/500" -> "500 Internal Server Error"
              "/status/503" -> "503 Service Unavailable"
              else -> "200 OK"
            }
            val content = when (route) {
              "/forbidden" -> "Access denied"
              "/interactive-forbidden" -> """
                <main>
                  <p id='manual-status'>HTTP 403 verification page</p>
                  <button id='manual-check' type='button'>Verify</button>
                  <span id='manual-result'>waiting</span>
                  <a id='manual-next' href='/interactive-next'>Continue</a>
                </main>
                <script>
                  window.noreaManualHttpErrorLoaded = true;
                  document.getElementById('manual-check').addEventListener('click', function () {
                    document.getElementById('manual-result').textContent = 'clicked';
                  });
                </script>
              """.trimIndent()
              "/interactive-next" -> """
                <p id='manual-next-status'>${if (fresh) "Recovered same URL" else "Blocked next page"}</p>
                <a id='manual-next' href='/interactive-recovered'>Continue</a>
              """.trimIndent()
              "/interactive-recovered" -> "<p id='manual-recovered'>Recovered page</p>"
              "/with-forbidden-image" -> "<div id='chapter-content'>Chapter content</div><img src='/forbidden-image'>"
              "/with-missing-image" -> "<div id='chapter-content'>Chapter content</div><img src='/status/404'>"
              else -> "${if (fresh) "fresh" else "blocked"}-$path"
            }
            val body = "<!doctype html><html><head><link rel='icon' href='data:,'></head><body>$content</body></html>"
              .toByteArray(Charsets.UTF_8)
            val response = buildString {
              append("HTTP/1.1 $status\r\n")
              append("Date: ${DateTimeFormatter.RFC_1123_DATE_TIME.format(ZonedDateTime.now(java.time.ZoneOffset.UTC))}\r\n")
              append("Content-Type: text/html; charset=utf-8\r\n")
              append("Cache-Control: public, max-age=3600\r\n")
              append("Content-Length: ${body.size}\r\nConnection: close\r\n\r\n")
            }
            socket.getOutputStream().apply { write(response.toByteArray(Charsets.UTF_8)); write(body); flush() }
          }
        } catch (error: SocketException) {
          if (!server.isClosed) throw error
        }
      }
    }, "NoreaVpnSessionFixture").apply { isDaemon = true; start() }

    override fun close() {
      server.close()
      thread.join(5_000)
    }
  }

  private inner class Browser(private val origin: String, namespace: String?) : Closeable {
    val sourceId = "vpn-session-qa-${UUID.randomUUID()}"
    private val output = LinkedBlockingQueue<Pair<String, String>>()
    private lateinit var activityScenario: ActivityScenario<MainActivity>
    private lateinit var host: WebView
    private lateinit var surface: FrameLayout
    private lateinit var bridge: AndroidScraperBridge
    private lateinit var cookies: CookieManager

    init {
      check(context.packageName == "io.github.tinywind.norea.debug") {
        "VPN session device checks require the isolated debug application."
      }
      val options = ActivityOptions.makeBasic().apply { launchDisplayId = 0 }.toBundle()
      activityScenario = ActivityScenario.launch(
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        options,
      )
      activityScenario.onActivity { activity ->
        assertTrue(WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE))
        assertTrue(WebViewFeature.isFeatureSupported(WebViewFeature.GET_COOKIE_INFO))
        cookies = ProfileStore.getInstance().getOrCreateProfile(androidScraperProfileName(sourceId, namespace)).cookieManager
        surface = FrameLayout(activity)
        host = WebView(activity)
        surface.addView(host, FrameLayout.LayoutParams(480, 800))
        activity.findViewById<ViewGroup>(android.R.id.content)
          .addView(surface, FrameLayout.LayoutParams(480, 800))
        surface.measure(
          android.view.View.MeasureSpec.makeMeasureSpec(480, android.view.View.MeasureSpec.EXACTLY),
          android.view.View.MeasureSpec.makeMeasureSpec(800, android.view.View.MeasureSpec.EXACTLY),
        )
        surface.layout(0, 0, 480, 800)
        bridge = AndroidScraperBridge(
          host, BridgeSession(), output = { id, envelope -> output.put(id to envelope) },
          profileNamespace = namespace, surfaceContainer = surface, appUrl = "https://tauri.localhost",
        )
        bridge.resumeBackgroundWorkWebViews()
      }
    }

    private fun command(
      method: String,
      value: JSONObject = JSONObject(),
      expectedSuccess: Boolean? = true,
    ): JSONObject {
      val id = UUID.randomUUID().toString()
      value.put("id", id).put("sourceId", sourceId).put("queue", "pool:0")
        .put("timeoutMs", value.optLong("timeoutMs", 20_000))
      when (method) {
        "fetch" -> bridge.fetch(value.toString())
        "extract" -> bridge.extract(value.toString())
        "navigate" -> bridge.navigate(value.toString())
        "resetVpnSession" -> bridge.resetVpnSession(value.toString())
        else -> error("Unsupported fixture command")
      }
      val response = checkNotNull(output.poll(30, TimeUnit.SECONDS)) { "No $method response from scraper" }
      assertEquals("Unexpected scraper response", id, response.first)
      val json = JSONObject(response.second)
      expectedSuccess?.let { assertEquals(json.toString(), it, json.getBoolean("ok")) }
      return json
    }

    fun read(path: String, extract: Boolean): String {
      val payload = JSONObject().put("url", origin + path)
      return if (extract) {
        payload.put("chapterNavigationScript", "function () { return false; }")
        payload.put("beforeScript", """
          function capture() {
            window.ReactNativeWebView.postMessage(document.body.innerText);
          }
          if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', capture, {once:true});
          else capture();
        """.trimIndent())
        command("extract", payload).getString("result")
      } else {
        val encoded = command("fetch", payload).getJSONObject("result").getString("bodyBase64")
        String(Base64.decode(encoded, Base64.DEFAULT), Charsets.UTF_8)
      }
    }

    fun extractChapter(path: String): JSONObject = command(
      "extract",
      JSONObject().put("url", origin + path).put("timeoutMs", 12_000)
        .put("chapterNavigationScript", "function () { return false; }")
        .put("beforeScript", """
          function capture() {
            const content = document.querySelector('#chapter-content');
            if (content) window.ReactNativeWebView.postMessage(content.textContent);
          }
          if (document.readyState === 'complete') capture();
          else window.addEventListener('load', capture, {once:true});
        """.trimIndent()),
      expectedSuccess = null,
    )

    fun openSite(path: String, forceNavigation: Boolean = false) {
      assertTrue(command("navigate", JSONObject().put("url", origin + path)
        .put("forceNavigation", forceNavigation)).getBoolean("result"))
    }

    fun showRetainedPage(path: String) = openSite(path)

    fun sourceIsVisible(): Boolean {
      val view = sourceView()
      var visible = false
      instrumentation.runOnMainSync {
        val bounds = Rect()
        visible = view.visibility == View.VISIBLE && view.alpha > 0f && view.isClickable &&
          view.isShown && view.getGlobalVisibleRect(bounds) && bounds.width() > 1 && bounds.height() > 1
      }
      return visible
    }

    fun assertLatePageFinishedKeepsHttpErrorUnusable(path: String, phase: String) {
      val view = sourceView()
      instrumentation.runOnMainSync {
        assertTrue(WebViewFeature.isFeatureSupported(WebViewFeature.GET_WEB_VIEW_CLIENT))
        // Inspect the existing state without adding a production-only test API.
        val states = AndroidScraperBridge::class.java.getDeclaredField("queues")
          .apply { isAccessible = true }.get(bridge) as Map<*, *>
        val state = states.values.filterIsInstance<AndroidScraperState>().single { it.webView === view }
        val client = WebViewCompat.getWebViewClient(view)
        val contextBefore = state.contextReady
        val failureBefore = runCatching {
          client.javaClass.getDeclaredField("mainFrameFailed").apply { isAccessible = true }.getBoolean(client)
        }.getOrNull()
        client.onPageFinished(view, origin + path)
        assertFalse(
          "A late page-finished callback made the HTTP error a reusable context " +
            "(phase=$phase, contextBefore=$contextBefore, failureBefore=$failureBefore)",
          state.contextReady,
        )
        assertEquals(origin + path, state.pendingChallengeUrl)
        val session = AndroidScraperBridge::class.java.getDeclaredField("vpnSession")
          .apply { isAccessible = true }.get(bridge) as AndroidScraperVpnSession
        assertTrue("Displaying an HTTP error must not mark the URL VPN-fresh",
          session.needsFreshResponse(sourceId, origin + path))
      }
    }

    fun assertSuccessfulPageDoesNotRefreshFailedTarget(failedPath: String, successfulPath: String) {
      val view = sourceView()
      instrumentation.runOnMainSync {
        WebViewCompat.getWebViewClient(view).onPageFinished(view, origin + successfulPath)
        val states = AndroidScraperBridge::class.java.getDeclaredField("queues")
          .apply { isAccessible = true }.get(bridge) as Map<*, *>
        val state = states.values.filterIsInstance<AndroidScraperState>().single { it.webView === view }
        assertTrue("A later successful page must become a usable context", state.contextReady)
        assertEquals(origin + successfulPath, state.currentUrl)
        val session = AndroidScraperBridge::class.java.getDeclaredField("vpnSession")
          .apply { isAccessible = true }.get(bridge) as AndroidScraperVpnSession
        assertTrue("A later page must not mark the earlier HTTP error URL VPN-fresh",
          session.needsFreshResponse(sourceId, origin + failedPath))
      }
    }

    fun assertNavigationSucceeded(path: String) {
      val view = sourceView()
      instrumentation.runOnMainSync {
        val states = AndroidScraperBridge::class.java.getDeclaredField("queues")
          .apply { isAccessible = true }.get(bridge) as Map<*, *>
        val state = states.values.filterIsInstance<AndroidScraperState>().single { it.webView === view }
        assertTrue("A successful explicit navigation must become a usable context", state.contextReady)
        assertEquals(origin + path, state.currentUrl)
        assertEquals("A successful explicit navigation must clear the old challenge", null, state.pendingChallengeUrl)
        val session = AndroidScraperBridge::class.java.getDeclaredField("vpnSession")
          .apply { isAccessible = true }.get(bridge) as AndroidScraperVpnSession
        assertFalse("A successful explicit navigation must record its fresh response",
          session.needsFreshResponse(sourceId, origin + path))
      }
    }

    fun hideRetainedPage() {
      instrumentation.runOnMainSync { bridge.releaseWorkerBrowser() }
    }

    fun reset() {
      assertTrue(command("resetVpnSession").getBoolean("result"))
    }

    private fun sourceViewOrNull(): WebView? {
      var view: WebView? = null
      instrumentation.runOnMainSync {
        view = (0 until surface.childCount).map { surface.getChildAt(it) }
          .filterIsInstance<WebView>().singleOrNull { it !== host }
      }
      return view
    }

    fun sourceView(): WebView = checkNotNull(sourceViewOrNull())

    fun evaluate(script: String): String? {
      val done = CountDownLatch(1)
      var result: String? = null
      val view = sourceView()
      instrumentation.runOnMainSync { view.evaluateJavascript(script) { result = it; done.countDown() } }
      assertTrue("The source WebView did not finish the check", done.await(10, TimeUnit.SECONDS))
      return result
    }

    fun cookieNames(): Set<String> {
      var names = emptySet<String>()
      instrumentation.runOnMainSync {
        names = CookieManagerCompat.getCookieInfo(cookies, origin + "/")
          .map { it.substringBefore("=").trim() }.toSet()
      }
      return names
    }

    fun seedCookies() {
      setCookies(listOf(
        "login_session=qa-login; Path=/; HttpOnly; SameSite=Lax",
        "cf_clearance=qa-old-route; Path=/; HttpOnly; SameSite=Lax",
      ))
    }

    private fun setCookies(headers: List<String>) {
      val done = CountDownLatch(headers.size)
      instrumentation.runOnMainSync {
        headers.forEach { header -> cookies.setCookie(origin + "/", header) { done.countDown() } }
      }
      assertTrue("Cookie callbacks did not complete", done.await(10, TimeUnit.SECONDS))
      instrumentation.runOnMainSync { cookies.flush() }
    }

    override fun close() {
      try {
        if (sourceViewOrNull() != null) {
          evaluate("localStorage.removeItem('norea-vpn-session-qa'); sessionStorage.removeItem('norea-vpn-session-qa')")
        }
      } finally {
        try {
          setCookies(listOf("login_session=; Path=/; Max-Age=0", "cf_clearance=; Path=/; Max-Age=0"))
        } finally {
          instrumentation.runOnMainSync {
            bridge.destroy()
            (host.parent as? ViewGroup)?.removeView(host)
            host.destroy()
            (surface.parent as? ViewGroup)?.removeView(surface)
          }
          // AndroidX's finish invoker launches an auxiliary activity in the test package.
          // Finish our display-0 activity first so close only releases the lifecycle observer.
          activityScenario.onActivity { it.finish() }
          val finishDeadline = SystemClock.uptimeMillis() + 10_000
          instrumentation.waitForIdleSync()
          while (activityScenario.state != Lifecycle.State.DESTROYED &&
            SystemClock.uptimeMillis() < finishDeadline) {
            Thread.sleep(10)
            instrumentation.waitForIdleSync()
          }
          assertEquals(
            "The owned fixture activity did not finish on display 0",
            Lifecycle.State.DESTROYED,
            activityScenario.state,
          )
          activityScenario.close()
        }
      }
    }
  }

  private fun verifyRouteChange(extract: Boolean, namespace: String?) {
    Fixture().use { fixture ->
      Browser(fixture.origin, namespace).use { browser ->
        browser.seedCookies()
        assertTrue(browser.read("/first", extract).contains("blocked-/first"))
        if (namespace != null) {
          assertFalse("The worker sent its previous route's clearance cookie", fixture.requests.single().cookies.contains("cf_clearance="))
          assertTrue(fixture.requests.single().cookies.contains("login_session=qa-login"))
        }
        assertTrue(browser.read("/second", extract).contains("blocked-/second"))
        assertTrue(browser.read("/first", extract).contains("blocked-/first"))
        assertEquals("The fixture must seed and reuse two HTTP cache entries: ${fixture.requests.map { it.path to it.cacheControl }}", 2, fixture.requests.size)
        browser.seedCookies()
        val before = browser.sourceView()
        browser.evaluate("""
          localStorage.setItem('norea-vpn-session-qa', 'retained');
          sessionStorage.setItem('norea-vpn-session-qa', 'retained');
          window.__noreaOldChallenge = true;
        """.trimIndent())
        assertTrue(browser.cookieNames().containsAll(setOf("login_session", "cf_clearance")))
        fixture.fresh = true
        browser.reset()
        assertSame("VPN reset must preserve the tab's session storage", before, browser.sourceView())
        assertEquals("false", browser.evaluate("Boolean(window.__noreaOldChallenge)"))
        assertTrue(browser.read("/first", extract).contains("fresh-/first"))
        assertTrue(browser.read("/second", extract).contains("fresh-/second"))
        assertTrue(browser.read("/first", extract).contains("fresh-/first"))
        assertEquals("Two requested URLs refresh once; revisiting uses their updated cache", 4, fixture.requests.size)
        assertEquals(listOf("/first", "/second", "/first", "/second"), fixture.requests.map { it.path })
        fixture.requests.drop(2).forEach { request ->
          assertTrue("Login cookie was lost after route reset", request.cookies.contains("login_session=qa-login"))
          assertFalse("Old route clearance survived the callback gate", request.cookies.contains("cf_clearance="))
        }
        assertEquals(setOf("login_session"), browser.cookieNames())
        assertEquals(
          "\"retained|retained\"",
          browser.evaluate("localStorage.getItem('norea-vpn-session-qa') + '|' + sessionStorage.getItem('norea-vpn-session-qa')"),
        )
      }
    }
  }

  private fun verifyFirstBrowserHttpError(namespace: String?) {
    Fixture().use { fixture ->
      Browser(fixture.origin, namespace).use { browser ->
        browser.seedCookies()
        browser.reset()
        assertTrue("Setup must not request a source document", fixture.requests.isEmpty())
        val forbiddenPath = "/interactive-forbidden?access=qa-private-value"

        // No fetch/extraction precedes this first explicit browser navigation.
        browser.openSite(forbiddenPath)
        val view = browser.sourceView()
        val loaded = """
          document.readyState === 'complete' &&
          window.noreaManualHttpErrorLoaded === true &&
          document.getElementById('manual-status')?.textContent === 'HTTP 403 verification page'
        """.trimIndent()
        val deadline = SystemClock.elapsedRealtime() + 10_000
        while (SystemClock.elapsedRealtime() < deadline) {
          if (browser.evaluate(loaded) == "true" && browser.sourceIsVisible()) break
          Thread.sleep(20)
        }
        assertEquals("The HTTP 403 response body and its script must load", "true", browser.evaluate(loaded))
        assertTrue("The first HTTP 403 document must be visible and clickable", browser.sourceIsVisible())
        assertEquals(
          "\"clicked\"",
          browser.evaluate(
            "document.getElementById('manual-check').click(); document.getElementById('manual-result').textContent",
          ),
        )
        assertEquals("Opening the HTTP error must not retry it", listOf(forbiddenPath), fixture.requests.map { it.path })
        assertTrue("The login cookie must reach the first request",
          fixture.requests.single().cookies.contains("login_session=qa-login"))
        assertTrue("The HTTP error must preserve the login cookie", browser.cookieNames().contains("login_session"))
        browser.assertLatePageFinishedKeepsHttpErrorUnusable(forbiddenPath, "first open")

        browser.showRetainedPage(forbiddenPath)
        assertSame("Reopening the retained response must keep its WebView", view, browser.sourceView())
        assertTrue(browser.sourceIsVisible())
        assertEquals("\"clicked\"", browser.evaluate("document.getElementById('manual-result').textContent"))
        assertEquals("Retained-page opening must not send another request",
          listOf(forbiddenPath), fixture.requests.map { it.path })
        assertTrue(browser.cookieNames().contains("login_session"))
        browser.assertLatePageFinishedKeepsHttpErrorUnusable(forbiddenPath, "retained open")

        // The next page can also fail before its page-start callback. The
        // previous document's failed flag must not suppress this new response.
        val blockedNextPath = "/interactive-next"
        browser.evaluate("document.getElementById('manual-next').click()")
        val blockedNext = """
          document.readyState === 'complete' &&
          document.getElementById('manual-next-status')?.textContent === 'Blocked next page'
        """.trimIndent()
        val blockedNextDeadline = SystemClock.elapsedRealtime() + 10_000
        while (SystemClock.elapsedRealtime() < blockedNextDeadline) {
          if (browser.evaluate(blockedNext) == "true" && browser.sourceIsVisible()) break
          Thread.sleep(20)
        }
        assertEquals("The next HTTP error document must load", "true", browser.evaluate(blockedNext))
        assertTrue(browser.sourceIsVisible())
        assertSame(view, browser.sourceView())
        assertEquals(listOf(forbiddenPath, blockedNextPath), fixture.requests.map { it.path })
        browser.assertLatePageFinishedKeepsHttpErrorUnusable(blockedNextPath, "next HTTP error")

        // A real same-URL reload is a new navigation, unlike retained-page open.
        fixture.fresh = true
        browser.evaluate("window.location.reload()")
        val sameUrlRecovered = """
          document.readyState === 'complete' &&
          document.getElementById('manual-next-status')?.textContent === 'Recovered same URL'
        """.trimIndent()
        val sameUrlDeadline = SystemClock.elapsedRealtime() + 10_000
        while (SystemClock.elapsedRealtime() < sameUrlDeadline) {
          if (browser.evaluate(sameUrlRecovered) == "true" && browser.sourceIsVisible()) break
          Thread.sleep(20)
        }
        assertEquals("A successful same-URL reload must recover", "true", browser.evaluate(sameUrlRecovered))
        assertTrue(browser.sourceIsVisible())
        assertSame(view, browser.sourceView())
        assertEquals("Only the explicit reload may repeat the URL",
          listOf(forbiddenPath, blockedNextPath, blockedNextPath), fixture.requests.map { it.path })
        browser.assertSuccessfulPageDoesNotRefreshFailedTarget(forbiddenPath, blockedNextPath)

        // A normal in-page link must settle its own document without consuming
        // the failed attempt's VPN-fresh bookkeeping.
        val successfulPath = "/interactive-recovered"
        browser.evaluate("document.getElementById('manual-next').click()")
        val recovered = """
          document.readyState === 'complete' &&
          document.getElementById('manual-recovered')?.textContent === 'Recovered page'
        """.trimIndent()
        val recoveryDeadline = SystemClock.elapsedRealtime() + 10_000
        while (SystemClock.elapsedRealtime() < recoveryDeadline) {
          if (browser.evaluate(recovered) == "true" && browser.sourceIsVisible()) break
          Thread.sleep(20)
        }
        assertEquals("The in-page navigation must display the successful document", "true", browser.evaluate(recovered))
        assertSame("In-page navigation must keep the source WebView", view, browser.sourceView())
        assertTrue(browser.sourceIsVisible())
        assertEquals("Only explicit clicks and the explicit reload may add requests",
          listOf(forbiddenPath, blockedNextPath, blockedNextPath, successfulPath), fixture.requests.map { it.path })
        fixture.requests.forEach { request ->
          assertTrue("In-page navigation must retain the login cookie", request.cookies.contains("login_session=qa-login"))
        }
        browser.assertSuccessfulPageDoesNotRefreshFailedTarget(forbiddenPath, successfulPath)
      }
    }
  }

  @Test
  fun firstBrowser403ShowsUsableDocumentWithoutRetryAndKeepsLoginSession() =
    verifyFirstBrowserHttpError(namespace = null)

  @Test
  fun firstWorkerBrowser403ShowsUsableDocumentWithoutRetryAndKeepsLoginSession() =
    verifyFirstBrowserHttpError(namespace = "vpn-worker-qa-${UUID.randomUUID()}")

  private fun verifyExplicitAddressSubmission(namespace: String?) {
    Fixture().use { fixture ->
      Browser(fixture.origin, namespace).use { browser ->
        browser.seedCookies()
        browser.reset()
        val path = "/interactive-next"
        browser.openSite(path)
        val view = browser.sourceView()
        val blocked = """
          document.readyState === 'complete' &&
          document.getElementById('manual-next-status')?.textContent === 'Blocked next page'
        """.trimIndent()
        val deadline = SystemClock.elapsedRealtime() + 10_000
        while (SystemClock.elapsedRealtime() < deadline && browser.evaluate(blocked) != "true") {
          Thread.sleep(20)
        }
        assertEquals("The original HTTP error must load", "true", browser.evaluate(blocked))
        browser.evaluate("sessionStorage.setItem('explicit-navigation-session', 'retained')")
        browser.showRetainedPage(path)
        assertSame(view, browser.sourceView())
        assertEquals("The first handoff must retain the challenge without another request",
          listOf(path), fixture.requests.map { it.path })

        fixture.fresh = true
        browser.openSite(path, forceNavigation = true)
        assertSame("Explicit navigation must preserve the source WebView", view, browser.sourceView())
        assertEquals("\"Recovered same URL\"", browser.evaluate("document.getElementById('manual-next-status')?.textContent"))
        assertEquals("\"retained\"", browser.evaluate("sessionStorage.getItem('explicit-navigation-session')"))
        assertEquals("Explicit same-address submission must send exactly one new request",
          listOf(path, path), fixture.requests.map { it.path })
        assertTrue("Explicit navigation must preserve the VPN freshness policy",
          fixture.requests.last().cacheControl.contains("no-cache"))
        fixture.requests.forEach { request ->
          assertTrue("Explicit navigation must retain the login cookie", request.cookies.contains("login_session=qa-login"))
        }
        assertTrue(browser.cookieNames().contains("login_session"))
        browser.assertNavigationSucceeded(path)
      }
    }
  }

  @Test
  fun explicitAddressSubmissionReloadsRetained403AndKeepsLoginSession() =
    verifyExplicitAddressSubmission(namespace = null)

  @Test
  fun workerExplicitAddressSubmissionReloadsRetained403AndKeepsLoginSession() =
    verifyExplicitAddressSubmission(namespace = "vpn-worker-qa-${UUID.randomUUID()}")

  private fun verifyMainFrameHttpError(namespace: String?) {
    Fixture().use { fixture ->
      Browser(fixture.origin, namespace).use { browser ->
        browser.seedCookies()
        assertTrue(browser.read("/initial", extract = true).contains("blocked-/initial"))
        val before = browser.sourceView()
        val started = SystemClock.elapsedRealtime()
        val forbiddenPath = "/forbidden?access=qa-private-value"
        val result = browser.extractChapter(forbiddenPath)
        val elapsed = SystemClock.elapsedRealtime() - started
        assertFalse(result.toString(), result.getBoolean("ok"))
        val error = result.getString("error")
        assertTrue(error, error.contains("HTTP 403"))
        assertTrue(error, error.contains(fixture.origin))
        assertFalse("HTTP error leaked URL query data", error.contains("qa-private-value"))
        assertTrue("HTTP errors must settle before the extraction timeout: ${elapsed}ms", elapsed < 10_000)
        assertSame("HTTP errors must keep the session WebView", before, browser.sourceView())
        assertTrue(browser.cookieNames().contains("login_session"))
        browser.showRetainedPage(forbiddenPath)
        assertSame("Manual inspection must reuse the blocked page", before, browser.sourceView())
        assertEquals("Manual inspection must not retry the blocked URL", listOf("/initial", forbiddenPath), fixture.requests.map { it.path })
        browser.hideRetainedPage()
        assertTrue(browser.read("/recovered", extract = true).contains("blocked-/recovered"))
        assertEquals(listOf("/initial", forbiddenPath, "/recovered"), fixture.requests.map { it.path })
        fixture.requests.forEach { request ->
          assertTrue("Login cookie was lost after an HTTP error", request.cookies.contains("login_session=qa-login"))
        }
      }
    }
  }

  private fun verifyMainFrameHttpStatuses(namespace: String?) {
    Fixture().use { fixture ->
      Browser(fixture.origin, namespace).use { browser ->
        browser.seedCookies()
        assertTrue(browser.read("/initial", extract = true).contains("blocked-/initial"))
        val before = browser.sourceView()
        val requestedPaths = mutableListOf("/initial")
        for (status in listOf(401, 404, 429, 500, 503)) {
          val path = "/status/$status?access=qa-private-$status"
          val started = SystemClock.elapsedRealtime()
          val result = browser.extractChapter(path)
          val elapsed = SystemClock.elapsedRealtime() - started
          assertFalse(result.toString(), result.getBoolean("ok"))
          val error = result.getString("error")
          assertTrue(error, error.contains("HTTP $status"))
          assertFalse("HTTP error leaked URL query data", error.contains("qa-private-$status"))
          assertTrue("HTTP $status must settle before the extraction timeout: ${elapsed}ms", elapsed < 10_000)
          assertSame("HTTP $status must keep the session WebView", before, browser.sourceView())
          assertTrue("HTTP $status removed the login cookie", browser.cookieNames().contains("login_session"))
          browser.showRetainedPage(path)
          assertSame("Manual inspection must reuse the HTTP $status page", before, browser.sourceView())
          requestedPaths.add(path)
          assertEquals("HTTP $status must not repeat or implicitly retry a request", requestedPaths, fixture.requests.map { it.path })
          browser.hideRetainedPage()
        }
        val chapter = browser.extractChapter("/with-missing-image")
        assertTrue(chapter.toString(), chapter.getBoolean("ok"))
        assertEquals("Chapter content", chapter.getString("result"))
        requestedPaths.addAll(listOf("/with-missing-image", "/status/404"))
        assertEquals("A subresource 404 must not retry the chapter", requestedPaths, fixture.requests.map { it.path })
        assertTrue(browser.read("/recovered", extract = true).contains("blocked-/recovered"))
        requestedPaths.add("/recovered")
        assertEquals(requestedPaths, fixture.requests.map { it.path })
        fixture.requests.forEach { request ->
          assertTrue("Login cookie was lost after an HTTP error", request.cookies.contains("login_session=qa-login"))
        }
        assertSame("HTTP status failures must preserve the source session", before, browser.sourceView())
      }
    }
  }

  @Test
  fun mainFrameHttpErrorsFailExtractionImmediatelyAndKeepLoginSession() =
    verifyMainFrameHttpStatuses(namespace = null)

  @Test
  fun workerMainFrameHttpErrorsFailExtractionImmediatelyAndKeepLoginSession() =
    verifyMainFrameHttpStatuses(namespace = "vpn-worker-qa-${UUID.randomUUID()}")

  @Test
  fun mainFrame403FailsExtractionImmediatelyAndKeepsLoginSession() =
    verifyMainFrameHttpError(namespace = null)

  @Test
  fun workerMainFrame403FailsExtractionImmediatelyAndKeepsLoginSession() =
    verifyMainFrameHttpError(namespace = "vpn-worker-qa-${UUID.randomUUID()}")

  @Test
  fun subresource403DoesNotFailSuccessfulChapterExtraction() {
    Fixture().use { fixture ->
      Browser(fixture.origin, "vpn-worker-qa-${UUID.randomUUID()}").use { browser ->
        val result = browser.extractChapter("/with-forbidden-image")
        assertTrue(result.toString(), result.getBoolean("ok"))
        assertEquals("Chapter content", result.getString("result"))
        assertEquals(listOf("/with-forbidden-image", "/forbidden-image"), fixture.requests.map { it.path })
      }
    }
  }

  @Test
  fun routeChangeRefreshesCachedFetchesAndKeepsLoginAndSourceStorage() =
    verifyRouteChange(extract = false, namespace = null)

  @Test
  fun workerRouteChangeRefreshesCachedPagesAndKeepsLoginAndSourceStorage() =
    verifyRouteChange(extract = true, namespace = "vpn-worker-qa-${UUID.randomUUID()}")
}
