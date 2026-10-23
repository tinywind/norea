package io.github.tinywind.norea

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidStorageIdentityTest {
  @Test
  fun storageIdsPreserveValidUnicodeAndRejectUnsafeNames() {
    assertTrue(isAndroidStorageId("book-source"))
    assertTrue(isAndroidStorageId("\u00e9".repeat(120)))
    for (value in listOf("", ".book", " book", "book.", "book ", "../book", "a/b", "a\\b",
      "CON.txt", "com0", "lpt9.json", "book.PARTIAL", "book.norea-sync-backup", "a\u0000b",
      "\u00e9".repeat(121), "\uD800", "\uDC00")) {
      assertFalse(value, isAndroidStorageId(value))
    }
  }

  @Test
  fun pluginIdsRequireLowercaseKebabCase() {
    assertTrue(isAndroidPluginStorageId("source-1"))
    for (value in listOf("Source", "source_1", "source--1", "-source", "source-", "con")) {
      assertFalse(value, isAndroidPluginStorageId(value))
    }
  }

  @Test
  fun chapterDirectoriesUseOnlyCanonicalNumericSequences() {
    for (value in listOf("0", "1", "10", "1.5", "0.000001", "1000000000000000100", "100000000000000000000")) {
      assertTrue(value, isAndroidChapterDirectoryName(value))
    }
    for (value in listOf("", "1-Opening", "01", "1.0", "-1", "1e2", "NaN", "Infinity", "0.0000001")) {
      assertFalse(value, isAndroidChapterDirectoryName(value))
    }
  }
}
