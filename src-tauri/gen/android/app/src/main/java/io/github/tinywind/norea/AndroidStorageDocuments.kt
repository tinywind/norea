package io.github.tinywind.norea

import android.content.ContentResolver
import android.content.Context
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.system.Os
import android.system.OsConstants
import android.system.ErrnoException
import io.github.tinywind.norea.AppLog as Log
import android.webkit.MimeTypeMap
import androidx.documentfile.provider.DocumentFile
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipFile

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

private val storageAccessDeniedErrno = Regex("\\b(?:EACCES|EPERM) \\(")

internal fun isAndroidStorageAccessDenied(error: Throwable): Boolean =
  generateSequence(error) { it.cause }.take(8).any { cause ->
    cause is SecurityException ||
      cause.message?.let(storageAccessDeniedErrno::containsMatchIn) == true
  }

// SAF wraps an absent external-storage tree child in an IllegalArgumentException.
internal fun isAndroidMissingStorageDocument(error: Throwable, documentId: String): Boolean =
  generateSequence(error) { it.cause }.take(8).any { cause ->
    val message = cause.message.orEmpty()
    val missing = "Missing file for $documentId"
    (cause is java.io.FileNotFoundException && (message == missing || message.startsWith("$missing at "))) ||
      (cause is IllegalArgumentException && message.startsWith("Failed to determine if ") &&
        message.contains("java.io.FileNotFoundException: $missing at "))
  }

/**
 * Remembers storage roots whose direct file reads the platform denies, such as
 * files left by an earlier install's UID, so later reads use the document
 * provider without retrying direct I/O. Missing files never mark a root.
 */
internal class AndroidStorageDirectReadPolicy(
  private val onFirstDenial: (rootUri: String, error: Throwable) -> Unit,
) {
  private val deniedRoots = ConcurrentHashMap.newKeySet<String>()

  fun allows(rootUri: String): Boolean = rootUri !in deniedRoots

  /** Returns whether [error] denied direct access; only the first denial per root is reported. */
  fun recordFailure(rootUri: String, error: Throwable): Boolean {
    if (!isAndroidStorageAccessDenied(error)) return false
    if (deniedRoots.add(rootUri)) onFirstDenial(rootUri, error)
    return true
  }
}

internal const val ANDROID_ALL_FILES_ACCESS_REQUIRED = "All files access is required to use the storage folder."

internal class AndroidStorageDocuments(private val context: Context) {
  data class StorageChildDocument(
    val name: String,
    val uri: Uri,
    val mimeType: String?,
    val byteSize: Long?,
  ) {
    val isDirectory: Boolean
      get() = mimeType == DocumentsContract.Document.MIME_TYPE_DIR
  }

  private val contentResolver: ContentResolver
    get() = context.contentResolver

  private val directReads = AndroidStorageDirectReadPolicy { rootUri, error ->
    Log.w(TAG, "Android storage denies direct file reads; using the document provider until restart. root=$rootUri error=$error")
  }

