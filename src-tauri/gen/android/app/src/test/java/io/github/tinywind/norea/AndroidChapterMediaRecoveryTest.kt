package io.github.tinywind.norea

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import java.util.zip.ZipFile
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AndroidChapterMediaRecoveryTest {
  @Test
  fun countsUnknownEntriesTowardTheArchiveByteLimit() {
    val bytes = repairNamedArchiveFixture((1..9).map { "unknown$it.png" })
    for (index in 0..bytes.size - 28) {
      if (bytes.copyOfRange(index, index + 4).contentEquals(byteArrayOf(80, 75, 1, 2))) {
        val declared = ANDROID_CHAPTER_MEDIA_MAX_ENTRY_BYTES
        for (shift in 0..3) bytes[index + 24 + shift] = (declared ushr (shift * 8)).toByte()
      }
    }
    val archiveFile = File.createTempFile("repair-test", ".zip")
    val temporary = File.createTempFile("repair-test", ".part")
    try {
      archiveFile.writeBytes(bytes)
      ZipFile(archiveFile).use { archive ->
        assertThrows(IllegalArgumentException::class.java) {
          recoverAndroidChapterMediaArchive(archive, emptyList(), temporary) { _, _, _ ->
            throw AssertionError("An oversized archive must not publish an asset.")
          }
        }
      }
    } finally {
      archiveFile.delete()
      temporary.delete()
    }
  }

  @Test
  fun countsDuplicateStreamEntriesBeforePublishingAnyAsset() {
    val archive = repairNamedArchiveFixture(listOf("first.png"))
    val entry = archive.copyOf(zipSignatureOffset(archive, byteArrayOf(80, 75, 1, 2)))
    val repeated = ByteArray(entry.size * (ANDROID_CHAPTER_MEDIA_MAX_ENTRIES + 1))
    for (index in 0..ANDROID_CHAPTER_MEDIA_MAX_ENTRIES) entry.copyInto(repeated, index * entry.size)
    val temporary = File.createTempFile("repair-test", ".part")
    try {
      assertThrows(IllegalArgumentException::class.java) {
        recoverAndroidChapterMediaStream(ByteArrayInputStream(repeated), listOf(
          AndroidChapterMediaStoredFile("first.png", 1),
        ), temporary) { _, _, _ -> throw AssertionError("An oversized stream must not publish an asset.") }
      }
    } finally {
      temporary.delete()
    }
  }

  @Test
  fun omitsAmbiguousStreamEntriesWithoutPublishingEitherCopy() {
    val duplicate = repairNamedArchiveFixture(listOf("first.png", "other.png", "last.png"))
      .replaceAscii("other.png", "first.png")
    val end = zipSignatureOffset(duplicate, byteArrayOf(80, 75, 1, 2))
    val temporary = File.createTempFile("repair-test", ".part")
    try {
      val recovered = mutableMapOf<String, ByteArray>()
      recoverAndroidChapterMediaStream(ByteArrayInputStream(duplicate.copyOf(end)), listOf(
        AndroidChapterMediaStoredFile("first.png", 0),
        AndroidChapterMediaStoredFile("last.png", 0),
      ), temporary) { name, file, _ -> recovered[name] = file.readBytes() }
      assertEquals(setOf("last.png"), recovered.keys)
      assertArrayEquals(byteArrayOf(3), recovered["last.png"])
    } finally {
      temporary.delete()
    }
  }

  @Test
  fun omitsDuplicateCentralEntriesAndPreservesUnrelatedAssets() {
    val duplicate = repairNamedArchiveFixture(listOf("first.png", "other.png", "last.png"))
      .replaceAscii("other.png", "first.png")
    val archiveFile = File.createTempFile("repair-test", ".zip")
    val temporary = File.createTempFile("repair-test", ".part")
    try {
      archiveFile.writeBytes(duplicate)
      val recovered = mutableSetOf<String>()
      ZipFile(archiveFile).use { archive ->
        recoverAndroidChapterMediaArchive(archive, listOf(
          AndroidChapterMediaStoredFile("first.png", 0),
          AndroidChapterMediaStoredFile("last.png", 0),
        ), temporary) { name, _, _ -> recovered.add(name) }
      }
      assertEquals(setOf("last.png"), recovered)
    } finally {
      archiveFile.delete()
      temporary.delete()
    }
  }

  private fun ByteArray.replaceAscii(from: String, to: String): ByteArray {
    require(from.length == to.length)
    val result = clone()
    val needle = from.toByteArray(Charsets.US_ASCII)
    val replacement = to.toByteArray(Charsets.US_ASCII)
    for (index in 0..result.size - needle.size) {
      if (result.copyOfRange(index, index + needle.size).contentEquals(needle)) {
        replacement.copyInto(result, index)
      }
    }
    return result
  }

  private fun zipSignatureOffset(bytes: ByteArray, signature: ByteArray): Int =
    (0..bytes.size - signature.size).first { index ->
      bytes.copyOfRange(index, index + signature.size).contentEquals(signature)
    }

  private fun repairNamedArchiveFixture(names: List<String>): ByteArray {
    val output = ByteArrayOutputStream()
    ZipOutputStream(output).use { archive ->
      names.forEachIndexed { index, name ->
        val bytes = byteArrayOf((index + 1).toByte())
        archive.putNextEntry(ZipEntry(name).apply {
          method = ZipEntry.STORED
          size = bytes.size.toLong()
          crc = CRC32().apply { update(bytes) }.value
        })
        archive.write(bytes)
        archive.closeEntry()
      }
    }
    return output.toByteArray()
  }

  @Test
  fun preservesValidNeighborsWhenOneArchiveEntryHasAnInvalidCrc() {
    val original = repairArchiveFixture()
    val corrupt = original.clone()
    val payload = byteArrayOf(41, 42, 43, 44)
    val offset = (0..corrupt.size - payload.size).first { index ->
      corrupt.copyOfRange(index, index + payload.size).contentEquals(payload)
    }
    corrupt[offset] = 0
    val archiveFile = File.createTempFile("repair-test", ".zip")
    val temporary = File.createTempFile("repair-test", ".part")
    try {
      archiveFile.writeBytes(corrupt)
      val recovered = mutableMapOf<String, ByteArray>()
      ZipFile(archiveFile).use { archive ->
        recoverAndroidChapterMediaArchive(archive, listOf(
          AndroidChapterMediaStoredFile("first.png", 0),
          AndroidChapterMediaStoredFile("broken.png", 4),
          AndroidChapterMediaStoredFile("last.png", 3),
          AndroidChapterMediaStoredFile("missing.png", 5),
        ), temporary) { name, file, _ -> recovered[name] = file.readBytes() }
      }
      assertEquals(setOf("first.png", "last.png"), recovered.keys)
      assertArrayEquals(byteArrayOf(1, 2, 3), recovered["first.png"])
      assertArrayEquals(byteArrayOf(7, 8, 9), recovered["last.png"])
      assertArrayEquals(corrupt, archiveFile.readBytes())
    } finally {
      archiveFile.delete()
      temporary.delete()
    }
  }

  @Test
  fun salvagesCompleteEntriesWhenTheCentralDirectoryWasTruncated() {
    val archive = repairArchiveFixture()
    val end = (0..archive.size - 4).first { index ->
      archive.copyOfRange(index, index + 4).contentEquals(byteArrayOf(80, 75, 1, 2))
    }
    val temporary = File.createTempFile("repair-test", ".part")
    try {
      val recovered = mutableMapOf<String, Long>()
      recoverAndroidChapterMediaStream(ByteArrayInputStream(archive.copyOf(end)), listOf(
        AndroidChapterMediaStoredFile("first.png", 3),
        AndroidChapterMediaStoredFile("broken.png", 4),
        AndroidChapterMediaStoredFile("last.png", 3),
      ), temporary) { name, _, bytes -> recovered[name] = bytes }
      assertEquals(mapOf("first.png" to 3L, "broken.png" to 4L, "last.png" to 3L), recovered)
    } finally {
      temporary.delete()
    }
  }

  private fun repairArchiveFixture(): ByteArray {
    val output = ByteArrayOutputStream()
    ZipOutputStream(output).use { archive ->
      for ((name, bytes) in listOf(
        "first.png" to byteArrayOf(1, 2, 3),
        "broken.png" to byteArrayOf(41, 42, 43, 44),
        "last.png" to byteArrayOf(7, 8, 9),
      )) {
        archive.putNextEntry(ZipEntry(name).apply {
          method = ZipEntry.STORED
          size = bytes.size.toLong()
          crc = CRC32().apply { update(bytes) }.value
        })
        archive.write(bytes)
        archive.closeEntry()
      }
    }
    return output.toByteArray()
  }

  @Test
  fun validatesOnlyStoredManifestFilesAgainstLooseMedia() {
    val stored = androidChapterMediaStoredFiles(
      listOf(
        manifestFile("remote", "remote.webp", 0),
        manifestFile("stored", "app.js", 5),
        manifestFile("stored", "reader.css", 4),
        manifestFile("stored", "font.woff2", 8),
        manifestFile("stored", "metadata.json", 2),
      ),
    )

    validateAndroidChapterMediaLooseFiles(
      stored,
      listOf(
        AndroidChapterMediaLooseFile("app.js", 5),
        AndroidChapterMediaLooseFile("reader.css", 4),
        AndroidChapterMediaLooseFile("font.woff2", 8),
        AndroidChapterMediaLooseFile("metadata.json", 2),
      ),
      requireAllStoredFiles = true,
    )

    assertEquals(
      listOf("app.js", "font.woff2", "metadata.json", "reader.css"),
      stored.map { it.fileName },
    )
  }

  @Test
  fun rejectsUnsafeDuplicateOrUnexpectedLooseMedia() {
    assertThrows(IllegalArgumentException::class.java) {
      androidChapterMediaStoredFiles(
        listOf(
          manifestFile("stored", "page.webp", 5),
          manifestFile("stored", "page.webp", 5),
        ),
      )
    }
    assertThrows(IllegalArgumentException::class.java) {
      androidChapterMediaStoredFiles(
        listOf(manifestFile("stored", "../page.webp", 5)),
      )
    }
    assertThrows(IllegalArgumentException::class.java) {
      androidChapterMediaStoredFiles(
        listOf(
          manifestFile("stored", "page.webp", 5).copy(path = "media/other.webp"),
        ),
      )
    }

    val stored = androidChapterMediaStoredFiles(
      listOf(manifestFile("stored", "page.webp", 5)),
    )
    listOf(
      listOf(AndroidChapterMediaLooseFile("page.webp.part", 5)),
      listOf(AndroidChapterMediaLooseFile("unexpected.webp", 5)),
      listOf(AndroidChapterMediaLooseFile("page.webp", 4)),
      listOf(AndroidChapterMediaLooseFile("nested", 0, isRegularFile = false)),
    ).forEach { looseFiles ->
      assertThrows(IllegalArgumentException::class.java) {
        validateAndroidChapterMediaLooseFiles(
          stored,
          looseFiles,
          requireAllStoredFiles = true,
        )
      }
    }
  }

  @Test
  fun acceptsRemainingStoredSubsetAfterArchiveWasValidated() {
    val stored = androidChapterMediaStoredFiles(
      listOf(
        manifestFile("stored", "page-1.webp", 5),
        manifestFile("stored", "page-2.webp", 4),
      ),
    )

    validateAndroidChapterMediaLooseFiles(
      stored,
      listOf(AndroidChapterMediaLooseFile("page-2.webp", 4)),
      requireAllStoredFiles = false,
    )
  }

  @Test
  fun readsRequestedArchiveEntrySizesAndOmitsMissingEntries() {
    val archive = ByteArrayOutputStream().also { output ->
      ZipOutputStream(output).use { zip ->
        zip.putNextEntry(ZipEntry("page-1.webp"))
        zip.write(byteArrayOf(1, 2, 3))
        zip.closeEntry()
        zip.putNextEntry(ZipEntry("page-2.webp"))
        zip.write(byteArrayOf(4, 5, 6, 7))
        zip.closeEntry()
      }
    }

    assertEquals(
      mapOf("page-1.webp" to 3L),
      readAndroidChapterMediaArchiveEntrySizes(
        ByteArrayInputStream(archive.toByteArray()),
        setOf("page-1.webp", "missing.webp"),
      ),
    )
  }

  @Test
  fun preservesRecoverySourceWhenSelectingArchivePublicationStagingFile() {
    assertEquals(
      "media.zip.bak",
      androidChapterMediaArchiveStagingFileName(
        recoverySourceFileName = "media.zip.rollback",
        hasBackup = false,
        hasRollback = true,
      ),
    )
    assertEquals(
      "media.zip.rollback",
      androidChapterMediaArchiveStagingFileName(
        recoverySourceFileName = "media.zip.bak",
        hasBackup = true,
        hasRollback = false,
      ),
    )
  }

  @Test
  fun recoversFirstManifestWriteFromAValidTempAfterPublishWasInterrupted() {
    val store = FakeManifestArtifactStore()
    store.renameFailureSources.add("manifest.json.tmp")

    assertThrows(IllegalStateException::class.java) {
      replaceAndroidChapterMediaManifestAtomically(
        store,
        writeTemp = { store.files["manifest.json.tmp"] = "valid:first" },
        readValid = store::readValid,
      )
    }
    assertEquals(null, store.files["manifest.json"])
    assertEquals("valid:first", store.files["manifest.json.tmp"])

    store.renameFailureSources.clear()
    val recovered = recoverAndroidChapterMediaManifestArtifacts(store, store::readValid)

    assertEquals("valid:first", recovered)
    assertEquals("valid:first", store.files["manifest.json"])
    assertEquals(null, store.files["manifest.json.tmp"])
  }

  @Test
  fun preservesManifestRecoveryPublicationFailureWhenBackupRestoreFails() {
    val store = FakeManifestArtifactStore(
      mapOf(
        "manifest.json" to "valid:published",
        "manifest.json.tmp" to "valid:temp",
      ),
    )
    store.renameFailureSources.addAll(
      listOf("manifest.json.tmp", "manifest.json.bak"),
    )

    val error = assertThrows(IllegalStateException::class.java) {
      recoverAndroidChapterMediaManifestArtifacts(store, store::readValid)
    }

    assertCompoundPublicationFailure(
      error,
      "Cannot publish Android chapter media manifest temp file.",
      "Cannot restore Android chapter media manifest backup.",
    )
  }

  @Test
  fun preservesManifestReplacementPublicationFailureWhenBackupRestoreFails() {
    val store = FakeManifestArtifactStore(
      mapOf("manifest.json" to "valid:published"),
    )
    store.renameFailureSources.addAll(
      listOf("manifest.json.tmp", "manifest.json.bak"),
    )

    val error = assertThrows(IllegalStateException::class.java) {
      replaceAndroidChapterMediaManifestAtomically(
        store,
        writeTemp = { store.files["manifest.json.tmp"] = "valid:replacement" },
        readValid = store::readValid,
      )
    }

    assertCompoundPublicationFailure(
      error,
      "Cannot publish Android chapter media manifest.",
      "Cannot restore Android chapter media manifest backup.",
    )
  }

  @Test
  fun preservesArchivePublicationFailureWhenRollbackRestoreFails() {
    val error = assertThrows(IllegalStateException::class.java) {
      publishAndroidChapterMediaArtifactWithRollback(
        publicationErrorMessage = "Cannot publish Android chapter media archive.",
        restorationErrorMessage = "Cannot restore previous Android chapter media archive.",
        publish = { false },
        restore = { false },
      )
    }

    assertCompoundPublicationFailure(
      error,
      "Cannot publish Android chapter media archive.",
      "Cannot restore previous Android chapter media archive.",
    )
  }

  @Test
  fun preservesManifestValidationFailureWhenBackupRestoreFails() {
    val store = FakeManifestArtifactStore(
      mapOf("manifest.json" to "valid:published"),
    )

    val error = assertThrows(IllegalStateException::class.java) {
      replaceAndroidChapterMediaManifestAtomically<String>(
        store,
        writeTemp = { store.files["manifest.json.tmp"] = "valid:replacement" },
        readValid = { fileName ->
          if (
            fileName == "manifest.json" &&
            store.files[fileName] == "valid:replacement"
          ) {
            store.renameFailureSources.add("manifest.json.bak")
            null
          } else {
            store.readValid(fileName)
          }
        },
      )
    }

    assertCompoundPublicationFailure(
      error,
      "Published Android chapter media manifest failed validation.",
      "Cannot restore Android chapter media manifest backup.",
    )
  }

  @Test
  fun preservesArchiveValidationFailureWhenInvalidPublicationCannotBeDeleted() {
    val error = assertThrows(IllegalStateException::class.java) {
      recoverInvalidPublishedAndroidChapterMediaArchive(
        deletePublished = { false },
        restorePrevious = null,
      )
    }

    assertCompoundPublicationFailure(
      error,
      "Published Android chapter media archive failed validation.",
      "Cannot remove invalid published chapter media archive.",
    )
  }

  @Test
  fun preservesRestoredManifestValidationFailureWhenBackupCannotBePreserved() {
    val store = FakeManifestArtifactStore(
      mapOf("manifest.json.bak" to "valid:backup"),
    )

    val error = assertThrows(IllegalStateException::class.java) {
      recoverAndroidChapterMediaManifestArtifacts(store) { fileName ->
        if (
          fileName == "manifest.json" &&
          store.files[fileName] == "valid:backup"
        ) {
          store.renameFailureSources.add("manifest.json")
          null
        } else {
          store.readValid(fileName)
        }
      }
    }

    assertCompoundPublicationFailure(
      error,
      "Restored Android chapter media manifest failed validation.",
      "Cannot preserve invalid Android chapter media manifest.",
    )
  }

  @Test
  fun replacesAnInvalidFinalManifestWithAValidTemp() {
    val store = FakeManifestArtifactStore(
      mapOf(
        "manifest.json" to "invalid:final",
        "manifest.json.tmp" to "valid:temp",
      ),
    )

    val recovered = recoverAndroidChapterMediaManifestArtifacts(store, store::readValid)

    assertEquals("valid:temp", recovered)
    assertEquals("valid:temp", store.files["manifest.json"])
    assertEquals(null, store.files["manifest.json.tmp"])
  }

  @Test
  fun prefersANewerValidTempOverAnOlderValidFinal() {
    val store = FakeManifestArtifactStore(
      mapOf(
        "manifest.json" to "valid:old-final",
        "manifest.json.tmp" to "valid:new-temp",
      ),
    )

    val recovered = recoverAndroidChapterMediaManifestArtifacts(store, store::readValid)

    assertEquals("valid:new-temp", recovered)
    assertEquals("valid:new-temp", store.files["manifest.json"])
    assertEquals(null, store.files["manifest.json.tmp"])
    assertEquals(null, store.files["manifest.json.bak"])
  }

  @Test
  fun prefersAValidTempThenFallsBackToBackup() {
    val newest = FakeManifestArtifactStore(
      mapOf(
        "manifest.json" to "invalid:final",
        "manifest.json.tmp" to "valid:temp",
        "manifest.json.bak" to "valid:backup",
      ),
    )

    assertEquals(
      "valid:temp",
      recoverAndroidChapterMediaManifestArtifacts(newest, newest::readValid),
    )
    assertEquals(null, newest.files["manifest.json.bak"])

    val fallback = FakeManifestArtifactStore(
      mapOf(
        "manifest.json.tmp" to "invalid:temp",
        "manifest.json.bak" to "valid:backup",
      ),
    )

    assertEquals(
      "valid:backup",
      recoverAndroidChapterMediaManifestArtifacts(fallback, fallback::readValid),
    )
    assertEquals("valid:backup", fallback.files["manifest.json"])
    assertEquals(null, fallback.files["manifest.json.tmp"])
  }

  @Test
  fun preservesPublishedManifestAndBackupWhenTempWriteFails() {
    val store = FakeManifestArtifactStore(
      mapOf(
        "manifest.json" to "valid:current",
        "manifest.json.bak" to "valid:backup",
      ),
    )

    assertThrows(IllegalStateException::class.java) {
      replaceAndroidChapterMediaManifestAtomically(
        store,
        writeTemp = {
          store.files["manifest.json.tmp"] = "invalid:partial"
          throw IllegalStateException("write failed")
        },
        readValid = store::readValid,
      )
    }

    assertEquals("valid:current", store.files["manifest.json"])
    assertEquals("valid:backup", store.files["manifest.json.bak"])
    assertEquals("invalid:partial", store.files["manifest.json.tmp"])
  }

  @Test
  fun writesAndReopensAnExactArchive() {
    val bodies = mapOf(
      "page-1.webp" to "alpha".toByteArray(),
      "page-2.webp" to "beta".toByteArray(),
    )
    val stored = bodies.map { (fileName, body) ->
      AndroidChapterMediaStoredFile(fileName, body.size.toLong())
    }
    val output = ByteArrayOutputStream()

    writeAndroidChapterMediaArchive(stored, output) { fileName ->
      ByteArrayInputStream(bodies.getValue(fileName))
    }

    validateAndroidChapterMediaArchive(
      stored,
      ByteArrayInputStream(output.toByteArray()),
    )
  }

  @Test
  fun mergesExistingArchiveEntriesAndPrefersSameLengthLooseFiles() {
    val stored = listOf(
      AndroidChapterMediaStoredFile("page-1.webp", 5),
      AndroidChapterMediaStoredFile("page-2.webp", 4),
    )
    val existingBodies = mapOf(
      "page-1.webp" to "alpha".toByteArray(),
      "page-2.webp" to "zeta".toByteArray(),
    )
    val existingOutput = ByteArrayOutputStream()
    writeAndroidChapterMediaArchive(
      existingBodies.map { (fileName, body) ->
        AndroidChapterMediaStoredFile(fileName, body.size.toLong())
      },
      existingOutput,
    ) { fileName -> ByteArrayInputStream(existingBodies.getValue(fileName)) }
    val existingBytes = existingOutput.toByteArray()
    validateAndroidChapterMediaArchive(stored, ByteArrayInputStream(existingBytes))
    val mergedOutput = ByteArrayOutputStream()

    mergeAndroidChapterMediaArchive(
      storedFiles = stored,
      looseFileNames = setOf("page-2.webp"),
      existingArchive = ByteArrayInputStream(existingBytes),
      output = mergedOutput,
    ) { fileName ->
      check(fileName == "page-2.webp")
      ByteArrayInputStream("beta".toByteArray())
    }

    val mergedBytes = mergedOutput.toByteArray()
    validateAndroidChapterMediaArchive(stored, ByteArrayInputStream(mergedBytes))
    val bodies = mutableMapOf<String, String>()
    ZipInputStream(ByteArrayInputStream(mergedBytes)).use { zip ->
      var entry = zip.nextEntry
      while (entry != null) {
        bodies[entry.name] = zip.readBytes().toString(Charsets.UTF_8)
        zip.closeEntry()
        entry = zip.nextEntry
      }
    }
    assertEquals(
      mapOf("page-1.webp" to "alpha", "page-2.webp" to "beta"),
      bodies,
    )
  }

  @Test
  fun rejectsTruncatedExistingArchiveDuringMerge() {
    val body = "archive-body".toByteArray()
    val crc = CRC32().apply { update(body) }.value
    val existingOutput = ByteArrayOutputStream()
    ZipOutputStream(existingOutput).use { zip ->
      val entry = ZipEntry("page-1.bin").apply {
        method = ZipEntry.STORED
        size = body.size.toLong()
        compressedSize = body.size.toLong()
        this.crc = crc
      }
      zip.putNextEntry(entry)
      zip.write(body)
      zip.closeEntry()
    }
    val archiveBytes = existingOutput.toByteArray()
    val bodyOffset = archiveBytes.indexOfSlice(body)
    check(bodyOffset >= 0)
    val truncatedArchive = archiveBytes.copyOf(bodyOffset + body.size - 1)

    assertThrows(Exception::class.java) {
      mergeAndroidChapterMediaArchive(
        storedFiles = listOf(
          AndroidChapterMediaStoredFile("page-1.bin", body.size.toLong()),
          AndroidChapterMediaStoredFile("page-2.bin", 4),
        ),
        looseFileNames = setOf("page-2.bin"),
        existingArchive = ByteArrayInputStream(truncatedArchive),
        output = ByteArrayOutputStream(),
      ) { ByteArrayInputStream("beta".toByteArray()) }
    }
  }

  @Test
  fun rejectsArchiveEntriesOutsideTheManifest() {
    val output = ByteArrayOutputStream()
    ZipOutputStream(output).use { zip ->
      zip.putNextEntry(ZipEntry("page.webp"))
      zip.write("alpha".toByteArray())
      zip.closeEntry()
      zip.putNextEntry(ZipEntry("unexpected.webp"))
      zip.write("beta".toByteArray())
      zip.closeEntry()
    }

    assertThrows(IllegalArgumentException::class.java) {
      validateAndroidChapterMediaArchive(
        listOf(AndroidChapterMediaStoredFile("page.webp", 5)),
        ByteArrayInputStream(output.toByteArray()),
      )
    }
  }

  @Test
  fun acceptsEmptyArchivesWithAndWithoutComments() {
    for (comment in listOf("", "partial media")) {
      val output = ByteArrayOutputStream()
      ZipOutputStream(output).use { it.setComment(comment) }

      validateAndroidChapterMediaArchive(emptyList(), ByteArrayInputStream(output.toByteArray()))
    }
  }

  @Test
  fun rejectsMalformedEmptyArchives() {
    val output = ByteArrayOutputStream()
    ZipOutputStream(output).use { }
    val emptyArchive = output.toByteArray()
    val invalidArchives = listOf(
      byteArrayOf(),
      "damaged archive preserved".toByteArray(),
      emptyArchive.copyOf(21),
      emptyArchive + byteArrayOf(0),
      emptyArchive.copyOf().apply { this[20] = 1 },
      emptyArchive.copyOf().apply { this[4] = 1 },
      emptyArchive.copyOf().apply { this[10] = 1 },
      emptyArchive.copyOf().apply { this[16] = 1 },
    )

    for (bytes in invalidArchives) {
      assertThrows(Exception::class.java) {
        validateAndroidChapterMediaArchive(emptyList(), ByteArrayInputStream(bytes))
      }
    }
  }

  @Test
  fun rejectsArchiveDataWithAnInvalidCrc() {
    val body = "unchanged-body".toByteArray()
    val crc = CRC32().apply { update(body) }.value
    val output = ByteArrayOutputStream()
    ZipOutputStream(output).use { zip ->
      val entry = ZipEntry("page.bin").apply {
        method = ZipEntry.STORED
        size = body.size.toLong()
        compressedSize = body.size.toLong()
        this.crc = crc
      }
      zip.putNextEntry(entry)
      zip.write(body)
      zip.closeEntry()
    }
    val corrupted = output.toByteArray()
    val bodyOffset = corrupted.indexOfSlice(body)
    check(bodyOffset >= 0)
    corrupted[bodyOffset] = (corrupted[bodyOffset].toInt() xor 1).toByte()

    assertThrows(Exception::class.java) {
      validateAndroidChapterMediaArchive(
        listOf(AndroidChapterMediaStoredFile("page.bin", body.size.toLong())),
        ByteArrayInputStream(corrupted),
      )
    }
  }

  private fun manifestFile(
    status: String,
    fileName: String,
    bytes: Long,
  ): AndroidChapterMediaManifestFile =
    AndroidChapterMediaManifestFile(
      bytes = bytes,
      fileName = fileName,
      path = "media/$fileName",
      status = status,
    )

  private fun assertCompoundPublicationFailure(
    error: IllegalStateException,
    publicationMessage: String,
    restorationMessage: String,
  ) {
    assertEquals("$publicationMessage $restorationMessage", error.message)
    assertEquals(publicationMessage, error.cause?.message)
    assertEquals(listOf(restorationMessage), error.suppressed.map { it.message })
  }

  private class FakeManifestArtifactStore(
    initialFiles: Map<String, String> = emptyMap(),
  ) : AndroidChapterMediaManifestArtifactStore {
    val files = initialFiles.toMutableMap()
    val renameFailureSources = mutableSetOf<String>()

    override fun delete(fileName: String): Boolean = files.remove(fileName) != null

    override fun exists(fileName: String): Boolean = fileName in files

    override fun isFile(fileName: String): Boolean = fileName in files

    override fun rename(sourceFileName: String, targetFileName: String): Boolean {
      if (sourceFileName in renameFailureSources || targetFileName in files) return false
      val value = files[sourceFileName] ?: return false
      files.remove(sourceFileName)
      files[targetFileName] = value
      return true
    }

    fun readValid(fileName: String): String? =
      files[fileName]?.takeIf { it.startsWith("valid:") }
  }

  private fun ByteArray.indexOfSlice(target: ByteArray): Int {
    if (target.isEmpty()) return 0
    for (start in 0..size - target.size) {
      if (target.indices.all { offset -> this[start + offset] == target[offset] }) {
        return start
      }
    }
    return -1
  }
}
