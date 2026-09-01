package io.github.tinywind.norea

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidScraperBridgePolicyTest {
  @Test
  fun deletesOnlyTheLegacyChapterPageCacheDirectory() {
    val cacheRoot = Files.createTempDirectory("norea-cache-root-test").toFile()
    val legacyCache = File(cacheRoot, "scraper-chapter-pages")
    val unrelatedCache = File(cacheRoot, "keep").apply { writeText("keep") }
    try {
      File(legacyCache, "nested/page.page").apply {
        parentFile?.mkdirs()
        writeText("cached")
      }

      deleteLegacyChapterPageCache(legacyCache)

      assertFalse(legacyCache.exists())
      assertTrue(unrelatedCache.isFile)
      deleteLegacyChapterPageCache(legacyCache)
    } finally {
      cacheRoot.deleteRecursively()
    }
  }

  @Test
  fun blanksBeforeStartingQueuedWorkWhenNoActionIsActive() {
    assertEquals(
      ForegroundBlankTiming.BEFORE_NEXT_ACTION,
      foregroundBlankTiming(activeBrowserAction = null),
    )
  }

  @Test
  fun blanksBeforeStartingQueuedWorkWhenCancellingABrowserAction() {
    assertEquals(
      ForegroundBlankTiming.BEFORE_NEXT_ACTION,
      foregroundBlankTiming(activeBrowserAction = true),
    )
  }

  @Test
  fun defersBlankingUntilAnActiveNonBrowserActionFinishes() {
    assertEquals(
      ForegroundBlankTiming.AFTER_ACTIVE_ACTION,
      foregroundBlankTiming(activeBrowserAction = false),
    )
  }

  @Test
  fun blocksQueuedWorkWhileBlankingIsPending() {
    assertFalse(
      canStartQueuedAction(
        busy = false,
        blankBeforeNextAction = true,
        blankNavigationInProgress = false,
      ),
    )
  }

  @Test
  fun blocksQueuedWorkWhileBlankNavigationIsInProgress() {
    assertFalse(
      canStartQueuedAction(
        busy = false,
        blankBeforeNextAction = false,
        blankNavigationInProgress = true,
      ),
    )
  }

  @Test
  fun startsQueuedWorkAfterBlankNavigationFinishes() {
    assertTrue(
      canStartQueuedAction(
        busy = false,
        blankBeforeNextAction = false,
        blankNavigationInProgress = false,
      ),
    )
  }

  @Test
  fun completesBlankNavigationForAnExactFinishOrAStallTimeout() {
    assertTrue(
      shouldCompleteBlankNavigation(
        blankNavigationInProgress = true,
        isCurrentWebView = true,
        finishedUrl = "about:blank",
        timeoutElapsed = false,
      ),
    )
    assertTrue(
      shouldCompleteBlankNavigation(
        blankNavigationInProgress = true,
        isCurrentWebView = true,
        finishedUrl = null,
        timeoutElapsed = true,
      ),
    )
    assertFalse(
      shouldCompleteBlankNavigation(
        blankNavigationInProgress = true,
        isCurrentWebView = true,
        finishedUrl = "https://example.com/late",
        timeoutElapsed = false,
      ),
    )
    assertFalse(
      shouldCompleteBlankNavigation(
        blankNavigationInProgress = true,
        isCurrentWebView = false,
        finishedUrl = null,
        timeoutElapsed = true,
      ),
    )
  }
}
