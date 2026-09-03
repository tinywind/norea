package io.github.tinywind.norea

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ContentResolver
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.documentfile.provider.DocumentFile
import androidx.core.graphics.Insets
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.File
import java.io.InputStream
import java.io.IOException
import java.io.OutputStream
import java.security.MessageDigest
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipException
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

private const val ANDROID_CHAPTER_MEDIA_MAX_ENTRY_BYTES = 256L * 1024L * 1024L
private const val ANDROID_CHAPTER_MEDIA_MAX_ENTRIES = 100_000
private const val ANDROID_CHAPTER_MEDIA_MAX_TOTAL_BYTES = 2L * 1024L * 1024L * 1024L
private const val ANDROID_CHAPTER_MEDIA_COPY_BUFFER_BYTES = 64 * 1024
private const val CHAPTER_MEDIA_ARCHIVE_BACKUP_FILE = "media.zip.bak"
private const val CHAPTER_MEDIA_ARCHIVE_FILE = "media.zip"
private const val CHAPTER_MEDIA_ARCHIVE_ROLLBACK_FILE = "media.zip.rollback"
private const val CHAPTER_MEDIA_ARCHIVE_TEMP_FILE = "media.zip.tmp.zip"
private const val CHAPTER_MEDIA_MANIFEST_BACKUP_FILE = "manifest.json.bak"
private const val CHAPTER_MEDIA_MANIFEST_FILE = "manifest.json"
private const val CHAPTER_MEDIA_MANIFEST_TEMP_FILE = "manifest.json.tmp"
private const val NOVEL_COVER_MANIFEST_FILE = "cover.json"

internal fun resolvedAndroidFinalChapterMediaBytes(
  finalizedMediaBytes: Long?,
  existingArchiveBytes: Long?,
): Long = (finalizedMediaBytes ?: existingArchiveBytes ?: 0L).coerceAtLeast(0L)

internal data class AndroidNovelCoverInspection(
  val manifest: String,
  val relativePath: String,
  val sourceId: String?,
  val novelPath: String?,
  val sourceUrl: String,
  val updatedAt: Long,
)

internal data class AndroidNovelCoverIdentity(
  val sourceId: String?,
  val novelPath: String?,
)

internal fun parseAndroidNovelCoverIdentity(
  sourceIdValue: Any?,
  novelPathValue: Any?,
): AndroidNovelCoverIdentity? {
  if (sourceIdValue != null && sourceIdValue !is String) return null
  if (novelPathValue != null && novelPathValue !is String) return null
  return AndroidNovelCoverIdentity(
    sourceId = (sourceIdValue as? String)?.takeIf { it.isNotBlank() },
    novelPath = novelPathValue as? String,
  )
}

internal fun nonEmptyAndroidNovelCoverInspection(
  inspection: AndroidNovelCoverInspection,
  bytes: Long,
): AndroidNovelCoverInspection? =
  if (bytes > 0L) {
    inspection
  } else {
    null
  }

internal fun selectAndroidNovelCoverInspection(
  preferred: AndroidNovelCoverInspection?,
  matches: List<AndroidNovelCoverInspection>,
  sourceId: String,
  novelPath: String,
  expectedSourceUrl: String,
): AndroidNovelCoverInspection? {
  fun AndroidNovelCoverInspection.hasIdentity(): Boolean =
    this.sourceId != null || this.novelPath != null

  fun AndroidNovelCoverInspection.matchesIdentity(): Boolean =
    this.sourceId == sourceId && this.novelPath == novelPath

  if (preferred != null && (!preferred.hasIdentity() || preferred.matchesIdentity())) {
    return preferred
  }

  return matches
    .asSequence()
    .filter { candidate ->
      candidate.matchesIdentity() ||
        (!candidate.hasIdentity() &&
          expectedSourceUrl.isNotBlank() &&
          candidate.sourceUrl == expectedSourceUrl)
    }
    .sortedWith(
      compareByDescending<AndroidNovelCoverInspection> { it.updatedAt }
        .thenBy { it.relativePath },
    )
    .firstOrNull()
}

internal fun inferAndroidStorageMimeType(
  relativePath: String,
  mimeTypeForExtension: (String) -> String?,
): String {
  val extension = relativePath.substringAfterLast('.', "")
    .lowercase()
    .takeIf { it.isNotBlank() }
  return extension
    ?.let(mimeTypeForExtension)
    ?: "application/octet-stream"
}

internal fun createRawAndroidStorageFile(parent: File, name: String): File? {
  val child = File(parent, name)
  return try {
    if (child.createNewFile()) child else null
  } catch (_: IOException) {
    null
  }
}

private fun validateAndroidContentStorageRelativeDir(
  relativePath: String,
  allowedDepths: Set<Int>,
): List<String> {
  val normalized = relativePath.replace('\\', '/')
  require(!normalized.startsWith('/') && !normalized.endsWith('/')) {
    "Android chapter storage path must be relative."
  }
  val segments = normalized.split('/')
  require(
    segments.size in allowedDepths &&
      segments.firstOrNull() == "contents" &&
      segments.all { segment ->
        segment.isNotEmpty() &&
          segment == segment.trim() &&
          segment != "." &&
          segment != ".." &&
          !segment.contains('\u0000')
      },
  ) {
    "Android chapter storage path must identify a novel or chapter directory."
  }
  return segments
}

internal fun validateAndroidChapterStorageRelativeDir(relativePath: String): List<String> =
  validateAndroidContentStorageRelativeDir(relativePath, setOf(4))

internal fun validateAndroidChapterStorageRemovalRelativeDir(relativePath: String): List<String> =
  validateAndroidContentStorageRelativeDir(relativePath, setOf(3, 4))

private fun validateAndroidChapterStorageTransferToken(token: String): String {
  require(
    token.isNotEmpty() &&
      token.length <= 128 &&
      token.all { character ->
        character.code < 128 &&
          (character.isLetterOrDigit() || character == '-' || character == '_')
      },
  ) {
    "Android chapter storage transfer token is invalid."
  }
  return token
}

internal fun androidChapterStorageTransferSiblingName(
  targetName: String,
  token: String,
  kind: String,
): String {
  require(
    targetName.isNotEmpty() &&
      targetName != "." &&
      targetName != ".." &&
      !targetName.contains('/') &&
      !targetName.contains('\\') &&
      !targetName.contains('\u0000'),
  ) {
    "Android chapter storage transfer target name is invalid."
  }
  require(kind == "stage" || kind == "backup") {
    "Android chapter storage transfer workspace kind is invalid."
  }
  return ".$targetName.norea-transfer-${validateAndroidChapterStorageTransferToken(token)}.$kind"
}

internal fun androidChapterStorageTransferMarkerName(token: String): String =
  ".norea-transfer-${validateAndroidChapterStorageTransferToken(token)}"

internal fun androidChapterMediaArchiveStagingFileName(
  recoverySourceFileName: String?,
  hasBackup: Boolean,
  hasRollback: Boolean,
): String {
  require(
    recoverySourceFileName == null ||
      recoverySourceFileName == CHAPTER_MEDIA_ARCHIVE_FILE ||
      recoverySourceFileName == CHAPTER_MEDIA_ARCHIVE_BACKUP_FILE ||
      recoverySourceFileName == CHAPTER_MEDIA_ARCHIVE_ROLLBACK_FILE,
  ) {
    "Android chapter media archive recovery source is invalid."
  }
  return when {
    recoverySourceFileName == CHAPTER_MEDIA_ARCHIVE_BACKUP_FILE ->
      CHAPTER_MEDIA_ARCHIVE_ROLLBACK_FILE
    recoverySourceFileName == CHAPTER_MEDIA_ARCHIVE_ROLLBACK_FILE ->
      CHAPTER_MEDIA_ARCHIVE_BACKUP_FILE
    !hasRollback -> CHAPTER_MEDIA_ARCHIVE_ROLLBACK_FILE
    !hasBackup -> CHAPTER_MEDIA_ARCHIVE_BACKUP_FILE
    else -> CHAPTER_MEDIA_ARCHIVE_ROLLBACK_FILE
  }
}

internal interface AndroidChapterMediaManifestArtifactStore {
  fun delete(fileName: String): Boolean

  fun exists(fileName: String): Boolean

  fun isFile(fileName: String): Boolean

  fun rename(sourceFileName: String, targetFileName: String): Boolean
}

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

private fun androidChapterMediaManifestArtifactsAreFiles(
  store: AndroidChapterMediaManifestArtifactStore,
): Boolean = listOf(
  CHAPTER_MEDIA_MANIFEST_FILE,
  CHAPTER_MEDIA_MANIFEST_TEMP_FILE,
  CHAPTER_MEDIA_MANIFEST_BACKUP_FILE,
).all { fileName -> !store.exists(fileName) || store.isFile(fileName) }

private fun requireAndroidChapterMediaManifestArtifactsAreFiles(
  store: AndroidChapterMediaManifestArtifactStore,
) {
  check(androidChapterMediaManifestArtifactsAreFiles(store)) {
    "Android chapter media manifest artifact path is not a file."
  }
}

private fun deleteAndroidChapterMediaManifestArtifact(
  store: AndroidChapterMediaManifestArtifactStore,
  fileName: String,
  errorMessage: String,
) {
  if (store.exists(fileName) && !store.delete(fileName)) {
    throw IllegalStateException(errorMessage)
  }
}

internal fun publishAndroidChapterMediaArtifactWithRollback(
  publicationErrorMessage: String,
  restorationErrorMessage: String,
  publish: () -> Boolean,
  restore: (() -> Boolean)?,
) {
  if (publish()) return

  val publicationError = IllegalStateException(publicationErrorMessage)
  if (restore != null) {
    val restorationError = try {
      if (restore()) null else IllegalStateException(restorationErrorMessage)
    } catch (restorationCause: Exception) {
      IllegalStateException(restorationErrorMessage, restorationCause)
    }
    if (restorationError != null) {
      throw IllegalStateException(
        "$publicationErrorMessage $restorationErrorMessage",
        publicationError,
      ).apply {
        addSuppressed(restorationError)
      }
    }
  }
  throw publicationError
}

internal fun runAndroidChapterMediaRecoveryPreservingPrimaryFailure(
  primaryFailure: IllegalStateException,
  recovery: () -> Unit,
) {
  try {
    recovery()
  } catch (recoveryFailure: Exception) {
    throw IllegalStateException(
      "${primaryFailure.message} ${recoveryFailure.message}",
      primaryFailure,
    ).apply {
      addSuppressed(recoveryFailure)
    }
  }
}

internal fun recoverInvalidPublishedAndroidChapterMediaArchive(
  deletePublished: () -> Boolean,
  restorePrevious: (() -> Boolean)?,
) {
  val validationFailure = IllegalStateException(
    "Published Android chapter media archive failed validation.",
  )
  runAndroidChapterMediaRecoveryPreservingPrimaryFailure(validationFailure) {
    if (!deletePublished()) {
      throw IllegalStateException("Cannot remove invalid published chapter media archive.")
    }
    if (restorePrevious != null && !restorePrevious()) {
      throw IllegalStateException("Cannot restore previous Android chapter media archive.")
    }
  }
}

internal fun <T> recoverAndroidChapterMediaManifestArtifacts(
  store: AndroidChapterMediaManifestArtifactStore,
  readValid: (String) -> T?,
): T? {
  if (!androidChapterMediaManifestArtifactsAreFiles(store)) return null

  val temp = if (store.exists(CHAPTER_MEDIA_MANIFEST_TEMP_FILE)) {
    readValid(CHAPTER_MEDIA_MANIFEST_TEMP_FILE)
  } else {
    null
  }
  val publishedBeforeRecovery = if (store.exists(CHAPTER_MEDIA_MANIFEST_FILE)) {
    readValid(CHAPTER_MEDIA_MANIFEST_FILE)
  } else {
    null
  }
  if (temp != null) {
    val hadPublishedManifest = publishedBeforeRecovery != null
    if (hadPublishedManifest) {
      deleteAndroidChapterMediaManifestArtifact(
        store,
        CHAPTER_MEDIA_MANIFEST_BACKUP_FILE,
        "Cannot remove stale Android chapter media manifest backup.",
      )
      if (!store.rename(CHAPTER_MEDIA_MANIFEST_FILE, CHAPTER_MEDIA_MANIFEST_BACKUP_FILE)) {
        throw IllegalStateException("Cannot backup Android chapter media manifest.")
      }
    } else {
      deleteAndroidChapterMediaManifestArtifact(
        store,
        CHAPTER_MEDIA_MANIFEST_FILE,
        "Cannot remove invalid Android chapter media manifest.",
      )
    }
    publishAndroidChapterMediaArtifactWithRollback(
      publicationErrorMessage = "Cannot publish Android chapter media manifest temp file.",
      restorationErrorMessage = "Cannot restore Android chapter media manifest backup.",
      publish = {
        store.rename(CHAPTER_MEDIA_MANIFEST_TEMP_FILE, CHAPTER_MEDIA_MANIFEST_FILE)
      },
      restore = if (hadPublishedManifest) {
        {
          store.rename(CHAPTER_MEDIA_MANIFEST_BACKUP_FILE, CHAPTER_MEDIA_MANIFEST_FILE)
        }
      } else {
        null
      },
    )
    val published = readValid(CHAPTER_MEDIA_MANIFEST_FILE)
    if (published == null) {
      val validationFailure = IllegalStateException(
        "Published Android chapter media manifest failed validation.",
      )
      runAndroidChapterMediaRecoveryPreservingPrimaryFailure(validationFailure) {
        if (!store.rename(CHAPTER_MEDIA_MANIFEST_FILE, CHAPTER_MEDIA_MANIFEST_TEMP_FILE)) {
          throw IllegalStateException("Cannot preserve invalid Android chapter media manifest.")
        }
        if (
          hadPublishedManifest &&
          !store.rename(CHAPTER_MEDIA_MANIFEST_BACKUP_FILE, CHAPTER_MEDIA_MANIFEST_FILE)
        ) {
          throw IllegalStateException("Cannot restore Android chapter media manifest backup.")
        }
      }
      throw validationFailure
    }
    deleteAndroidChapterMediaManifestArtifact(
      store,
      CHAPTER_MEDIA_MANIFEST_BACKUP_FILE,
      "Cannot remove Android chapter media manifest backup.",
    )
    return published
  }
  if (publishedBeforeRecovery != null) return publishedBeforeRecovery

  val backup = if (store.exists(CHAPTER_MEDIA_MANIFEST_BACKUP_FILE)) {
    readValid(CHAPTER_MEDIA_MANIFEST_BACKUP_FILE)
  } else {
    null
  }
  if (backup != null) {
    deleteAndroidChapterMediaManifestArtifact(
      store,
      CHAPTER_MEDIA_MANIFEST_FILE,
      "Cannot remove invalid Android chapter media manifest.",
    )
    if (!store.rename(CHAPTER_MEDIA_MANIFEST_BACKUP_FILE, CHAPTER_MEDIA_MANIFEST_FILE)) {
      throw IllegalStateException("Cannot restore Android chapter media manifest backup.")
    }
    val published = readValid(CHAPTER_MEDIA_MANIFEST_FILE)
    if (published == null) {
      val validationFailure = IllegalStateException(
        "Restored Android chapter media manifest failed validation.",
      )
      runAndroidChapterMediaRecoveryPreservingPrimaryFailure(validationFailure) {
        if (!store.rename(CHAPTER_MEDIA_MANIFEST_FILE, CHAPTER_MEDIA_MANIFEST_BACKUP_FILE)) {
          throw IllegalStateException("Cannot preserve invalid Android chapter media manifest.")
        }
      }
      throw validationFailure
    }
    deleteAndroidChapterMediaManifestArtifact(
      store,
      CHAPTER_MEDIA_MANIFEST_TEMP_FILE,
      "Cannot remove invalid Android chapter media manifest temp file.",
    )
    return published
  }

  return null
}

