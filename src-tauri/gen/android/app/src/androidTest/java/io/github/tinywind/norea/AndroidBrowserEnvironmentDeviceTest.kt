package io.github.tinywind.norea

import android.app.ActivityOptions
import android.content.Intent
import android.os.SystemClock
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebSettingsCompat
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidBrowserEnvironmentDeviceTest {
  private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
  private val context get() = instrumentation.targetContext

  private fun onMain(action: () -> Unit) = instrumentation.runOnMainSync(action)

  private fun snapshot(view: WebView): JSONObject {
    val loaded = CountDownLatch(1)
    onMain {
      view.webViewClient = object : WebViewClient() {
        override fun onPageFinished(view: WebView, url: String) { loaded.countDown() }
      }
      view.loadDataWithBaseURL("https://norea-environment.test/", """
        <!doctype html><html><head><script>
        const canvas = document.createElement('canvas');
        canvas.width = 128; canvas.height = 64;
        const context = canvas.getContext('2d');
        context.fillStyle = '#234567'; context.fillRect(0, 0, 128, 64);
        context.font = '16px sans-serif'; context.fillText('Norea environment', 4, 24);
        window.initialEnvironment = {
          ua: navigator.userAgent,
          platform: navigator.platform,
          cores: navigator.hardwareConcurrency,
          memory: navigator.deviceMemory,
          touch: navigator.maxTouchPoints,
          width: screen.width, height: screen.height,
          canvas: canvas.toDataURL(),
          repeat: canvas.toDataURL(),
          language: navigator.language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        };
        </script></head><body>Environment fixture</body></html>
      """.trimIndent(), "text/html", "UTF-8", null)
    }
    assertTrue("Environment fixture did not load", loaded.await(20, TimeUnit.SECONDS))
    val evaluated = CountDownLatch(1)
    var result: JSONObject? = null
    onMain {
      view.evaluateJavascript("JSON.stringify(window.initialEnvironment)") { value ->
        result = JSONObject(JSONTokener(value).nextValue() as String)
        evaluated.countDown()
      }
    }
    assertTrue("Environment snapshot did not complete", evaluated.await(10, TimeUnit.SECONDS))
    return checkNotNull(result)
  }

  @Test
  fun allViewsUseOnePersistedEnvironmentUntilARealRouteChange() {
    check(context.packageName == "io.github.tinywind.norea.debug") {
      "Browser environment checks require the isolated debug application."
    }
    assertTrue("The test requires document-start and UA metadata support", AndroidBrowserEnvironment.isSupported())
    val options = ActivityOptions.makeBasic().apply { launchDisplayId = 0 }.toBundle()
    ActivityScenario.launch<MainActivity>(
      Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), options,
    ).use { activity ->
      val views = mutableListOf<WebView>()
      var container: FrameLayout? = null
      fun create(userAgent: String): WebView {
        var result: WebView? = null
        activity.onActivity { host ->
          if (container == null) {
            container = FrameLayout(host)
            host.addContentView(container, FrameLayout.LayoutParams(480, 800))
          }
          result = WebView(host).also { view ->
            view.settings.javaScriptEnabled = true
            AndroidBrowserEnvironment.apply(view, userAgent)
            container!!.addView(view, FrameLayout.LayoutParams(480, 800))
            views.add(view)
          }
        }
        return checkNotNull(result)
      }
      try {
        AndroidBrowserEnvironment.configure(context, false, true)
        assertFalse(AndroidBrowserEnvironment.configure(context, true, false))
        assertTrue(AndroidBrowserEnvironment.configure(context, true, true, "a".repeat(64)))
        val novel = create("SourceSpecificNovel/1.0")
        val webtoon = create("SourceSpecificWebtoon/2.0")
        val first = snapshot(novel)
        val second = snapshot(webtoon)
        assertEquals(first.toString(), second.toString())
        assertEquals(first.getString("canvas"), first.getString("repeat"))
        onMain {
          val metadata = WebSettingsCompat.getUserAgentMetadata(novel.settings)
          assertTrue(first.getString("ua").contains(checkNotNull(metadata.model)))
          assertEquals("Android", metadata.platform)
          assertEquals(metadata, WebSettingsCompat.getUserAgentMetadata(webtoon.settings))
        }
        // The same profile reconnect and opening another view preserve identity.
        assertFalse(AndroidBrowserEnvironment.configure(context, true, false, "a".repeat(64)))
        assertFalse(AndroidBrowserEnvironment.configure(context, true, true, "a".repeat(64)))
        assertEquals(first.toString(), snapshot(create("AnotherSource/3.0")).toString())
        assertTrue(AndroidBrowserEnvironment.configure(context, true, true, "b".repeat(64)))
        val rotated = snapshot(create("IgnoredSource/4.0"))
        assertNotEquals(first.getString("canvas"), rotated.getString("canvas"))
        assertEquals(first.getString("language"), rotated.getString("language"))
        assertEquals(first.getString("timezone"), rotated.getString("timezone"))
        // Turning the option off does not mutate an active page mid-session.
        assertFalse(AndroidBrowserEnvironment.configure(context, false, false))
        assertTrue(AndroidBrowserEnvironment.configure(context, false, true))
        val restored = create("IgnoredSource/5.0")
        onMain {
          assertEquals(android.webkit.WebSettings.getDefaultUserAgent(context), restored.settings.userAgentString)
        }
      } finally {
        onMain {
          views.forEach { view -> container?.removeView(view); view.destroy() }
          (container?.parent as? android.view.ViewGroup)?.removeView(container)
        }
        AndroidBrowserEnvironment.configure(context, false, true)
        // Finish our display-0 activity before ActivityScenario releases its observer.
        // Its auxiliary test activity is unavailable on this standalone fixture APK.
        activity.onActivity { it.finish() }
        val finishDeadline = SystemClock.uptimeMillis() + 10_000
        instrumentation.waitForIdleSync()
        while (activity.state != Lifecycle.State.DESTROYED &&
          SystemClock.uptimeMillis() < finishDeadline) {
          Thread.sleep(10)
          instrumentation.waitForIdleSync()
        }
        assertEquals(Lifecycle.State.DESTROYED, activity.state)
      }
    }
  }
}
