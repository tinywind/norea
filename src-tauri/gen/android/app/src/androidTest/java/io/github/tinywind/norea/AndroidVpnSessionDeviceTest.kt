package io.github.tinywind.norea

import android.util.Base64
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.CookieManagerCompat
import androidx.webkit.ProfileStore
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
            val body = "<!doctype html><html><head><link rel='icon' href='data:,'></head><body>${if (fresh) "fresh" else "blocked"}-$path</body></html>"
              .toByteArray(Charsets.UTF_8)
            val response = buildString {
              append("HTTP/1.1 200 OK\r\n")
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
    private lateinit var host: WebView
    private lateinit var surface: FrameLayout
    private lateinit var bridge: AndroidScraperBridge
    private lateinit var cookies: CookieManager

    init {
      check(context.packageName == "io.github.tinywind.norea.debug") {
        "VPN session device checks require the isolated debug application."
      }
      instrumentation.runOnMainSync {
        assertTrue(WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE))
        assertTrue(WebViewFeature.isFeatureSupported(WebViewFeature.GET_COOKIE_INFO))
        cookies = ProfileStore.getInstance().getOrCreateProfile(androidScraperProfileName(sourceId, namespace)).cookieManager
        surface = FrameLayout(context)
        host = WebView(context)
        surface.addView(host, FrameLayout.LayoutParams(480, 800))
        surface.measure(
          android.view.View.MeasureSpec.makeMeasureSpec(480, android.view.View.MeasureSpec.EXACTLY),
          android.view.View.MeasureSpec.makeMeasureSpec(800, android.view.View.MeasureSpec.EXACTLY),
        )
        surface.layout(0, 0, 480, 800)
        bridge = AndroidScraperBridge(
          host, BridgeSession(), output = { id, envelope -> output.put(id to envelope) },
          profileNamespace = namespace, surfaceContainer = surface, appUrl = "https://tauri.localhost",
        )
      }
    }

    private fun command(method: String, value: JSONObject = JSONObject()): JSONObject {
      val id = UUID.randomUUID().toString()
      value.put("id", id).put("sourceId", sourceId).put("queue", "pool:0").put("timeoutMs", 20_000)
      when (method) {
        "fetch" -> bridge.fetch(value.toString())
        "extract" -> bridge.extract(value.toString())
        "resetVpnSession" -> bridge.resetVpnSession(value.toString())
        else -> error("Unsupported fixture command")
      }
      val response = checkNotNull(output.poll(30, TimeUnit.SECONDS)) { "No $method response from scraper" }
      assertEquals("Unexpected scraper response", id, response.first)
      val json = JSONObject(response.second)
      assertTrue(json.toString(), json.getBoolean("ok"))
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

    fun reset() {
      assertTrue(command("resetVpnSession").getBoolean("result"))
    }

    fun sourceView(): WebView {
      var view: WebView? = null
      instrumentation.runOnMainSync {
        view = (0 until surface.childCount).map { surface.getChildAt(it) }
          .filterIsInstance<WebView>().single { it !== host }
      }
      return checkNotNull(view)
    }

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
        evaluate("localStorage.removeItem('norea-vpn-session-qa'); sessionStorage.removeItem('norea-vpn-session-qa')")
      } finally {
        try {
          setCookies(listOf("login_session=; Path=/; Max-Age=0", "cf_clearance=; Path=/; Max-Age=0"))
        } finally {
          instrumentation.runOnMainSync {
            bridge.destroy()
            (host.parent as? ViewGroup)?.removeView(host)
            host.destroy()
          }
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

  @Test
  fun routeChangeRefreshesCachedFetchesAndKeepsLoginAndSourceStorage() =
    verifyRouteChange(extract = false, namespace = null)

  @Test
  fun workerRouteChangeRefreshesCachedPagesAndKeepsLoginAndSourceStorage() =
    verifyRouteChange(extract = true, namespace = "vpn-worker-qa-${UUID.randomUUID()}")
}
