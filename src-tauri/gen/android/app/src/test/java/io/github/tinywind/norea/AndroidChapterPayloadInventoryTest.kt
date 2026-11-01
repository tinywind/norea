package io.github.tinywind.norea

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidChapterPayloadInventoryTest {
  @Test
  fun hashesBytesAndEnforcesTheLimit() {
    val value = hashAndroidChapterPayload("abc".byteInputStream(), 3)
    assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", value.sha256)
    assertEquals(3L, value.bytes)
    assertEquals(0x352441c2L, value.crc)
    try {
      hashAndroidChapterPayload("abcd".byteInputStream(), 3)
      throw AssertionError("Expected the byte limit to reject the input")
    } catch (_: IllegalArgumentException) { }
  }

  @Test
  fun missingDirectoriesAreDistinctFromListingFailures() {
    val directories = mapOf("root" to mapOf("work" to "work"), "work" to emptyMap())
    assertEquals(null, resolveAndroidChapterDirectory("root", listOf("work", "chapter")) { directories.getValue(it) })
    try {
      resolveAndroidChapterDirectory("root", listOf("work", "chapter")) {
        if (it == "work") throw SecurityException("Access denied")
        directories.getValue(it)
      }
      throw AssertionError("Expected directory access failure")
    } catch (_: SecurityException) { }
  }

  @Test
  fun interruptedInstallBackupIsNotIgnored() {
    try {
      resolveAndroidChapterDirectory("root", listOf("chapter")) {
        mapOf("chapter" to "published", ".chapter.norea-sync-backup" to "backup")
      }
      throw AssertionError("Expected an interrupted installation to be rejected")
    } catch (_: IllegalStateException) { }
  }

  @Test
  fun rejectsPhysicalChangesAndAcceptsStableOrMissingSnapshots() {
    val first = hashAndroidChapterPayload("body".byteInputStream(), 8).sha256
    val changed = hashAndroidChapterPayload("other".byteInputStream(), 8).sha256
    requireStableAndroidChapterPayload(first, first)
    requireStableAndroidChapterPayload(null, null)
    try {
      requireStableAndroidChapterPayload(first, changed)
      throw AssertionError("Expected changed payload to be rejected")
    } catch (_: IllegalStateException) { }
    try {
      requireStableAndroidChapterPayload(null, first)
      throw AssertionError("Expected newly created payload to be rejected")
    } catch (_: IllegalStateException) { }
  }

  @Test
  fun treatsMalformedArchivesAsIncomparableButPropagatesReadFailure() {
    assertTrue(inspectAndroidChapterArchive { })
    assertFalse(inspectAndroidChapterArchive { throw java.util.zip.ZipException("Invalid ZIP") })
    assertFalse(inspectAndroidChapterArchive { throw IllegalArgumentException("Duplicate ZIP entry") })
    try {
      inspectAndroidChapterArchive { throw java.io.IOException("Permission denied") }
      throw AssertionError("Expected storage failure to propagate")
    } catch (error: java.io.IOException) {
      assertEquals("Permission denied", error.message)
    }
  }

  @Test
  fun validatesArchiveStructureBeforeAcceptingInventory() {
    val root = generateSequence(java.io.File(".").canonicalFile) { it.parentFile }
      .first { java.io.File(it, "CLAUDE.md").isFile && java.io.File(it, "src-tauri").isDirectory }
    val tempDir = java.io.File(root, ".tmp").apply { mkdirs() }
    val file = java.io.File.createTempFile("norea-inventory-", ".zip", tempDir)
    try {
      java.util.zip.ZipOutputStream(file.outputStream()).use { zip ->
        zip.putNextEntry(java.util.zip.ZipEntry("image.png"))
        zip.write("image".toByteArray())
        zip.closeEntry()
      }
      assertTrue(inspectAndroidChapterArchive {
        java.util.zip.ZipFile(file).use { validateAndroidChapterMediaInventory(emptySet(), it, file) }
      })
      file.writeBytes(byteArrayOf(1, 2, 3))
      assertFalse(inspectAndroidChapterArchive {
        java.util.zip.ZipFile(file).use { validateAndroidChapterMediaInventory(emptySet(), it, file) }
      })
    } finally {
      file.delete()
    }
  }

  @Test
  fun retainsDeletionErrorsWhenRemainingInspectionFails() {
    val failure = androidChapterDeleteInspectionError(
      IllegalStateException("Manifest unreadable"),
      listOf("media.zip" to "Permission denied", "content.pdf" to "Busy"),
    )
    assertTrue(failure.message!!.contains("Manifest unreadable"))
    assertTrue(failure.message!!.contains("media.zip: Permission denied"))
    assertTrue(failure.message!!.contains("content.pdf: Busy"))
  }

  @Test
  fun payloadSelectionPreservesMetadata() {
    assertTrue("content.html" in ANDROID_CHAPTER_PAYLOAD_NAMES)
    assertTrue("media.zip.rollback" in ANDROID_CHAPTER_PAYLOAD_NAMES)
    assertFalse("manifest.json" in ANDROID_CHAPTER_PAYLOAD_NAMES)
    assertFalse("novel.json" in ANDROID_CHAPTER_PAYLOAD_NAMES)
    assertFalse("cover.jpg" in ANDROID_CHAPTER_PAYLOAD_NAMES)
  }
}
