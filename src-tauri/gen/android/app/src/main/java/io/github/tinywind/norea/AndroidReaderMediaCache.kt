package io.github.tinywind.norea

import android.content.Context
import android.util.Log
import org.json.JSONObject
import androidx.documentfile.provider.DocumentFile
import java.io.File
import java.util.zip.ZipInputStream

private const val READER_MEDIA_CACHE_DIR = "reader-media"
private const val TAG = "NoreaStorage"

internal data class ReaderMediaCacheStats(
  val entryCount: Int = 0,
  val totalBytes: Long = 0L,
)

internal class AndroidReaderMediaCache(
  private val context: Context,
  private val storage: AndroidStorageDocuments,
) {
  private fun readerMediaCacheRoot(): File {
    val root = File(context.cacheDir, READER_MEDIA_CACHE_DIR).canonicalFile
    if (!root.exists() && !root.mkdirs()) {
      throw IllegalStateException("Cannot create reader media cache folder.")
    }
    require(root.isDirectory) { "Reader media cache path is not a folder." }
    return root
  }

  fun readerMediaCacheTokenRoot(cacheToken: String): File {
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

  fun safeReaderMediaCacheToken(value: String): String? =
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
    val safeName = storage.safeZipEntryName(fileName)
      ?: throw IllegalArgumentException("Reader media file name is invalid.")
    val file = File(root, safeName).canonicalFile
    require(file.path.startsWith(root.path + File.separator)) {
      "Reader media file is outside the cache folder."
    }
    return file
  }

  fun readerMediaCacheFileForRequest(fileName: String): File {
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

  fun copyReaderMediaDirectoryToCache(
    rootUri: String,
    mediaRelativePath: String,
    cacheRoot: File,
  ): ReaderMediaCacheStats {
    val sourceDir = storage.storageDocumentAt(rootUri, mediaRelativePath)
      ?.takeIf { it.isDirectory }
      ?: return ReaderMediaCacheStats()
    var entryCount = 0
    var totalBytes = 0L

    fun copyChildren(directory: DocumentFile, prefix: String) {
      directory.listFiles()
        .sortedBy { it.name ?: "" }
        .forEach { child ->
          val childName = child.name ?: return@forEach
          val entryName = storage.safeZipEntryName(
            if (prefix.isBlank()) childName else "$prefix/$childName",
          ) ?: return@forEach
          if (child.isDirectory) {
            copyChildren(child, entryName)
            return@forEach
          }
          if (!child.isFile || entryName.endsWith(".part")) return@forEach
          storage.requireStorageFileZipEntrySize(child, "Reader media file")
          entryCount = storage.nextZipEntryCount(entryCount, "Reader media directory")
          val target = containedReaderMediaCacheFile(entryName, cacheRoot)
          target.parentFile?.mkdirs()
          target.outputStream().use { output ->
            val copied = storage.openStorageInputStream(
              rootUri,
              "$mediaRelativePath/$entryName",
              child,
            )?.use { input ->
              storage.copyToWithLimit(input, output, MAX_ZIP_ENTRY_BYTES)
            } ?: throw IllegalStateException("Cannot open reader media file.")
            totalBytes = storage.addZipTotalBytes(
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

  fun copyReaderMediaArchiveToCache(
    rootUri: String,
    archiveRelativePath: String,
    cacheRoot: File,
  ): ReaderMediaCacheStats {
    var entryCount = 0
    var totalBytes = 0L
    storage.openStorageInputStream(rootUri, archiveRelativePath)?.use { input ->
      ZipInputStream(input.buffered()).use { zip ->
        var entry = zip.nextEntry
        while (entry != null) {
          entryCount = storage.nextZipEntryCount(entryCount, "Reader media archive")
          val entryName = storage.safeZipEntryName(entry.name)
          if (!entry.isDirectory && entryName != null) {
            storage.requireZipEntrySize(entry, "Reader media archive entry")
            val target = containedReaderMediaCacheFile(entryName, cacheRoot)
            target.parentFile?.mkdirs()
            target.outputStream().use { output ->
              val copied = storage.copyToWithLimit(zip, output, MAX_ZIP_ENTRY_BYTES)
              totalBytes = storage.addZipTotalBytes(
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

  fun prepareReaderMediaCache(
    rootUri: String,
    mediaRelativePath: String,
    archiveRelativePath: String,
    cacheToken: String,
  ): JSONObject =
    run {
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

}
