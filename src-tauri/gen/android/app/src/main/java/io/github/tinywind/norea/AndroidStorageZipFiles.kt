package io.github.tinywind.norea

import android.content.ContentResolver
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.util.zip.ZipInputStream

internal class AndroidStorageZipFiles(
  private val contentResolver: ContentResolver,
  private val storage: AndroidStorageDocuments,
) {
  fun readZipEntryBase64(
    rootUri: String,
    archiveRelativePath: String,
    entryName: String,
  ): JSONObject = run {
    val safeEntryName = storage.safeZipEntryName(entryName)
      ?: throw IllegalArgumentException("Android storage zip entry is invalid: $entryName")
    val bytes = storage.readZipEntryBytes(rootUri, archiveRelativePath, safeEntryName)
      ?: throw IllegalArgumentException("Android storage zip entry not found: $entryName")
    JSONObject()
      .put("ok", true)
      .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
      .put("mimeType", storage.mimeTypeForPath(safeEntryName, ""))
  }

  fun readZipEntriesBase64(
    rootUri: String,
    archiveRelativePath: String,
    entryNamesJson: String,
  ): JSONObject = run {
    val requested = JSONArray(entryNamesJson)
    val requestedNames = linkedSetOf<String>()
    for (index in 0 until requested.length()) {
      val entryName = storage.safeZipEntryName(requested.optString(index))
      if (entryName != null) requestedNames.add(entryName)
    }
    val entries = JSONObject()
    if (requestedNames.isEmpty()) {
      return@run JSONObject()
        .put("ok", true)
        .put("entries", entries)
    }
    storage.openStorageInputStream(rootUri, archiveRelativePath)?.use { input ->
      ZipInputStream(input.buffered()).use { zip ->
        val remaining = requestedNames.toMutableSet()
        var entry = zip.nextEntry
        var entryCount = 0
        var totalBytes = 0L
        while (entry != null && remaining.isNotEmpty()) {
          entryCount = storage.nextZipEntryCount(entryCount, "Media archive")
          val currentName = storage.safeZipEntryName(entry.name)
          if (
            !entry.isDirectory &&
            currentName != null &&
            remaining.contains(currentName)
          ) {
            storage.requireZipEntrySize(entry, "Media archive entry")
            val bytes = storage.readBytesWithLimit(zip, MAX_ZIP_ENTRY_BYTES)
            totalBytes = storage.addZipTotalBytes(
              totalBytes,
              bytes.size.toLong(),
              "Media archive read",
            )
            entries.put(
              currentName,
              JSONObject()
                .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                .put("mimeType", storage.mimeTypeForPath(currentName, "")),
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

  fun extractZip(
    rootUri: String,
    archiveRelativePath: String,
    targetRelativePath: String,
  ): JSONObject = run {
    var bytes = 0L
    storage.openStorageInputStream(rootUri, archiveRelativePath)?.use { input ->
      ZipInputStream(input.buffered()).use { zip ->
        var entry = zip.nextEntry
        var entryCount = 0
        while (entry != null) {
          entryCount = storage.nextZipEntryCount(entryCount, "Media archive extraction")
          val entryName = storage.safeZipEntryName(entry.name)
          if (!entry.isDirectory && entryName != null) {
            storage.requireZipEntrySize(entry, "Media archive extraction entry")
            val targetPath = "$targetRelativePath/$entryName"
            if (storage.storageDocumentAt(rootUri, targetPath) == null) {
              val file = storage.ensureStorageFile(
                rootUri,
                targetPath,
                storage.mimeTypeForPath(entryName, "application/octet-stream"),
              )
              contentResolver.openOutputStream(file.uri, "wt")?.use { output ->
                val copied = storage.copyToWithLimit(zip, output, MAX_ZIP_ENTRY_BYTES)
                bytes = storage.addZipTotalBytes(
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

}
