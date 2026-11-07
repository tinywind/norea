package io.github.tinywind.norea

import android.content.Context
import android.os.SystemClock
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject

/** Uses the debug application's real local proxy registry; it never creates a VPN tunnel. */
internal object AndroidSiteBrowserDeviceFixture {
  fun foregroundPort(): Int {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val deadline = SystemClock.uptimeMillis() + 30_000
    while (SystemClock.uptimeMillis() < deadline) {
      var port: Int? = null
      instrumentation.runOnMainSync {
        val type = AndroidSiteBrowserOwner::class.java
        val ready = type.getDeclaredField("foregroundReady").apply { isAccessible = true }.getBoolean(AndroidSiteBrowserOwner)
        val changing = type.getDeclaredField("transitioning").apply { isAccessible = true }.getBoolean(AndroidSiteBrowserOwner)
        if (ready && !changing) {
          val route = AndroidSiteBrowserOwner::class.java.getDeclaredField("foreground")
            .apply { isAccessible = true }.get(AndroidSiteBrowserOwner)
          if (route != null) port = route.javaClass.getDeclaredField("port").apply { isAccessible = true }.getInt(route)
        }
      }
      port?.let { return it }
      Thread.sleep(20)
    }
    error("The debug application's foreground browser proxy did not become ready")
  }

  fun configure(context: Context, port: Int, hash: String? = null) {
    check(context.packageName == "io.github.tinywind.norea.debug")
    AndroidSiteBrowserOwner.configureForeground(context, JSONObject()
      .put("port", port).put("profileHash", hash ?: JSONObject.NULL)
      .put("rotateFingerprintOnVpnChange", false))
    prepareForeground()
  }

  fun prepareForeground() {
    val complete = CountDownLatch(1)
    var failure: Throwable? = null
    InstrumentationRegistry.getInstrumentation().runOnMainSync {
      AndroidSiteBrowserOwner.prepareCommand(SITE_BROWSER_FOREGROUND_OWNER) { result ->
        failure = result.exceptionOrNull()
        complete.countDown()
      }
    }
    check(complete.await(35, TimeUnit.SECONDS)) { "The foreground route preparation timed out" }
    failure?.let { throw it }
  }
}
