package io.github.tinywind.norea

import android.view.View
import android.webkit.WebView
import androidx.webkit.ScriptHandler

internal class AndroidScraperConcurrentFetch(
  val nonce: String,
  val timeout: Runnable,
)

internal class AndroidScraperState(var key: String) {
  val queue = AndroidScraperQueue()
  var activeAction: AndroidScraperQueuedAction? = null
  var activeExtractId: String? = null
  var retainExtractDocument = false
  var activeExtractScript: ScriptHandler? = null
  var activeFetchId: String? = null
  var activeResultNonce: String? = null
  var activeTimeout: Runnable? = null
  var blankBeforeNextAction = false
  var blankNavigationInProgress = false
  var busy = false
  val concurrentFetches: MutableMap<String, AndroidScraperConcurrentFetch> = mutableMapOf()
  var contextReady = false
  var currentUrl: String? = null
  var fetchInFlight = false
  var documentStartScriptEnabled = false
  var pendingDocumentReady: ((String) -> Unit)? = null
  var pendingSurfaceLayoutListener: View.OnLayoutChangeListener? = null
  var sourceId: String? = null
  var pendingChallengeUrl: String? = null
  var authenticationReturnQueue: String? = null
  var userAgent: String? = null
  var webView: WebView? = null
}

private fun AndroidScraperState.canTransfer(): Boolean =
  !busy && activeAction == null && queue.isEmpty() && concurrentFetches.isEmpty() &&
    !blankBeforeNextAction && !blankNavigationInProgress && pendingSurfaceLayoutListener == null

private fun swapIdleScraperStates(
  queues: MutableMap<String, AndroidScraperState>,
  left: AndroidScraperState,
  right: AndroidScraperState,
): Boolean {
  if (!left.canTransfer() || !right.canTransfer()) return false
  val leftKey = left.key
  left.key = right.key
  right.key = leftKey
  queues[left.key] = left
  queues[right.key] = right
  return true
}

internal fun promoteScraperAuthentication(
  queues: MutableMap<String, AndroidScraperState>,
  sourceId: String,
): Boolean {
  val foreground = queues["immediate"] ?: return false
  if (foreground.authenticationReturnQueue != null) return false
  val blocked = queues.values.firstOrNull {
    it.key != "immediate" && it.sourceId == sourceId && it.pendingChallengeUrl != null
  } ?: return false
  val returnQueue = blocked.key
  if (!swapIdleScraperStates(queues, foreground, blocked)) return false
  blocked.authenticationReturnQueue = returnQueue
  return true
}

internal fun restoreScraperAuthentication(
  queues: MutableMap<String, AndroidScraperState>,
  targetQueue: String? = null,
): Boolean {
  val foreground = queues["immediate"] ?: return false
  val returnQueue = foreground.authenticationReturnQueue ?: return false
  val worker = queues[targetQueue ?: returnQueue] ?: return false
  if (worker === foreground) return false
  if (!swapIdleScraperStates(queues, foreground, worker)) return false
  foreground.authenticationReturnQueue = null
  return true
}
