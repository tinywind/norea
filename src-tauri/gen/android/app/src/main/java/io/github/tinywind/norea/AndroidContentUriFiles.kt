package io.github.tinywind.norea

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.webkit.MimeTypeMap
import org.json.JSONObject
import java.io.File

private const val TAG = "NoreaStorage"
private const val MAX_ANDROID_TEMP_BYTES = 2L * 1024L * BYTES_PER_MIB
private const val STORAGE_TEMP_DIR = "android-storage-bridge"

internal class AndroidContentUriFiles(
  private val context: Context,
  private val storage: AndroidStorageDocuments,
) {
  private val contentResolver = context.contentResolver

  private data class ContentUriMetadata(
    val fileName: String?,
    val size: Long?,
  )

  fun writeContentUriBytes(uri: String, base64: String, mimeType: String): JSONObject =
    run {
      val bytes = Base64.decode(base64, Base64.DEFAULT)
      contentResolver.openOutputStream(Uri.parse(uri), "wt")?.use { output ->
        output.write(bytes)
      } ?: throw IllegalStateException("Cannot open selected file for writing.")
      JSONObject()
        .put("ok", true)
        .put("bytes", bytes.size)
        .put("mimeType", mimeType)
    }

  fun writeContentUriFile(uri: String, inputPath: String, mimeType: String): JSONObject =
    run {
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

  fun writeContentUriFileCapped(
    uri: String,
    inputPath: String,
    mimeType: String,
    maxBytes: String,
  ): JSONObject = run {
    val limit = parseStorageByteLimit(maxBytes)
    val inputFile = containedAppCacheFile(inputPath)
    require(inputFile.isFile) { "Selected backup temp file is unavailable." }
    val fileLength = inputFile.length().coerceAtLeast(0L)
    require(fileLength <= limit) {
      "Selected backup temp file exceeds the $limit byte limit."
    }
    val bytes = inputFile.inputStream().use { input ->
      contentResolver.openOutputStream(Uri.parse(uri), "wt")?.use { output ->
        storage.copyToWithLimit(input, output, limit)
      } ?: throw IllegalStateException("Cannot open selected file for writing.")
    }
    JSONObject()
      .put("ok", true)
      .put("bytes", bytes)
      .put("mimeType", mimeType)
  }

  fun describeContentUri(uri: String): JSONObject = run {
    val contentUri = Uri.parse(uri)
    val metadata = contentUriMetadata(contentUri)
    val mimeType = contentUriMimeType(contentUri)
    JSONObject()
      .put("ok", true)
      .put("fileName", contentUriFileName(contentUri, mimeType, metadata.fileName))
      .put("mimeType", mimeType)
      .put("size", metadata.size ?: JSONObject.NULL)
  }

  fun readContentUriFile(uri: String, maxBytes: String): JSONObject = run {
    val limit = parseStorageByteLimit(maxBytes)
    val contentUri = Uri.parse(uri)
    val metadata = contentUriMetadata(contentUri)
    val mimeType = contentUriMimeType(contentUri)
    val tempFile = createStorageTempFile()
    var bytes = 0L
    try {
      contentResolver.openInputStream(contentUri)?.use { input ->
        tempFile.outputStream().use { output ->
          bytes = storage.copyToWithLimit(input, output, limit)
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

  fun deleteTempFile(path: String): JSONObject = run {
    val tempFile = containedStorageTempFile(path)
    val existed = tempFile.exists()
    if (existed && !tempFile.delete()) {
      throw IllegalStateException("Cannot remove Android storage temp file.")
    }
    JSONObject()
      .put("ok", true)
      .put("deleted", existed)
  }

  fun readContentUriBase64(uri: String): JSONObject = run {
    val bytes = contentResolver.openInputStream(Uri.parse(uri))?.use { input ->
      input.readBytes()
    } ?: throw IllegalStateException("Cannot open selected file for reading.")
    JSONObject()
      .put("ok", true)
      .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
      .put("mimeType", storage.mimeTypeForPath(uri, "application/octet-stream"))
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
      ?: storage.mimeTypeForPath(uri.toString(), "")
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
    val root = File(context.cacheDir, STORAGE_TEMP_DIR)
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

  private fun containedAppCacheFile(path: String): File {
    val root = context.cacheDir.canonicalFile
    val file = File(path).canonicalFile
    require(file.path == root.path || file.path.startsWith(root.path + File.separator)) {
      "Selected backup temp file is outside the app cache folder."
    }
    return file
  }

}
