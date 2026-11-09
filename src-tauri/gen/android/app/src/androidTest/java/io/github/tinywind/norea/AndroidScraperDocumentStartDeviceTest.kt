package io.github.tinywind.norea

import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidScraperDocumentStartDeviceTest {
  private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
  private val context get() = instrumentation.targetContext

  private fun onMain(action: () -> Unit) = instrumentation.runOnMainSync(action)

  private fun loadTitle(view: WebView, origin: String): String {
    val loaded = CountDownLatch(1)
    var title: String? = null
    onMain {
      view.webViewClient = object : WebViewClient() {
        override fun onPageFinished(current: WebView, url: String) {
          current.evaluateJavascript("document.title") { value ->
            title = value.removeSurrounding("\"")
            loaded.countDown()
          }
        }
      }
      view.loadDataWithBaseURL(
        "$origin/path",
        "<!doctype html><title>loading</title><script>document.title = window.__noreaDocumentStartProof || 'missing';</script>",
        "text/html",
        "UTF-8",
        null,
      )
    }
    assertTrue("WebView document did not finish", loaded.await(20, TimeUnit.SECONDS))
    return checkNotNull(title)
  }

  @Test
  fun requestScriptsUseNativeOriginScopedDocumentStartInjection() {
    assertTrue(
      "Waydroid WebView must support native document-start scripts",
      WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT),
    )
    var view: WebView? = null
    var script: androidx.webkit.ScriptHandler? = null
    onMain {
      view = WebView(context).also { it.settings.javaScriptEnabled = true }
      script = WebViewCompat.addDocumentStartJavaScript(
        checkNotNull(view),
        "window.__noreaDocumentStartProof = 'trusted-before-page';",
        setOf("https://allowed.norea.test"),
      )
    }
    try {
      assertEquals("trusted-before-page", loadTitle(checkNotNull(view), "https://allowed.norea.test"))
      assertEquals("missing", loadTitle(checkNotNull(view), "https://denied.norea.test"))
      onMain { checkNotNull(script).remove() }
      script = null
      assertEquals("missing", loadTitle(checkNotNull(view), "https://allowed.norea.test"))
    } finally {
      onMain {
        script?.remove()
        checkNotNull(view).destroy()
      }
    }
  }

  @Test
  fun staticBridgeResourcesContainNoPageControlledCodeTransport() {
    val init = context.resources.openRawResource(R.raw.norea_scraper_init)
      .bufferedReader().use { it.readText() }
    val extract = context.resources.openRawResource(R.raw.norea_scraper_extract_start)
      .bufferedReader().use { it.readText() }
    for (script in listOf(init, extract)) {
      assertFalse(script.contains("__norea_script__"))
      assertFalse(script.contains("(0, eval)"))
      assertFalse(Regex("\\beval\\s*\\(").containsMatchIn(script))
    }
    assertTrue(extract.contains("__NOREA_TARGET_ORIGIN_JSON__"))
    assertTrue(extract.contains("location.origin !== targetOrigin"))
  }
}
