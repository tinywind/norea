package io.github.tinywind.norea

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidScraperQueueTest {
  private fun action(
    id: String,
    priority: Int = 1,
    browserAction: Boolean = false,
    sourceId: String = "source-a",
  ): AndroidScraperQueuedAction = AndroidScraperQueuedAction(
    id = id,
    sourceId = sourceId,
    priority = priority,
    browserAction = browserAction,
    run = {},
  )

  @Test
  fun prioritizesInteractiveWorkAndKeepsEqualPriorityFifo() {
    val queue = AndroidScraperQueue()
    queue.enqueue(action("background", priority = 2))
    queue.enqueue(action("first-user", priority = 1))
    queue.enqueue(action("interactive", priority = 0))
    queue.enqueue(action("second-user", priority = 1))

    assertEquals("interactive", queue.takeNext(false)?.id)
    assertEquals("first-user", queue.takeNext(false)?.id)
    assertEquals("second-user", queue.takeNext(false)?.id)
    assertEquals("background", queue.takeNext(false)?.id)
    assertNull(queue.takeNext(false))
  }

  @Test
  fun visibleBrowserLeavesNonBrowserActionsQueued() {
    val queue = AndroidScraperQueue()
    queue.enqueue(action("fetch", priority = 0))
    queue.enqueue(action("navigation", priority = 1, browserAction = true))

    assertTrue(queue.hasBrowserAction)
    assertEquals("navigation", queue.takeNext(true)?.id)
    assertFalse(queue.hasBrowserAction)
    assertNull(queue.takeNext(true))
    assertEquals(1, queue.size)
    assertEquals("fetch", queue.takeNext(false)?.id)
  }

  @Test
  fun concurrentSelectionDoesNotConsumeActionsForAnotherSession() {
    val queue = AndroidScraperQueue()
    queue.enqueue(action("other-source", priority = 0, sourceId = "source-b"))
    queue.enqueue(action("same-source-later", priority = 2))
    queue.enqueue(action("same-source-first", priority = 1))

    assertEquals("same-source-first", queue.takeMatching { it.sourceId == "source-a" }?.id)
    assertEquals("same-source-later", queue.takeMatching { it.sourceId == "source-a" }?.id)
    assertNull(queue.takeMatching { it.sourceId == "source-a" })
    assertEquals("other-source", queue.takeNext(false)?.id)
  }

  @Test
  fun cancellationRemovesOnlyMatchingQueuedRequests() {
    val queue = AndroidScraperQueue()
    queue.enqueue(action("cancel"))
    queue.enqueue(action("keep-first"))
    queue.enqueue(action("cancel"))
    queue.enqueue(action("keep-second"))

    assertEquals(listOf("cancel", "cancel"), queue.removeWhere { it.id == "cancel" }.map { it.id })
    assertEquals("keep-first", queue.takeNext(false)?.id)
    assertEquals("keep-second", queue.takeNext(false)?.id)
    assertTrue(queue.isEmpty())
  }

  @Test
  fun parkingNavigationExtractionAndForegroundBrowserExcludeConcurrentFetches() {
    assertTrue(canStartConcurrentScraperFetches(false, false, false, false))
    assertFalse(canStartConcurrentScraperFetches(true, false, false, false))
    assertFalse(canStartConcurrentScraperFetches(false, true, false, false))
    assertFalse(canStartConcurrentScraperFetches(false, false, true, false))
    assertFalse(canStartConcurrentScraperFetches(false, false, false, true))
  }

  @Test
  fun independentFetchesShareTheLimitWithThePrimaryFetch() {
    assertEquals(3, availableScraperFetchSlots(4, true, 0))
    assertEquals(1, availableScraperFetchSlots(4, true, 2))
    assertEquals(0, availableScraperFetchSlots(4, true, 3))
    assertEquals(1, availableScraperFetchSlots(4, false, 3))
    assertEquals(0, availableScraperFetchSlots(4, false, 5))
  }
}
