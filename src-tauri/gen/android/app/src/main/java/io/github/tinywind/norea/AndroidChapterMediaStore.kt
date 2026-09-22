package io.github.tinywind.norea

import android.content.ContentResolver
import androidx.documentfile.provider.DocumentFile
import org.json.JSONObject
import java.io.EOFException
import java.util.zip.ZipException

private const val CHAPTER_MEDIA_DIRECTORY = "media"
private const val MAX_CHAPTER_MEDIA_MANIFEST_BYTES = 8L * BYTES_PER_MIB

private class AndroidChapterMediaManifestDocumentStore(
  private val directory: DocumentFile,
) : AndroidChapterMediaManifestArtifactStore {
  override fun delete(fileName: String): Boolean =
    directory.findFile(fileName)?.delete() ?: true

  override fun exists(fileName: String): Boolean = directory.findFile(fileName) != null

  override fun isFile(fileName: String): Boolean = directory.findFile(fileName)?.isFile == true

  override fun rename(sourceFileName: String, targetFileName: String): Boolean {
    if (directory.findFile(targetFileName) != null) return false
    return directory.findFile(sourceFileName)?.renameTo(targetFileName) == true
  }
}


internal class AndroidChapterMediaStore(
  private val contentResolver: ContentResolver,
  private val storage: AndroidStorageDocuments,
) {
  data class ChapterMediaManifest(
    val complete: Boolean,
    val files: List<AndroidChapterMediaManifestFile>,
    val json: JSONObject,
  )

  private data class ChapterMediaManifestReadResult(
    val exists: Boolean,
    val manifest: ChapterMediaManifest?,
  )

  private data class ChapterMediaLooseDocument(
    val document: DocumentFile,
    val file: AndroidChapterMediaLooseFile,
  )

  private fun chapterMediaJsonLong(value: Any?, field: String): Long {
    val number = value as? Number
      ?: throw IllegalArgumentException("Chapter media manifest $field is not a number.")
    val doubleValue = number.toDouble()
    val longValue = number.toLong()
    require(doubleValue.isFinite() && doubleValue == longValue.toDouble() && longValue >= 0L) {
      "Chapter media manifest $field is invalid."
    }
    return longValue
  }

  private fun parseChapterMediaManifest(json: JSONObject): ChapterMediaManifest {
    require(chapterMediaJsonLong(json.opt("version"), "version") == 1L) {
      "Chapter media manifest version is unsupported."
    }
    val complete = json.opt("complete") as? Boolean
      ?: throw IllegalArgumentException("Chapter media manifest completion state is invalid.")
    chapterMediaJsonLong(json.opt("updatedAt"), "updatedAt")
    val media = json.optJSONObject("media")
      ?: throw IllegalArgumentException("Chapter media manifest media value is invalid.")
    val filesJson = media.optJSONArray("files")
      ?: throw IllegalArgumentException("Chapter media manifest file list is invalid.")
    require(filesJson.length() <= ANDROID_CHAPTER_MEDIA_MAX_ENTRIES) {
      "Chapter media manifest has too many files."
    }
    val files = (0 until filesJson.length()).map { index ->
      val file = filesJson.optJSONObject(index)
        ?: throw IllegalArgumentException("Chapter media manifest file entry is invalid.")
      val bytes = chapterMediaJsonLong(file.opt("bytes"), "file bytes")
      require(bytes <= ANDROID_CHAPTER_MEDIA_MAX_ENTRY_BYTES) {
        "Chapter media manifest file exceeds the byte limit."
      }
      val fileName = file.opt("fileName") as? String
        ?: throw IllegalArgumentException("Chapter media manifest file name is invalid.")
      val path = file.opt("path") as? String
        ?: throw IllegalArgumentException("Chapter media manifest file path is invalid.")
      file.opt("sourceUrl") as? String
        ?: throw IllegalArgumentException("Chapter media manifest source URL is invalid.")
      val status = file.opt("status") as? String
        ?: throw IllegalArgumentException("Chapter media manifest file status is invalid.")
      chapterMediaJsonLong(file.opt("updatedAt"), "file updatedAt")
      if (file.has("contentType") && !file.isNull("contentType")) {
        require(file.opt("contentType") is String) {
          "Chapter media manifest content type is invalid."
        }
      }
      AndroidChapterMediaManifestFile(
        bytes = bytes,
        fileName = fileName,
        path = path,
        status = status,
      )
    }
    androidChapterMediaStoredFiles(files)
    return ChapterMediaManifest(
      complete = complete,
      files = files,
      json = json,
    )
  }

  private fun readChapterMediaManifestDocument(
    rootUri: String,
    relativePath: String,
    document: DocumentFile,
  ): ChapterMediaManifest? {
    if (!document.isFile) return null
    if (!document.canRead()) {
      throw IllegalStateException("Android chapter media manifest is not readable.")
    }
    val raw = try {
      storage.openStorageInputStream(rootUri, relativePath, document)?.use { input ->
        storage.readBytesWithLimit(input, MAX_CHAPTER_MEDIA_MANIFEST_BYTES)
          .toString(Charsets.UTF_8)
      } ?: throw IllegalStateException("Cannot open Android chapter media manifest.")
    } catch (_: IllegalArgumentException) {
      return null
    }
    return try {
      parseChapterMediaManifest(JSONObject(raw))
    } catch (_: Exception) {
      null
    }
  }

  private fun readChapterMediaManifest(
    rootUri: String,
    directory: DocumentFile,
    relativeDir: String,
  ): ChapterMediaManifestReadResult {
    val store = AndroidChapterMediaManifestDocumentStore(directory)
    val manifestExists = listOf(
      CHAPTER_MEDIA_MANIFEST_FILE,
      CHAPTER_MEDIA_MANIFEST_TEMP_FILE,
      CHAPTER_MEDIA_MANIFEST_BACKUP_FILE,
    ).any(store::exists)
    fun readValid(fileName: String): ChapterMediaManifest? {
      val document = directory.findFile(fileName) ?: return null
      return readChapterMediaManifestDocument(
        rootUri,
        "$relativeDir/$fileName",
        document,
      )
    }
    return ChapterMediaManifestReadResult(
      exists = manifestExists,
      manifest = recoverAndroidChapterMediaManifestArtifacts(store, ::readValid),
    )
  }

  fun writeChapterMediaManifestAtomically(
    rootUri: String,
    directory: DocumentFile,
    relativeDir: String,
    body: ByteArray,
  ): ChapterMediaManifest {
    val store = AndroidChapterMediaManifestDocumentStore(directory)
    fun readValid(fileName: String): ChapterMediaManifest? {
      val document = directory.findFile(fileName) ?: return null
      return readChapterMediaManifestDocument(
        rootUri,
        "$relativeDir/$fileName",
        document,
      )
    }
    return replaceAndroidChapterMediaManifestAtomically(
      store,
      writeTemp = {
        val tempRelativePath = "$relativeDir/$CHAPTER_MEDIA_MANIFEST_TEMP_FILE"
        val tempManifest = storage.ensureStorageFile(
          rootUri,
          tempRelativePath,
          "application/octet-stream",
        )
        contentResolver.openOutputStream(tempManifest.uri, "wt")?.use { output ->
          output.write(body)
        } ?: throw IllegalStateException("Cannot write Android chapter media manifest temp file.")
      },
      readValid = ::readValid,
    )
  }

  private fun chapterMediaLooseDocuments(
    directory: DocumentFile,
  ): List<ChapterMediaLooseDocument>? {
    val documents = mutableListOf<ChapterMediaLooseDocument>()
    for (document in directory.listFiles()) {
      val fileName = document.name ?: return null
      val isRegularFile = document.isFile
      if (isRegularFile && !document.canRead()) {
        throw IllegalStateException("Android staged chapter media file is not readable.")
      }
      documents.add(
        ChapterMediaLooseDocument(
          document = document,
          file = AndroidChapterMediaLooseFile(
            fileName = fileName,
            bytes = if (isRegularFile) document.length() else 0L,
            isRegularFile = isRegularFile,
          ),
        ),
      )
    }
    return documents
  }

  private fun hasValidChapterMediaLooseFiles(
    storedFiles: List<AndroidChapterMediaStoredFile>,
    looseFiles: List<AndroidChapterMediaLooseFile>,
    requireAllStoredFiles: Boolean,
  ): Boolean = try {
    validateAndroidChapterMediaLooseFiles(
      storedFiles,
      looseFiles,
      requireAllStoredFiles,
    )
    true
  } catch (_: IllegalArgumentException) {
    false
  } catch (_: ArithmeticException) {
    false
  }

  private fun hasValidChapterMediaArchive(
    rootUri: String,
    relativePath: String,
    archive: DocumentFile,
    storedFiles: List<AndroidChapterMediaStoredFile>,
  ): Boolean {
    if (!archive.isFile) return false
    if (!archive.canRead()) {
      throw IllegalStateException("Android chapter media archive is not readable.")
    }
    val input = storage.openStorageInputStream(rootUri, relativePath, archive)
      ?: throw IllegalStateException("Cannot open Android chapter media archive.")
    return try {
      input.use { validateAndroidChapterMediaArchive(storedFiles, it) }
      true
    } catch (_: IllegalArgumentException) {
      false
    } catch (_: ArithmeticException) {
      false
    } catch (_: EOFException) {
      false
    } catch (_: ZipException) {
      false
    }
  }

  private fun deleteChapterMediaLooseDirectory(
    directory: DocumentFile,
    relativeDir: String,
  ) {
    directory.listFiles().forEach { child ->
      if (!child.delete()) {
        throw IllegalStateException("Cannot remove staged chapter media file: ${child.name}")
      }
    }
    if (!directory.delete()) {
      throw IllegalStateException("Cannot remove chapter media staging directory: $relativeDir/media")
    }
  }

  private fun deleteChapterMediaArchiveWorkFiles(directory: DocumentFile): Boolean {
    for (fileName in listOf(
      CHAPTER_MEDIA_ARCHIVE_TEMP_FILE,
      CHAPTER_MEDIA_ARCHIVE_BACKUP_FILE,
      CHAPTER_MEDIA_ARCHIVE_ROLLBACK_FILE,
    )) {
      val artifact = directory.findFile(fileName) ?: continue
      if (!artifact.isFile) return false
      if (!artifact.delete()) {
        throw IllegalStateException("Cannot remove stale Android chapter media archive artifact.")
      }
    }
    return true
  }

  private fun publishValidatedChapterMediaArchive(
    rootUri: String,
    directory: DocumentFile,
    relativeDir: String,
    candidate: DocumentFile,
    storedFiles: List<AndroidChapterMediaStoredFile>,
    recoverySourceRelativePath: String? = null,
  ): DocumentFile? {
    val recoverySourceFileName = recoverySourceRelativePath?.substringAfterLast('/')
    val archiveBackup = directory.findFile(CHAPTER_MEDIA_ARCHIVE_BACKUP_FILE)
    val archiveRollback = directory.findFile(CHAPTER_MEDIA_ARCHIVE_ROLLBACK_FILE)
    val stagingFileName = androidChapterMediaArchiveStagingFileName(
      recoverySourceFileName,
      hasBackup = archiveBackup != null,
      hasRollback = archiveRollback != null,
    )
    val currentArchive = directory.findFile(CHAPTER_MEDIA_ARCHIVE_FILE)
    if (currentArchive != null) {
      val staleStagingFile = when (stagingFileName) {
        CHAPTER_MEDIA_ARCHIVE_BACKUP_FILE -> archiveBackup
        else -> archiveRollback
      }
      staleStagingFile?.let { staleArtifact ->
        if (!staleArtifact.isFile) return null
        if (!staleArtifact.delete()) {
          throw IllegalStateException("Cannot remove stale Android chapter media archive staging file.")
        }
      }
      if (!currentArchive.renameTo(stagingFileName)) {
        throw IllegalStateException("Cannot stage Android chapter media archive rollback.")
      }
    }
    publishAndroidChapterMediaArtifactWithRollback(
      publicationErrorMessage = "Cannot publish Android chapter media archive.",
      restorationErrorMessage = "Cannot restore previous Android chapter media archive.",
      publish = { candidate.renameTo(CHAPTER_MEDIA_ARCHIVE_FILE) },
      restore = if (currentArchive != null) {
        {
          val stagedArchive = directory.findFile(stagingFileName)
            ?: throw IllegalStateException(
              "Android chapter media archive rollback is unavailable.",
            )
          stagedArchive.renameTo(CHAPTER_MEDIA_ARCHIVE_FILE)
        }
      } else {
        null
      },
    )
    val published = directory.findFile(CHAPTER_MEDIA_ARCHIVE_FILE)
      ?: throw IllegalStateException("Published Android chapter media archive is unavailable.")
    if (
      !hasValidChapterMediaArchive(
        rootUri,
        "$relativeDir/$CHAPTER_MEDIA_ARCHIVE_FILE",
        published,
        storedFiles,
      )
    ) {
      recoverInvalidPublishedAndroidChapterMediaArchive(
        deletePublished = { published.delete() },
        restorePrevious = if (currentArchive != null) {
          {
            val stagedArchive = directory.findFile(stagingFileName)
              ?: throw IllegalStateException(
                "Android chapter media archive rollback is unavailable.",
              )
            stagedArchive.renameTo(CHAPTER_MEDIA_ARCHIVE_FILE)
          }
        } else {
          null
        },
      )
      return null
    }
    if (!deleteChapterMediaArchiveWorkFiles(directory)) return null
    return published
  }

  private fun createValidatedChapterMediaArchive(
    rootUri: String,
    directory: DocumentFile,
    relativeDir: String,
    storedFiles: List<AndroidChapterMediaStoredFile>,
    looseDocuments: List<ChapterMediaLooseDocument>,
    sourceArchive: DocumentFile?,
    sourceArchiveRelativePath: String?,
  ): DocumentFile? {
    val looseByName = looseDocuments.associateBy { it.file.fileName }
    val looseNames = looseByName.keys
    val needsSourceArchive = looseNames != storedFiles.mapTo(mutableSetOf()) { it.fileName }
    if (needsSourceArchive && (sourceArchive == null || sourceArchiveRelativePath == null)) {
      return null
    }
    val tempRelativePath = "$relativeDir/$CHAPTER_MEDIA_ARCHIVE_TEMP_FILE"
    directory.findFile(CHAPTER_MEDIA_ARCHIVE_TEMP_FILE)?.let { staleTemp ->
      if (!staleTemp.isFile) return null
      if (!staleTemp.delete()) {
        throw IllegalStateException("Cannot remove stale Android chapter media archive temp file.")
      }
    }
    val tempArchive = storage.ensureStorageFile(rootUri, tempRelativePath, "application/zip")
    try {
      contentResolver.openOutputStream(tempArchive.uri, "wt")?.use { output ->
        val previousArchive = if (needsSourceArchive) {
          storage.openStorageInputStream(
            rootUri,
            sourceArchiveRelativePath!!,
            sourceArchive!!,
          ) ?: throw IllegalStateException("Cannot open existing Android chapter media archive.")
        } else {
          null
        }
        mergeAndroidChapterMediaArchive(
          storedFiles = storedFiles,
          looseFileNames = looseNames,
          existingArchive = previousArchive,
          output = output,
        ) { fileName ->
          val loose = looseByName[fileName]
            ?: throw IllegalArgumentException("Stored chapter media file is unavailable.")
          storage.openStorageInputStream(
            rootUri,
            "$relativeDir/media/$fileName",
            loose.document,
          ) ?: throw IllegalStateException("Cannot open staged Android chapter media file.")
        }
      } ?: throw IllegalStateException("Cannot open Android chapter media archive for writing.")
    } catch (_: IllegalArgumentException) {
      if (!tempArchive.delete()) {
        throw IllegalStateException("Cannot remove invalid Android chapter media archive temp file.")
      }
      return null
    } catch (_: ArithmeticException) {
      if (!tempArchive.delete()) {
        throw IllegalStateException("Cannot remove invalid Android chapter media archive temp file.")
      }
      return null
    } catch (_: EOFException) {
      if (!tempArchive.delete()) {
        throw IllegalStateException("Cannot remove invalid Android chapter media archive temp file.")
      }
      return null
    } catch (_: ZipException) {
      if (!tempArchive.delete()) {
        throw IllegalStateException("Cannot remove invalid Android chapter media archive temp file.")
      }
      return null
    }
    if (!hasValidChapterMediaArchive(rootUri, tempRelativePath, tempArchive, storedFiles)) {
      if (!tempArchive.delete()) {
        throw IllegalStateException("Cannot remove invalid Android chapter media archive temp file.")
      }
      return null
    }

    return publishValidatedChapterMediaArchive(
      rootUri,
      directory,
      relativeDir,
      tempArchive,
      storedFiles,
      recoverySourceRelativePath = sourceArchiveRelativePath,
    )
  }

  private fun writeCompletedChapterMediaManifest(
    rootUri: String,
    directory: DocumentFile,
    relativeDir: String,
    manifest: ChapterMediaManifest,
  ) {
    val completeJson = JSONObject(manifest.json.toString())
      .put("complete", true)
      .put("updatedAt", System.currentTimeMillis())
    val body = "${completeJson.toString(2)}\n".toByteArray(Charsets.UTF_8)
    if (
      !writeChapterMediaManifestAtomically(
        rootUri,
        directory,
        relativeDir,
        body,
      ).complete
    ) {
      throw IllegalStateException("Completed Android chapter media manifest failed validation.")
    }
  }

  fun finalizeChapterMediaArtifacts(
    rootUri: String,
    directory: DocumentFile,
    relativeDir: String,
    allowLegacyWithoutManifest: Boolean,
  ): Long? {
    val manifestResult = readChapterMediaManifest(rootUri, directory, relativeDir)
    if (!manifestResult.exists) {
      if (!allowLegacyWithoutManifest) return null
      val legacyArchive = directory.findFile(CHAPTER_MEDIA_ARCHIVE_FILE)
      if (legacyArchive != null && legacyArchive.isFile && !legacyArchive.canRead()) {
        throw IllegalStateException("Android legacy chapter media archive is not readable.")
      }
      return legacyArchive
        ?.takeIf { it.isFile }
        ?.length()
        ?.coerceAtLeast(0L)
        ?: 0L
    }
    val manifest = manifestResult.manifest ?: return null
    val storedFiles = try {
      androidChapterMediaStoredFiles(manifest.files)
    } catch (_: IllegalArgumentException) {
      return null
    } catch (_: ArithmeticException) {
      return null
    }

    val looseDirectory = directory.findFile(CHAPTER_MEDIA_DIRECTORY)
    if (looseDirectory != null) {
      if (!looseDirectory.isDirectory) return null
      if (!looseDirectory.canRead()) {
        throw IllegalStateException("Android chapter media staging directory is not readable.")
      }
    }
    var archive = directory.findFile(CHAPTER_MEDIA_ARCHIVE_FILE)
    if (archive != null) {
      if (!archive.isFile) return null
      if (!archive.canRead()) {
        throw IllegalStateException("Android chapter media archive is not readable.")
      }
    }

    val archiveTemp = directory.findFile(CHAPTER_MEDIA_ARCHIVE_TEMP_FILE)
    val archiveBackup = directory.findFile(CHAPTER_MEDIA_ARCHIVE_BACKUP_FILE)
    val archiveRollback = directory.findFile(CHAPTER_MEDIA_ARCHIVE_ROLLBACK_FILE)
    val manifestTemp = directory.findFile(CHAPTER_MEDIA_MANIFEST_TEMP_FILE)
    val manifestBackup = directory.findFile(CHAPTER_MEDIA_MANIFEST_BACKUP_FILE)
    if (manifestTemp != null && !manifestTemp.isFile) return null
    if (manifestBackup != null && !manifestBackup.isFile) return null
    if (
      manifest.complete &&
        looseDirectory == null &&
        archiveTemp == null &&
        archiveBackup == null &&
        archiveRollback == null &&
        manifestTemp == null &&
        manifestBackup == null
    ) {
      if (storedFiles.isEmpty() && archive == null) return 0L
      if (storedFiles.isNotEmpty() && archive != null && archive.length() > 0L) {
        return archive.length().coerceAtLeast(0L)
      }
    }

    val looseDocuments = looseDirectory?.let(::chapterMediaLooseDocuments)
      ?: if (looseDirectory == null) emptyList() else return null
    var archiveValid = archive?.let {
      hasValidChapterMediaArchive(
        rootUri,
        "$relativeDir/$CHAPTER_MEDIA_ARCHIVE_FILE",
        it,
        storedFiles,
      )
    } == true

    if (!archiveValid) {
      val tempArchive = archiveTemp
      if (tempArchive != null) {
        if (!tempArchive.isFile) return null
        if (!tempArchive.canRead()) {
          throw IllegalStateException("Android chapter media archive temp file is not readable.")
        }
        if (
          hasValidChapterMediaArchive(
            rootUri,
            "$relativeDir/$CHAPTER_MEDIA_ARCHIVE_TEMP_FILE",
            tempArchive,
            storedFiles,
          )
        ) {
          archive = publishValidatedChapterMediaArchive(
            rootUri,
            directory,
            relativeDir,
            tempArchive,
            storedFiles,
          ) ?: return null
          archiveValid = true
        }
      }
    }

    if (storedFiles.isEmpty()) {
      if (
        !hasValidChapterMediaLooseFiles(
          storedFiles,
          looseDocuments.map(ChapterMediaLooseDocument::file),
          requireAllStoredFiles = true,
        )
      ) {
        return null
      }
      if (archive != null && !archiveValid) return null
      for (artifactName in listOf(
        CHAPTER_MEDIA_ARCHIVE_TEMP_FILE,
        CHAPTER_MEDIA_ARCHIVE_BACKUP_FILE,
        CHAPTER_MEDIA_ARCHIVE_ROLLBACK_FILE,
      )) {
        val artifact = directory.findFile(artifactName) ?: continue
        if (!artifact.isFile) return null
        if (!artifact.canRead()) {
          throw IllegalStateException("Android chapter media archive artifact is not readable.")
        }
        if (
          !hasValidChapterMediaArchive(
            rootUri,
            "$relativeDir/$artifactName",
            artifact,
            storedFiles,
          )
        ) {
          return null
        }
      }
      if (archive != null && !archive.delete()) {
        throw IllegalStateException("Cannot remove empty Android chapter media archive.")
      }
      if (!deleteChapterMediaArchiveWorkFiles(directory)) return null
      looseDirectory?.let { deleteChapterMediaLooseDirectory(it, relativeDir) }
      writeCompletedChapterMediaManifest(rootUri, directory, relativeDir, manifest)
      return 0L
    }

    if (
      !hasValidChapterMediaLooseFiles(
        storedFiles,
        looseDocuments.map(ChapterMediaLooseDocument::file),
        requireAllStoredFiles = false,
      )
    ) {
      return null
    }
    if (!archiveValid || looseDocuments.isNotEmpty()) {
      val looseNames = looseDocuments.mapTo(mutableSetOf()) { it.file.fileName }
      val expectedNames = storedFiles.mapTo(mutableSetOf()) { it.fileName }
      var rebuiltArchive: DocumentFile? = null
      if (looseNames == expectedNames) {
        rebuiltArchive = createValidatedChapterMediaArchive(
          rootUri,
          directory,
          relativeDir,
          storedFiles,
          looseDocuments,
          sourceArchive = null,
          sourceArchiveRelativePath = null,
        )
      } else {
        val validatedArchive = archive?.takeIf { archiveValid }
        val sourceArchives = validatedArchive?.let { source ->
          listOf(source to "$relativeDir/$CHAPTER_MEDIA_ARCHIVE_FILE")
        } ?: listOfNotNull(
          directory.findFile(CHAPTER_MEDIA_ARCHIVE_BACKUP_FILE)?.let { source ->
            source to "$relativeDir/$CHAPTER_MEDIA_ARCHIVE_BACKUP_FILE"
          },
          directory.findFile(CHAPTER_MEDIA_ARCHIVE_ROLLBACK_FILE)?.let { source ->
            source to "$relativeDir/$CHAPTER_MEDIA_ARCHIVE_ROLLBACK_FILE"
          },
          archive?.let { source ->
            source to "$relativeDir/$CHAPTER_MEDIA_ARCHIVE_FILE"
          },
        )
        for ((source, sourceRelativePath) in sourceArchives) {
          if (!source.isFile) return null
          if (!source.canRead()) {
            throw IllegalStateException("Android chapter media archive source is not readable.")
          }
          rebuiltArchive = createValidatedChapterMediaArchive(
            rootUri,
            directory,
            relativeDir,
            storedFiles,
            looseDocuments,
            source,
            sourceRelativePath,
          )
          if (rebuiltArchive != null) break
        }
      }
      archive = rebuiltArchive ?: return null
      archiveValid = true
    }
    if (!archiveValid || archive == null) return null
    if (!deleteChapterMediaArchiveWorkFiles(directory)) return null
    looseDirectory?.let { deleteChapterMediaLooseDirectory(it, relativeDir) }
    writeCompletedChapterMediaManifest(rootUri, directory, relativeDir, manifest)
    return archive.length().coerceAtLeast(0L)
  }

}
