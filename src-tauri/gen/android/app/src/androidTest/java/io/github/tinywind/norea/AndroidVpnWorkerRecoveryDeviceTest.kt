package io.github.tinywind.norea

import android.app.Application
import android.app.ActivityOptions
import android.content.Intent
import android.content.Context
import android.os.SystemClock
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import androidx.webkit.WebViewCompat
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidVpnWorkerRecoveryDeviceTest {
  private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
  private val context get() = instrumentation.targetContext
  private lateinit var host: WebView
  private lateinit var workers: AndroidVpnDownloadWorkers
  private lateinit var session: BridgeSession
  private var requestSequence = 0

  private fun evaluate(script: String): String {
    val finished = CountDownLatch(1)
    var result: String? = null
    instrumentation.runOnMainSync {
      host.evaluateJavascript(script) { result = it; finished.countDown() }
    }
    assertTrue("The owned worker host did not answer", finished.await(5, TimeUnit.SECONDS))
    return checkNotNull(result)
  }

  private fun request(method: String, arguments: JSONObject): JSONObject {
    val id = "worker-recovery-${++requestSequence}"
    val payload = JSONObject(arguments.toString())
      .put("id", id)
      .put("method", method)
      .put("_bridge", JSONObject()
        .put("sessionToken", session.sessionToken)
        .put("capability", BridgeCapabilities.VPN_WORKER)
        .put("nonce", session.newNonce()))
    workers.request(payload.toString())
    val deadline = SystemClock.uptimeMillis() + 45_000
    while (SystemClock.uptimeMillis() < deadline) {
      val value = evaluate("window.__workerRecoveryResults[${JSONObject.quote(id)}] || null")
      if (value != "null") return JSONObject(value)
      Thread.sleep(25)
    }
    error("The worker did not answer $method")
  }

  @Test
  fun sharesTheMainProcessAndProfileWhileRejectingStaleOrConcurrentWorkerRoutes() {
    check(context.packageName == "io.github.tinywind.norea.debug") {
      "Shared worker route checks require the isolated debug application."
    }
    var activity: MainActivity? = null
    try {
      val owner = instrumentation.startActivitySync(
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        ActivityOptions.makeBasic().apply { launchDisplayId = 0 }.toBundle(),
      ) as MainActivity
      activity = owner
      val loaded = CountDownLatch(1)
      instrumentation.runOnMainSync {
        session = BridgeSession()
        val hostUrl = "https://tauri.localhost/worker-recovery-fixture"
        val hostHtml = """<!doctype html><script>
          window.__workerRecoveryResults = Object.create(null);
          window.__noreaAndroidScraperResolve = function(id, envelope) {
            window.__workerRecoveryResults[id] = JSON.parse(envelope);
          };
        </script>""".trimIndent()
        host = WebView(owner).apply {
          settings.javaScriptEnabled = true
          webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
              if (request.url.toString() == hostUrl) {
                WebResourceResponse("text/html", "UTF-8", hostHtml.byteInputStream())
              } else super.shouldInterceptRequest(view, request)

            override fun onPageFinished(view: WebView, url: String) {
              if (url == hostUrl) loaded.countDown()
            }
          }
          loadUrl(hostUrl)
        }
        owner.addContentView(host, ViewGroup.LayoutParams(1, 1))
        workers = AndroidVpnDownloadWorkers(owner, host, session) { true }
      }
      assertTrue("The owned worker host did not load", loaded.await(15, TimeUnit.SECONDS))
      val proxyPort = AndroidSiteBrowserDeviceFixture.foregroundPort()
      AndroidSiteBrowserDeviceFixture.configure(context, proxyPort)
      run {
        val configuration = JSONObject()
          .put("slot", 0).put("generation", 1L)
          .put("sourceId", "worker-recovery-fixture")
          .put("profileId", "worker-recovery-proxy")
          .put("proxyPort", proxyPort).put("profileHash", "a".repeat(64))
          .put("rotateFingerprintOnVpnChange", true)
        val configured = request("configureWorker", configuration)
        assertTrue("Initial worker configuration failed: $configured", configured.getBoolean("ok"))
        assertTrue(configured.getJSONObject("result").getBoolean("configured"))
        val service = checkNotNull(AndroidVpnWorkerProcess.service)
        assertEquals("Site workers must run in the browser-owner process", context.packageName, Application.getProcessName())
        instrumentation.runOnMainSync {
          val scraper = AndroidVpnDownloadWorkerService::class.java.getDeclaredField("scraper")
            .apply { isAccessible = true }.get(service) as AndroidScraperBridge
          assertTrue(scraper.showWorkerBrowser("worker-recovery-fixture", allowNewBrowser = true))
          val states = AndroidScraperBridge::class.java.getDeclaredField("queues")
            .apply { isAccessible = true }.get(scraper) as Map<*, *>
          val view = states.values.filterIsInstance<AndroidScraperState>().single { it.webView != null }.webView!!
          assertEquals(sharedSiteBrowserProfileName(), WebViewCompat.getProfile(view).name)
          scraper.releaseWorkerBrowser()
        }
        val cookieOrigin = "https://worker-reconnect-fixture.invalid/"
        val cookieSet = CountDownLatch(1)
        instrumentation.runOnMainSync {
          AndroidSiteBrowserOwner.profile().cookieManager.setCookie(cookieOrigin, "worker_reconnect_qa=retained; Path=/; Secure") { cookieSet.countDown() }
        }
        assertTrue(cookieSet.await(10, TimeUnit.SECONDS))
        val environmentPreferences = context.getSharedPreferences("norea_shared_browser_environment", Context.MODE_PRIVATE)
        val originalEnvironment = environmentPreferences.getString("environment_v1", null)
        assertTrue("An enabled actual route change must create a browser environment", originalEnvironment != null)
        val healthy = request("ensureWorker", configuration)
        assertTrue(healthy.getBoolean("ok"))
        assertTrue("A ready worker must be reused", healthy.getBoolean("result"))
        assertSame(service, AndroidVpnWorkerProcess.service)

        val concurrent = JSONObject(configuration.toString()).put("slot", 1)
        assertFalse("A second browser route must not start", request("configureWorker", concurrent).getBoolean("ok"))
        assertSame(service, AndroidVpnWorkerProcess.service)

        val wrongSourceClose = request("closeWorker", JSONObject()
          .put("queue", "vpn:0:1").put("sourceId", "another-source"))
        assertFalse("A different source must not close the owned worker", wrongSourceClose.getBoolean("ok"))
        assertTrue("A rejected close must preserve recovery authority", request("ensureWorker", configuration).getBoolean("ok"))

        val staleRoutes = listOf(
          JSONObject(configuration.toString()).put("generation", 2L),
          JSONObject(configuration.toString()).put("sourceId", "another-source"),
          JSONObject(configuration.toString()).put("profileId", "another-profile"),
          JSONObject(configuration.toString()).put("profileHash", "b".repeat(64)),
          JSONObject(configuration.toString()).put("proxyPort", if (proxyPort == 65_535) 65_534 else proxyPort + 1),
        )
        for (stale in staleRoutes) {
          assertFalse("Recovery accepted a different route identity", request("ensureWorker", stale).getBoolean("ok"))
          assertSame("A rejected route must not replace the browser owner", service, AndroidVpnWorkerProcess.service)
        }
        val retained = request("ensureWorker", configuration)
        assertTrue(retained.getBoolean("ok"))
        assertTrue("Rejected identities must leave the owned worker ready", retained.getBoolean("result"))

        val replacement = JSONObject(configuration.toString()).put("generation", 2L)
        val reconfigured = request("configureWorker", replacement)
        assertTrue("The next explicit generation did not configure: $reconfigured", reconfigured.getBoolean("ok"))
        assertTrue(reconfigured.getJSONObject("result").getBoolean("configured"))
        assertFalse("An older generation must not recover over its replacement", request("ensureWorker", configuration).getBoolean("ok"))
        assertSame(service, AndroidVpnWorkerProcess.service)
        instrumentation.runOnMainSync {
          assertTrue("Same-profile worker reconnect must retain cookies",
            AndroidSiteBrowserOwner.profile().cookieManager.getCookie(cookieOrigin).orEmpty().contains("worker_reconnect_qa=retained"))
        }
        assertTrue("Same-profile reconnect must retain its environment",
          originalEnvironment == environmentPreferences.getString("environment_v1", null))

        val closed = request("closeWorker", JSONObject()
          .put("queue", "vpn:0:2").put("sourceId", "worker-recovery-fixture"))
        assertTrue("The recovered worker did not close: $closed", closed.getBoolean("ok"))
        assertFalse("A closed route must not be resurrected", request("ensureWorker", replacement).getBoolean("ok"))
        instrumentation.runOnMainSync {
          assertFalse("Worker release must leave the browser quiesced until a real foreground operation",
            AndroidSiteBrowserOwner.canLoad(SITE_BROWSER_FOREGROUND_OWNER))
          assertTrue(AndroidSiteBrowserOwner.profile().cookieManager.getCookie(cookieOrigin).orEmpty().contains("worker_reconnect_qa=retained"))
        }
        assertTrue(originalEnvironment == environmentPreferences.getString("environment_v1", null))
        // Re-reading an unchanged foreground status is not an actual browser visit.
        AndroidSiteBrowserOwner.configureForeground(context, JSONObject()
          .put("port", proxyPort).put("profileHash", JSONObject.NULL)
          .put("rotateFingerprintOnVpnChange", true))
        instrumentation.runOnMainSync {
          assertFalse(AndroidSiteBrowserOwner.canLoad(SITE_BROWSER_FOREGROUND_OWNER))
          assertTrue(AndroidSiteBrowserOwner.profile().cookieManager.getCookie(cookieOrigin).orEmpty().contains("worker_reconnect_qa=retained"))
        }
        AndroidSiteBrowserDeviceFixture.prepareForeground()
        instrumentation.runOnMainSync {
          assertTrue(AndroidSiteBrowserOwner.canLoad(SITE_BROWSER_FOREGROUND_OWNER))
          assertFalse("The actual foreground route transition must expire the previous route's cookies",
            AndroidSiteBrowserOwner.profile().cookieManager.getCookie(cookieOrigin).orEmpty().contains("worker_reconnect_qa="))
        }
        assertTrue("An actual foreground route change must rotate the enabled environment",
          originalEnvironment != environmentPreferences.getString("environment_v1", null))
      }
    } finally {
      instrumentation.runOnMainSync {
        if (this::workers.isInitialized) workers.destroy()
        if (this::host.isInitialized) {
          (host.parent as? ViewGroup)?.removeView(host)
          host.destroy()
        }
        activity?.finish()
      }
    }
  }
}