internal fun <T> replaceAndroidChapterMediaManifestAtomically(
  store: AndroidChapterMediaManifestArtifactStore,
  writeTemp: () -> Unit,
  readValid: (String) -> T?,
): T {
  recoverAndroidChapterMediaManifestArtifacts(store, readValid)
  requireAndroidChapterMediaManifestArtifactsAreFiles(store)
  deleteAndroidChapterMediaManifestArtifact(
    store,
    CHAPTER_MEDIA_MANIFEST_TEMP_FILE,
    "Cannot remove stale Android chapter media manifest temp file.",
  )

  writeTemp()
  requireAndroidChapterMediaManifestArtifactsAreFiles(store)
  if (
    !store.exists(CHAPTER_MEDIA_MANIFEST_TEMP_FILE) ||
    readValid(CHAPTER_MEDIA_MANIFEST_TEMP_FILE) == null
  ) {
    throw IllegalStateException("Android chapter media manifest temp file failed validation.")
  }

  val hadPublishedManifest = store.exists(CHAPTER_MEDIA_MANIFEST_FILE)
  if (hadPublishedManifest) {
    deleteAndroidChapterMediaManifestArtifact(
      store,
      CHAPTER_MEDIA_MANIFEST_BACKUP_FILE,
      "Cannot remove stale Android chapter media manifest backup.",
    )
    if (!store.rename(CHAPTER_MEDIA_MANIFEST_FILE, CHAPTER_MEDIA_MANIFEST_BACKUP_FILE)) {
      throw IllegalStateException("Cannot backup Android chapter media manifest.")
    }
  }

  publishAndroidChapterMediaArtifactWithRollback(
    publicationErrorMessage = "Cannot publish Android chapter media manifest.",
    restorationErrorMessage = "Cannot restore Android chapter media manifest backup.",
    publish = {
      store.rename(CHAPTER_MEDIA_MANIFEST_TEMP_FILE, CHAPTER_MEDIA_MANIFEST_FILE)
    },
    restore = if (hadPublishedManifest) {
      {
        store.rename(CHAPTER_MEDIA_MANIFEST_BACKUP_FILE, CHAPTER_MEDIA_MANIFEST_FILE)
      }
    } else {
      null
    },
  )

  val published = readValid(CHAPTER_MEDIA_MANIFEST_FILE)
  if (published == null) {
    val validationFailure = IllegalStateException(
      "Published Android chapter media manifest failed validation.",
    )
    runAndroidChapterMediaRecoveryPreservingPrimaryFailure(validationFailure) {
      if (!store.rename(CHAPTER_MEDIA_MANIFEST_FILE, CHAPTER_MEDIA_MANIFEST_TEMP_FILE)) {
        throw IllegalStateException("Cannot preserve invalid Android chapter media manifest.")
      }
      if (hadPublishedManifest) {
        if (!store.rename(CHAPTER_MEDIA_MANIFEST_BACKUP_FILE, CHAPTER_MEDIA_MANIFEST_FILE)) {
          throw IllegalStateException("Cannot restore Android chapter media manifest backup.")
        }
      }
    }
    throw validationFailure
  }

  deleteAndroidChapterMediaManifestArtifact(
    store,
    CHAPTER_MEDIA_MANIFEST_BACKUP_FILE,
    "Cannot remove Android chapter media manifest backup.",
  )
  return published
}

internal data class AndroidChapterMediaManifestFile(
  val bytes: Long,
  val fileName: String,
  val path: String,
  val status: String,
)

internal data class AndroidChapterMediaStoredFile(
  val fileName: String,
  val bytes: Long,
)

internal data class AndroidChapterMediaLooseFile(
  val fileName: String,
  val bytes: Long,
  val isRegularFile: Boolean = true,
)

private fun isSafeAndroidChapterMediaFileName(fileName: String): Boolean =
  fileName.isNotEmpty() &&
    fileName == fileName.trim() &&
    fileName != "." &&
    fileName != ".." &&
    !fileName.contains('/') &&
    !fileName.contains('\\') &&
    !fileName.contains('\u0000') &&
    fileName.all { character ->
      character.isLetterOrDigit() ||
        character == '.' ||
        character == '_' ||
        character == '-'
    }

private fun requireAndroidChapterMediaStoredFiles(
  storedFiles: List<AndroidChapterMediaStoredFile>,
) {
  require(storedFiles.size <= ANDROID_CHAPTER_MEDIA_MAX_ENTRIES) {
    "Chapter media manifest has too many stored files."
  }
  val fileNames = mutableSetOf<String>()
  var totalBytes = 0L
  storedFiles.forEach { file ->
    require(isSafeAndroidChapterMediaFileName(file.fileName)) {
      "Chapter media manifest contains an unsafe stored file name."
    }
    require(fileNames.add(file.fileName)) {
      "Chapter media manifest contains a duplicate stored file name."
    }
    require(file.bytes in 0L..ANDROID_CHAPTER_MEDIA_MAX_ENTRY_BYTES) {
      "Chapter media manifest stored file size is invalid."
    }
    totalBytes = Math.addExact(totalBytes, file.bytes)
    require(totalBytes <= ANDROID_CHAPTER_MEDIA_MAX_TOTAL_BYTES) {
      "Chapter media manifest stored files exceed the total byte limit."
    }
  }
}

internal fun androidChapterMediaStoredFiles(
  manifestFiles: List<AndroidChapterMediaManifestFile>,
): List<AndroidChapterMediaStoredFile> {
  require(manifestFiles.size <= ANDROID_CHAPTER_MEDIA_MAX_ENTRIES) {
    "Chapter media manifest has too many files."
  }
  val storedFiles = manifestFiles.mapNotNull { file ->
    require(file.status == "remote" || file.status == "stored") {
      "Chapter media manifest contains an invalid file status."
    }
    if (file.status == "remote") return@mapNotNull null
    require(isSafeAndroidChapterMediaFileName(file.fileName)) {
      "Chapter media manifest contains an unsafe stored file name."
    }
    require(file.path == "media/${file.fileName}") {
      "Chapter media manifest stored path does not match its file name."
    }
    AndroidChapterMediaStoredFile(file.fileName, file.bytes)
  }.sortedBy(AndroidChapterMediaStoredFile::fileName)
  requireAndroidChapterMediaStoredFiles(storedFiles)
  return storedFiles
}

internal fun validateAndroidChapterMediaLooseFiles(
  storedFiles: List<AndroidChapterMediaStoredFile>,
  looseFiles: List<AndroidChapterMediaLooseFile>,
  requireAllStoredFiles: Boolean,
) {
  requireAndroidChapterMediaStoredFiles(storedFiles)
  val expectedByName = storedFiles.associateBy(AndroidChapterMediaStoredFile::fileName)
  val looseNames = mutableSetOf<String>()
  looseFiles.forEach { loose ->
    require(loose.isRegularFile && isSafeAndroidChapterMediaFileName(loose.fileName)) {
      "Chapter media staging directory contains an unsupported entry."
    }
    require(!loose.fileName.endsWith(".part")) {
      "Chapter media staging directory contains a partial file."
    }
    require(looseNames.add(loose.fileName)) {
      "Chapter media staging directory contains a duplicate file name."
    }
    val expected = expectedByName[loose.fileName]
      ?: throw IllegalArgumentException(
        "Chapter media staging directory contains an unexpected file.",
      )
    require(loose.bytes == expected.bytes) {
      "Chapter media staged file size does not match its manifest entry."
    }
  }
  if (requireAllStoredFiles) {
    require(looseNames == expectedByName.keys) {
      "Chapter media staging directory is missing a stored manifest file."
    }
  }
}

private fun copyAndroidChapterMediaFile(
  input: InputStream,
  output: OutputStream,
  expectedBytes: Long,
) {
  val buffer = ByteArray(ANDROID_CHAPTER_MEDIA_COPY_BUFFER_BYTES)
  var copied = 0L
  while (true) {
    val read = input.read(buffer)
    if (read < 0) break
    copied = Math.addExact(copied, read.toLong())
    require(copied <= expectedBytes) {
      "Chapter media file is larger than its manifest entry."
    }
    output.write(buffer, 0, read)
  }
  require(copied == expectedBytes) {
    "Chapter media file is smaller than its manifest entry."
  }
}

internal fun writeAndroidChapterMediaArchive(
  storedFiles: List<AndroidChapterMediaStoredFile>,
  output: OutputStream,
  openFile: (String) -> InputStream?,
) {
  mergeAndroidChapterMediaArchive(
    storedFiles = storedFiles,
    looseFileNames = storedFiles.mapTo(mutableSetOf()) { it.fileName },
    existingArchive = null,
    output = output,
    openLooseFile = openFile,
  )
}

private fun consumeAndroidChapterMediaArchiveEntry(
  zip: ZipInputStream,
  entry: ZipEntry,
  expectedBytes: Long?,
  output: OutputStream?,
): Long {
  require(entry.size < 0L || entry.size <= ANDROID_CHAPTER_MEDIA_MAX_ENTRY_BYTES) {
    "Chapter media archive entry exceeds the byte limit."
  }
  if (expectedBytes != null) {
    require(entry.size < 0L || entry.size == expectedBytes) {
      "Chapter media archive entry size does not match its manifest entry."
    }
  }
  val crc = CRC32()
  val buffer = ByteArray(ANDROID_CHAPTER_MEDIA_COPY_BUFFER_BYTES)
  var bytes = 0L
  while (true) {
    val read = zip.read(buffer)
    if (read < 0) break
    bytes = Math.addExact(bytes, read.toLong())
    require(bytes <= (expectedBytes ?: ANDROID_CHAPTER_MEDIA_MAX_ENTRY_BYTES)) {
      "Chapter media archive entry exceeds its byte limit."
    }
    crc.update(buffer, 0, read)
    output?.write(buffer, 0, read)
  }
  if (expectedBytes != null) {
    require(bytes == expectedBytes) {
      "Chapter media archive entry size does not match its manifest entry."
    }
  }
  require(entry.crc < 0L || entry.crc == crc.value) {
    "Chapter media archive entry CRC is invalid."
  }
  return bytes
}

internal fun mergeAndroidChapterMediaArchive(
  storedFiles: List<AndroidChapterMediaStoredFile>,
  looseFileNames: Set<String>,
  existingArchive: InputStream?,
  output: OutputStream,
  openLooseFile: (String) -> InputStream?,
) {
  requireAndroidChapterMediaStoredFiles(storedFiles)
  val expectedByName = storedFiles.associateBy(AndroidChapterMediaStoredFile::fileName)
  require(looseFileNames.all(expectedByName::containsKey)) {
    "Chapter media staging set contains an unexpected file."
  }
  ZipOutputStream(output.buffered()).use { zip ->
    val sourcedNames = mutableSetOf<String>()
    existingArchive?.use { input ->
      ZipInputStream(input.buffered()).use { previousZip ->
        val previousNames = mutableSetOf<String>()
        var previousBytes = 0L
        var entry = previousZip.nextEntry
        while (entry != null) {
          require(!entry.isDirectory) {
            "Chapter media archive contains a directory entry."
          }
          val entryName = entry.name
          require(isSafeAndroidChapterMediaFileName(entryName)) {
            "Chapter media archive contains an unsafe entry name."
          }
          require(previousNames.add(entryName)) {
            "Chapter media archive contains a duplicate entry."
          }
          val expected = expectedByName[entryName]
            ?: throw IllegalArgumentException(
              "Chapter media archive contains an unexpected entry.",
            )
          val useLooseFile = entryName in looseFileNames
          if (!useLooseFile) {
            require(sourcedNames.add(entryName)) {
              "Chapter media archive contains a duplicate stored entry."
            }
            zip.putNextEntry(ZipEntry(entryName))
          }
          val copied = consumeAndroidChapterMediaArchiveEntry(
            previousZip,
            entry,
            expectedBytes = if (useLooseFile) null else expected.bytes,
            output = if (useLooseFile) null else zip,
          )
          previousBytes = Math.addExact(previousBytes, copied)
          require(previousBytes <= ANDROID_CHAPTER_MEDIA_MAX_TOTAL_BYTES) {
            "Chapter media archive exceeds the total byte limit."
          }
          previousZip.closeEntry()
          if (!useLooseFile) zip.closeEntry()
          entry = previousZip.nextEntry
        }
      }
    }

    storedFiles.filter { it.fileName in looseFileNames }.forEach { file ->
      require(sourcedNames.add(file.fileName)) {
        "Chapter media archive contains a duplicate stored entry."
      }
      zip.putNextEntry(ZipEntry(file.fileName))
      val input = openLooseFile(file.fileName)
        ?: throw IllegalStateException("Cannot open staged chapter media file.")
      input.use { source ->
        copyAndroidChapterMediaFile(source, zip, file.bytes)
      }
      zip.closeEntry()
    }
    require(sourcedNames == expectedByName.keys) {
      "Chapter media sources are missing a stored manifest entry."
    }
  }
}

internal fun validateAndroidChapterMediaArchive(
  storedFiles: List<AndroidChapterMediaStoredFile>,
  input: InputStream,
) {
  requireAndroidChapterMediaStoredFiles(storedFiles)
  val expectedByName = storedFiles.associateBy(AndroidChapterMediaStoredFile::fileName)
  val seenNames = mutableSetOf<String>()
  var totalBytes = 0L
  ZipInputStream(input.buffered()).use { zip ->
    var entry = zip.nextEntry
    while (entry != null) {
      require(!entry.isDirectory) {
        "Chapter media archive contains a directory entry."
      }
      val entryName = entry.name
      require(isSafeAndroidChapterMediaFileName(entryName)) {
        "Chapter media archive contains an unsafe entry name."
      }
      require(seenNames.add(entryName)) {
        "Chapter media archive contains a duplicate entry."
      }
      val expected = expectedByName[entryName]
        ?: throw IllegalArgumentException("Chapter media archive contains an unexpected entry.")
      val copied = consumeAndroidChapterMediaArchiveEntry(
        zip,
        entry,
        expectedBytes = expected.bytes,
        output = null,
      )
      totalBytes = Math.addExact(totalBytes, copied)
      require(totalBytes <= ANDROID_CHAPTER_MEDIA_MAX_TOTAL_BYTES) {
        "Chapter media archive exceeds the total byte limit."
      }
      zip.closeEntry()
      entry = zip.nextEntry
    }
  }
  require(seenNames == expectedByName.keys) {
    "Chapter media archive is missing a stored manifest entry."
  }
}

internal fun readAndroidChapterMediaArchiveEntrySizes(
  input: InputStream,
  requestedFileNames: Set<String>,
): Map<String, Long> {
  require(requestedFileNames.size <= ANDROID_CHAPTER_MEDIA_MAX_ENTRIES) {
    "Chapter media archive size request has too many files."
  }
  requestedFileNames.forEach { fileName ->
    require(isSafeAndroidChapterMediaFileName(fileName)) {
      "Chapter media archive size request contains an unsafe file name."
    }
  }

  val sizes = linkedMapOf<String, Long>()
  val seenNames = mutableSetOf<String>()
  var totalBytes = 0L
  ZipInputStream(input.buffered()).use { zip ->
    var entry = zip.nextEntry
    while (entry != null) {
      require(!entry.isDirectory) {
        "Chapter media archive contains a directory entry."
      }
      val entryName = entry.name
      require(isSafeAndroidChapterMediaFileName(entryName)) {
        "Chapter media archive contains an unsafe entry name."
      }
      require(seenNames.add(entryName)) {
        "Chapter media archive contains a duplicate entry."
      }
      val copied = consumeAndroidChapterMediaArchiveEntry(
        zip,
        entry,
        expectedBytes = null,
        output = null,
      )
      totalBytes = Math.addExact(totalBytes, copied)
      require(totalBytes <= ANDROID_CHAPTER_MEDIA_MAX_TOTAL_BYTES) {
        "Chapter media archive exceeds the total byte limit."
      }
      if (entryName in requestedFileNames) sizes[entryName] = copied
      zip.closeEntry()
      entry = zip.nextEntry
    }
  }
  return sizes
}

class MainActivity : TauriActivity() {
  private data class ContentUriMetadata(
    val fileName: String?,
    val size: Long?,
  )

