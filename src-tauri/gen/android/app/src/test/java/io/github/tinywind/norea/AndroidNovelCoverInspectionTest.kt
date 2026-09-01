package io.github.tinywind.norea

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AndroidNovelCoverInspectionTest {
  private val sourceId = "demo"
  private val novelPath = "novel/path"
  private val sourceUrl = "https://source.test/cover.jpg"

  @Test
  fun prefersExactIdentityCoverInPreferredDirectory() {
    val preferred = cover(
      relativePath = "contents/demo/Current-novel-path/cover.jpg",
      updatedAt = 1L,
    )
    val fallback = cover(
      relativePath = "contents/demo/Previous-novel-path/cover.jpg",
      updatedAt = 2L,
    )

    assertEquals(
      preferred,
      select(
        preferred = preferred,
        matches = listOf(fallback),
      ),
    )
  }

  @Test
  fun prefersLegacyCoverInPreferredDirectory() {
    val preferred = cover(
      relativePath = "contents/demo/Current-novel-path/cover.jpg",
      sourceId = null,
      novelPath = null,
      sourceUrl = "https://source.test/legacy.jpg",
      updatedAt = 1L,
    )
    val fallback = cover(
      relativePath = "contents/demo/Previous-novel-path/cover.jpg",
      updatedAt = 2L,
    )

    assertEquals(
      preferred,
      select(
        preferred = preferred,
        matches = listOf(fallback),
      ),
    )
  }

  @Test
  fun rejectsPreferredCoverWithDifferentStoredIdentity() {
    val preferredCollision = cover(
      relativePath = "contents/demo/Current-novel-path/cover.jpg",
      novelPath = "other/novel/path",
      updatedAt = 2L,
    )
    val fallback = cover(
      relativePath = "contents/demo/Previous-novel-path/cover.jpg",
      updatedAt = 1L,
    )

    assertEquals(
      fallback,
      select(
        preferred = preferredCollision,
        matches = listOf(fallback),
      ),
    )
  }

  @Test
  fun allowsLegacyFallbackOnlyForExactExpectedSourceUrl() {
    val legacy = cover(
      relativePath = "contents/demo/Previous-novel-path/cover.jpg",
      sourceId = null,
      novelPath = null,
    )

    assertEquals(
      legacy,
      select(
        matches = listOf(legacy),
        expectedSourceUrl = sourceUrl,
      ),
    )
    assertNull(select(matches = listOf(legacy), expectedSourceUrl = ""))
    assertNull(
      select(
        matches = listOf(legacy),
        expectedSourceUrl = "https://source.test/different.jpg",
      ),
    )
  }

  @Test
  fun excludesSuffixCollisionWithDifferentManifestIdentity() {
    assertNull(
      select(
        matches = listOf(
          cover(
            relativePath = "contents/demo/Other-novel-path/cover.jpg",
            novelPath = "other/novel/path",
          ),
        ),
        expectedSourceUrl = sourceUrl,
      ),
    )
  }

  @Test
  fun supportsPersistedNovelIdentityWhenTheSourcePathIsBlank() {
    val identity = parseAndroidNovelCoverIdentity(sourceId, "")
    assertEquals("", identity?.novelPath)
    val cover = cover(
      relativePath = "contents/demo/Current-7/cover.jpg",
      sourceId = identity?.sourceId,
      novelPath = identity?.novelPath,
    )

    assertEquals(
      cover,
      selectAndroidNovelCoverInspection(
        preferred = cover,
        matches = emptyList(),
        sourceId = sourceId,
        novelPath = "",
        expectedSourceUrl = sourceUrl,
      ),
    )
  }

  @Test
  fun selectsLatestIdentityMatchAndBreaksTiesByRelativePath() {
    val old = cover(
      relativePath = "contents/demo/Old-novel-path/cover.jpg",
      updatedAt = 1L,
    )
    val latestSecond = cover(
      relativePath = "contents/demo/Z-latest-novel-path/cover.jpg",
      updatedAt = 2L,
    )
    val latestFirst = cover(
      relativePath = "contents/demo/A-latest-novel-path/cover.jpg",
      updatedAt = 2L,
    )

    assertEquals(
      latestFirst,
      select(matches = listOf(latestSecond, old, latestFirst)),
    )
  }

  @Test
  fun rejectsAnEmptyCoverFile() {
    assertNull(
      nonEmptyAndroidNovelCoverInspection(
        inspection = cover(
          relativePath = "contents/demo/Previous-novel-path/cover.jpg",
        ),
        bytes = 0L,
      ),
    )
  }

  private fun cover(
    relativePath: String,
    sourceId: String? = this.sourceId,
    novelPath: String? = this.novelPath,
    sourceUrl: String = this.sourceUrl,
    updatedAt: Long = 1L,
  ): AndroidNovelCoverInspection = AndroidNovelCoverInspection(
    manifest = relativePath,
    relativePath = relativePath,
    sourceId = sourceId,
    novelPath = novelPath,
    sourceUrl = sourceUrl,
    updatedAt = updatedAt,
  )

  private fun select(
    preferred: AndroidNovelCoverInspection? = null,
    matches: List<AndroidNovelCoverInspection>,
    expectedSourceUrl: String = sourceUrl,
  ): AndroidNovelCoverInspection? = selectAndroidNovelCoverInspection(
    preferred = preferred,
    matches = matches,
    sourceId = sourceId,
    novelPath = novelPath,
    expectedSourceUrl = expectedSourceUrl,
  )
}
