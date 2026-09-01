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

  @Test
  fun backgroundRenderingUsesTheLaidOutMainWebViewSize() {
    assertEquals(
      AndroidScraperSurfaceSize(width = 1904, height = 3040),
      androidBackgroundScraperSurfaceSize(
        mainWidth = 1904,
        mainHeight = 3040,
        displayWidth = 2560,
        displayHeight = 1600,
      ),
    )
  }

  @Test
  fun backgroundRenderingFallsBackToTheDisplayBeforeUsingOnePixel() {
    assertEquals(
      AndroidScraperSurfaceSize(width = 2560, height = 1600),
      androidBackgroundScraperSurfaceSize(
        mainWidth = 0,
        mainHeight = 1,
        displayWidth = 2560,
        displayHeight = 1600,
      ),
    )
    assertEquals(
      AndroidScraperSurfaceSize(width = 1, height = 1),
      androidBackgroundScraperSurfaceSize(
        mainWidth = 0,
        mainHeight = 0,
        displayWidth = 0,
        displayHeight = 0,
      ),
    )
  }

  @Test
  fun aNewOrPooledWebViewIsNotMistakenForTheForegroundBrowser() {
    assertFalse(
      androidScraperSurfaceIsForeground(
        browserVisible = false,
        isImmediateWebView = true,
        surfaceVisible = true,
        alpha = 1f,
        clickable = true,
      ),
    )
    assertFalse(
      androidScraperSurfaceIsForeground(
        browserVisible = true,
        isImmediateWebView = false,
        surfaceVisible = true,
        alpha = 1f,
        clickable = true,
      ),
    )
    assertTrue(
      androidScraperSurfaceIsForeground(
        browserVisible = true,
        isImmediateWebView = true,
        surfaceVisible = true,
        alpha = 1f,
        clickable = true,
      ),
    )
  }

  @Test
  fun backgroundNavigationWaitsForANonTrivialLayout() {
    assertFalse(androidBackgroundScraperSurfaceIsReady(width = 1, height = 3040))
    assertFalse(androidBackgroundScraperSurfaceIsReady(width = 1904, height = 1))
    assertTrue(androidBackgroundScraperSurfaceIsReady(width = 1904, height = 3040))
  }

  @Test
  fun onlyTheCompletedBackgroundExtractCollapsesItsSurface() {
    assertTrue(
      shouldCollapseAndroidScraperSurface(
        activeExtractId = "extract-1",
        completedId = "extract-1",
        foreground = false,
      ),
    )
    assertFalse(
      shouldCollapseAndroidScraperSurface(
        activeExtractId = "extract-1",
        completedId = "extract-2",
        foreground = false,
      ),
    )
    assertFalse(
      shouldCollapseAndroidScraperSurface(
        activeExtractId = "extract-1",
        completedId = "extract-1",
        foreground = true,
      ),
    )
  }
}
