package io.github.tinywind.norea

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidScraperBridgePolicyTest {
  @Test
  fun prefersCachedMediaWhenRequestedByTheChapterPipeline() {
    assertEquals("force-cache", browserFetchCacheMode(preferBrowserCache = true))
    assertEquals("default", browserFetchCacheMode(preferBrowserCache = false))
  }

  @Test
  fun revalidatesTheTopLevelDocumentAfterAChapterPageCacheMiss() {
    assertEquals(
      mapOf(
        "Cache-Control" to "no-cache",
        "Pragma" to "no-cache",
      ),
      chapterPageNetworkHeaders(),
    )
  }

  @Test
  fun reappliesDocumentRevalidationHeadersToServerRedirects() {
    assertTrue(
      shouldRevalidateChapterPageRedirect(
        isForMainFrame = true,
        method = "GET",
        isRedirect = true,
        navigationInProgress = true,
        documentRevalidationInProgress = true,
        url = "https://cdn.example.com/chapter/7",
      ),
    )
    assertFalse(
      shouldRevalidateChapterPageRedirect(
        isForMainFrame = true,
        method = "GET",
        isRedirect = false,
        navigationInProgress = true,
        documentRevalidationInProgress = true,
        url = "https://cdn.example.com/chapter/7",
      ),
    )
    assertFalse(
      shouldRevalidateChapterPageRedirect(
        isForMainFrame = true,
        method = "GET",
        isRedirect = true,
        navigationInProgress = true,
        documentRevalidationInProgress = false,
        url = "https://cdn.example.com/chapter/7",
      ),
    )
  }

  @Test
  fun usesTheFinalRedirectUrlWithoutDroppingTheExtractionFragment() {
    assertEquals(
      "https://cdn.example.com/releases/chapter-7#__lnr_script__=encoded",
      cachedPageBaseUrl(
        targetUrl = "https://example.com/chapter/latest#__lnr_script__=encoded",
        documentUrl = "https://cdn.example.com/releases/chapter-7",
      ),
    )
    assertEquals(
      "https://cdn.example.com/releases/chapter-7",
      cachedPageBaseUrl(
        targetUrl = "https://example.com/chapter/latest",
        documentUrl = "https://cdn.example.com/releases/chapter-7",
      ),
    )
  }

  @Test
  fun blocksRequestedAndRedirectAliasHitsWhileReloadInvalidationIsPending() {
    val requested = ChapterPageCacheKey(
      "source-a",
      "https://example.com/chapter/latest",
    )
    val final = ChapterPageCacheKey(
      "source-a",
      "https://cdn.example.com/chapter/7",
    )
    val entry = ChapterPageCacheEntry(
      url = final.url,
      html = "<html>stale</html>",
      isChapterPage = true,
      aliasUrls = linkedSetOf(requested.url, final.url),
    )

    assertEquals(
      requested,
      pendingChapterPageCacheInvalidationKey(
        key = final,
        entry = entry,
        pendingKeys = setOf(requested),
        pendingSourceIds = emptySet(),
      ),
    )
    assertEquals(
      final,
      pendingChapterPageCacheInvalidationKey(
        key = final,
        entry = null,
        pendingKeys = setOf(final),
        pendingSourceIds = emptySet(),
      ),
    )
    assertEquals(
      final,
      pendingChapterPageCacheInvalidationKey(
        key = final,
        entry = entry,
        pendingKeys = emptySet(),
        pendingSourceIds = setOf("source-a"),
      ),
    )
    assertEquals(
      final,
      pendingChapterPageCacheInvalidationKey(
        key = final,
        entry = entry,
        pendingKeys = emptySet(),
        pendingSourceIds = emptySet(),
        fullClearPending = true,
      ),
    )
    assertEquals(
      null,
      pendingChapterPageCacheInvalidationKey(
        key = final,
        entry = entry,
        pendingKeys = emptySet(),
        pendingSourceIds = emptySet(),
      ),
    )
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
