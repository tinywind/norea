package io.github.tinywind.norea

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AndroidChapterStorageTransferTest {
  @Test
  fun retainsTheJournalTokenInsteadOfGeneratingAnotherToken() {
    assertEquals(
      "source-renumber-123",
      resolveAndroidChapterStorageTransferToken("source-renumber-123") {
        throw AssertionError("A persisted journal token must not be replaced")
      },
    )
    assertEquals(
      "generated-transfer-456",
      resolveAndroidChapterStorageTransferToken(null) { "generated-transfer-456" },
    )
  }

  @Test
  fun refusesInvalidJournalTokensWithoutFallingBack() {
    for (token in listOf("", "../other-operation", "token/child", "x".repeat(129))) {
      assertThrows(IllegalArgumentException::class.java) {
        resolveAndroidChapterStorageTransferToken(token) {
          throw AssertionError("An invalid persisted token must fail closed")
        }
      }
    }
  }

  @Test
  fun acceptsOnlyChapterDirectoriesForTransferEntries() {
    assertEquals(
      listOf("contents", "source-a", "Novel-a", "1-Opening"),
      validateAndroidChapterStorageRelativeDir("contents/source-a/Novel-a/1-Opening"),
    )
    assertThrows(IllegalArgumentException::class.java) {
      validateAndroidChapterStorageRelativeDir("contents/source-a/Novel-a")
    }
    assertThrows(IllegalArgumentException::class.java) {
      validateAndroidChapterStorageRelativeDir("chapter-media/source-a/Novel-a/1-Opening")
    }
    assertThrows(IllegalArgumentException::class.java) {
      validateAndroidChapterStorageRelativeDir("contents/source-a/../1-Opening")
    }
  }

  @Test
  fun permitsNovelOrChapterDirectoriesForMergeCleanup() {
    assertEquals(
      listOf("contents", "source-a", "Novel-a"),
      validateAndroidChapterStorageRemovalRelativeDir("contents/source-a/Novel-a"),
    )
    assertEquals(
      listOf("contents", "source-a", "Novel-a", "1-Opening"),
      validateAndroidChapterStorageRemovalRelativeDir(
        "contents/source-a/Novel-a/1-Opening",
      ),
    )
    assertThrows(IllegalArgumentException::class.java) {
      validateAndroidChapterStorageRemovalRelativeDir("contents/source-a")
    }
  }

  @Test
  fun buildsTransferSiblingNamesFromValidatedTokens() {
    assertEquals(
      ".1-Opening.norea-transfer-transfer_1.stage",
      androidChapterStorageTransferSiblingName(
        "1-Opening",
        "transfer_1",
        "stage",
      ),
    )
    assertEquals(
      ".norea-transfer-transfer_1",
      androidChapterStorageTransferMarkerName("transfer_1"),
    )
    assertThrows(IllegalArgumentException::class.java) {
      androidChapterStorageTransferSiblingName("1-Opening", "../escape", "stage")
    }
  }
}
