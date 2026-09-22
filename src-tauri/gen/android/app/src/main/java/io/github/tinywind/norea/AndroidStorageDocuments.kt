package io.github.tinywind.norea

import android.content.ContentResolver
import android.content.Context
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.util.Log
import android.webkit.MimeTypeMap
import androidx.documentfile.provider.DocumentFile
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream

private const val EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY = "com.android.externalstorage.documents"
private const val TAG = "NoreaStorage"

internal const val BYTES_PER_MIB = 1024L * 1024L
internal const val CONTENTS_ROOT_DIR = "contents"
internal const val DEFAULT_STORAGE_COPY_BUFFER_BYTES = 64 * 1024
internal const val MAX_ZIP_ENTRY_BYTES = 256L * BYTES_PER_MIB
internal const val MAX_ZIP_ENTRIES = 100_000
internal const val MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 2L * 1024L * BYTES_PER_MIB

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

internal fun androidStorageCreationMimeType(
  fileName: String,
  requestedMimeType: String,
  mimeTypeForExtension: (String) -> String?,
): String {
  if (requestedMimeType.substringBefore(';').trim().equals("application/octet-stream", ignoreCase = true)) {
    return "application/octet-stream"
  }
  // SAF may append a MIME-derived extension, but app storage paths must stay exact.
  return inferAndroidStorageMimeType(fileName, mimeTypeForExtension)
}

internal fun createRawAndroidStorageFile(parent: File, name: String): File? {
  val child = File(parent, name)
  return try {
    if (child.createNewFile()) child else null
  } catch (_: IOException) {
    null
  }
}

internal class AndroidStorageDocuments(private val context: Context) {
  data class StorageChildDocument(
    val name: String,
    val uri: Uri,
    val mimeType: String?,
  ) {
    val isDirectory: Boolean
      get() = mimeType == DocumentsContract.Document.MIME_TYPE_DIR
  }

  private val contentResolver: ContentResolver
    get() = context.contentResolver

  fun storageRoot(rootUri: String): DocumentFile {
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

    return DocumentFile.fromTreeUri(context, root)
      ?: throw IllegalArgumentException("Android storage folder is unavailable.")
  }

