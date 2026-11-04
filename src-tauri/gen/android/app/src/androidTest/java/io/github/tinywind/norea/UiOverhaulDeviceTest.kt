package io.github.tinywind.norea

import android.content.Intent
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class UiOverhaulDeviceTest {
  private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
  private val context get() = instrumentation.targetContext

  private fun requireIsolatedApp() {
    check(context.packageName == "io.github.tinywind.norea.debug") {
      "These checks must run in the isolated debug application."
    }
  }

  @Test
  fun automaticBackupReportsAMissingFolderGrantWithoutChangingTheArchive() {
    requireIsolatedApp()
    val input = File.createTempFile("backup-grant-check-", ".zip", context.cacheDir)
    val bytes = byteArrayOf(0x50, 0x4b, 3, 4)
    input.writeBytes(bytes)
    val storage = AndroidStorageDocuments(context)
    val backups = AndroidAutoBackups(context, storage, AndroidContentUriFiles(context, storage))
    val root = "content://com.android.externalstorage.documents/tree/primary%3ANorea-ungranted-ui-qa"
    assertTrue(context.contentResolver.persistedUriPermissions.none { it.uri.toString() == root })
    try {
      val error = runCatching {
        backups.publish(root, input.path, "norea-auto-backup-20261104000000.zip", 1)
      }.exceptionOrNull()
      assertTrue(error.toString(), error?.message?.startsWith(AUTO_BACKUP_FOLDER_UNAVAILABLE) == true)
      assertTrue(input.readBytes().contentEquals(bytes))
    } finally {
      input.delete()
    }
  }

  private fun shell(command: String): String =
    ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command))
      .bufferedReader().use { it.readText().trim() }

  private fun mainWebView(activity: MainActivity): WebView {
    fun find(view: View): WebView? {
      if (view is WebView && Uri.parse(view.url ?: "").host == "tauri.localhost") return view
      if (view is ViewGroup) {
        for (index in 0 until view.childCount) find(view.getChildAt(index))?.let { return it }
      }
      return null
    }
    repeat(200) {
      var webView: WebView? = null
      instrumentation.runOnMainSync { webView = find(activity.window.decorView) }
      if (webView != null) return webView!!
      Thread.sleep(50)
    }
    error("The recreated activity did not receive its WebView")
  }

  private fun evaluate(webView: WebView, script: String): String? {
    val finished = CountDownLatch(1)
    var result: String? = null
    instrumentation.runOnMainSync {
      webView.evaluateJavascript(script) { result = it; finished.countDown() }
    }
    assertTrue("WebView did not answer the lifecycle check", finished.await(5, TimeUnit.SECONDS))
    return result
  }

  private fun awaitFrontend(webView: WebView) {
    repeat(200) {
      if (evaluate(webView, "Boolean(window.__TAURI_INTERNALS__ && document.readyState === 'complete' && document.querySelector('#root')?.childElementCount)") == "true") return
      Thread.sleep(50)
    }
    val state = evaluate(webView, "JSON.stringify({url: location.href, ready: document.readyState, body: document.body.innerText.slice(0, 180), ipc: Boolean(window.__TAURI_INTERNALS__)})")
    error("The recreated WebView did not load the frontend: $state")
  }

  @Test
  fun activityReplacementKeepsRuntimeAndDeepLink() {
    requireIsolatedApp()
    var activity: MainActivity? = null
    try {
      activity = instrumentation.startActivitySync(
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      ) as MainActivity
      val firstView = mainWebView(activity)
      awaitFrontend(firstView)
      evaluate(firstView, "localStorage.setItem('norea-lifecycle-qa', 'retained')")
      repeat(3) {
        val url = "norea://repo/add?url=https%3A%2F%2Fexample.invalid%2Flifecycle-${System.nanoTime()}.json"
        activity = instrumentation.startActivitySync(
          Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .setData(Uri.parse(url))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
        ) as MainActivity
        val secondView = mainWebView(activity!!)
        awaitFrontend(secondView)
        evaluate(secondView, """
          window.__noreaLifecycleCheck = 'pending';
          Promise.all([
            window.__TAURI_INTERNALS__.invoke('get_build_info'),
            window.__TAURI_INTERNALS__.invoke('plugin:deep-link|get_current')
          ]).then(([build, urls]) => {
            window.__noreaLifecycleCheck = build && urls?.includes('$url') &&
              localStorage.getItem('norea-lifecycle-qa') === 'retained' ? 'ok' : 'missing runtime, URL or stored data';
          }).catch(error => { window.__noreaLifecycleCheck = String(error); });
        """.trimIndent())
        var result: String? = null
        for (attempt in 0 until 100) {
          result = evaluate(secondView, "window.__noreaLifecycleCheck")
          if (result != "\"pending\"") break
          Thread.sleep(50)
        }
        assertEquals("\"ok\"", result)
      }
      evaluate(mainWebView(activity!!), "localStorage.removeItem('norea-lifecycle-qa')")
    } finally {
      instrumentation.runOnMainSync { activity?.finish() }
    }
  }

  @Test
  fun webViewRequestsReducedMotionWhenSystemAnimationsAreDisabled() {
    requireIsolatedApp()
    val names = listOf("animator_duration_scale", "transition_animation_scale", "window_animation_scale")
    val previous = names.associateWith { shell("settings get global $it") }
    var webView: WebView? = null
    var activity: MainActivity? = null
    try {
      names.forEach { shell("settings put global $it 0") }
      val finished = CountDownLatch(1)
      var result: String? = null
      activity = instrumentation.startActivitySync(
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      ) as MainActivity
      instrumentation.runOnMainSync {
        webView = WebView(activity).apply {
          settings.javaScriptEnabled = true
          webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
              view.evaluateJavascript("matchMedia('(prefers-reduced-motion: reduce)').matches") {
                result = it
                finished.countDown()
              }
            }
          }
          loadDataWithBaseURL(null, "<!doctype html><title>Motion check</title>", "text/html", "UTF-8", null)
        }
        activity.addContentView(webView, ViewGroup.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.MATCH_PARENT,
        ))
      }
      assertTrue("WebView did not finish the motion check", finished.await(15, TimeUnit.SECONDS))
      assertEquals("true", result)
    } finally {
      try {
        instrumentation.runOnMainSync {
          webView?.destroy()
          activity?.finish()
        }
      } finally {
        previous.forEach { (name, value) ->
          shell(if (value == "null") "settings delete global $name" else "settings put global $name $value")
        }
      }
    }
  }
}
