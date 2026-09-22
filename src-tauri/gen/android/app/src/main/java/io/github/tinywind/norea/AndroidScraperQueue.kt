package io.github.tinywind.norea

import org.json.JSONObject

internal enum class ForegroundBlankTiming {
  BEFORE_NEXT_ACTION,
  AFTER_ACTIVE_ACTION,
}

internal fun foregroundBlankTiming(activeBrowserAction: Boolean?): ForegroundBlankTiming =
  if (activeBrowserAction == false) {
    ForegroundBlankTiming.AFTER_ACTIVE_ACTION
  } else {
    ForegroundBlankTiming.BEFORE_NEXT_ACTION
  }

internal fun canStartQueuedAction(
  busy: Boolean,
  blankBeforeNextAction: Boolean,
  blankNavigationInProgress: Boolean,
): Boolean = !busy && !blankBeforeNextAction && !blankNavigationInProgress

internal fun shouldCompleteBlankNavigation(
  blankNavigationInProgress: Boolean,
  isCurrentWebView: Boolean,
  finishedUrl: String?,
  timeoutElapsed: Boolean,
  expectedUrl: String = "about:blank",
): Boolean =
  blankNavigationInProgress &&
    isCurrentWebView &&
    (timeoutElapsed || finishedUrl == expectedUrl)

internal fun canStartConcurrentScraperFetches(
  blankBeforeNextAction: Boolean,
  blankNavigationInProgress: Boolean,
  exclusiveActionActive: Boolean,
  foregroundBrowser: Boolean,
): Boolean =
  !blankBeforeNextAction &&
    !blankNavigationInProgress &&
    !exclusiveActionActive &&
    !foregroundBrowser

internal fun availableScraperFetchSlots(
  limit: Int,
  primaryFetchActive: Boolean,
  concurrentFetchCount: Int,
): Int = (limit - concurrentFetchCount - if (primaryFetchActive) 1 else 0).coerceAtLeast(0)

internal data class AndroidScraperQueuedAction(
  val id: String,
  val sourceId: String,
  val priority: Int,
  val browserAction: Boolean,
  val run: (AndroidScraperState) -> Unit,
  val fetchPayload: JSONObject? = null,
)

internal class AndroidScraperQueue {
  private val actions = mutableListOf<AndroidScraperQueuedAction>()

  val size: Int
    get() = actions.size

  val hasBrowserAction: Boolean
    get() = actions.any { it.browserAction }

  fun isEmpty(): Boolean = actions.isEmpty()

  fun enqueue(action: AndroidScraperQueuedAction) {
    actions.add(action)
  }

  fun takeNext(browserExclusive: Boolean): AndroidScraperQueuedAction? =
    takeMatching { !browserExclusive || it.browserAction }

  fun takeMatching(eligible: (AndroidScraperQueuedAction) -> Boolean): AndroidScraperQueuedAction? {
    var selectedIndex: Int? = null
    for (index in actions.indices) {
      val candidate = actions[index]
      if (!eligible(candidate)) continue
      val selected = selectedIndex?.let(actions::get)
      // The list preserves enqueue order, so equal priorities remain FIFO.
      if (selected == null || candidate.priority < selected.priority) {
        selectedIndex = index
      }
    }
    return selectedIndex?.let(actions::removeAt)
  }

  fun removeWhere(predicate: (AndroidScraperQueuedAction) -> Boolean): List<AndroidScraperQueuedAction> {
    val removed = mutableListOf<AndroidScraperQueuedAction>()
    val iterator = actions.iterator()
    while (iterator.hasNext()) {
      val action = iterator.next()
      if (predicate(action)) {
        iterator.remove()
        removed.add(action)
      }
    }
    return removed
  }

  fun clear() = actions.clear()
}
