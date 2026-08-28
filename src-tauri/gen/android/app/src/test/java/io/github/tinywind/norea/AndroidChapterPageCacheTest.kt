package io.github.tinywind.norea

import java.io.File
import java.io.IOException
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidChapterPageCacheTest {
  @Test
  fun parsesExplicitPageCachePoliciesOnly() {
    assertEquals(
      ChapterPageCachePolicy.PREFER_CACHE,
      chapterPageCachePolicy("prefer-cache"),
    )
    assertEquals(
      ChapterPageCachePolicy.RELOAD,
      chapterPageCachePolicy("reload"),
    )
    assertNull(chapterPageCachePolicy(null))
    assertNull(chapterPageCachePolicy(""))
    assertNull(chapterPageCachePolicy("force-cache"))
  }

  @Test
  fun removesOnlyTheFragmentFromHttpCacheUrls() {
    assertEquals(
      "https://example.com/chapter?id=7",
      fragmentlessChapterPageUrl(
        "https://example.com/chapter?id=7#__lnr_script__=encoded",
      ),
    )
    assertEquals(
      "http://example.com/chapter",
      fragmentlessChapterPageUrl("http://example.com/chapter#reader"),
    )
    assertNull(fragmentlessChapterPageUrl("about:blank"))
    assertNull(fragmentlessChapterPageUrl("data:text/html,chapter"))
    assertNull(fragmentlessChapterPageUrl("https:///missing-host"))
  }

  @Test
  fun removesReservedCaptureQueriesWithoutChangingOtherQueryValues() {
    assertEquals(
      "https://example.com/chapter?id=7&token=a%2Bb",
      fragmentlessChapterPageUrl(
        "https://example.com/chapter?id=7&_norea_capture=abc&token=a%2Bb#reader",
      ),
    )
    assertEquals(
      "https://example.com/chapter?id=7",
      fragmentlessChapterPageUrl(
        "https://example.com/chapter?_norea_capture=first&id=7&_norea_capture=last",
      ),
    )
    assertEquals(
      "https://example.com/chapter",
      fragmentlessChapterPageUrl(
        "https://example.com/chapter?_norea_capture=only",
      ),
    )
  }

  @Test
  fun persistsSnapshotsAcrossCacheInstancesAndSharesFragmentKeys() = withCache { directory ->
    val first = AndroidChapterPageCache(directory)
    val key = ChapterPageCacheKey(
      sourceId = "naver-webtoon",
      url = "https://example.com/chapter?id=7#foreground",
    )
    val writeToken = first.writeToken(key)

    assertTrue(first.write(
      key,
      html = "<html><body>cached</body></html>",
      isChapterPage = false,
      writeToken = writeToken,
    ))

    val reopened = AndroidChapterPageCache(directory)
    assertEquals(
      ChapterPageCacheEntry(
        url = "https://example.com/chapter?id=7",
        html = "<html><body>cached</body></html>",
        isChapterPage = false,
      ),
      reopened.read(
        ChapterPageCacheKey(
          sourceId = "naver-webtoon",
          url = "https://example.com/chapter?id=7#batch",
        ),
      ),
    )
  }

  @Test
  fun storesRedirectedDocumentsUnderRequestedAndFinalCacheKeys() = withCache { directory ->
    val cache = AndroidChapterPageCache(directory)
    val requested = ChapterPageCacheKey(
      "source-a",
      "https://example.com/chapter/latest?_norea_capture=nonce",
    )
    val final = ChapterPageCacheKey(
      "source-a",
      "https://cdn.example.com/releases/chapter-7#reader",
    )

    assertTrue(
      cache.write(
        requested,
        html = "<html>redirected</html>",
        isChapterPage = true,
        writeToken = cache.writeToken(requested),
        documentUrl = final.url,
        documentWriteToken = cache.writeToken(final),
      ),
    )

    val expected = ChapterPageCacheEntry(
      url = "https://cdn.example.com/releases/chapter-7",
      html = "<html>redirected</html>",
      isChapterPage = true,
      aliasUrls = setOf(
        "https://example.com/chapter/latest",
        "https://cdn.example.com/releases/chapter-7",
      ),
    )
    assertEquals(
      expected,
      cache.read(ChapterPageCacheKey("source-a", "https://example.com/chapter/latest")),
    )
    assertEquals(expected, cache.read(final))

    cache.advanceKeyGenerations(listOf(final))
    assertEquals(
      setOf(
        ChapterPageCacheKey("source-a", "https://example.com/chapter/latest"),
        ChapterPageCacheKey("source-a", "https://cdn.example.com/releases/chapter-7"),
      ),
      cache.invalidate(listOf(final)),
    )

    assertNull(cache.read(requested))
    assertNull(cache.read(final))
  }

  @Test
  fun redirectedSnapshotCannotOverwriteAFinalAliasInvalidatedAfterNavigationStarted() =
    withCache { directory ->
      val cache = AndroidChapterPageCache(directory)
      val requested = ChapterPageCacheKey("source-a", "https://example.com/chapter/latest")
      val final = ChapterPageCacheKey("source-a", "https://cdn.example.com/chapter/7")
      val requestedToken = cache.writeToken(requested)
      val staleFinalToken = cache.writeToken(final)

      cache.advanceKeyGenerations(listOf(final))
      assertTrue(
        cache.write(
          final,
          "<html>fresh</html>",
          true,
          cache.writeToken(final),
        ),
      )

      assertFalse(
        cache.write(
          requested,
          html = "<html>stale redirect</html>",
          isChapterPage = true,
          writeToken = requestedToken,
          documentUrl = final.url,
          documentWriteToken = staleFinalToken,
        ),
      )
      assertEquals("<html>fresh</html>", cache.read(final)?.html)
    }

  @Test
  fun aCompetingFinalUrlWriteCannotSplitTheRedirectAliasPair() =
    withCache { directory ->
      val cache = AndroidChapterPageCache(directory)
      val requested = ChapterPageCacheKey("source-a", "https://example.com/chapter/latest")
      val final = ChapterPageCacheKey("source-a", "https://cdn.example.com/chapter/7")
      assertTrue(
        cache.write(
          requested,
          html = "<html>redirected leader</html>",
          isChapterPage = true,
          writeToken = cache.writeToken(requested),
          documentUrl = final.url,
          documentWriteToken = cache.writeToken(final),
        ),
      )

      assertFalse(
        cache.write(
          final,
          html = "<html>final leader</html>",
          isChapterPage = true,
          writeToken = cache.writeToken(final),
        ),
      )

      assertEquals("<html>redirected leader</html>", cache.read(requested)?.html)
      assertEquals("<html>redirected leader</html>", cache.read(final)?.html)
    }

  @Test
  fun isolatesSourcesAndInvalidatesOnlyExactEntries() = withCache { directory ->
    val cache = AndroidChapterPageCache(directory)
    val target = ChapterPageCacheKey("source-a", "https://example.com/chapter/1")
    val otherUrl = ChapterPageCacheKey("source-a", "https://example.com/chapter/2")
    val otherSource = ChapterPageCacheKey("source-b", "https://example.com/chapter/1")
    val targetToken = cache.writeToken(target)
    val otherUrlToken = cache.writeToken(otherUrl)

    listOf(target, otherUrl, otherSource).forEach { key ->
      assertTrue(
        cache.write(
          key,
          "<html>${key.sourceId}:${key.url}</html>",
          true,
          cache.writeToken(key),
        ),
      )
    }

    cache.advanceKeyGenerations(listOf(target))
    cache.invalidate(listOf(target))

    assertNull(cache.read(target))
    assertEquals(otherUrl.url, cache.read(otherUrl)?.url)
    assertEquals(otherSource.url, cache.read(otherSource)?.url)
    assertFalse(cache.write(target, "<html>late target</html>", true, targetToken))
    assertTrue(cache.write(otherUrl, "<html>late other</html>", true, otherUrlToken))
  }

  @Test
  fun preservesWhitespaceDistinctSourceIdsAcrossStorageAndSourceInvalidation() =
    withCache { directory ->
      val cache = AndroidChapterPageCache(directory)
      val exact = ChapterPageCacheKey("source-a", "https://example.com/chapter/1")
      val padded = ChapterPageCacheKey(" source-a ", "https://example.com/chapter/1")
      val staleExactToken = cache.writeToken(exact)
      val paddedToken = cache.writeToken(padded)

      assertTrue(cache.write(exact, "<html>exact</html>", true, staleExactToken))
      assertTrue(cache.write(padded, "<html>padded</html>", true, paddedToken))

      val reopened = AndroidChapterPageCache(directory)
      assertEquals("<html>exact</html>", reopened.read(exact)?.html)
      assertEquals("<html>padded</html>", reopened.read(padded)?.html)

      cache.advanceSourceGenerations(setOf(exact.sourceId))
      cache.invalidateSources(setOf(exact.sourceId))

      assertNull(cache.read(exact))
      assertEquals("<html>padded</html>", cache.read(padded)?.html)
      assertFalse(cache.write(exact, "<html>late exact</html>", true, staleExactToken))
      assertTrue(cache.write(padded, "<html>updated padded</html>", true, paddedToken))
    }

  @Test
  fun sourceInvalidationLeavesOtherSourcesAndTheirInflightWritesUntouched() =
    withCache { directory ->
      val cache = AndroidChapterPageCache(directory)
      val sourceAFirst = ChapterPageCacheKey("source-a", "https://example.com/chapter/1")
      val sourceASecond = ChapterPageCacheKey("source-a", "https://example.com/chapter/2")
      val sourceB = ChapterPageCacheKey("source-b", "https://example.com/chapter/1")
      val staleSourceAToken = cache.writeToken(sourceAFirst)
      val sourceBToken = cache.writeToken(sourceB)

      listOf(sourceAFirst, sourceASecond, sourceB).forEach { key ->
        assertTrue(cache.write(key, "<html>${key.sourceId}</html>", true, cache.writeToken(key)))
      }

      cache.advanceSourceGenerations(setOf("source-a"))
      cache.invalidateSources(setOf("source-a"))

      assertNull(cache.read(sourceAFirst))
      assertNull(cache.read(sourceASecond))
      assertEquals("<html>source-b</html>", cache.read(sourceB)?.html)
      assertFalse(
        cache.write(sourceAFirst, "<html>late source a</html>", true, staleSourceAToken),
      )
      assertTrue(cache.write(sourceB, "<html>late source b</html>", true, sourceBToken))
    }

  @Test
  fun clearRejectsLateWritesFromEarlierNavigations() = withCache { directory ->
    val cache = AndroidChapterPageCache(directory)
    val key = ChapterPageCacheKey("source-a", "https://example.com/chapter/1")
    val staleToken = cache.writeToken(key)

    assertTrue(cache.write(key, "<html>before</html>", true, staleToken))
    cache.advanceGeneration()
    cache.clear()

    assertFalse(cache.write(key, "<html>late</html>", true, staleToken))
    assertNull(cache.read(key))
    assertTrue(
      cache.write(
        key,
        "<html>after</html>",
        true,
        cache.writeToken(key),
      ),
    )
    assertEquals("<html>after</html>", cache.read(key)?.html)
  }

  @Test
  fun rejectsSnapshotDeliveryAfterItsKeyIsInvalidated() = withCache { directory ->
    val cache = AndroidChapterPageCache(directory)
    val key = ChapterPageCacheKey("source-a", "https://example.com/chapter/1")
    val writeToken = cache.writeToken(key)
    assertTrue(cache.write(key, "<html>before</html>", true, writeToken))

    cache.advanceKeyGenerations(listOf(key))

    assertFalse(cache.isCurrentWriteToken(key, writeToken))
  }

  @Test
  fun invalidationSurfacesEntryDeletionFailures() = withCache { directory ->
    val cache = AndroidChapterPageCache(directory)
    val key = ChapterPageCacheKey("source-a", "https://example.com/chapter/1")
    assertTrue(cache.write(key, "<html>cached</html>", true, cache.writeToken(key)))
    val cacheFile = requireNotNull(directory.listFiles()).single()
    assertTrue(cacheFile.delete())
    assertTrue(cacheFile.mkdir())
    File(cacheFile, "undeletable-child").writeText("blocked")

    assertThrows(IOException::class.java) {
      cache.invalidate(listOf(key))
    }
  }

  @Test
  fun followersReceiveTheLeadingNavigationSnapshot() {
    val flights = ChapterPageCacheFlights()
    val key = ChapterPageCacheKey("source-a", "https://example.com/chapter/1")
    val entry = ChapterPageCacheEntry(key.url, "<html>cached</html>", true)
    var followedEntry: ChapterPageCacheEntry? = null

    val leader = flights.beginOrFollow(key) { }
    assertTrue(leader != null)
    assertNull(flights.beginOrFollow(key) { followedEntry = it })
    flights.complete(requireNotNull(leader), entry)

    assertEquals(entry, followedEntry)
    assertTrue(flights.beginOrFollow(key) { } != null)
  }

  @Test
  fun whitespaceDistinctSourceIdsDoNotFollowTheSameNavigation() {
    val flights = ChapterPageCacheFlights()
    val exact = ChapterPageCacheKey("source-a", "https://example.com/chapter/1")
    val padded = ChapterPageCacheKey(" source-a ", "https://example.com/chapter/1")

    assertTrue(flights.beginOrFollow(exact) { } != null)
    assertTrue(flights.beginOrFollow(padded) { } != null)
  }

  @Test
  fun followersCanJoinALeadingNavigationThroughItsRedirectAlias() {
    val flights = ChapterPageCacheFlights()
    val requested = ChapterPageCacheKey("source-a", "https://example.com/chapter/latest")
    val final = ChapterPageCacheKey("source-a", "https://cdn.example.com/chapter/7")
    val entry = ChapterPageCacheEntry(
      url = final.url,
      html = "<html>redirected</html>",
      isChapterPage = true,
      aliasUrls = linkedSetOf(requested.url, final.url),
    )
    var followedEntry: ChapterPageCacheEntry? = null

    val leader = requireNotNull(flights.beginOrFollow(requested) { })
    flights.addAlias(leader, final)
    assertNull(flights.beginOrFollow(final) { followedEntry = it })
    flights.complete(leader, entry)

    assertEquals(entry, followedEntry)
    assertTrue(flights.beginOrFollow(requested) { } != null)
    assertTrue(flights.beginOrFollow(final) { } != null)
  }

  @Test
  fun replacementLeaderPreventsAnOlderNavigationFromCompletingFollowers() {
    val flights = ChapterPageCacheFlights()
    val key = ChapterPageCacheKey("source-a", "https://example.com/chapter/1")
    val staleLeader = requireNotNull(flights.beginOrFollow(key) { })
    var followedEntry: ChapterPageCacheEntry? = null
    assertNull(flights.beginOrFollow(key) { followedEntry = it })
    val replacement = requireNotNull(flights.replaceLeader(key))
    val freshEntry = ChapterPageCacheEntry(key.url, "<html>fresh</html>", true)

    flights.complete(staleLeader, ChapterPageCacheEntry(key.url, "<html>stale</html>", true))
    assertNull(followedEntry)
    flights.complete(replacement, freshEntry)

    assertEquals(freshEntry, followedEntry)
  }

  @Test
  fun rejectsErrorsChallengesNonHtmlAndOversizedSnapshots() {
    val valid = ChapterPageSnapshotMetadata(
      url = "https://example.com/chapter/1",
      contentType = "text/html",
      byteSize = 128,
      mainFrameFailed = false,
      mainFrameStatus = 200,
      challenge = false,
    )

    assertTrue(isCacheableChapterPageSnapshot(valid, maxBytes = 1_024))
    assertFalse(isCacheableChapterPageSnapshot(valid.copy(url = "about:blank"), 1_024))
    assertFalse(isCacheableChapterPageSnapshot(valid.copy(contentType = "text/plain"), 1_024))
    assertFalse(isCacheableChapterPageSnapshot(valid.copy(mainFrameFailed = true), 1_024))
    assertFalse(isCacheableChapterPageSnapshot(valid.copy(mainFrameStatus = 404), 1_024))
    assertFalse(isCacheableChapterPageSnapshot(valid.copy(challenge = true), 1_024))
    assertFalse(isCacheableChapterPageSnapshot(valid.copy(byteSize = 1_025), 1_024))
  }

  private fun withCache(block: (java.io.File) -> Unit) {
    val directory = Files.createTempDirectory("norea-chapter-page-cache-test").toFile()
    try {
      block(directory)
    } finally {
      directory.deleteRecursively()
    }
  }
}