  fun ensureContentsNoMedia(rootUri: String): Boolean {
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
          context,
          arrayOf(marker.absolutePath),
          null,
          null,
        )
      }
    return true
  }

  fun safeStorageSegments(relativePath: String): List<String> {
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

  private fun isExternalStorageTreeDocument(uri: Uri): Boolean =
    uri.scheme == ContentResolver.SCHEME_CONTENT &&
      uri.authority == EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY

  private fun treeChildDocument(parent: DocumentFile, childDocumentId: String): DocumentFile? =
    DocumentFile.fromTreeUri(
      context,
      DocumentsContract.buildDocumentUriUsingTree(parent.uri, childDocumentId),
    )

  fun storageChildDocumentFile(child: StorageChildDocument): DocumentFile? =
    if (child.uri.scheme == ContentResolver.SCHEME_FILE) {
      child.uri.path?.let { DocumentFile.fromFile(File(it)) }
    } else {
      DocumentFile.fromTreeUri(context, child.uri)
    }

  /**
   * Lists a directory with one provider query. DocumentFile.listFiles() only
   * returns ids, so reading names through it costs one extra query per child,
   * which is what makes DocumentFile.findFile() scale with the folder size.
   */
  fun listStorageChildren(parent: DocumentFile): List<StorageChildDocument> {
    if (parent.uri.scheme == ContentResolver.SCHEME_FILE) {
      return parent.listFiles().mapNotNull { child ->
        val name = child.name ?: return@mapNotNull null
        StorageChildDocument(
          name,
          child.uri,
          if (child.isDirectory) DocumentsContract.Document.MIME_TYPE_DIR else child.type,
        )
      }
    }
    val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
      parent.uri,
      DocumentsContract.getDocumentId(parent.uri),
    )
    val projection = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
    )
    val children = mutableListOf<StorageChildDocument>()
    contentResolver.query(childrenUri, projection, null, null, null)?.use { cursor ->
      while (cursor.moveToNext()) {
        val documentId = cursor.getString(0) ?: continue
        val name = cursor.getString(1) ?: continue
        children.add(
          StorageChildDocument(
            name,
            DocumentsContract.buildDocumentUriUsingTree(parent.uri, documentId),
            cursor.getString(2),
          ),
        )
      }
    }
    return children
  }

  /**
   * Resolves one child without walking the parent. The platform external
   * storage provider uses path-shaped document ids, so its children resolve
   * with a single existence query; other providers fall back to one listing.
   */
  fun findStorageChild(parent: DocumentFile, name: String): DocumentFile? {
    if (parent.uri.scheme == ContentResolver.SCHEME_FILE) return parent.findFile(name)
    if (isExternalStorageTreeDocument(parent.uri)) {
      return treeChildDocument(parent, "${DocumentsContract.getDocumentId(parent.uri)}/$name")
        ?.takeIf { it.exists() }
    }
    val child = listStorageChildren(parent).firstOrNull { it.name == name } ?: return null
    return storageChildDocumentFile(child)
  }

  fun storageDocumentAt(rootUri: String, relativePath: String): DocumentFile? {
    val root = storageRoot(rootUri)
    val segments = safeStorageSegments(relativePath)
    if (isExternalStorageTreeDocument(root.uri)) {
      return treeChildDocument(
        root,
        "${DocumentsContract.getDocumentId(root.uri)}/${segments.joinToString("/")}",
      )?.takeIf { it.exists() }
    }
    var current = root
    for (segment in segments) {
      current = findStorageChild(current, segment) ?: return null
    }
    return current
  }

  fun openStorageInputStream(
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

  fun openStorageInputStream(rootUri: String, relativePath: String): InputStream? {
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

  fun storageReadFailureMessage(rootUri: String, relativePath: String): String {
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

  fun externalStorageFile(rootUri: String, relativePath: String): File? {
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

  fun ensureStorageDirectory(parent: DocumentFile, name: String): DocumentFile {
    val existing = findStorageChild(parent, name)
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

  fun createStorageFile(
    parent: DocumentFile,
    mimeType: String,
    name: String,
  ): DocumentFile? {
    if (parent.uri.scheme != ContentResolver.SCHEME_FILE) {
      val creationMimeType = androidStorageCreationMimeType(name, mimeType) { extension ->
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
      }
      return parent.createFile(creationMimeType, name)
    }
    val parentPath = parent.uri.path ?: return null
    val created = createRawAndroidStorageFile(File(parentPath), name) ?: return null
    return DocumentFile.fromFile(created)
  }

  fun ensureStorageFile(
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
    val existing = findStorageChild(current, fileName)
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
    val raced = findStorageChild(current, fileName)
    if (raced != null) {
      require(raced.isFile) { "Android storage path is not a file: $relativePath" }
      return raced
    }
    throw IllegalStateException("Cannot create Android storage file: $relativePath")
  }

  fun requireExactCreatedStorageName(
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

  fun safeZipEntryName(name: String?): String? {
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

  fun nextZipEntryCount(count: Int, context: String): Int {
    val next = count + 1
    require(next <= MAX_ZIP_ENTRIES) {
      "$context has more than $MAX_ZIP_ENTRIES entries."
    }
    return next
  }

  fun requireZipEntrySize(entry: ZipEntry, context: String) {
    val size = entry.size
    require(size < 0L || size <= MAX_ZIP_ENTRY_BYTES) {
      "$context exceeds the $MAX_ZIP_ENTRY_BYTES byte entry limit."
    }
  }

  fun requireStorageFileZipEntrySize(file: DocumentFile, context: String) {
    val size = file.length()
    require(size <= 0L || size <= MAX_ZIP_ENTRY_BYTES) {
      "$context exceeds the $MAX_ZIP_ENTRY_BYTES byte entry limit."
    }
  }

  fun addZipTotalBytes(total: Long, copied: Long, context: String): Long {
    val next = total + copied
    require(next >= total && next <= MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
      "$context exceeds the $MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES byte total limit."
    }
    return next
  }

  fun readZipEntryBytes(
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

  fun readBytesWithLimit(input: InputStream, maxBytes: Long): ByteArray {
    val output = ByteArrayOutputStream()
    copyToWithLimit(input, output, maxBytes)
    return output.toByteArray()
  }

  fun copyToWithLimit(
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

  fun mimeTypeForPath(relativePath: String, fallback: String): String {
    if (fallback.isNotBlank()) return fallback
    return inferAndroidStorageMimeType(relativePath) { extension ->
      MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
    }
  }

  fun storageDocumentSize(
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

  fun storageDocumentSize(document: DocumentFile): Long =
    if (document.isDirectory) {
      document.listFiles().sumOf(::storageDocumentSize)
    } else {
      document.length().coerceAtLeast(0L)
    }
}
