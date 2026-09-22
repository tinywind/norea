package io.github.tinywind.norea

import android.view.View
import android.webkit.WebView
import androidx.webkit.ScriptHandler

internal class AndroidScraperConcurrentFetch(
  val nonce: String,
  val timeout: Runnable,
)

internal class AndroidScraperState(val key: String) {
  val queue = AndroidScraperQueue()
  var activeAction: AndroidScraperQueuedAction? = null
  var activeExtractId: String? = null
  var activeExtractScript: ScriptHandler? = null
  var activeFetchId: String? = null
  var activeResultNonce: String? = null
  var activeTimeout: Runnable? = null
  var blankBeforeNextAction = false
  var blankNavigationInProgress = false
  var busy = false
  val concurrentFetches: MutableMap<String, AndroidScraperConcurrentFetch> = mutableMapOf()
  var currentUrl: String? = null
  var fetchInFlight = false
  var documentStartScriptEnabled = false
  var pendingDocumentReady: ((String) -> Unit)? = null
  var pendingSurfaceLayoutListener: View.OnLayoutChangeListener? = null
  var sourceId: String? = null
  var userAgent: String? = null
  var webView: WebView? = null
}