  /**
   * The storage folder as plain files. On Android 11 and later Norea uses it only with All files
   * access: going through the document provider costs one provider query per lookup, which made
   * merges, their recovery and deletions take minutes. Older devices keep the document tree.
   */
  fun storageRoot(rootUri: String): DocumentFile {
    val root = Uri.parse(rootUri)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      check(Environment.isExternalStorageManager()) { ANDROID_ALL_FILES_ACCESS_REQUIRED }
      require(root.authority == EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY) { "Android storage folder must be on device storage." }
      val directory = externalStorageFile(rootUri, "")
        ?.takeIf { it.isDirectory && it.canRead() && it.canWrite() }
        ?: throw IllegalArgumentException("Android storage folder is unavailable.")
      return DocumentFile.fromFile(directory)
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
          child.length(),
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
      DocumentsContract.Document.COLUMN_SIZE,
    )
    val children = mutableListOf<StorageChildDocument>()
    val cursor = contentResolver.query(childrenUri, projection, null, null, null)
      ?: throw IOException("Cannot list Android storage directory: ${parent.uri}")
    cursor.use {
      while (cursor.moveToNext()) {
        val documentId = cursor.getString(0) ?: continue
        val name = cursor.getString(1) ?: continue
        children.add(
          StorageChildDocument(
            name,
            DocumentsContract.buildDocumentUriUsingTree(parent.uri, documentId),
            cursor.getString(2),
            if (cursor.isNull(3)) null else cursor.getLong(3),
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
  fun findStorageChildWithoutRecovery(parent: DocumentFile, name: String): DocumentFile? {
    require(parent.isDirectory && parent.canRead()) { "Android storage directory is not readable." }
    if (parent.uri.scheme == ContentResolver.SCHEME_FILE) {
      val child = File(parent.uri.path!!, name)
      try { Os.lstat(child.path) }
      catch (error: ErrnoException) {
        if (error.errno == OsConstants.ENOENT) return null
        throw IOException("Cannot inspect Android storage child: $name", error)
      }
      return DocumentFile.fromFile(child)
    }
    if (isExternalStorageTreeDocument(parent.uri)) {
      val child = treeChildDocument(parent, "${DocumentsContract.getDocumentId(parent.uri)}/$name") ?: return null
      val exists = try {
        contentResolver.query(child.uri, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID), null, null, null)?.use { it.moveToFirst() }
      } catch (error: Exception) {
        if (isAndroidMissingStorageDocument(error, DocumentsContract.getDocumentId(child.uri))) false else throw error
      }
      if (exists == true) return child
      require(parent.canRead()) { "Android storage directory became unavailable during lookup." }
      return null
    }
    val matches = listStorageChildren(parent).filter { it.name == name }
    require(matches.size <= 1) { "Ambiguous Android storage entry: $name" }
    val child = matches.firstOrNull() ?: return null
    return storageChildDocumentFile(child)
  }

  @Synchronized
  fun findStorageChild(parent: DocumentFile, name: String): DocumentFile? {
    findStorageChildWithoutRecovery(parent, name)?.let { return it }
    if (name.startsWith('.')) return null
    val backup = findStorageChildWithoutRecovery(parent, ".$name.norea-sync-backup") ?: return null
    require(backup.isDirectory) { "Invalid chapter recovery directory." }
    check(backup.renameTo(name)) { "Cannot recover interrupted chapter installation." }
    return backup
  }

  fun storageDocumentAt(rootUri: String, relativePath: String): DocumentFile? {
    val root = storageRoot(rootUri)
    val segments = safeStorageSegments(relativePath)
    if (isExternalStorageTreeDocument(root.uri)) {
      treeChildDocument(
        root,
        "${DocumentsContract.getDocumentId(root.uri)}/${segments.joinToString("/")}",
      )?.takeIf { it.exists() }?.let { return it }
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
        ?.takeIf { directReads.allows(rootUri) && it.isFile }
        ?.inputStream()
    }.getOrElse { error ->
      directReads.recordFailure(rootUri, error)
      null
    }
      ?: runCatching { contentResolver.openInputStream(document.uri) }.getOrNull()

  fun openStorageInputStream(rootUri: String, relativePath: String): InputStream? {
    val directFile = runCatching {
      externalStorageFile(rootUri, relativePath)
    }.getOrElse { error ->
      Log.w(TAG, singleLineLogMessage("Android storage direct path failed. path=$relativePath root=$rootUri ${error.stackTraceToString()}"))
      null
    }
    val direct = directFile?.takeIf { directReads.allows(rootUri) && it.isFile }?.let { file ->
      runCatching { file.inputStream() }.getOrElse { error ->
        if (!directReads.recordFailure(rootUri, error)) {
          Log.w(
            TAG,
            singleLineLogMessage("Android storage direct read failed. path=$relativePath file=${file.absolutePath} ${error.stackTraceToString()}"),
          )
        }
        null
      }
    }
    if (direct != null) return direct

    val documentUri = runCatching {
      storageDocumentUri(rootUri, relativePath)
    }.getOrElse { error ->
      Log.w(
        TAG,
        singleLineLogMessage("Android storage document uri failed. path=$relativePath root=$rootUri ${error.stackTraceToString()}"),
      )
      null
    }
    var documentReadFailure: Throwable? = null
    val documentStream = documentUri?.let { uri ->
      runCatching { contentResolver.openInputStream(uri) }.getOrElse { error ->
        documentReadFailure = error
        null
      }
    }
    if (documentStream != null) return documentStream

    // Missing files fail the document read too; callers treat them as not found, so only existing files are reported.
    val document = storageDocumentAt(rootUri, relativePath) ?: return null
    if (!document.isFile) return null
    documentReadFailure?.let { error ->
      Log.w(
        TAG,
        singleLineLogMessage("Android storage document read failed. path=$relativePath uri=$documentUri ${error.stackTraceToString()}"),
      )
    }
    return runCatching { contentResolver.openInputStream(document.uri) }.getOrElse { error ->
      Log.w(
        TAG,
        singleLineLogMessage("Android storage fallback document read failed. path=$relativePath uri=${document.uri} ${error.stackTraceToString()}"),
      )
      null
    }
  }

  fun <T> inspectChapterMediaZip(
    rootUri: String,
    relativePath: String,
    document: DocumentFile,
    inspect: (ZipFile, File) -> T,
  ): T {
    val direct = externalStorageFile(rootUri, relativePath)?.takeIf { directReads.allows(rootUri) && it.isFile }
    val directArchive = direct?.let { file ->
      try {
        ZipFile(file)
      } catch (error: Exception) {
        if (error !is IOException && error !is SecurityException) throw error
        if (!directReads.recordFailure(rootUri, error)) {
          Log.w(TAG, "Android chapter media direct read failed. path=$relativePath file=${file.absolutePath}", error)
        }
        null
      }
    }
    if (direct != null && directArchive != null) return directArchive.use { inspect(it, direct) }
    val temporary = File.createTempFile("chapter-media-", ".zip", context.cacheDir)
    try {
      val input = openStorageInputStream(rootUri, relativePath, document)
        ?: throw IOException("Cannot open Android chapter media archive.")
      input.use { source ->
        temporary.outputStream().use { target ->
          val buffer = ByteArray(DEFAULT_STORAGE_COPY_BUFFER_BYTES)
          var copied = 0L
          while (true) {
            val count = source.read(buffer)
            if (count < 0) break
            copied += count
            require(copied <= 512L * BYTES_PER_MIB) {
              "Chapter media archive exceeds the byte limit."
            }
            target.write(buffer, 0, count)
          }
        }
      }
      return ZipFile(temporary).use { inspect(it, temporary) }
    } finally {
      temporary.delete()
    }
  }

  /** App-private, not purged like the cache, so an interrupted work folder reset can still be restored. */
  fun workResetBackupRoot(): File = File(context.noBackupFilesDir, "work-reset-backups")

  /** App-private records of the chapters an unfinished chapter storage transfer touched. */
  fun transferProgressRoot(): File = File(context.noBackupFilesDir, "transfer-progress")

  fun createChapterMediaRepairTempFile(): File =
    File.createTempFile("chapter-media-repair-", ".tmp", context.cacheDir)

  fun storageReadFailureMessage(rootUri: String, relativePath: String): String {
    val document = runCatching { storageDocumentAt(rootUri, relativePath) }.getOrNull()
    val message = when {
      document == null -> "Android storage file not found: $relativePath"
      !document.isFile -> "Android storage path is not a file: $relativePath"
      else -> "Cannot open storage file for reading: $relativePath"
    }
    // Readers map "not found" to a null result, so a missing file is an ordinary answer.
    if (document == null) {
      Log.d(TAG, singleLineLogMessage("$message root=$rootUri"))
    } else {
      Log.w(TAG, singleLineLogMessage("$message root=$rootUri"))
    }
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
