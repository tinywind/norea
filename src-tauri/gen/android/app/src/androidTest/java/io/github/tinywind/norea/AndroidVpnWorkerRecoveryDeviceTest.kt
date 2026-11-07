package io.github.tinywind.norea

import android.app.ActivityManager
import android.app.ActivityOptions
import android.content.Intent
import android.os.Process
import android.os.SystemClock
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
    val deadline = SystemClock.uptimeMillis() + 25_000
    while (SystemClock.uptimeMillis() < deadline) {
      val value = evaluate("window.__workerRecoveryResults[${JSONObject.quote(id)}] || null")
      if (value != "null") return JSONObject(value)
      Thread.sleep(25)
    }
    error("The worker did not answer $method")
  }

  private fun workerProcess(): ActivityManager.RunningAppProcessInfo? =
    context.getSystemService(ActivityManager::class.java).runningAppProcesses.orEmpty()
      .singleOrNull { it.processName == "${context.packageName}:vpn_download_0" && it.uid == Process.myUid() }

  private fun awaitWorkerPid(previous: Int? = null): Int {
    val deadline = SystemClock.uptimeMillis() + 10_000
    while (SystemClock.uptimeMillis() < deadline) {
      workerProcess()?.pid?.takeIf { it != previous }?.let { return it }
      Thread.sleep(25)
    }
    error("The configured child worker process did not appear")
  }

  @Test
  fun recreatesOnlyTheOwnedBrowserAfterItsChildProcessDies() {
    check(context.packageName == "io.github.tinywind.norea.debug") {
      "Worker process recovery checks require the isolated debug application."
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
      ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { proxy ->
        val configuration = JSONObject()
          .put("slot", 0).put("generation", 1L)
          .put("sourceId", "worker-recovery-fixture")
          .put("profileId", "worker-recovery-proxy")
          .put("proxyPort", proxy.localPort)
        val configured = request("configureWorker", configuration)
        assertTrue("Initial worker configuration failed: $configured", configured.getBoolean("ok"))
        assertTrue(configured.getJSONObject("result").getBoolean("configured"))
        val originalPid = awaitWorkerPid()
        assertNotEquals("The child must not be the application process", Process.myPid(), originalPid)
        assertEquals(Process.myUid(), checkNotNull(workerProcess()).uid)

        val healthy = request("ensureWorker", configuration)
        assertTrue(healthy.getBoolean("ok"))
        assertTrue("A ready worker must be reused", healthy.getBoolean("result"))
        assertEquals(originalPid, awaitWorkerPid())

        val wrongSourceClose = request("closeWorker", JSONObject()
          .put("queue", "vpn:0:1").put("sourceId", "another-source"))
        assertFalse("A different source must not close the owned worker", wrongSourceClose.getBoolean("ok"))
        assertTrue("A rejected close must preserve recovery authority", request("ensureWorker", configuration).getBoolean("ok"))

        Process.killProcess(originalPid)
        val deathDeadline = SystemClock.uptimeMillis() + 10_000
        while (workerProcess()?.pid == originalPid && SystemClock.uptimeMillis() < deathDeadline) Thread.sleep(25)
        assertNotEquals("The exact child process did not die", originalPid, workerProcess()?.pid)
        instrumentation.waitForIdleSync()
        val recovered = request("ensureWorker", configuration)
        assertTrue("The remembered route was not recovered: $recovered", recovered.getBoolean("ok"))
        assertTrue("Recovery must finish browser configuration", recovered.getJSONObject("result").getBoolean("configured"))
        val recoveredPid = awaitWorkerPid(originalPid)
        assertNotEquals(originalPid, recoveredPid)

        val staleRoutes = listOf(
          JSONObject(configuration.toString()).put("generation", 2L),
          JSONObject(configuration.toString()).put("sourceId", "another-source"),
          JSONObject(configuration.toString()).put("profileId", "another-profile"),
          JSONObject(configuration.toString()).put("proxyPort", if (proxy.localPort == 65_535) 65_534 else proxy.localPort + 1),
        )
        for (stale in staleRoutes) {
          assertFalse("Recovery accepted a different route identity", request("ensureWorker", stale).getBoolean("ok"))
          assertEquals("A rejected route must not replace the live child", recoveredPid, awaitWorkerPid())
        }
        val retained = request("ensureWorker", configuration)
        assertTrue(retained.getBoolean("ok"))
        assertTrue("Rejected identities must leave the owned worker ready", retained.getBoolean("result"))

        val replacement = JSONObject(configuration.toString()).put("generation", 2L)
        val reconfigured = request("configureWorker", replacement)
        assertTrue("The next explicit generation did not configure: $reconfigured", reconfigured.getBoolean("ok"))
        assertTrue(reconfigured.getJSONObject("result").getBoolean("configured"))
        assertFalse("An older generation must not recover over its replacement", request("ensureWorker", configuration).getBoolean("ok"))
        assertEquals(recoveredPid, awaitWorkerPid())

        val closed = request("closeWorker", JSONObject()
          .put("queue", "vpn:0:2").put("sourceId", "worker-recovery-fixture"))
        assertTrue("The recovered worker did not close: $closed", closed.getBoolean("ok"))
        assertFalse("A closed route must not be resurrected", request("ensureWorker", replacement).getBoolean("ok"))
        assertTrue("A rejected recovery started another process", workerProcess()?.pid.let { it == null || it == recoveredPid })
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
