package io.github.tinywind.norea

import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AndroidChapterMediaInventoryTest {
  private fun manifestFile(
    name: String = "page.png",
    path: String = "media/$name",
  ) = AndroidChapterMediaDeclaredFile(fileName = name, path = path)

  private fun withArchive(names: List<String>, attributes: Long? = null, inspect: (ZipFile, File) -> Unit) {
    val file = File.createTempFile("chapter-inventory-", ".zip")
    try {
      ZipOutputStream(file.outputStream()).use { zip ->
        for (name in names) {
          zip.putNextEntry(ZipEntry(name))
          zip.write(byteArrayOf(1, 2, 3))
          zip.closeEntry()
        }
      }
      if (attributes != null) {
        val bytes = file.readBytes()
        val central = (0..bytes.size - 46).first { index ->
          bytes[index] == 0x50.toByte() && bytes[index + 1] == 0x4b.toByte() &&
            bytes[index + 2] == 0x01.toByte() && bytes[index + 3] == 0x02.toByte()
        }
        for (offset in 0..3) bytes[central + 38 + offset] = (attributes ushr (8 * offset)).toByte()
        file.writeBytes(bytes)
      }
      ZipFile(file).use { inspect(it, file) }
    } finally {
      file.delete()
    }
  }

  @Test fun usesEveryDeclaredAssetAndAcceptsSafeExtraEntries() {
    val names = androidChapterMediaDeclaredFileNames(listOf(
      manifestFile("first.png", ""),
      manifestFile("second.png", ""),
    ))
    assertEquals(setOf("first.png", "second.png"), names)
    withArchive(listOf("first.png", "second.png", "extra.png", "extras/", "extras/\u00e9.png")) { archive, file ->
      validateAndroidChapterMediaInventory(names, archive, file)
    }
  }

  @Test fun requiresEveryDeclaredAssetInTheZip() {
    val names = androidChapterMediaDeclaredFileNames(listOf(manifestFile(path = "")))
    withArchive(listOf("other.png")) { archive, file ->
      assertThrows(IllegalArgumentException::class.java) { validateAndroidChapterMediaInventory(names, archive, file) }
    }
  }

  @Test fun rechecksCompleteIncompleteAndCompleteInventories() {
    val names = androidChapterMediaDeclaredFileNames(listOf(manifestFile("first.png"), manifestFile("second.png")))
    withArchive(listOf("first.png", "second.png")) { archive, file -> validateAndroidChapterMediaInventory(names, archive, file) }
    withArchive(listOf("first.png")) { archive, file ->
      assertThrows(IllegalArgumentException::class.java) { validateAndroidChapterMediaInventory(names, archive, file) }
    }
    withArchive(listOf("first.png", "second.png")) { archive, file -> validateAndroidChapterMediaInventory(names, archive, file) }
  }

  @Test fun rejectsUnsafeOrDuplicateManifestDeclarations() {
    for (files in listOf(
      listOf(manifestFile("../page.png", "")),
      listOf(manifestFile("page.png", "../page.png")),
      listOf(manifestFile("page.png"), manifestFile("PAGE.png")),
      listOf(manifestFile("CON.png", "")),
    )) {
      assertThrows(IllegalArgumentException::class.java) { androidChapterMediaDeclaredFileNames(files) }
    }
  }

  @Test fun rejectsUnsafeOrDuplicateExtraZipEntries() {
    for (names in listOf(listOf("page.png", "../extra.png"), listOf("page.png", "PAGE.png"))) {
      withArchive(names) { archive, file ->
        assertThrows(IllegalArgumentException::class.java) { validateAndroidChapterMediaInventory(setOf("page.png"), archive, file) }
      }
    }
  }

  @Test fun rejectsSymlinksNonRegularModesAndMislabelledDirectories() {
    for (attributes in listOf(0xa1ff0000L, 0x40000000L, 0x10000000L, 0x10L)) {
      withArchive(listOf("page.png"), attributes) { archive, file ->
        assertThrows(IllegalArgumentException::class.java) {
          validateAndroidChapterMediaInventory(setOf("page.png"), archive, file)
        }
      }
    }
    withArchive(listOf("extras/"), 0x80000000L) { archive, file ->
      assertThrows(IllegalArgumentException::class.java) {
        validateAndroidChapterMediaInventory(emptySet(), archive, file)
      }
    }
  }

  @Test fun acceptsAnEmptyValidArchiveWhenNoAssetsAreDeclared() {
    withArchive(emptyList()) { archive, file -> validateAndroidChapterMediaInventory(emptySet(), archive, file) }
  }

  @Test fun rejectsMalformedAndTruncatedArchives() {
    val file = File.createTempFile("chapter-inventory-", ".zip")
    try {
      file.writeText("not a zip")
      assertThrows(java.util.zip.ZipException::class.java) { ZipFile(file).close() }
      ZipOutputStream(file.outputStream()).use { zip ->
        zip.putNextEntry(ZipEntry("page.png"))
        zip.write(byteArrayOf(1, 2, 3))
        zip.closeEntry()
      }
      file.writeBytes(file.readBytes().dropLast(12).toByteArray())
      assertThrows(java.util.zip.ZipException::class.java) { ZipFile(file).close() }
    } finally {
      file.delete()
    }
  }
}
