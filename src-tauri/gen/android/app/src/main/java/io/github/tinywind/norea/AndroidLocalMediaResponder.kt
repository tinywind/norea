package io.github.tinywind.norea

import android.content.Context
import android.net.Uri
import android.util.Base64
import android.util.Log
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream

private const val ANDROID_DIRECT_MEDIA_PATH = "file"
private const val ANDROID_LOCAL_MEDIA_PATH = "__norea_android_media__"
private const val ANDROID_ZIP_MEDIA_PATH = "zip"
private const val IMAGE_SIGNATURE_MAX_BYTES = 256
private const val IMMUTABLE_COVER_CACHE_CONTROL =
  "public, max-age=31536000, immutable"
private const val NOREA_MEDIA_HOST = "reader-asset"
private const val NOREA_MEDIA_SCHEME = "norea-media"
private const val READER_MEDIA_CACHE_SCOPE_SEGMENT = "~cache"
private const val STORAGE_ROOT_CONFIG_FILE = "chapter-media-storage-root.txt"
private const val TAG = "NoreaStorage"

internal class AndroidLocalMediaResponder(
  private val context: Context,
  private val storage: AndroidStorageDocuments,
  private val readerMediaCache: AndroidReaderMediaCache,
) {
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
    val safeName = storage.safeZipEntryName(fileName)
      ?: return androidLocalMediaErrorResponse(
        400,
        "Android reader media file is invalid.",
      )
    val file = readerMediaCache.readerMediaCacheFileForRequest(safeName)
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
      imageMimeType ?: storage.mimeTypeForPath(safeName, ""),
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
      val input = storage.openStorageInputStream(rootUri, relativePath)
        ?: return androidLocalMediaErrorResponse(
          404,
          "Android media file cannot be opened.",
      )
    return androidLocalMediaResponse(
      storage.mimeTypeForPath(relativePath, ""),
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
    val safeEntryName = storage.safeZipEntryName(entryName)
      ?: return androidLocalMediaErrorResponse(
        400,
        "Android media archive entry is invalid.",
      )
    val bytes = storage.readZipEntryBytes(rootUri, archivePath, safeEntryName)
      ?: return androidLocalMediaErrorResponse(
        404,
        "Android media archive entry was not found.",
      )
    return androidLocalMediaResponse(
      storage.mimeTypeForPath(safeEntryName, ""),
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

  private fun configuredStorageRootUri(): String? {
    val roots = listOfNotNull(
      File(context.applicationInfo.dataDir, STORAGE_ROOT_CONFIG_FILE),
      context.filesDir.parentFile?.let { File(it, STORAGE_ROOT_CONFIG_FILE) },
    ).distinctBy { it.absolutePath }
    for (root in roots) {
      val value = runCatching { root.readText().trim() }.getOrNull()
      if (!value.isNullOrBlank() && value.startsWith("content://")) {
        return value
      }
    }
    return null
  }

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
}