  private data class ChapterMediaManifest(
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

  private data class ChapterStorageTransferEntry(
    val entryId: String,
    val sourceRelativeDir: String,
    val targetRelativeDir: String,
  )

  private data class PreparedChapterStorageTransferEntry(
    val entry: ChapterStorageTransferEntry,
    val outcome: String,
    val replacedTarget: Boolean,
  )

  private data class ChapterStorageTransferPreparation(
    val token: String,
    val entries: List<PreparedChapterStorageTransferEntry>,
  )

  private data class ChapterStorageTransferArtifacts(
    val contentBytes: Long,
    val contentName: String,
    val mediaBytes: Long,
  )

  private val bridgeSession = BridgeSession()
  private val storageExecutor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "NoreaStorageBridge").apply { isDaemon = true }
  }
  private var androidScraperBridge: AndroidScraperBridge? = null
  private var scraperBackPressedCallback: OnBackPressedCallback? = null
  private var mainWebView: WebView? = null
  private var notificationPermissionRequested = false
  private var pendingStorageRootRequestId: String? = null
  private var mainBackEvaluationGeneration = 0L
  private var mainBackEvaluationPending = false
  private var mainBackReplayPending = false
  private var taskForegroundServiceActive = false
  @Volatile
  private var safeAreaInsetsJson = insetsJson(Insets.NONE)

  override fun onCreate(savedInstanceState: Bundle?) {
    RustlsPlatformVerifierBridge.init(applicationContext)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onPause() {
    super.onPause()
    resumeTaskWebViewsForBackgroundWork()
  }

  override fun onResume() {
    super.onResume()
    resumeTaskWebViewsForBackgroundWork()
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    resetMainBackEvaluation()
    mainWebView = webView
    val bridge = AndroidScraperBridge(webView, bridgeSession)
    androidScraperBridge = bridge
    webView.addJavascriptInterface(BridgeInfoBridge(), "__NoreaAndroidBridge")
    webView.addJavascriptInterface(bridge, "__NoreaAndroidScraper")
    webView.addJavascriptInterface(SafeAreaBridge(), "__NoreaAndroidSafeArea")
    webView.addJavascriptInterface(TaskNotificationBridge(), "__NoreaAndroidTasks")
    webView.addJavascriptInterface(UpdateInstallBridge(), "__NoreaAndroidUpdater")
    webView.addJavascriptInterface(StorageBridge(), "__NoreaAndroidStorage")
    webView.addJavascriptInterface(WindowMetricsBridge(webView), "__NoreaAndroidWindow")
    webView.settings.apply {
      setSupportZoom(false)
      builtInZoomControls = false
      displayZoomControls = false
      loadWithOverviewMode = false
      useWideViewPort = true
      textZoom = 100
    }
    webView.setInitialScale(100)
    installScraperBackHandler()

    ViewCompat.setOnApplyWindowInsetsListener(webView) { _, windowInsets ->
      val types = WindowInsetsCompat.Type.systemBars() or
        WindowInsetsCompat.Type.displayCutout()
      val insets = windowInsets.getInsets(types)
      safeAreaInsetsJson = insetsJson(insets)
      val script =
        "window.__lnrApplyAndroidSafeAreaInsets && window.__lnrApplyAndroidSafeAreaInsets($safeAreaInsetsJson);"
      webView.evaluateJavascript(
        script,
        null,
      )

      windowInsets
    }
    ViewCompat.requestApplyInsets(webView)
  }

  override fun onDestroy() {
    resetMainBackEvaluation()
    scraperBackPressedCallback?.remove()
    scraperBackPressedCallback = null
    androidScraperBridge?.destroy()
    androidScraperBridge = null
    storageExecutor.shutdownNow()
    super.onDestroy()
  }

  private fun installScraperBackHandler() {
    scraperBackPressedCallback?.remove()
    scraperBackPressedCallback = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (androidScraperBridge?.handleBackPressed() == true) return
        if (handleMainWebViewBackPressed()) return
        dispatchUnhandledBackPressed()
      }
    }.also { callback ->
      // Register after Tauri creates its WebView so source-browser back wins.
      onBackPressedDispatcher.addCallback(this, callback)
    }
  }

  private fun handleMainWebViewBackPressed(): Boolean {
    val webView = mainWebView ?: return false
    if (mainAppPath(webView.url) == null) return false
    if (mainBackEvaluationPending) {
      mainBackReplayPending = true
      return true
    }

    mainBackEvaluationGeneration += 1
    val requestId = mainBackEvaluationGeneration
    mainBackEvaluationPending = true
    val requestedUrl = webView.url
    webView.evaluateJavascript(
      "(() => { try { return window.__NoreaAndroidBackNavigation?.handle() === true; } catch { return false; } })();",
    ) { handled ->
      finishMainBackEvaluation(
        requestId,
        webView,
        requestedUrl,
        handled == "true",
      )
    }
    return true
  }

  private fun finishMainBackEvaluation(
    requestId: Long,
    webView: WebView,
    requestedUrl: String?,
    handled: Boolean,
  ) {
    if (!mainBackEvaluationPending || mainBackEvaluationGeneration != requestId) return

    mainBackEvaluationPending = false
    val replayBackPressed = mainBackReplayPending
    mainBackReplayPending = false

    val requestStillTargetsCurrentPage =
      mainWebView === webView && webView.url == requestedUrl
    if (
      requestStillTargetsCurrentPage &&
      !handled &&
      !handleDefaultMainWebViewBackPressed(webView)
    ) {
      dispatchUnhandledBackPressed()
    }
    if (replayBackPressed) {
      webView.post {
        if (!isFinishing && !isDestroyed && mainWebView === webView) {
          if (!handleMainWebViewBackPressed()) {
            dispatchUnhandledBackPressed()
          }
        }
      }
    }
  }

  private fun resetMainBackEvaluation() {
    mainBackEvaluationPending = false
    mainBackEvaluationGeneration += 1
    mainBackReplayPending = false
  }

  private fun handleDefaultMainWebViewBackPressed(webView: WebView): Boolean {
    if (!webView.canGoBack()) return false
    webView.goBack()
    return true
  }

  private fun dispatchUnhandledBackPressed() {
    val callback = scraperBackPressedCallback ?: return
    callback.isEnabled = false
    try {
      onBackPressedDispatcher.onBackPressed()
    } finally {
      callback.isEnabled = true
    }
  }

  private fun resumeTaskWebViewsForBackgroundWork() {
    if (!taskForegroundServiceActive) return
    mainWebView?.post {
      mainWebView?.resumeTimers()
      mainWebView?.onResume()
      androidScraperBridge?.resumeBackgroundWorkWebViews()
    }
  }

  private fun mainAppPath(url: String?): String? {
    if (url.isNullOrBlank()) return null
    return runCatching {
      val parsed = Uri.parse(url)
      parsed.path?.takeIf { parsed.host == "tauri.localhost" }
    }.getOrNull()
  }

  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode != REQUEST_MEDIA_STORAGE_ROOT) return

    val requestId = pendingStorageRootRequestId ?: return
    pendingStorageRootRequestId = null
    if (resultCode != Activity.RESULT_OK) {
      resolveStorageRootPick(
        requestId,
        JSONObject()
          .put("ok", false)
          .put("cancelled", true),
      )
      return
    }

    val uri = data?.data
    if (uri == null) {
      resolveStorageRootPick(
        requestId,
        JSONObject()
          .put("ok", false)
          .put("error", "No storage folder was selected."),
      )
      return
    }

    val flags = data.flags and (
      Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
      )
    runCatching {
      contentResolver.takePersistableUriPermission(uri, flags)
      uri.toString()
    }.fold(
      onSuccess = { root ->
        resolveStorageRootPick(
          requestId,
          JSONObject()
            .put("ok", true)
            .put("root", root),
        )
      },
      onFailure = { error ->
        resolveStorageRootPick(
          requestId,
          JSONObject()
            .put("ok", false)
            .put("error", error.message ?: error.toString()),
        )
      },
    )
  }

  private inner class BridgeInfoBridge {
    @JavascriptInterface
    fun session(): String =
      JSONObject()
        .put("version", 2)
        .put("sessionToken", bridgeSession.sessionToken)
        .put("capabilities", JSONArray(BridgeCapabilities.ALL))
        .put("legacyCallsAccepted", true)
        .toString()

    @JavascriptInterface
    fun nonce(): String = bridgeSession.newNonce()
  }

  private inner class SafeAreaBridge {
    @JavascriptInterface
    fun getInsets(): String = safeAreaInsetsJson
  }

  private inner class TaskNotificationBridge {
    @JavascriptInterface
    fun update(payload: String) {
      runOnUiThread {
        try {
          try {
            requestNotificationPermissionIfNeeded()
          } catch (_: Throwable) {
            // Permission prompts are best-effort; task execution must continue.
          }
          val json = JSONObject(payload)
          val progress = json.optJSONObject("progress")
          val current = progress?.takeIf { it.has("current") }?.optInt("current")
          val total = progress?.takeIf { it.has("total") }?.optInt("total")
          taskForegroundServiceActive = true
          TaskForegroundService.update(
            this@MainActivity,
            json.optString("title", "Norea tasks"),
            json.optString("body", ""),
            current,
            total,
          )
          resumeTaskWebViewsForBackgroundWork()
        } catch (_: Throwable) {
          // Ignore malformed bridge payloads so task execution is not affected.
        }
      }
    }

    @JavascriptInterface
    fun stop() {
      runOnUiThread {
        try {
          taskForegroundServiceActive = false
          TaskForegroundService.stop(this@MainActivity)
        } catch (_: Throwable) {
          // The service may already be stopped by Android.
        }
      }
    }
  }

  private inner class UpdateInstallBridge {
    @JavascriptInterface
    fun openApk(path: String): String =
      runCatching {
        val request = parseUpdateOpenRequest(path)
        val authority = bridgeSession.validate(
          BridgeCapabilities.UPDATE_OPEN_APK,
          request.authority,
        )
        require(authority.legacy || request.integrity != null) {
          "Update integrity metadata is missing."
        }
        val apk = allowedUpdateApk(request.path)
        request.integrity?.let { integrity ->
          verifyUpdateApkIntegrity(apk, integrity)
        }

        val uri = FileProvider.getUriForFile(
          this@MainActivity,
          "$packageName.fileprovider",
          apk,
        )
        startActivity(apkInstallIntent(uri))
      }.fold(
        onSuccess = { JSONObject().put("ok", true).toString() },
        onFailure = { error ->
          JSONObject()
            .put("ok", false)
            .put("error", error.message ?: error.toString())
            .toString()
        },
      )
  }

  private inner class StorageBridge {
    @JavascriptInterface
    fun pickMediaStorageRoot(requestId: String) {
      runOnUiThread {
        if (pendingStorageRootRequestId != null) {
          resolveStorageRootPick(
            requestId,
            JSONObject()
              .put("ok", false)
              .put("error", "A storage folder picker is already open."),
          )
          return@runOnUiThread
        }

        pendingStorageRootRequestId = requestId
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
          addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
          addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
          putExtra("android.content.extra.SHOW_ADVANCED", true)
        }
        runCatching {
          startActivityForResult(intent, REQUEST_MEDIA_STORAGE_ROOT)
        }.onFailure { error ->
          pendingStorageRootRequestId = null
          resolveStorageRootPick(
            requestId,
            JSONObject()
              .put("ok", false)
              .put("error", error.message ?: error.toString()),
          )
        }
      }
    }

    @JavascriptInterface
    fun ensureNoMedia(rootUri: String): String = storageResponse {
      val created = ensureContentsNoMedia(rootUri)
      JSONObject()
        .put("ok", true)
        .put("created", created)
    }

    @JavascriptInterface
    fun writeBytes(
      rootUri: String,
      relativePath: String,
      base64: String,
      mimeType: String,
    ): String = storageResponse {
      val bytes = Base64.decode(base64, Base64.DEFAULT)
      val file = ensureStorageFile(rootUri, relativePath, mimeTypeForPath(relativePath, mimeType))
      contentResolver.openOutputStream(file.uri, "wt")?.use { output ->
        output.write(bytes)
      } ?: throw IllegalStateException("Cannot open storage file for writing.")
      JSONObject()
        .put("ok", true)
        .put("bytes", bytes.size)
    }

    @JavascriptInterface
    fun writeContentUriBytes(uri: String, base64: String, mimeType: String): String =
      storageResponse {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        contentResolver.openOutputStream(Uri.parse(uri), "wt")?.use { output ->
          output.write(bytes)
        } ?: throw IllegalStateException("Cannot open selected file for writing.")
        JSONObject()
          .put("ok", true)
          .put("bytes", bytes.size)
          .put("mimeType", mimeType)
      }

    @JavascriptInterface
    fun writeContentUriFile(uri: String, inputPath: String, mimeType: String): String =
      storageResponse {
        val inputFile = File(inputPath)
        require(inputFile.isFile) { "Selected backup temp file is unavailable." }
        val bytes = inputFile.inputStream().use { input ->
          contentResolver.openOutputStream(Uri.parse(uri), "wt")?.use { output ->
            input.copyTo(output)
          } ?: throw IllegalStateException("Cannot open selected file for writing.")
        }
        JSONObject()
          .put("ok", true)
          .put("bytes", bytes)
          .put("mimeType", mimeType)
      }

    @JavascriptInterface
    fun writeContentUriFileCapped(
      uri: String,
      inputPath: String,
      mimeType: String,
      maxBytes: String,
    ): String = storageResponse {
      val limit = parseStorageByteLimit(maxBytes)
      val inputFile = containedAppCacheFile(inputPath)
      require(inputFile.isFile) { "Selected backup temp file is unavailable." }
      val fileLength = inputFile.length().coerceAtLeast(0L)
      require(fileLength <= limit) {
        "Selected backup temp file exceeds the $limit byte limit."
      }
      val bytes = inputFile.inputStream().use { input ->
        contentResolver.openOutputStream(Uri.parse(uri), "wt")?.use { output ->
          copyToWithLimit(input, output, limit)
        } ?: throw IllegalStateException("Cannot open selected file for writing.")
      }
      JSONObject()
        .put("ok", true)
        .put("bytes", bytes)
        .put("mimeType", mimeType)
    }

    @JavascriptInterface
    fun describeContentUri(uri: String): String = storageResponse {
      val contentUri = Uri.parse(uri)
      val metadata = contentUriMetadata(contentUri)
      val mimeType = contentUriMimeType(contentUri)
      JSONObject()
        .put("ok", true)
        .put("fileName", contentUriFileName(contentUri, mimeType, metadata.fileName))
        .put("mimeType", mimeType)
        .put("size", metadata.size ?: JSONObject.NULL)
    }

    @JavascriptInterface
    fun readContentUriFile(uri: String, maxBytes: String): String = storageResponse {
      val limit = parseStorageByteLimit(maxBytes)
      val contentUri = Uri.parse(uri)
      val metadata = contentUriMetadata(contentUri)
      val mimeType = contentUriMimeType(contentUri)
      val tempFile = createStorageTempFile()
      var bytes = 0L
      try {
        contentResolver.openInputStream(contentUri)?.use { input ->
          tempFile.outputStream().use { output ->
            bytes = copyToWithLimit(input, output, limit)
          }
        } ?: throw IllegalStateException("Cannot open selected file for reading.")
      } catch (error: Throwable) {
        tempFile.delete()
        throw error
      }
      JSONObject()
        .put("ok", true)
        .put("bytes", bytes)
        .put("fileName", contentUriFileName(contentUri, mimeType, metadata.fileName))
        .put("mimeType", mimeType)
        .put("path", tempFile.absolutePath)
    }

    @JavascriptInterface
    fun deleteTempFile(path: String): String = storageResponse {
      val tempFile = containedStorageTempFile(path)
      val existed = tempFile.exists()
      if (existed && !tempFile.delete()) {
        throw IllegalStateException("Cannot remove Android storage temp file.")
      }
      JSONObject()
        .put("ok", true)
        .put("deleted", existed)
    }

    @JavascriptInterface
    fun readContentUriBase64(uri: String): String = storageResponse {
      val bytes = contentResolver.openInputStream(Uri.parse(uri))?.use { input ->
        input.readBytes()
      } ?: throw IllegalStateException("Cannot open selected file for reading.")
      JSONObject()
        .put("ok", true)
        .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        .put("mimeType", mimeTypeForPath(uri, "application/octet-stream"))
    }

    @JavascriptInterface
    fun writeText(rootUri: String, relativePath: String, text: String): String =
      storageResponse {
        val bytes = text.toByteArray(Charsets.UTF_8)
        val segments = safeStorageSegments(relativePath)
        if (segments.last() == CHAPTER_MEDIA_MANIFEST_FILE) {
          var directory = storageRoot(rootUri)
          for (segment in segments.dropLast(1)) {
            directory = ensureStorageDirectory(directory, segment)
          }
          writeChapterMediaManifestAtomically(
            rootUri,
            directory,
            segments.dropLast(1).joinToString("/"),
            bytes,
          )
        } else {
          val file = ensureStorageFile(
            rootUri,
            relativePath,
            textMimeTypeForPath(relativePath),
          )
          contentResolver.openOutputStream(file.uri, "wt")?.use { output ->
            output.write(bytes)
          } ?: throw IllegalStateException("Cannot open storage file for writing.")
        }
        JSONObject()
          .put("ok", true)
          .put("bytes", bytes.size)
      }

    @JavascriptInterface
    fun archiveDirectory(
      rootUri: String,
      sourceRelativePath: String,
      archiveRelativePath: String,
    ): String = storageResponse {
      val sourceSegments = safeStorageSegments(sourceRelativePath)
      val archiveSegments = safeStorageSegments(archiveRelativePath)
      require(
        sourceSegments.lastOrNull() == "media" &&
          archiveSegments.lastOrNull() == "media.zip" &&
          sourceSegments.dropLast(1) == archiveSegments.dropLast(1),
      ) {
        "Android chapter media archive paths do not share a chapter directory."
      }
      val chapterRelativeDir = sourceSegments.dropLast(1).joinToString("/")
      val chapterDirectory = storageDocumentAt(rootUri, chapterRelativeDir)
        ?: throw IllegalStateException("Android chapter media directory is unavailable.")
      require(chapterDirectory.isDirectory && chapterDirectory.canRead()) {
        "Android chapter media path is not a readable folder."
      }
      val mediaBytes = finalizeChapterMediaArtifacts(
        rootUri,
        chapterDirectory,
        chapterRelativeDir,
        allowLegacyWithoutManifest = false,
      ) ?: throw IllegalStateException(
        "Android chapter media files do not match the manifest.",
      )
      JSONObject()
        .put("ok", true)
        .put("bytes", mediaBytes)
    }

    @JavascriptInterface
    fun readText(rootUri: String, relativePath: String): String = storageResponse {
      Log.d(TAG, "Android storage readText path=$relativePath root=$rootUri")
      val text = openStorageInputStream(rootUri, relativePath)?.use { input ->
        input.readBytes().toString(Charsets.UTF_8)
      } ?: throw IllegalStateException(storageReadFailureMessage(rootUri, relativePath))
      JSONObject()
        .put("ok", true)
        .put("text", text)
    }

    @JavascriptInterface
    fun inspectNovelCover(
      requestId: String,
      rootUri: String,
      preferredNovelDir: String,
      sourceDir: String,
      novelIdentitySuffix: String,
      sourceId: String,
      novelPath: String,
      expectedSourceUrl: String,
    ) {
      storageExecutor.execute {
        resolveNovelCoverInspection(
          requestId,
          inspectNovelCoverResponse(
            rootUri,
            preferredNovelDir,
            sourceDir,
            novelIdentitySuffix,
            sourceId,
            novelPath,
            expectedSourceUrl,
          ),
        )
      }
    }

    private fun inspectNovelCoverResponse(
      rootUri: String,
      preferredNovelDir: String,
      sourceDir: String,
      novelIdentitySuffix: String,
      sourceId: String,
      novelPath: String,
      expectedSourceUrl: String,
    ): String = storageResponse {
      val root = storageRoot(rootUri)
      require(root.canRead()) { "Android storage folder is not readable." }
      require(sourceId.isNotBlank()) { "Android storage novel source id is required." }

      fun inspectDirectory(
        directory: DocumentFile,
        relativeDir: String,
      ): AndroidNovelCoverInspection? {
        require(directory.isDirectory) {
          "Android storage novel path is not a folder: $relativeDir"
        }
        require(directory.canRead()) {
          "Android storage novel path is not readable: $relativeDir"
        }
        val manifestDocument = directory.findFile(NOVEL_COVER_MANIFEST_FILE)
          ?: return null
        require(manifestDocument.isFile && manifestDocument.canRead()) {
          "Android storage novel cover manifest is not a readable file: $relativeDir"
        }
        val manifestRelativePath = "$relativeDir/$NOVEL_COVER_MANIFEST_FILE"
        val manifest = openStorageInputStream(
          rootUri,
          manifestRelativePath,
          manifestDocument,
        )?.use { input ->
          input.readBytes().toString(Charsets.UTF_8)
        } ?: throw IllegalStateException(
          "Cannot read Android storage novel cover manifest: $manifestRelativePath",
        )
        val manifestJson = runCatching { JSONObject(manifest) }.getOrNull() ?: return null
        val version = manifestJson.opt("version") as? Number ?: return null
        if (version.toDouble() != 1.0) return null
        val fileName = (manifestJson.opt("fileName") as? String)
          ?.trim()
          ?.takeIf { candidate ->
            runCatching { safeStorageSegments(candidate) }.getOrNull() == listOf(candidate)
          } ?: return null
        val storedSourceIdValue = manifestJson.opt("sourceId")
        val storedNovelPathValue = manifestJson.opt("novelPath")
        val identity = parseAndroidNovelCoverIdentity(
          storedSourceIdValue.takeUnless { it == JSONObject.NULL },
          storedNovelPathValue.takeUnless { it == JSONObject.NULL },
        ) ?: return null
        val sourceUrl = manifestJson.opt("sourceUrl") as? String ?: return null
        val updatedAt = (manifestJson.opt("updatedAt") as? Number)?.toLong() ?: 0L
        val cover = directory.findFile(fileName) ?: return null
        if (!cover.isFile) return null
        require(cover.canRead()) {
          "Android storage novel cover is not readable: $relativeDir/$fileName"
        }
        val relativePath = "$relativeDir/$fileName"
        return nonEmptyAndroidNovelCoverInspection(
          inspection = AndroidNovelCoverInspection(
            manifest = manifest,
            relativePath = relativePath,
            sourceId = identity.sourceId,
            novelPath = identity.novelPath,
            sourceUrl = sourceUrl,
            updatedAt = updatedAt,
          ),
          bytes = storageDocumentSize(rootUri, relativePath, cover),
        )
      }

      val preferred = storageDocumentAt(rootUri, preferredNovelDir)?.let { directory ->
        inspectDirectory(directory, preferredNovelDir)
      }
      val selectedPreferred = selectAndroidNovelCoverInspection(
        preferred = preferred,
        matches = emptyList(),
        sourceId = sourceId,
        novelPath = novelPath,
        expectedSourceUrl = expectedSourceUrl,
      )
      val selected = selectedPreferred ?: run {
        val matches = mutableListOf<AndroidNovelCoverInspection>()
        val source = storageDocumentAt(rootUri, sourceDir)
        if (source != null) {
          require(source.isDirectory) {
            "Android storage source path is not a folder: $sourceDir"
          }
          require(source.canRead()) {
            "Android storage source path is not readable: $sourceDir"
          }
          for (novel in source.listFiles()) {
            val novelName = novel.name ?: continue
            if (!novelName.endsWith(novelIdentitySuffix)) continue
            inspectDirectory(novel, "$sourceDir/$novelName")?.let(matches::add)
          }
        }
        selectAndroidNovelCoverInspection(
          preferred = null,
          matches = matches,
          sourceId = sourceId,
          novelPath = novelPath,
          expectedSourceUrl = expectedSourceUrl,
        )
      }

      if (selected == null) {
        JSONObject()
          .put("ok", true)
          .put("status", "missing")
      } else {
        JSONObject()
          .put("ok", true)
          .put("status", "present")
          .put("manifest", selected.manifest)
          .put("relativePath", selected.relativePath)
      }
    }

    @JavascriptInterface
    fun inspectChapterArtifacts(
      requestId: String,
      rootUri: String,
      preferredChapterDir: String,
      sourceDir: String,
      novelIdentitySuffix: String,
      chapterIdentityPrefix: String,
      preferredContentFileName: String,
    ) {
      storageExecutor.execute {
        resolveChapterArtifactInspection(
          requestId,
          inspectChapterArtifactsResponse(
            rootUri,
            preferredChapterDir,
            sourceDir,
            novelIdentitySuffix,
            chapterIdentityPrefix,
            preferredContentFileName,
          ),
        )
      }
    }

    private fun inspectChapterArtifactsResponse(
      rootUri: String,
      preferredChapterDir: String,
      sourceDir: String,
      novelIdentitySuffix: String,
      chapterIdentityPrefix: String,
      preferredContentFileName: String,
    ): String = storageResponse {
      val root = storageRoot(rootUri)
      require(root.canRead()) { "Android storage folder is not readable." }
      val preferredName = safeStorageSegments(preferredContentFileName).singleOrNull()
        ?: throw IllegalArgumentException("Android storage content file name is invalid.")
      val contentNames = linkedSetOf(preferredName, "content.html", "content.pdf")

      fun inspectDirectory(directory: DocumentFile, relativeDir: String): JSONObject? {
        require(directory.isDirectory) { "Android storage chapter path is not a folder: $relativeDir" }
        require(directory.canRead()) { "Android storage chapter path is not readable: $relativeDir" }
        val content = contentNames.firstNotNullOfOrNull { name ->
          directory.findFile(name)?.also { candidate ->
            require(candidate.isFile) {
              "Android storage content path is not a file: $relativeDir/$name"
            }
          }
        } ?: return null
        require(content.canRead()) { "Android storage content file is not readable: $relativeDir" }
        val contentName = content.name ?: preferredName
        val finalizedMediaBytes = finalizeChapterMediaArtifacts(
          rootUri,
          directory,
          relativeDir,
          allowLegacyWithoutManifest = true,
        )
        val existingArchiveBytes = directory.findFile(CHAPTER_MEDIA_ARCHIVE_FILE)
          ?.takeIf { it.isFile }
          ?.length()
        val archiveBytes = resolvedAndroidFinalChapterMediaBytes(
          finalizedMediaBytes,
          existingArchiveBytes,
        )
        return JSONObject()
          .put("ok", true)
          .put("status", "present")
          .put("contentFile", "$relativeDir/$contentName")
          .put("contentBytes", content.length().coerceAtLeast(0L))
          .put("mediaBytes", archiveBytes)
      }

      storageDocumentAt(rootUri, preferredChapterDir)?.let { preferred ->
        inspectDirectory(preferred, preferredChapterDir)?.let { return@storageResponse it }
      }

      val matches = mutableListOf<JSONObject>()
      val source = storageDocumentAt(rootUri, sourceDir)
      if (source != null) {
        require(source.isDirectory) { "Android storage source path is not a folder: $sourceDir" }
        require(source.canRead()) { "Android storage source path is not readable: $sourceDir" }
        for (novel in source.listFiles()) {
          val novelName = novel.name ?: continue
          if (!novelName.endsWith(novelIdentitySuffix)) continue
          require(novel.isDirectory) { "Android storage novel path is not a folder: $novelName" }
          require(novel.canRead()) { "Android storage novel path is not readable: $novelName" }
          for (chapter in novel.listFiles()) {
            val chapterName = chapter.name ?: continue
            if (!chapterName.startsWith(chapterIdentityPrefix)) continue
            require(chapter.isDirectory) {
              "Android storage chapter path is not a folder: $chapterName"
            }
            require(chapter.canRead()) {
              "Android storage chapter path is not readable: $chapterName"
            }
            inspectDirectory(chapter, "$sourceDir/$novelName/$chapterName")
              ?.let(matches::add)
          }
        }
      }

      when (matches.size) {
        0 -> JSONObject()
          .put("ok", true)
          .put("status", "missing")
          .put("contentBytes", 0)
          .put("mediaBytes", 0)
        1 -> matches.single()
        else -> throw IllegalStateException(
          "Multiple stored chapter folders match source identity $chapterIdentityPrefix",
        )
      }
    }

    @JavascriptInterface
    fun prepareChapterStorageTransfer(
      requestId: String,
      rootUri: String,
      entriesJson: String,
    ) {
      storageExecutor.execute {
        val response = storageResponse {
          JSONObject()
            .put("ok", true)
            .put(
              "preparation",
              this@MainActivity.prepareChapterStorageTransfer(rootUri, entriesJson),
            )
        }
        resolveChapterStorageTransfer(requestId, response)
      }
    }

    @JavascriptInterface
    fun finalizeChapterStorageTransfer(
      requestId: String,
      rootUri: String,
      preparationJson: String,
    ) {
      storageExecutor.execute {
        val response = storageResponse {
          this@MainActivity.finalizeChapterStorageTransfer(rootUri, preparationJson)
          JSONObject().put("ok", true)
        }
        resolveChapterStorageTransfer(requestId, response)
      }
    }

    @JavascriptInterface
    fun rollbackChapterStorageTransfer(
      requestId: String,
      rootUri: String,
      preparationJson: String,
    ) {
      storageExecutor.execute {
        val response = storageResponse {
          this@MainActivity.rollbackChapterStorageTransfer(rootUri, preparationJson)
          JSONObject().put("ok", true)
        }
        resolveChapterStorageTransfer(requestId, response)
      }
    }

    @JavascriptInterface
    fun removeChapterStorageDirectory(
      requestId: String,
      rootUri: String,
      relativeDir: String,
    ) {
      storageExecutor.execute {
        val response = storageResponse {
          this@MainActivity.removeChapterStorageDirectory(rootUri, relativeDir)
          JSONObject().put("ok", true)
        }
        resolveChapterStorageTransfer(requestId, response)
      }
    }

    @JavascriptInterface
    fun listChapterStorageDirs(
      rootUri: String,
      preferredChapterDir: String,
      sourceDir: String,
      novelIdentitySuffix: String,
      chapterIdentityPrefix: String,
    ): String = storageResponse {
      val root = storageRoot(rootUri)
      require(root.canRead()) { "Android storage folder is not readable." }
      val chapterDirs = linkedSetOf<String>()

      storageDocumentAt(rootUri, preferredChapterDir)?.let { preferred ->
        require(preferred.isDirectory) {
          "Android storage chapter path is not a folder: $preferredChapterDir"
        }
        require(preferred.canRead()) {
          "Android storage chapter path is not readable: $preferredChapterDir"
        }
        chapterDirs.add(preferredChapterDir)
      }

      val source = storageDocumentAt(rootUri, sourceDir)
      if (source != null) {
        require(source.isDirectory) { "Android storage source path is not a folder: $sourceDir" }
        require(source.canRead()) { "Android storage source path is not readable: $sourceDir" }
        for (novel in source.listFiles()) {
          val novelName = novel.name ?: continue
          if (!novelName.endsWith(novelIdentitySuffix)) continue
          require(novel.isDirectory) { "Android storage novel path is not a folder: $novelName" }
          require(novel.canRead()) { "Android storage novel path is not readable: $novelName" }
          for (chapter in novel.listFiles()) {
            val chapterName = chapter.name ?: continue
            if (!chapterName.startsWith(chapterIdentityPrefix)) continue
            require(chapter.isDirectory) {
              "Android storage chapter path is not a folder: $chapterName"
            }
            require(chapter.canRead()) {
              "Android storage chapter path is not readable: $chapterName"
            }
            chapterDirs.add("$sourceDir/$novelName/$chapterName")
          }
        }
      }

      JSONObject()
        .put("ok", true)
        .put("chapterDirs", JSONArray(chapterDirs.toList()))
    }

    @JavascriptInterface
    fun readBase64(rootUri: String, relativePath: String): String = storageResponse {
      Log.d(TAG, "Android storage readBase64 path=$relativePath root=$rootUri")
      val bytes = openStorageInputStream(rootUri, relativePath)?.use { input ->
        input.readBytes()
      } ?: throw IllegalStateException(storageReadFailureMessage(rootUri, relativePath))
      JSONObject()
        .put("ok", true)
        .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        .put("mimeType", mimeTypeForPath(relativePath, ""))
    }

    @JavascriptInterface
    fun readZipEntryBase64(
      rootUri: String,
      archiveRelativePath: String,
      entryName: String,
    ): String = storageResponse {
      val safeEntryName = safeZipEntryName(entryName)
        ?: throw IllegalArgumentException("Android storage zip entry is invalid: $entryName")
      val bytes = readZipEntryBytes(rootUri, archiveRelativePath, safeEntryName)
        ?: throw IllegalArgumentException("Android storage zip entry not found: $entryName")
      JSONObject()
        .put("ok", true)
        .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        .put("mimeType", mimeTypeForPath(safeEntryName, ""))
    }

    @JavascriptInterface
    fun readZipEntriesBase64(
      rootUri: String,
      archiveRelativePath: String,
      entryNamesJson: String,
    ): String = storageResponse {
      val requested = JSONArray(entryNamesJson)
      val requestedNames = linkedSetOf<String>()
      for (index in 0 until requested.length()) {
        val entryName = safeZipEntryName(requested.optString(index))
        if (entryName != null) requestedNames.add(entryName)
      }
      val entries = JSONObject()
      if (requestedNames.isEmpty()) {
        return@storageResponse JSONObject()
          .put("ok", true)
          .put("entries", entries)
      }
      openStorageInputStream(rootUri, archiveRelativePath)?.use { input ->
        ZipInputStream(input.buffered()).use { zip ->
          val remaining = requestedNames.toMutableSet()
          var entry = zip.nextEntry
          var entryCount = 0
          var totalBytes = 0L
          while (entry != null && remaining.isNotEmpty()) {
            entryCount = nextZipEntryCount(entryCount, "Media archive")
            val currentName = safeZipEntryName(entry.name)
            if (
              !entry.isDirectory &&
              currentName != null &&
              remaining.contains(currentName)
            ) {
              requireZipEntrySize(entry, "Media archive entry")
              val bytes = readBytesWithLimit(zip, MAX_ZIP_ENTRY_BYTES)
              totalBytes = addZipTotalBytes(
                totalBytes,
                bytes.size.toLong(),
                "Media archive read",
              )
              entries.put(
                currentName,
                JSONObject()
                  .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                  .put("mimeType", mimeTypeForPath(currentName, "")),
              )
              remaining.remove(currentName)
            }
            zip.closeEntry()
            entry = zip.nextEntry
          }
        }
      }
      JSONObject()
        .put("ok", true)
        .put("entries", entries)
    }

    @JavascriptInterface
    fun zipEntrySizes(
      rootUri: String,
      archiveRelativePath: String,
      entryNamesJson: String,
    ): String = storageResponse {
      val requested = JSONArray(entryNamesJson)
      val requestedNames = linkedSetOf<String>()
      for (index in 0 until requested.length()) {
        val entryName = safeZipEntryName(requested.optString(index))
        if (entryName != null) requestedNames.add(entryName)
      }
      val sizes = JSONObject()
      openStorageInputStream(rootUri, archiveRelativePath)?.use { input ->
        readAndroidChapterMediaArchiveEntrySizes(input, requestedNames)
          .forEach { (entryName, bytes) -> sizes.put(entryName, bytes) }
      }
      JSONObject()
        .put("ok", true)
        .put("sizes", sizes)
    }

    @JavascriptInterface
    fun zipEntryExists(rootUri: String, archiveRelativePath: String, entryName: String): String =
      storageResponse {
        val safeEntryName = safeZipEntryName(entryName)
          ?: throw IllegalArgumentException("Android storage zip entry is invalid: $entryName")
        val exists = openStorageInputStream(rootUri, archiveRelativePath)?.use { input ->
          var found = false
          ZipInputStream(input.buffered()).use { zip ->
            var entry = zip.nextEntry
            var entryCount = 0
            while (entry != null) {
              entryCount = nextZipEntryCount(entryCount, "Media archive")
              val currentName = safeZipEntryName(entry.name)
              if (!entry.isDirectory && currentName == safeEntryName) {
                found = true
                break
              }
              zip.closeEntry()
              entry = zip.nextEntry
            }
          }
          found
        } ?: false
        JSONObject()
          .put("ok", true)
          .put("exists", exists)
      }

    @JavascriptInterface
    fun extractZip(
      rootUri: String,
      archiveRelativePath: String,
      targetRelativePath: String,
    ): String = storageResponse {
      var bytes = 0L
      openStorageInputStream(rootUri, archiveRelativePath)?.use { input ->
        ZipInputStream(input.buffered()).use { zip ->
          var entry = zip.nextEntry
          var entryCount = 0
          while (entry != null) {
            entryCount = nextZipEntryCount(entryCount, "Media archive extraction")
            val entryName = safeZipEntryName(entry.name)
            if (!entry.isDirectory && entryName != null) {
              requireZipEntrySize(entry, "Media archive extraction entry")
              val targetPath = "$targetRelativePath/$entryName"
              if (storageDocumentAt(rootUri, targetPath) == null) {
                val file = ensureStorageFile(
                  rootUri,
                  targetPath,
                  mimeTypeForPath(entryName, "application/octet-stream"),
                )
                contentResolver.openOutputStream(file.uri, "wt")?.use { output ->
                  val copied = copyToWithLimit(zip, output, MAX_ZIP_ENTRY_BYTES)
                  bytes = addZipTotalBytes(
                    bytes,
                    copied,
                    "Media archive extraction",
                  )
                } ?: throw IllegalStateException("Cannot open extracted media file.")
              }
            }
            zip.closeEntry()
            entry = zip.nextEntry
          }
        }
      } ?: throw IllegalStateException("Cannot open media archive for extraction.")
      JSONObject()
        .put("ok", true)
        .put("bytes", bytes)
    }

    @JavascriptInterface
    fun pathSize(rootUri: String, relativePath: String): String = storageResponse {
      val document = storageDocumentAt(rootUri, relativePath)
      JSONObject()
        .put("ok", true)
        .put(
          "bytes",
          document?.let { storageDocumentSize(rootUri, relativePath, it) }
            ?: externalStorageFile(rootUri, relativePath)
              ?.takeIf { it.isFile }
              ?.length()
              ?.coerceAtLeast(0L)
            ?: 0L,
        )
    }

    @JavascriptInterface
    fun prepareReaderMediaCache(
      rootUri: String,
      mediaRelativePath: String,
      archiveRelativePath: String,
      cacheToken: String,
    ): String =
      storageResponse {
        val safeCacheToken = safeReaderMediaCacheToken(cacheToken)
          ?: throw IllegalArgumentException("Reader media cache token is invalid.")
        val cacheRoot = readerMediaCacheTokenRoot(safeCacheToken)
        Log.d(
          TAG,
          "Android reader media cache prepare start. " +
            "token=$safeCacheToken mediaPath=$mediaRelativePath " +
            "archivePath=$archiveRelativePath",
        )
        val mediaStats = copyReaderMediaDirectoryToCache(
          rootUri,
          mediaRelativePath,
          cacheRoot,
        )
        var archiveFailure: String? = null
        val archiveStats = runCatching {
          copyReaderMediaArchiveToCache(rootUri, archiveRelativePath, cacheRoot)
        }.getOrElse { error ->
          if (mediaStats.entryCount == 0) throw error
          archiveFailure = error.message ?: error.toString()
          Log.w(
            TAG,
            "Android reader media archive overlay failed. path=$archiveRelativePath",
            error,
          )
          ReaderMediaCacheStats()
        }
        if (mediaStats.entryCount == 0 && archiveStats.entryCount == 0) {
          throw IllegalStateException("Cannot open reader media source.")
        }
        val entryCount = mediaStats.entryCount + archiveStats.entryCount
        val totalBytes = mediaStats.totalBytes + archiveStats.totalBytes

        Log.d(
          TAG,
          "Android reader media cache prepared. " +
            "token=$safeCacheToken " +
            "mediaPath=$mediaRelativePath " +
            "archivePath=$archiveRelativePath " +
            "mediaCount=${mediaStats.entryCount} " +
            "archiveCount=${archiveStats.entryCount} " +
            "bytes=$totalBytes",
        )
        JSONObject()
          .put("ok", true)
          .put("archiveError", archiveFailure)
          .put("bytes", totalBytes)
          .put("count", entryCount)
      }

    @JavascriptInterface
    fun deletePath(rootUri: String, relativePath: String): String = storageResponse {
      storageDocumentAt(rootUri, relativePath)?.let { document ->
        if (!document.delete()) {
          throw IllegalStateException("Cannot delete Android storage path: $relativePath")
        }
      }
      JSONObject().put("ok", true)
    }

    @JavascriptInterface
    fun beginRestore(rootUri: String, token: String): String = storageResponse {
      val root = storageRoot(rootUri)
      val backupName = restoreBackupDirectoryName(token)
      root.findFile(backupName)?.let { staleBackup ->
        if (!staleBackup.delete()) {
          throw IllegalStateException("Cannot remove stale Android restore backup.")
        }
      }
      root.findFile("contents")?.let { contents ->
        if (!contents.renameTo(backupName)) {
          throw IllegalStateException("Cannot backup Android media contents.")
        }
      }
      ensureContentsNoMedia(rootUri)
      JSONObject().put("ok", true)
    }

    @JavascriptInterface
    fun commitRestore(rootUri: String, token: String): String = storageResponse {
      val backupName = restoreBackupDirectoryName(token)
      storageRoot(rootUri).findFile(backupName)?.let { backup ->
        if (!backup.delete()) {
          throw IllegalStateException("Cannot remove Android restore backup.")
        }
      }
      JSONObject().put("ok", true)
    }

    @JavascriptInterface
    fun rollbackRestore(rootUri: String, token: String): String = storageResponse {
      val root = storageRoot(rootUri)
      val backupName = restoreBackupDirectoryName(token)
      root.findFile("contents")?.let { contents ->
        if (!contents.delete()) {
          throw IllegalStateException("Cannot remove failed Android restore contents.")
        }
      }
      root.findFile(backupName)?.let { backup ->
        if (!backup.renameTo("contents")) {
          throw IllegalStateException("Cannot rollback Android restore backup.")
        }
      }
      JSONObject().put("ok", true)
    }

    @JavascriptInterface
    fun renamePath(rootUri: String, relativePath: String, newName: String): String =
      storageResponse {
        val safeNewName = safeStorageSegments(newName).singleOrNull()
          ?: throw IllegalArgumentException("Android storage target name is invalid: $newName")
        val document = storageDocumentAt(rootUri, relativePath)
          ?: throw IllegalArgumentException("Android storage path not found: $relativePath")
        val parentPath = safeStorageSegments(relativePath).dropLast(1).joinToString("/")
        val parent = if (parentPath.isEmpty()) {
          storageRoot(rootUri)
        } else {
          storageDocumentAt(rootUri, parentPath)
            ?: throw IllegalStateException("Android storage parent path not found: $parentPath")
        }
        if (document.name == safeNewName) {
          return@storageResponse JSONObject().put("ok", true)
        }
        val backupName = "$safeNewName.bak"
        val existing = parent.findFile(safeNewName)
        var backup = parent.findFile(backupName)
        if (existing != null) {
          if (backup != null && !backup.delete()) {
            throw IllegalStateException("Cannot remove Android storage backup: $backupName")
          }
          if (!existing.renameTo(backupName)) {
            throw IllegalStateException("Cannot backup Android storage path: $safeNewName")
          }
          backup = existing
        }
        if (!document.renameTo(safeNewName)) {
          val rollbackBackup = backup
          if (rollbackBackup != null) {
            if (!rollbackBackup.renameTo(safeNewName)) {
              throw IllegalStateException(
                "Cannot restore Android storage path after rename failure: $safeNewName",
              )
            }
          }
          throw IllegalStateException("Cannot rename Android storage path: $relativePath")
        }
        parent.findFile(backupName)?.let { publishedBackup ->
          if (!publishedBackup.delete()) {
            throw IllegalStateException("Cannot remove Android storage backup: $backupName")
          }
        }
        JSONObject().put("ok", true)
      }

    @JavascriptInterface
    fun deleteChildrenExcept(rootUri: String, relativePath: String, keepName: String): String =
      storageResponse {
        storageDocumentAt(rootUri, relativePath)?.listFiles()?.forEach { child ->
          if (child.name != keepName) {
            child.delete()
          }
        }
        JSONObject().put("ok", true)
      }

    @JavascriptInterface
    fun deleteRootChildren(rootUri: String): String = storageResponse {
      storageRoot(rootUri).listFiles().forEach { child ->
        child.delete()
      }
      JSONObject().put("ok", true)
    }
  }

  private inner class WindowMetricsBridge(private val webView: WebView) {
    @JavascriptInterface
    fun getMetrics(): String = windowMetricsJson(webView)
  }

  private data class UpdateOpenRequest(
    val path: String,
    val authority: BridgeAuthorityFields,
    val integrity: UpdateApkIntegrity?,
  )

  private data class UpdateApkIntegrity(
    val size: Long,
    val sha256: String,
  )

  private fun parseUpdateOpenRequest(raw: String): UpdateOpenRequest {
    val trimmed = raw.trim()
    if (!trimmed.startsWith("{")) {
      return UpdateOpenRequest(trimmed, BridgeAuthorityFields(), null)
    }

    val json = JSONObject(trimmed)
    val requestPath = json.optString("path")
      .ifBlank { json.optString("apkPath") }
      .trim()
    require(requestPath.isNotEmpty()) { "APK path is missing." }
    return UpdateOpenRequest(
      requestPath,
      bridgeAuthorityFields(json),
      updateApkIntegrity(json.optJSONObject("metadata") ?: json.optJSONObject("integrity")),
    )
  }

  private fun bridgeAuthorityFields(payload: JSONObject): BridgeAuthorityFields {
    val wrapper = payload.optJSONObject("_bridge") ?: payload.optJSONObject("bridge")
    fun field(name: String): String? =
      wrapper?.optString(name)?.trim()?.takeIf { it.isNotEmpty() }

    return BridgeAuthorityFields(
      token = field("sessionToken") ?: field("token")
        ?: payload.optString("bridgeToken").trim().takeIf { it.isNotEmpty() },
      capability = field("capability")
        ?: payload.optString("capability").trim().takeIf { it.isNotEmpty() },
      nonce = field("nonce")
        ?: payload.optString("nonce").trim().takeIf { it.isNotEmpty() },
    )
  }

  private fun updateApkIntegrity(json: JSONObject?): UpdateApkIntegrity? {
    if (json == null) return null
    val size = when (val raw = json.opt("size")) {
      is Number -> raw.toLong()
      is String -> raw.trim().toLongOrNull()
      else -> null
    } ?: throw IllegalArgumentException("Update size metadata is invalid.")
    require(size >= 0L && size <= MAX_UPDATE_BYTES) {
      "Update size metadata exceeds the $MAX_UPDATE_BYTES byte limit."
    }
    val sha256 = json.optString("sha256").trim().lowercase()
    require(SHA256_HEX_PATTERN.matches(sha256)) {
      "Update SHA-256 metadata is invalid."
    }
    return UpdateApkIntegrity(size = size, sha256 = sha256)
  }

  private fun allowedUpdateApk(path: String): File {
    val apk = File(path).canonicalFile
    require(apk.isFile) { "APK file does not exist." }
    require(apk.extension.equals("apk", ignoreCase = true)) {
      "Update file is not an APK."
    }
    require(allowedUpdateRoots().any { root -> isContainedBy(apk, root) }) {
      "APK file is outside the Android update folder."
    }
    return apk
  }

  private fun allowedUpdateRoots(): List<File> {
    val roots = mutableListOf<File>()
    fun addUpdateRoots(base: File?) {
      if (base == null) return
      roots.add(File(base, UPDATE_DOWNLOAD_DIR))
      roots.add(File(File(base, "native-stream"), "update"))
    }

    addUpdateRoots(cacheDir)
    addUpdateRoots(externalCacheDir)
    addUpdateRoots(filesDir)
    addUpdateRoots(getExternalFilesDir(null))
    return roots.map { it.canonicalFile }
  }

  private fun verifyUpdateApkIntegrity(apk: File, integrity: UpdateApkIntegrity) {
    val fileSize = apk.length().coerceAtLeast(0L)
    require(fileSize <= MAX_UPDATE_BYTES) {
      "Update file exceeds the $MAX_UPDATE_BYTES byte limit."
    }
    require(fileSize == integrity.size) {
      "Update file size does not match metadata."
    }
    val actualSha256 = sha256Hex(apk)
    require(actualSha256 == integrity.sha256) {
      "Update file SHA-256 does not match metadata."
    }
  }

  private fun sha256Hex(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    var total = 0L
    val buffer = ByteArray(DEFAULT_STORAGE_COPY_BUFFER_BYTES)
    file.inputStream().use { input ->
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        total += read.toLong()
        require(total <= MAX_UPDATE_BYTES) {
          "Update file exceeds the $MAX_UPDATE_BYTES byte limit."
        }
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString(separator = "") { byte ->
      (byte.toInt() and 0xff).toString(16).padStart(2, '0')
    }
  }

  private fun isContainedBy(file: File, root: File): Boolean {
    val filePath = file.path
    val rootPath = root.path
    return filePath == rootPath || filePath.startsWith(rootPath + File.separator)
  }

  private fun apkInstallIntent(uri: Uri): Intent =
    Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, APK_MIME_TYPE)
      clipData = ClipData.newUri(contentResolver, "Norea update", uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

  private fun requestNotificationPermissionIfNeeded() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    if (notificationPermissionRequested) return
    if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
      PackageManager.PERMISSION_GRANTED
    ) {
      return
    }
    notificationPermissionRequested = true
    requestPermissions(
      arrayOf(Manifest.permission.POST_NOTIFICATIONS),
      REQUEST_POST_NOTIFICATIONS,
    )
  }

  private fun resolveStorageRootPick(requestId: String, payload: JSONObject) {
    val script =
      "window.__lnrResolveAndroidStoragePick && window.__lnrResolveAndroidStoragePick(" +
        "${JSONObject.quote(requestId)}, $payload);"
    mainWebView?.post {
      mainWebView?.evaluateJavascript(script, null)
    }
  }

  private fun resolveChapterArtifactInspection(requestId: String, response: String) {
    val script =
      "window.__lnrResolveAndroidChapterArtifacts && window.__lnrResolveAndroidChapterArtifacts(" +
        "${JSONObject.quote(requestId)}, ${JSONObject.quote(response)});"
    mainWebView?.post {
      mainWebView?.evaluateJavascript(script, null)
    }
  }

  private fun resolveNovelCoverInspection(requestId: String, response: String) {
    val script =
      "window.__lnrResolveAndroidNovelCover && window.__lnrResolveAndroidNovelCover(" +
        "${JSONObject.quote(requestId)}, ${JSONObject.quote(response)});"
    mainWebView?.post {
      mainWebView?.evaluateJavascript(script, null)
    }
  }

  private fun resolveChapterStorageTransfer(requestId: String, response: String) {
    val script =
      "window.__lnrResolveAndroidChapterStorageTransfer && " +
        "window.__lnrResolveAndroidChapterStorageTransfer(" +
        "${JSONObject.quote(requestId)}, ${JSONObject.quote(response)});"
    mainWebView?.post {
      mainWebView?.evaluateJavascript(script, null)
    }
  }

  private fun storageResponse(block: () -> JSONObject): String =
    runCatching(block).fold(
      onSuccess = { it.toString() },
      onFailure = { error ->
        JSONObject()
          .put("ok", false)
          .put("error", error.message ?: error.toString())
          .toString()
      },
    )

  private fun configuredStorageRootUri(): String? {
    val roots = listOfNotNull(
      File(applicationInfo.dataDir, STORAGE_ROOT_CONFIG_FILE),
      filesDir.parentFile?.let { File(it, STORAGE_ROOT_CONFIG_FILE) },
    ).distinctBy { it.absolutePath }
    for (root in roots) {
      val value = runCatching { root.readText().trim() }.getOrNull()
      if (!value.isNullOrBlank() && value.startsWith("content://")) {
        return value
      }
    }
    return null
  }

  fun androidLocalMediaResponse(uri: Uri): WebResourceResponse? {
    if (uri.scheme == NOREA_MEDIA_SCHEME) {
      return runCatching {
        androidReaderMediaResponse(uri)
      }.getOrElse { error ->
        Log.w(TAG, "Android reader media request failed. uri=$uri", error)
        androidLocalMediaErrorResponse(500, "Android reader media request failed.")
      }
    }

    val normalizedPath = uri.path?.trim('/') ?: return null
    if (
      normalizedPath != ANDROID_LOCAL_MEDIA_PATH &&
      !normalizedPath.startsWith("$ANDROID_LOCAL_MEDIA_PATH/")
    ) {
      return null
    }

    return runCatching {
      val parts = androidLocalMediaPathParts(normalizedPath)
      val rootUri = configuredStorageRootUri()
        ?: return@runCatching androidLocalMediaErrorResponse(
          404,
          "Android media storage is not selected.",
        )
      when (parts.getOrNull(0)) {
        ANDROID_DIRECT_MEDIA_PATH -> androidDirectLocalMediaResponse(rootUri, parts)
        ANDROID_ZIP_MEDIA_PATH -> androidZipLocalMediaResponse(rootUri, parts)
        else -> androidLocalMediaErrorResponse(
          404,
          "Android media source was not found.",
        )
      }
    }.getOrElse { error ->
      Log.w(TAG, "Android local media request failed. path=$normalizedPath", error)
      androidLocalMediaErrorResponse(500, "Android media request failed.")
    }
  }

  private fun androidReaderMediaResponse(uri: Uri): WebResourceResponse? {
    if (uri.host != NOREA_MEDIA_HOST) return null
    val fileName = readerMediaCacheFileName(uri)
      .takeIf { it.isNotBlank() }
      ?: return androidLocalMediaErrorResponse(
        400,
        "Android reader media file is missing.",
      )
    Log.d(TAG, "Android reader media request. uri=$uri fileName=$fileName")
    val safeName = safeZipEntryName(fileName)
      ?: return androidLocalMediaErrorResponse(
        400,
        "Android reader media file is invalid.",
      )
    val file = readerMediaCacheFileForRequest(safeName)
    if (!file.isFile) {
      Log.w(TAG, "Android reader media file not found. uri=$uri file=$file")
      return androidLocalMediaErrorResponse(
        404,
        "Android reader media file was not found.",
      )
    }
    Log.d(
      TAG,
      "Android reader media file opened. uri=$uri file=$file bytes=${file.length()}",
    )
    val imageMimeType = file.inputStream().buffered().use(::imageMimeType)
    return androidLocalMediaResponse(
      imageMimeType ?: mimeTypeForPath(safeName, ""),
      file.inputStream(),
    )
  }

  private fun readerMediaCacheFileName(uri: Uri): String {
    val segments = uri.pathSegments.filter { it.isNotBlank() }
    val fileSegments =
      if (
        segments.size >= 3 &&
          segments[0] == READER_MEDIA_CACHE_SCOPE_SEGMENT
      ) {
        segments.drop(1)
      } else {
        segments
      }
    return fileSegments.joinToString("/")
  }

  private fun androidDirectLocalMediaResponse(
    rootUri: String,
    parts: List<String>,
  ): WebResourceResponse {
      val relativePath = decodeAndroidMediaUrlPart(parts.getOrNull(1))
        ?: return androidLocalMediaErrorResponse(
          400,
          "Android media path is missing.",
        )
      val input = openStorageInputStream(rootUri, relativePath)
        ?: return androidLocalMediaErrorResponse(
          404,
          "Android media file cannot be opened.",
      )
    return androidLocalMediaResponse(
      mimeTypeForPath(relativePath, ""),
      input,
      if (isNovelCoverRelativePath(relativePath)) {
        IMMUTABLE_COVER_CACHE_CONTROL
      } else {
        "no-store"
      },
    )
  }

  private fun isNovelCoverRelativePath(relativePath: String): Boolean {
    val parts = relativePath.split('/').filter { it.isNotBlank() }
    val fileName = parts.getOrNull(3) ?: return false
    return parts.size == 4 &&
      parts[0] == CONTENTS_ROOT_DIR &&
      fileName != NOVEL_COVER_MANIFEST_FILE &&
      fileName.startsWith("cover.")
  }

  private fun androidZipLocalMediaResponse(
    rootUri: String,
    parts: List<String>,
  ): WebResourceResponse {
    val archivePath = decodeAndroidMediaUrlPart(parts.getOrNull(1))
      ?: return androidLocalMediaErrorResponse(
        400,
        "Android media archive path is missing.",
      )
    val entryName = decodeAndroidMediaUrlPart(parts.getOrNull(2))
      ?: return androidLocalMediaErrorResponse(
        400,
        "Android media archive entry is missing.",
      )
    val safeEntryName = safeZipEntryName(entryName)
      ?: return androidLocalMediaErrorResponse(
        400,
        "Android media archive entry is invalid.",
      )
    val bytes = readZipEntryBytes(rootUri, archivePath, safeEntryName)
      ?: return androidLocalMediaErrorResponse(
        404,
        "Android media archive entry was not found.",
      )
    return androidLocalMediaResponse(
      mimeTypeForPath(safeEntryName, ""),
      ByteArrayInputStream(bytes),
    )
  }

  private fun androidLocalMediaPathParts(path: String): List<String> {
    val prefix = ANDROID_LOCAL_MEDIA_PATH
    val normalized = path
      .trim('/')
      .removePrefix(prefix)
      .trim('/')
    return normalized
      .split('/')
      .filter { it.isNotBlank() }
  }

  private fun decodeAndroidMediaUrlPart(value: String?): String? {
    if (value.isNullOrBlank()) return null
    val padding = "=".repeat((4 - value.length % 4) % 4)
    return runCatching {
      String(
        Base64.decode(value + padding, Base64.URL_SAFE or Base64.NO_WRAP),
        Charsets.UTF_8,
      )
    }.getOrNull()
  }

  private fun androidLocalMediaResponse(
    mimeType: String,
    input: InputStream,
    cacheControl: String = "no-store",
  ): WebResourceResponse =
    WebResourceResponse(
      mimeType,
      null,
      200,
      "OK",
      mapOf(
        "Access-Control-Allow-Origin" to "*",
        "Cache-Control" to cacheControl,
      ),
      input,
    )

  private fun androidLocalMediaErrorResponse(
    statusCode: Int,
    message: String,
  ): WebResourceResponse =
    WebResourceResponse(
      "text/plain",
      "utf-8",
      statusCode,
      if (statusCode == 404) "Not Found" else "Error",
      mapOf("Cache-Control" to "no-store"),
      ByteArrayInputStream(message.toByteArray(Charsets.UTF_8)),
    )

  private fun storageRoot(rootUri: String): DocumentFile {
    val root = Uri.parse(rootUri)
    val treeId = runCatching { DocumentsContract.getTreeDocumentId(root) }.getOrNull()
    val hasPersistedAccess = contentResolver.persistedUriPermissions.any { permission ->
      permission.uri == root && permission.isReadPermission && permission.isWritePermission
    }
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
      Environment.isExternalStorageManager() &&
      hasPersistedAccess &&
      root.authority == "com.android.externalstorage.documents" &&
      treeId?.substringBefore(':') == "primary"
    ) {
      externalStorageFile(rootUri, "")
        ?.takeIf { it.isDirectory && it.canRead() && it.canWrite() }
        ?.let { return DocumentFile.fromFile(it) }
    }

    return DocumentFile.fromTreeUri(this, root)
      ?: throw IllegalArgumentException("Android storage folder is unavailable.")
  }

  private fun ensureContentsNoMedia(rootUri: String): Boolean {
    val relativePath = "$CONTENTS_ROOT_DIR/${MediaStore.MEDIA_IGNORE_FILENAME}"
    if (externalStorageFile(rootUri, relativePath)?.isFile == true) return false

    val existing = storageDocumentAt(rootUri, relativePath)
    if (existing != null) {
      require(existing.isFile) { "Android media marker is not a file." }
      return false
    }

    ensureStorageFile(rootUri, relativePath, "application/octet-stream")
    externalStorageFile(rootUri, relativePath)
      ?.takeIf { it.isFile }
      ?.let { marker ->
        MediaScannerConnection.scanFile(
          this,
          arrayOf(marker.absolutePath),
          null,
          null,
        )
      }
    return true
  }

  private fun safeStorageSegments(relativePath: String): List<String> {
    val segments = relativePath
      .replace('\\', '/')
      .split('/')
      .map { it.trim() }
      .filter { it.isNotEmpty() }
    require(segments.isNotEmpty()) { "Android storage path is empty." }
    for (segment in segments) {
      require(segment != "." && segment != ".." && !segment.contains('\u0000')) {
        "Android storage path contains an invalid segment."
      }
    }
    return segments
  }

  private fun storageDocumentAt(rootUri: String, relativePath: String): DocumentFile? {
    var current = storageRoot(rootUri)
    for (segment in safeStorageSegments(relativePath)) {
      current = current.findFile(segment) ?: return null
    }
    return current
  }

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
      openStorageInputStream(rootUri, relativePath, document)?.use { input ->
        readBytesWithLimit(input, MAX_CHAPTER_MEDIA_MANIFEST_BYTES)
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

  private fun writeChapterMediaManifestAtomically(
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
        val tempManifest = ensureStorageFile(
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
    val input = openStorageInputStream(rootUri, relativePath, archive)
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
    val tempArchive = ensureStorageFile(rootUri, tempRelativePath, "application/zip")
    try {
      contentResolver.openOutputStream(tempArchive.uri, "wt")?.use { output ->
        val previousArchive = if (needsSourceArchive) {
          openStorageInputStream(
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
          openStorageInputStream(
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

  private fun finalizeChapterMediaArtifacts(
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

  private fun chapterStorageTransferToken(): String =
    "${System.currentTimeMillis()}-${System.nanoTime().toString().replace('-', 'n')}"

  private fun parseChapterStorageTransferEntries(
    entries: JSONArray,
  ): List<ChapterStorageTransferEntry> {
    require(entries.length() > 0) { "Android chapter storage transfer is empty." }
    val entryIds = mutableSetOf<String>()
    val sources = mutableSetOf<String>()
    val targets = mutableSetOf<String>()
    return (0 until entries.length()).map { index ->
      val value = entries.getJSONObject(index)
      val entryId = value.getString("entryId").trim()
      require(entryId.isNotEmpty() && entryIds.add(entryId)) {
        "Android chapter storage transfer entry id is empty or duplicated."
      }
      val source = validateAndroidChapterStorageRelativeDir(
        value.getString("sourceRelativeDir"),
      ).joinToString("/")
      val target = validateAndroidChapterStorageRelativeDir(
        value.getString("targetRelativeDir"),
      ).joinToString("/")
      require(source != target) {
        "Android chapter storage transfer source and target must differ."
      }
      require(sources.add(source)) {
        "Android chapter storage transfer source is duplicated."
      }
      require(targets.add(target)) {
        "Android chapter storage transfer target is duplicated."
      }
      ChapterStorageTransferEntry(entryId, source, target)
    }
  }

  private fun parseChapterStorageTransferPreparation(
    preparationJson: String,
  ): ChapterStorageTransferPreparation {
    val value = JSONObject(preparationJson)
    val token = validateAndroidChapterStorageTransferToken(value.getString("token"))
    val entriesJson = value.getJSONArray("entries")
    val entries = parseChapterStorageTransferEntries(entriesJson)
    val preparedEntries = entries.mapIndexed { index, entry ->
      val prepared = entriesJson.getJSONObject(index)
      val outcome = prepared.getString("outcome")
      require(
        outcome == "copiedSource" ||
          outcome == "keptTarget" ||
          outcome == "sourceNotDownloaded",
      ) {
        "Android chapter storage transfer outcome is invalid."
      }
      PreparedChapterStorageTransferEntry(
        entry = entry,
        outcome = outcome,
        replacedTarget = prepared.optBoolean("replacedTarget", false),
      )
    }
    return ChapterStorageTransferPreparation(token, preparedEntries)
  }

  private fun preparedChapterStorageTransferEntryJson(
    entry: ChapterStorageTransferEntry,
    outcome: String,
    replacedTarget: Boolean,
    artifacts: ChapterStorageTransferArtifacts?,
  ): JSONObject =
    JSONObject()
      .put("entryId", entry.entryId)
      .put("sourceRelativeDir", entry.sourceRelativeDir)
      .put("targetRelativeDir", entry.targetRelativeDir)
      .put("outcome", outcome)
      .put("replacedTarget", replacedTarget)
      .put(
        "contentFile",
        artifacts?.let { "${entry.targetRelativeDir}/${it.contentName}" } ?: JSONObject.NULL,
      )
      .put("contentBytes", artifacts?.contentBytes ?: 0L)
      .put("mediaBytes", artifacts?.mediaBytes ?: 0L)

  private fun inspectChapterStorageTransferArtifacts(
    directory: DocumentFile,
    relativeDir: String,
  ): ChapterStorageTransferArtifacts? {
    if (!directory.isDirectory) return null
    require(directory.canRead()) {
      "Android chapter storage path is not readable: $relativeDir"
    }
    val content = listOf("content.html", "content.pdf")
      .firstNotNullOfOrNull { name ->
        directory.findFile(name)?.also { candidate ->
          require(candidate.isFile) {
            "Android chapter storage content path is not a file: $relativeDir/$name"
          }
          require(candidate.canRead()) {
            "Android chapter storage content is not readable: $relativeDir/$name"
          }
        }
      } ?: return null
    val contentName = content.name
      ?: throw IllegalStateException("Android chapter storage content name is unavailable.")
    val mediaDirectoryBytes = directory.findFile("media")?.let { media ->
      require(media.isDirectory) {
        "Android chapter storage media path is not a folder: $relativeDir/media"
      }
      storageDocumentSize(media)
    } ?: 0L
    val mediaArchiveBytes = directory.findFile("media.zip")?.let { archive ->
      require(archive.isFile) {
        "Android chapter storage media archive is not a file: $relativeDir/media.zip"
      }
      archive.length().coerceAtLeast(0L)
    } ?: 0L
    return ChapterStorageTransferArtifacts(
      contentBytes = content.length().coerceAtLeast(0L),
      contentName = contentName,
      mediaBytes = Math.addExact(mediaDirectoryBytes, mediaArchiveBytes),
    )
  }

  private fun ensureChapterStorageTransferParent(
    rootUri: String,
    targetSegments: List<String>,
  ): DocumentFile {
    var current = storageRoot(rootUri)
    for (segment in targetSegments.dropLast(1)) {
      current = ensureStorageDirectory(current, segment)
    }
    return current
  }

  private fun requireAndroidStorageEntryName(name: String?): String {
    val value = name
      ?: throw IllegalStateException("Android chapter storage entry has no name.")
    require(
      value.isNotEmpty() &&
        value == value.trim() &&
        value != "." &&
        value != ".." &&
        !value.contains('/') &&
        !value.contains('\\') &&
        !value.contains('\u0000'),
    ) {
      "Android chapter storage entry name is invalid."
    }
    return value
  }

  private fun copyChapterStorageDirectory(
    source: DocumentFile,
    targetParent: DocumentFile,
    targetName: String,
    targetRelativeDir: String,
  ): DocumentFile {
    require(source.isDirectory && source.canRead()) {
      "Android chapter storage transfer source is not a readable folder."
    }
    require(targetParent.findFile(targetName) == null) {
      "Android chapter storage transfer stage already exists."
    }
    val target = targetParent.createDirectory(targetName)
      ?.let { created ->
        requireExactCreatedStorageName(
          created,
          targetName,
          "folder",
          "Android chapter storage transfer stage is inaccessible.",
        )
      }
      ?: throw IllegalStateException("Cannot create Android chapter storage transfer stage.")

    fun copyChildren(sourceDirectory: DocumentFile, targetDirectory: DocumentFile, path: String) {
      for (sourceChild in sourceDirectory.listFiles()) {
        val name = requireAndroidStorageEntryName(sourceChild.name)
        val childPath = "$path/$name"
        when {
          sourceChild.isDirectory -> {
            val targetChild = targetDirectory.createDirectory(name)
              ?.let { created ->
                requireExactCreatedStorageName(
                  created,
                  name,
                  "folder",
                  "Android chapter storage transfer folder is inaccessible: $childPath",
                )
              }
              ?: throw IllegalStateException(
                "Cannot create Android chapter storage transfer folder: $childPath",
              )
            copyChildren(sourceChild, targetChild, childPath)
          }
          sourceChild.isFile -> {
            require(sourceChild.canRead()) {
              "Android chapter storage transfer file is not readable: $childPath"
            }
            val targetChild = createStorageFile(
              targetDirectory,
              sourceChild.type ?: mimeTypeForPath(childPath, "application/octet-stream"),
              name,
            )?.let { created ->
              requireExactCreatedStorageName(
                created,
                name,
                "file",
                "Android chapter storage transfer file is inaccessible: $childPath",
              )
            } ?: throw IllegalStateException(
              "Cannot create Android chapter storage transfer file: $childPath",
            )
            val input = contentResolver.openInputStream(sourceChild.uri)
              ?: throw IllegalStateException(
                "Cannot open Android chapter storage transfer source: $childPath",
              )
            val output = contentResolver.openOutputStream(targetChild.uri, "wt")
              ?: throw IllegalStateException(
                "Cannot open Android chapter storage transfer target: $childPath",
              )
            input.use { sourceStream ->
              output.use { targetStream ->
                sourceStream.copyTo(targetStream, DEFAULT_STORAGE_COPY_BUFFER_BYTES)
              }
            }
          }
          else -> throw IllegalStateException(
            "Android chapter storage transfer contains an unsupported entry: $childPath",
          )
        }
      }
    }

    return try {
      copyChildren(source, target, targetRelativeDir)
      target
    } catch (error: Throwable) {
      runCatching {
        deleteChapterStorageDocument(
          target,
          "Cannot remove failed Android chapter storage transfer stage.",
        )
      }.exceptionOrNull()?.let(error::addSuppressed)
      throw error
    }
  }

  private fun deleteChapterStorageDocument(document: DocumentFile, context: String) {
    if (!document.delete()) {
      throw IllegalStateException(context)
    }
  }

  private fun renameChapterStorageDocument(
    parent: DocumentFile,
    document: DocumentFile,
    newName: String,
    context: String,
  ): DocumentFile {
    require(parent.findFile(newName) == null) {
      "Android chapter storage transfer target already exists: $newName"
    }
    if (!document.renameTo(newName)) {
      throw IllegalStateException(context)
    }
    return parent.findFile(newName)
      ?: throw IllegalStateException("Android chapter storage renamed path is inaccessible: $newName")
  }

  private fun prepareChapterStorageTransferEntry(
    rootUri: String,
    entry: ChapterStorageTransferEntry,
    token: String,
  ): JSONObject {
    val targetSegments = validateAndroidChapterStorageRelativeDir(entry.targetRelativeDir)
    val targetName = targetSegments.last()
    storageDocumentAt(rootUri, entry.targetRelativeDir)?.let { target ->
      inspectChapterStorageTransferArtifacts(target, entry.targetRelativeDir)?.let { artifacts ->
        return preparedChapterStorageTransferEntryJson(
          entry,
          "keptTarget",
          false,
          artifacts,
        )
      }
    }

    val source = storageDocumentAt(rootUri, entry.sourceRelativeDir)
      ?: return preparedChapterStorageTransferEntryJson(
        entry,
        "sourceNotDownloaded",
        false,
        null,
      )
    require(source.isDirectory) {
      "Android chapter storage transfer source is not a folder: ${entry.sourceRelativeDir}"
    }
    val sourceArtifacts = inspectChapterStorageTransferArtifacts(
      source,
      entry.sourceRelativeDir,
    ) ?: return preparedChapterStorageTransferEntryJson(
      entry,
      "sourceNotDownloaded",
      false,
      null,
    )

    val targetParent = ensureChapterStorageTransferParent(rootUri, targetSegments)
    val stageName = androidChapterStorageTransferSiblingName(targetName, token, "stage")
    val backupName = androidChapterStorageTransferSiblingName(targetName, token, "backup")
    require(targetParent.findFile(stageName) == null && targetParent.findFile(backupName) == null) {
      "Android chapter storage transfer workspace already exists."
    }

    var replacedTarget = false
    var publishedTarget = false
    try {
      val stage = copyChapterStorageDirectory(
        source,
        targetParent,
        stageName,
        entry.targetRelativeDir,
      )
      val markerName = androidChapterStorageTransferMarkerName(token)
      require(stage.findFile(markerName) == null) {
        "Android chapter storage transfer marker already exists in copied source."
      }
      createStorageFile(stage, "application/octet-stream", markerName)
        ?.let { marker ->
          requireExactCreatedStorageName(
            marker,
            markerName,
            "file",
            "Android chapter storage transfer marker is inaccessible.",
          )
        }
        ?: throw IllegalStateException(
          "Cannot create Android chapter storage transfer marker.",
        )
      val stagedArtifacts = inspectChapterStorageTransferArtifacts(
        stage,
        "${targetSegments.dropLast(1).joinToString("/")}/$stageName",
      ) ?: throw IllegalStateException(
        "Android copied chapter storage transfer has no final content.",
      )
      require(
        stagedArtifacts.contentBytes == sourceArtifacts.contentBytes &&
          stagedArtifacts.mediaBytes == sourceArtifacts.mediaBytes,
      ) {
        "Android copied chapter storage transfer failed artifact verification."
      }

      targetParent.findFile(targetName)?.let { racedTarget ->
        inspectChapterStorageTransferArtifacts(
          racedTarget,
          entry.targetRelativeDir,
        )?.let { targetArtifacts ->
          deleteChapterStorageDocument(
            stage,
            "Cannot remove superseded Android chapter storage transfer stage.",
          )
          return preparedChapterStorageTransferEntryJson(
            entry,
            "keptTarget",
            false,
            targetArtifacts,
          )
        }
        renameChapterStorageDocument(
          targetParent,
          racedTarget,
          backupName,
          "Cannot backup invalid Android chapter storage transfer target.",
        )
        replacedTarget = true
      }

      renameChapterStorageDocument(
        targetParent,
        stage,
        targetName,
        "Cannot publish Android chapter storage transfer.",
      )
      publishedTarget = true
      val published = targetParent.findFile(targetName)
        ?: throw IllegalStateException("Published Android chapter storage transfer is missing.")
      val publishedArtifacts = inspectChapterStorageTransferArtifacts(
        published,
        entry.targetRelativeDir,
      ) ?: throw IllegalStateException(
        "Published Android chapter storage transfer has no final content.",
      )
      return preparedChapterStorageTransferEntryJson(
        entry,
        "copiedSource",
        replacedTarget,
        publishedArtifacts,
      )
    } catch (error: Throwable) {
      if (publishedTarget) {
        targetParent.findFile(targetName)?.let { target ->
          runCatching {
            deleteChapterStorageDocument(
              target,
              "Cannot remove failed Android chapter storage transfer target.",
            )
          }.exceptionOrNull()?.let(error::addSuppressed)
        }
      }
      if (replacedTarget) {
        targetParent.findFile(backupName)?.let { backup ->
          runCatching {
            if (targetParent.findFile(targetName) == null) {
              renameChapterStorageDocument(
                targetParent,
                backup,
                targetName,
                "Cannot restore failed Android chapter storage transfer target.",
              )
            }
          }.exceptionOrNull()?.let(error::addSuppressed)
        }
      }
      targetParent.findFile(stageName)?.let { stage ->
        runCatching {
          deleteChapterStorageDocument(
            stage,
            "Cannot remove failed Android chapter storage transfer stage.",
          )
        }.exceptionOrNull()?.let(error::addSuppressed)
      }
      throw error
    }
  }

  private fun prepareChapterStorageTransfer(rootUri: String, entriesJson: String): JSONObject {
    val entries = parseChapterStorageTransferEntries(JSONArray(entriesJson))
    val token = validateAndroidChapterStorageTransferToken(chapterStorageTransferToken())
    ensureContentsNoMedia(rootUri)
    val prepared = JSONArray()
    try {
      for (entry in entries) {
        prepared.put(prepareChapterStorageTransferEntry(rootUri, entry, token))
      }
    } catch (error: Throwable) {
      if (prepared.length() > 0) {
        val preparation = ChapterStorageTransferPreparation(
          token,
          (0 until prepared.length()).map { index ->
            val value = prepared.getJSONObject(index)
            PreparedChapterStorageTransferEntry(
              entry = entries[index],
              outcome = value.getString("outcome"),
              replacedTarget = value.optBoolean("replacedTarget", false),
            )
          },
        )
        runCatching {
          rollbackChapterStorageTransfer(rootUri, preparation)
        }.exceptionOrNull()?.let(error::addSuppressed)
      }
      throw error
    }
    return JSONObject()
      .put("token", token)
      .put("entries", prepared)
  }

  private fun finalizeChapterStorageTransfer(rootUri: String, preparationJson: String) {
    finalizeChapterStorageTransfer(
      rootUri,
      parseChapterStorageTransferPreparation(preparationJson),
    )
  }

  private fun finalizeChapterStorageTransfer(
    rootUri: String,
    preparation: ChapterStorageTransferPreparation,
  ) {
    validateAndroidChapterStorageTransferToken(preparation.token)
    for (prepared in preparation.entries) {
      val entry = prepared.entry
      val targetSegments = validateAndroidChapterStorageRelativeDir(entry.targetRelativeDir)
      val targetName = targetSegments.last()
      val parentPath = targetSegments.dropLast(1).joinToString("/")
      val parent = storageDocumentAt(rootUri, parentPath)
      parent?.findFile(
        androidChapterStorageTransferSiblingName(targetName, preparation.token, "stage"),
      )?.let { stage ->
        deleteChapterStorageDocument(
          stage,
          "Cannot remove finalized Android chapter storage transfer stage.",
        )
      }
      if (prepared.outcome == "copiedSource") {
        val target = parent?.findFile(targetName)
          ?: throw IllegalStateException(
            "Cannot finalize Android chapter storage transfer without its target.",
          )
        require(
          inspectChapterStorageTransferArtifacts(target, entry.targetRelativeDir) != null,
        ) {
          "Cannot finalize Android chapter storage transfer without final target content."
        }
        val markerName = androidChapterStorageTransferMarkerName(preparation.token)
        val source = storageDocumentAt(rootUri, entry.sourceRelativeDir)
        if (source != null) {
          require(source.isDirectory) {
            "Android chapter storage transfer source is not a folder."
          }
          val marker = target.findFile(markerName)
          require(marker?.isFile == true) {
            "Cannot finalize an unmarked Android chapter storage transfer target."
          }
          deleteChapterStorageDocument(
            source,
            "Cannot remove finalized Android chapter storage transfer source.",
          )
        }
        target.findFile(markerName)?.let { marker ->
          require(marker.isFile) {
            "Android chapter storage transfer marker is not a file."
          }
          deleteChapterStorageDocument(
            marker,
            "Cannot remove finalized Android chapter storage transfer marker.",
          )
        }
      }
      parent?.findFile(
        androidChapterStorageTransferSiblingName(targetName, preparation.token, "backup"),
      )?.let { backup ->
        deleteChapterStorageDocument(
          backup,
          "Cannot remove finalized Android chapter storage transfer backup.",
        )
      }
    }
  }

  private fun rollbackChapterStorageTransfer(rootUri: String, preparationJson: String) {
    rollbackChapterStorageTransfer(
      rootUri,
      parseChapterStorageTransferPreparation(preparationJson),
    )
  }

  private fun rollbackChapterStorageTransfer(
    rootUri: String,
    preparation: ChapterStorageTransferPreparation,
  ) {
    validateAndroidChapterStorageTransferToken(preparation.token)
    for (prepared in preparation.entries.asReversed()) {
      val entry = prepared.entry
      val targetSegments = validateAndroidChapterStorageRelativeDir(entry.targetRelativeDir)
      val targetName = targetSegments.last()
      val parentPath = targetSegments.dropLast(1).joinToString("/")
      val parent = storageDocumentAt(rootUri, parentPath) ?: continue
      val stageName = androidChapterStorageTransferSiblingName(
        targetName,
        preparation.token,
        "stage",
      )
      parent.findFile(stageName)?.let { stage ->
        deleteChapterStorageDocument(
          stage,
          "Cannot remove rolled back Android chapter storage transfer stage.",
        )
      }
      if (prepared.outcome != "copiedSource") continue
      val backupName = androidChapterStorageTransferSiblingName(
        targetName,
        preparation.token,
        "backup",
      )
      val markerName = androidChapterStorageTransferMarkerName(preparation.token)
      if (prepared.replacedTarget) {
        parent.findFile(backupName)?.let { backup ->
          parent.findFile(targetName)?.let { target ->
            val marker = target.findFile(markerName)
            if (marker?.isFile == true) {
              deleteChapterStorageDocument(
                target,
                "Cannot remove rolled back Android chapter storage transfer target.",
              )
            }
          }
          require(parent.findFile(targetName) == null) {
            "Cannot restore an Android chapter storage transfer backup over an unmarked target."
          }
          renameChapterStorageDocument(
            parent,
            backup,
            targetName,
            "Cannot restore rolled back Android chapter storage transfer target.",
          )
        }
      } else {
        parent.findFile(targetName)?.let { target ->
          if (target.findFile(markerName)?.isFile == true) {
            deleteChapterStorageDocument(
              target,
              "Cannot remove rolled back Android chapter storage transfer target.",
            )
          }
        }
      }
    }
  }

  private fun removeChapterStorageDirectory(rootUri: String, relativeDir: String) {
    val normalized = validateAndroidChapterStorageRemovalRelativeDir(relativeDir)
      .joinToString("/")
    storageDocumentAt(rootUri, normalized)?.let { directory ->
      require(directory.isDirectory) {
        "Android chapter storage cleanup path is not a folder: $normalized"
      }
      deleteChapterStorageDocument(
        directory,
        "Cannot remove Android chapter storage directory: $normalized",
      )
    }
  }

  private fun openStorageInputStream(
    rootUri: String,
    relativePath: String,
    document: DocumentFile,
  ): InputStream? =
    runCatching {
      externalStorageFile(rootUri, relativePath)
        ?.takeIf { it.isFile }
        ?.inputStream()
    }.getOrNull()
      ?: runCatching { contentResolver.openInputStream(document.uri) }.getOrNull()

  private fun openStorageInputStream(rootUri: String, relativePath: String): InputStream? {
    val directFile = runCatching {
      externalStorageFile(rootUri, relativePath)
    }.getOrElse { error ->
      Log.w(TAG, "Android storage direct path failed. path=$relativePath root=$rootUri", error)
      null
    }
    val direct = directFile?.takeIf { it.isFile }?.let { file ->
      runCatching { file.inputStream() }.getOrElse { error ->
        Log.w(
          TAG,
          "Android storage direct read failed. path=$relativePath file=${file.absolutePath}",
          error,
        )
        null
      }
    }
    if (direct != null) return direct

    val documentUri = runCatching {
      storageDocumentUri(rootUri, relativePath)
    }.getOrElse { error ->
      Log.w(
        TAG,
        "Android storage document uri failed. path=$relativePath root=$rootUri",
        error,
      )
      null
    }
    val documentStream = documentUri?.let { uri ->
      runCatching { contentResolver.openInputStream(uri) }.getOrElse { error ->
        Log.w(
          TAG,
          "Android storage document read failed. path=$relativePath uri=$uri",
          error,
        )
        null
      }
    }
    if (documentStream != null) return documentStream

    val document = storageDocumentAt(rootUri, relativePath) ?: return null
    if (!document.isFile) return null
    return runCatching { contentResolver.openInputStream(document.uri) }.getOrElse { error ->
      Log.w(
        TAG,
        "Android storage fallback document read failed. path=$relativePath uri=${document.uri}",
        error,
      )
      null
    }
  }

  private fun storageReadFailureMessage(rootUri: String, relativePath: String): String {
    val document = runCatching { storageDocumentAt(rootUri, relativePath) }.getOrNull()
    val message = when {
      document == null -> "Android storage file not found: $relativePath"
      !document.isFile -> "Android storage path is not a file: $relativePath"
      else -> "Cannot open storage file for reading: $relativePath"
    }
    Log.w(TAG, "$message root=$rootUri")
    return message
  }

  private fun storageDocumentUri(rootUri: String, relativePath: String): Uri {
    val root = Uri.parse(rootUri)
    val treeId = DocumentsContract.getTreeDocumentId(root)
    val relative = safeStorageSegments(relativePath).joinToString("/")
    val documentId = listOf(treeId, relative)
      .filter { it.isNotBlank() }
      .joinToString("/")
    return DocumentsContract.buildDocumentUriUsingTree(root, documentId)
  }

  private fun externalStorageFile(rootUri: String, relativePath: String): File? {
    val root = Uri.parse(rootUri)
    if (root.authority != "com.android.externalstorage.documents") return null
    val treeId = runCatching { DocumentsContract.getTreeDocumentId(root) }.getOrNull()
      ?: return null
    val separator = treeId.indexOf(':')
    val volume = if (separator >= 0) treeId.substring(0, separator) else treeId
    val treePath = if (separator >= 0) treeId.substring(separator + 1) else ""
    val base = if (volume == "primary") {
      Environment.getExternalStorageDirectory()
    } else {
      File("/storage/$volume")
    }
    val storagePath = listOf(treePath, relativePath)
      .filter { it.isNotBlank() }
      .joinToString("/")
    if (storagePath.isBlank()) return base
    var file = base
    for (segment in safeStorageSegments(storagePath)) {
      file = File(file, segment)
    }
    return file
  }

  private fun restoreBackupDirectoryName(token: String): String {
    val safeToken = safeZipEntryName(token)
      ?: throw IllegalArgumentException("Android restore token is invalid.")
    return "contents.restore-$safeToken"
  }

  private fun ensureStorageDirectory(parent: DocumentFile, name: String): DocumentFile {
    val existing = parent.findFile(name)
    if (existing != null) {
      require(existing.isDirectory) { "Android storage path segment is not a folder: $name" }
      return existing
    }
    val created = parent.createDirectory(name)
      ?: throw IllegalStateException("Cannot create Android storage folder: $name")
    return requireExactCreatedStorageName(
      created,
      name,
      "folder",
      "Android storage folder already exists but is not accessible: $name",
    )
  }

  private fun createStorageFile(
    parent: DocumentFile,
    mimeType: String,
    name: String,
  ): DocumentFile? {
    if (parent.uri.scheme != ContentResolver.SCHEME_FILE) {
      return parent.createFile(mimeType, name)
    }
    val parentPath = parent.uri.path ?: return null
    val created = createRawAndroidStorageFile(File(parentPath), name) ?: return null
    return DocumentFile.fromFile(created)
  }

  private fun ensureStorageFile(
    rootUri: String,
    relativePath: String,
    mimeType: String,
  ): DocumentFile {
    val segments = safeStorageSegments(relativePath)
    var current = storageRoot(rootUri)
    for (segment in segments.dropLast(1)) {
      current = ensureStorageDirectory(current, segment)
    }
    val fileName = segments.last()
    val existing = current.findFile(fileName)
    if (existing != null) {
      require(existing.isFile) { "Android storage path is not a file: $relativePath" }
      return existing
    }
    val created = createStorageFile(current, mimeType, fileName)
    if (created != null) {
      return requireExactCreatedStorageName(
        created,
        fileName,
        "file",
        "Android storage file already exists but is not accessible: $relativePath",
      )
    }
    val raced = current.findFile(fileName)
    if (raced != null) {
      require(raced.isFile) { "Android storage path is not a file: $relativePath" }
      return raced
    }
    throw IllegalStateException("Cannot create Android storage file: $relativePath")
  }

  private fun requireExactCreatedStorageName(
    created: DocumentFile,
    requestedName: String,
    kind: String,
    errorMessage: String,
  ): DocumentFile {
    val createdName = created.name
    if (createdName == requestedName) return created

    val deleted = runCatching { created.delete() }.getOrDefault(false)
    Log.w(
      TAG,
      "SAF created unexpected $kind name. requested=$requestedName actual=$createdName " +
        "uri=${created.uri} deleted=$deleted",
    )
    throw IllegalStateException(errorMessage)
  }

  private fun safeZipEntryName(name: String?): String? {
    val entryName = name
      ?.replace('\\', '/')
      ?.trim()
      ?.trim('/')
      ?.trim()
      ?: return null
    if (entryName.isEmpty() || entryName.contains('\u0000')) return null
    val parts = entryName.split('/')
    if (
      parts.any { part ->
        part.isEmpty() ||
          part == "." ||
          part == ".." ||
          !part.all { ch ->
            ch.isLetterOrDigit() || ch == '.' || ch == '_' || ch == '-'
          }
      }
    ) {
      return null
    }
    return entryName
  }

  private fun parseStorageByteLimit(raw: String): Long {
    val limit = raw.trim().toLongOrNull()
      ?: throw IllegalArgumentException("Android storage byte limit is invalid.")
    require(limit > 0L) { "Android storage byte limit must be positive." }
    require(limit <= MAX_ANDROID_TEMP_BYTES) {
      "Android storage byte limit exceeds the $MAX_ANDROID_TEMP_BYTES byte limit."
    }
    return limit
  }

  private fun contentUriMetadata(uri: Uri): ContentUriMetadata {
    var fileName: String? = null
    var size: Long? = null
    runCatching {
      contentResolver.query(
        uri,
        arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
        null,
        null,
        null,
      )?.use { cursor ->
        if (!cursor.moveToFirst()) return@use
        val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (nameIndex >= 0 && !cursor.isNull(nameIndex)) {
          fileName = cursor.getString(nameIndex)
        }
        val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
        if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
          size = cursor.getLong(sizeIndex).takeIf { it >= 0L }
        }
      }
    }.onFailure { error ->
      Log.w(TAG, "Android content URI metadata query failed. uri=$uri", error)
    }
    return ContentUriMetadata(fileName, size)
  }

  private fun contentUriMimeType(uri: Uri): String =
    contentResolver.getType(uri)
      ?.takeIf { it.isNotBlank() }
      ?: mimeTypeForPath(uri.toString(), "")
        .ifBlank { "application/octet-stream" }

  private fun contentUriFileName(
    uri: Uri,
    mimeType: String,
    displayName: String?,
  ): String {
    displayName?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
    uri.lastPathSegment
      ?.substringAfterLast('/')
      ?.substringAfterLast(':')
      ?.takeIf { it.isNotBlank() }
      ?.let { return it }
    val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType)
    return if (extension.isNullOrBlank()) "opened-file" else "opened-file.$extension"
  }

  private fun storageTempRoot(): File {
    val root = File(cacheDir, STORAGE_TEMP_DIR)
    if (!root.exists() && !root.mkdirs()) {
      throw IllegalStateException("Cannot create Android storage temp folder.")
    }
    require(root.isDirectory) { "Android storage temp path is not a folder." }
    return root.canonicalFile
  }

  private fun createStorageTempFile(): File =
    File.createTempFile("content-", ".tmp", storageTempRoot()).canonicalFile

  private fun containedStorageTempFile(path: String): File {
    val root = storageTempRoot()
    val file = File(path).canonicalFile
    require(file.path.startsWith(root.path + File.separator)) {
      "Android storage temp file is outside the bridge temp folder."
    }
    return file
  }

  private fun readerMediaCacheRoot(): File {
    val root = File(cacheDir, READER_MEDIA_CACHE_DIR).canonicalFile
    if (!root.exists() && !root.mkdirs()) {
      throw IllegalStateException("Cannot create reader media cache folder.")
    }
    require(root.isDirectory) { "Reader media cache path is not a folder." }
    return root
  }

  private fun readerMediaCacheTokenRoot(cacheToken: String): File {
    val root = readerMediaCacheRoot()
    val tokenRoot = File(root, cacheToken).canonicalFile
    require(tokenRoot.path.startsWith(root.path + File.separator)) {
      "Reader media cache token is outside the cache folder."
    }
    if (!tokenRoot.exists() && !tokenRoot.mkdirs()) {
      throw IllegalStateException("Cannot create reader media cache token folder.")
    }
    require(tokenRoot.isDirectory) {
      "Reader media cache token path is not a folder."
    }
    return tokenRoot
  }

  private fun safeReaderMediaCacheToken(value: String): String? =
    value
      .trim()
      .takeIf { it.isNotBlank() && it.length <= 96 }
      ?.takeIf { token ->
        token.all { char ->
          char in 'A'..'Z' ||
            char in 'a'..'z' ||
            char in '0'..'9' ||
            char == '.' ||
            char == '_' ||
            char == '-'
        }
      }

  private fun containedReaderMediaCacheFile(fileName: String): File =
    containedReaderMediaCacheFile(fileName, readerMediaCacheRoot())

  private fun containedReaderMediaCacheFile(fileName: String, root: File): File {
    val safeName = safeZipEntryName(fileName)
      ?: throw IllegalArgumentException("Reader media file name is invalid.")
    val file = File(root, safeName).canonicalFile
    require(file.path.startsWith(root.path + File.separator)) {
      "Reader media file is outside the cache folder."
    }
    return file
  }

  private fun readerMediaCacheFileForRequest(fileName: String): File {
    val direct = containedReaderMediaCacheFile(fileName)
    if (direct.isFile || fileName.contains("/")) return direct
    val root = readerMediaCacheRoot()
    val matches = root
      .listFiles()
      ?.filter { it.isDirectory }
      ?.mapNotNull { tokenRoot ->
        containedReaderMediaCacheFile(fileName, tokenRoot)
          .takeIf { it.isFile }
      }
      ?: emptyList()
    if (matches.size == 1) {
      Log.d(
        TAG,
        "Android reader media file opened from token fallback. " +
          "fileName=$fileName file=${matches[0]}",
      )
      return matches[0]
    }
    return direct
  }

  private data class ReaderMediaCacheStats(
    val entryCount: Int = 0,
    val totalBytes: Long = 0L,
  )

  private fun copyReaderMediaDirectoryToCache(
    rootUri: String,
    mediaRelativePath: String,
    cacheRoot: File,
  ): ReaderMediaCacheStats {
    val sourceDir = storageDocumentAt(rootUri, mediaRelativePath)
      ?.takeIf { it.isDirectory }
      ?: return ReaderMediaCacheStats()
    var entryCount = 0
    var totalBytes = 0L

    fun copyChildren(directory: DocumentFile, prefix: String) {
      directory.listFiles()
        .sortedBy { it.name ?: "" }
        .forEach { child ->
          val childName = child.name ?: return@forEach
          val entryName = safeZipEntryName(
            if (prefix.isBlank()) childName else "$prefix/$childName",
          ) ?: return@forEach
          if (child.isDirectory) {
            copyChildren(child, entryName)
            return@forEach
          }
          if (!child.isFile || entryName.endsWith(".part")) return@forEach
          requireStorageFileZipEntrySize(child, "Reader media file")
          entryCount = nextZipEntryCount(entryCount, "Reader media directory")
          val target = containedReaderMediaCacheFile(entryName, cacheRoot)
          target.parentFile?.mkdirs()
          target.outputStream().use { output ->
            val copied = openStorageInputStream(
              rootUri,
              "$mediaRelativePath/$entryName",
              child,
            )?.use { input ->
              copyToWithLimit(input, output, MAX_ZIP_ENTRY_BYTES)
            } ?: throw IllegalStateException("Cannot open reader media file.")
            totalBytes = addZipTotalBytes(
              totalBytes,
              copied,
              "Reader media directory",
            )
          }
        }
    }

    copyChildren(sourceDir, "")
    return ReaderMediaCacheStats(entryCount, totalBytes)
  }

  private fun copyReaderMediaArchiveToCache(
    rootUri: String,
    archiveRelativePath: String,
    cacheRoot: File,
  ): ReaderMediaCacheStats {
    var entryCount = 0
    var totalBytes = 0L
    openStorageInputStream(rootUri, archiveRelativePath)?.use { input ->
      ZipInputStream(input.buffered()).use { zip ->
        var entry = zip.nextEntry
        while (entry != null) {
          entryCount = nextZipEntryCount(entryCount, "Reader media archive")
          val entryName = safeZipEntryName(entry.name)
          if (!entry.isDirectory && entryName != null) {
            requireZipEntrySize(entry, "Reader media archive entry")
            val target = containedReaderMediaCacheFile(entryName, cacheRoot)
            target.parentFile?.mkdirs()
            target.outputStream().use { output ->
              val copied = copyToWithLimit(zip, output, MAX_ZIP_ENTRY_BYTES)
              totalBytes = addZipTotalBytes(
                totalBytes,
                copied,
                "Reader media archive",
              )
            }
          }
          zip.closeEntry()
          entry = zip.nextEntry
        }
      }
    } ?: return ReaderMediaCacheStats()
    return ReaderMediaCacheStats(entryCount, totalBytes)
  }

  private fun containedAppCacheFile(path: String): File {
    val root = cacheDir.canonicalFile
    val file = File(path).canonicalFile
    require(file.path == root.path || file.path.startsWith(root.path + File.separator)) {
      "Selected backup temp file is outside the app cache folder."
    }
    return file
  }

  private fun nextZipEntryCount(count: Int, context: String): Int {
    val next = count + 1
    require(next <= MAX_ZIP_ENTRIES) {
      "$context has more than $MAX_ZIP_ENTRIES entries."
    }
    return next
  }

  private fun requireZipEntrySize(entry: ZipEntry, context: String) {
    val size = entry.size
    require(size < 0L || size <= MAX_ZIP_ENTRY_BYTES) {
      "$context exceeds the $MAX_ZIP_ENTRY_BYTES byte entry limit."
    }
  }

  private fun requireStorageFileZipEntrySize(file: DocumentFile, context: String) {
    val size = file.length()
    require(size <= 0L || size <= MAX_ZIP_ENTRY_BYTES) {
      "$context exceeds the $MAX_ZIP_ENTRY_BYTES byte entry limit."
    }
  }

  private fun addZipTotalBytes(total: Long, copied: Long, context: String): Long {
    val next = total + copied
    require(next >= total && next <= MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
      "$context exceeds the $MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES byte total limit."
    }
    return next
  }

  private fun readZipEntryBytes(
    rootUri: String,
    archiveRelativePath: String,
    entryName: String,
  ): ByteArray? {
    val archive = storageDocumentAt(rootUri, archiveRelativePath) ?: return null
    if (!archive.isFile) return null
    return openStorageInputStream(rootUri, archiveRelativePath, archive)?.use { input ->
      var body: ByteArray? = null
      ZipInputStream(input.buffered()).use { zip ->
        var entry = zip.nextEntry
        var entryCount = 0
        while (entry != null) {
          entryCount = nextZipEntryCount(entryCount, "Media archive")
          val currentName = safeZipEntryName(entry.name)
          if (!entry.isDirectory && currentName == entryName) {
            requireZipEntrySize(entry, "Media archive entry")
            body = readBytesWithLimit(zip, MAX_ZIP_ENTRY_BYTES)
            break
          }
          zip.closeEntry()
          entry = zip.nextEntry
        }
      }
      body
    }
  }

  private fun readBytesWithLimit(input: InputStream, maxBytes: Long): ByteArray {
    val output = ByteArrayOutputStream()
    copyToWithLimit(input, output, maxBytes)
    return output.toByteArray()
  }

  private fun copyToWithLimit(
    input: InputStream,
    output: OutputStream,
    maxBytes: Long,
  ): Long {
    val buffer = ByteArray(DEFAULT_STORAGE_COPY_BUFFER_BYTES)
    var total = 0L
    while (true) {
      val read = input.read(buffer)
      if (read < 0) break
      val next = total + read
      if (next < total || next > maxBytes) {
        throw IllegalArgumentException(
          "Android storage stream exceeds the $maxBytes byte limit.",
        )
      }
      output.write(buffer, 0, read)
      total = next
    }
    return total
  }

  private fun textMimeTypeForPath(relativePath: String): String =
    mimeTypeForPath(relativePath, "")

  private fun imageMimeType(input: InputStream): String? {
    val header = ByteArray(IMAGE_SIGNATURE_MAX_BYTES)
    var length = 0
    while (length < header.size) {
      val read = input.read(header, length, header.size - length)
      if (read <= 0) break
      length += read
    }

    return when {
      length >= 3 &&
        byteValue(header[0]) == 0xff &&
        byteValue(header[1]) == 0xd8 &&
        byteValue(header[2]) == 0xff -> "image/jpeg"
      length >= 8 &&
        byteValue(header[0]) == 0x89 &&
        hasAsciiSignature(header, length, 1, "PNG") &&
        byteValue(header[4]) == 0x0d &&
        byteValue(header[5]) == 0x0a &&
        byteValue(header[6]) == 0x1a &&
        byteValue(header[7]) == 0x0a -> "image/png"
      hasAsciiSignature(header, length, 0, "GIF87a") ||
        hasAsciiSignature(header, length, 0, "GIF89a") -> "image/gif"
      hasAsciiSignature(header, length, 0, "RIFF") &&
        hasAsciiSignature(header, length, 8, "WEBP") -> "image/webp"
      hasAsciiSignature(header, length, 0, "BM") -> "image/bmp"
      hasAvifSignature(header, length) -> "image/avif"
      else -> null
    }
  }

  private fun hasAsciiSignature(
    bytes: ByteArray,
    length: Int,
    offset: Int,
    signature: String,
  ): Boolean {
    if (offset < 0 || offset + signature.length > length) return false
    return signature.indices.all { index ->
      byteValue(bytes[offset + index]) == signature[index].code
    }
  }

  private fun hasAvifSignature(header: ByteArray, length: Int): Boolean {
    if (length < 12 || !hasAsciiSignature(header, length, 4, "ftyp")) {
      return false
    }
    val declaredSize = (0 until 4).fold(0L) { size, index ->
      (size shl 8) or byteValue(header[index]).toLong()
    }
    val boxEnd = when {
      declaredSize == 0L -> length
      declaredSize == 1L -> return false
      else -> minOf(length.toLong(), declaredSize).toInt()
    }
    if (boxEnd < 12) return false
    if (
      hasAsciiSignature(header, boxEnd, 8, "avif") ||
      hasAsciiSignature(header, boxEnd, 8, "avis")
    ) {
      return true
    }

    var offset = 16
    while (offset + 4 <= boxEnd) {
      if (
        hasAsciiSignature(header, boxEnd, offset, "avif") ||
        hasAsciiSignature(header, boxEnd, offset, "avis")
      ) {
        return true
      }
      offset += 4
    }
    return false
  }

  private fun byteValue(value: Byte): Int = value.toInt() and 0xff

  private fun mimeTypeForPath(relativePath: String, fallback: String): String {
    if (fallback.isNotBlank()) return fallback
    return inferAndroidStorageMimeType(relativePath) { extension ->
      MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
    }
  }

  private fun storageDocumentSize(
    rootUri: String,
    relativePath: String,
    document: DocumentFile,
  ): Long =
    if (document.isDirectory) {
      document.listFiles().sumOf(::storageDocumentSize)
    } else {
      externalStorageFile(rootUri, relativePath)
        ?.takeIf { it.isFile }
        ?.length()
        ?.coerceAtLeast(0L)
        ?.takeIf { it > 0L }
        ?: document.length().coerceAtLeast(0L)
    }

  private fun storageDocumentSize(document: DocumentFile): Long =
    if (document.isDirectory) {
      document.listFiles().sumOf(::storageDocumentSize)
    } else {
      document.length().coerceAtLeast(0L)
    }

  private fun windowMetricsJson(webView: WebView): String {
    val metrics = resources.displayMetrics
    val density = if (metrics.density > 0f) metrics.density else 1f
    val widthPx = if (webView.width > 0) webView.width else metrics.widthPixels
    val heightPx = if (webView.height > 0) webView.height else metrics.heightPixels

    return JSONObject()
      .put("widthPx", widthPx)
      .put("heightPx", heightPx)
      .put("density", density.toDouble())
      .put("widthDp", widthPx / density)
      .put("heightDp", heightPx / density)
      .toString()
  }

  companion object {
    private const val APK_MIME_TYPE = "application/vnd.android.package-archive"
    private const val ANDROID_DIRECT_MEDIA_PATH = "file"
    private const val ANDROID_LOCAL_MEDIA_PATH = "__norea_android_media__"
    private const val ANDROID_ZIP_MEDIA_PATH = "zip"
    private const val IMMUTABLE_COVER_CACHE_CONTROL =
      "public, max-age=31536000, immutable"
    private const val BYTES_PER_MIB = 1024L * 1024L
    private const val CHAPTER_MEDIA_DIRECTORY = "media"
    private const val CONTENTS_ROOT_DIR = "contents"
    private const val DEFAULT_STORAGE_COPY_BUFFER_BYTES = 64 * 1024
    private const val IMAGE_SIGNATURE_MAX_BYTES = 256
    private const val STORAGE_ROOT_CONFIG_FILE = "chapter-media-storage-root.txt"
    private const val TAG = "NoreaStorage"
    private const val MAX_ANDROID_TEMP_BYTES = 2L * 1024L * BYTES_PER_MIB
    private const val MAX_CHAPTER_MEDIA_MANIFEST_BYTES = 8L * BYTES_PER_MIB
    private const val MAX_UPDATE_BYTES = 512L * BYTES_PER_MIB
    private const val MAX_ZIP_ENTRY_BYTES = 256L * BYTES_PER_MIB
    private const val MAX_ZIP_ENTRIES = 100_000
    private const val MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 2L * 1024L * BYTES_PER_MIB
    private const val NOREA_MEDIA_HOST = "reader-asset"
    private const val NOREA_MEDIA_SCHEME = "norea-media"
    private const val READER_MEDIA_CACHE_DIR = "reader-media"
    private const val READER_MEDIA_CACHE_SCOPE_SEGMENT = "~cache"
    private const val REQUEST_MEDIA_STORAGE_ROOT = 1001
    private const val REQUEST_POST_NOTIFICATIONS = 1002
    private const val STORAGE_TEMP_DIR = "android-storage-bridge"
    private const val UPDATE_DOWNLOAD_DIR = "Norea Updates"
    private val SHA256_HEX_PATTERN = Regex("^[a-f0-9]{64}$")

    private fun insetsJson(insets: Insets): String {
      return JSONObject()
        .put("top", insets.top)
        .put("right", insets.right)
        .put("bottom", insets.bottom)
        .put("left", insets.left)
        .toString()
    }
  }
}
