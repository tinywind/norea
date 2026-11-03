package io.github.tinywind.norea

import android.content.Context
import android.content.ContentUris
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.system.Os
import android.system.OsConstants
import androidx.documentfile.provider.DocumentFile
import java.io.File
import java.io.FileOutputStream
import java.io.FileInputStream

internal class AndroidLogDestinations(private val context: Context) {
  val stateDirectory: File get() = File(context.applicationInfo.dataDir, "files/norea-log-state")

  fun readSelectedRoot(): String? {
    val configs = listOfNotNull(File(context.applicationInfo.dataDir, "chapter-media-storage-root.txt"),
      context.filesDir.parentFile?.let { File(it, "chapter-media-storage-root.txt") }).distinctBy { it.path }
    return configs.firstNotNullOfOrNull { file ->
      runCatching { if (file.length() in 1..16_384) file.readText().trim().takeIf { it.isNotEmpty() } else null }.getOrNull()
    }
  }

  fun candidates(): List<AppLogDestination> {
    val destinations = mutableListOf<AppLogDestination>()
    val selected = readSelectedRoot()
    selected?.let { destinations += selectedDestination(it) }
    if (Build.VERSION.SDK_INT >= 29) destinations += AndroidDownloadsLogDestination(context)
    else destinations += AndroidDirectoryLogDestination(
      File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Norea"), "logs", context.packageName)
    destinations += AndroidDirectoryLogDestination(context.cacheDir, "norea-logs", context.packageName)
    val pending = AndroidDirectoryLogDestination(context.cacheDir, "norea-crash-pending", context.packageName)
    destinations += object : AppLogDestination by pending { override val acceptsWrites = false }
    val previous = runCatching { AppLogRootHistory(stateDirectory).remember(selected) }.getOrElse {
      System.err.println("Norea log history unavailable: ${singleLineLogMessage(it.toString())}")
      emptyList()
    }
    previous.filter { it != selected }.forEach { root ->
      val destination = selectedDestination(root)
      destinations += object : AppLogDestination by destination { override val acceptsWrites = false }
    }
    return destinations
  }

  private fun selectedDestination(selected: String): AppLogDestination =
    if (selected.startsWith("content://")) AndroidSafLogDestination(context, Uri.parse(selected))
    else AndroidDirectoryLogDestination(
      if (selected.startsWith("file://")) File(Uri.parse(selected).path!!) else File(selected), "logs", context.packageName)
}

internal class AndroidDirectoryLogDestination(
  private val root: File,
  private val child: String,
  private val namespace: String,
) : AppLogDestination {
  override val key: String get() = File(root, child).path

  private fun <T> directory(create: Boolean, operation: (File, File) -> T): T {
    val parent = root.canonicalFile
    if (create) check(parent.isDirectory || parent.mkdirs()) { "Log root is unavailable" }
    val logs = File(parent, child)
    if (create && !logs.exists()) check(logs.mkdir()) { "Cannot create log directory" }
    val fd = Os.open(logs.path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW, 0)
    if (!OsConstants.S_ISDIR(Os.fstat(fd).st_mode)) {
      Os.close(fd)
      throw IllegalStateException("Log path is not a directory")
    }
    val owned = try { ParcelFileDescriptor.dup(fd) } finally { Os.close(fd) }
    return owned.use { operation(File("/proc/self/fd/${it.fd}"), logs) }
  }

  override fun files(category: AppLogCategory): List<AppLogFile> = directory(false) { opened, logs ->
    opened.list().orEmpty().mapNotNull { name ->
      val sequence = AppLogNames.sequence(namespace, category, name) ?: return@mapNotNull null
      val stat = runCatching { Os.lstat(File(opened, name).path) }.getOrNull() ?: return@mapNotNull null
      if (!OsConstants.S_ISREG(stat.st_mode)) null else AppLogFile(File(logs, name).path, name, sequence, stat.st_size)
    }
  }

  override fun create(category: AppLogCategory, sequence: Long): AppLogFile = directory(true) { opened, logs ->
    val name = AppLogNames.create(namespace, category, sequence)
    val fd = Os.open(File(opened, name).path,
      OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_WRONLY or OsConstants.O_NOFOLLOW, 0x180)
    Os.close(fd)
    AppLogFile(File(logs, name).path, name, sequence, 0)
  }

  override fun append(file: AppLogFile, bytes: ByteArray, flush: Boolean) = directory(false) { opened, _ ->
    require(File(file.name).name == file.name && file.name.startsWith("norea-$namespace-"))
    val fd = Os.open(File(opened, file.name).path,
      OsConstants.O_APPEND or OsConstants.O_WRONLY or OsConstants.O_NOFOLLOW, 0)
    FileOutputStream(fd).use { output ->
      val stat = Os.fstat(fd)
      check(OsConstants.S_ISREG(stat.st_mode) && stat.st_size + bytes.size <= APP_LOG_FILE_BYTES)
      output.write(bytes)
      if (flush) output.fd.sync()
    }
  }

  override fun delete(file: AppLogFile): Boolean = directory(false) { opened, _ ->
    require(File(file.name).name == file.name && file.name.startsWith("norea-$namespace-"))
    val path = File(opened, file.name).path
    if (!OsConstants.S_ISREG(Os.lstat(path).st_mode)) false else { Os.remove(path); true }
  }

  fun read(file: AppLogFile): ByteArray = directory(false) { opened, _ ->
    require(File(file.name).name == file.name && AppLogNames.sequence(namespace, AppLogCategory.CRASH, file.name) != null)
    val fd = Os.open(File(opened, file.name).path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW, 0)
    FileInputStream(fd).use { input ->
      val stat = Os.fstat(fd)
      check(OsConstants.S_ISREG(stat.st_mode) && stat.st_size <= APP_LOG_FILE_BYTES)
      val bytes = ByteArray(APP_LOG_FILE_BYTES + 1)
      var count = 0
      while (count < bytes.size) {
        val read = input.read(bytes, count, bytes.size - count)
        if (read < 0) break
        count += read
      }
      check(count <= APP_LOG_FILE_BYTES)
      bytes.copyOf(count)
    }
  }
}

private fun appendLogDocument(context: Context, uri: Uri, bytes: ByteArray, flush: Boolean) {
  val descriptor = context.contentResolver.openFileDescriptor(uri, "wa")
    ?: throw IllegalStateException("Log document cannot be opened")
  ParcelFileDescriptor.AutoCloseOutputStream(descriptor).use { output ->
    val fd = descriptor.fileDescriptor
    val size = Os.lseek(fd, 0, OsConstants.SEEK_END)
    check(size >= 0 && size + bytes.size <= APP_LOG_FILE_BYTES) { "Log document exceeds the file limit" }
    output.write(bytes)
    output.flush()
    if (flush) Os.fsync(fd)
  }
}

internal class AndroidSafLogDestination(private val context: Context, private val tree: Uri) : AppLogDestination {
  override val key: String get() = tree.toString()
  private fun directory(create: Boolean): DocumentFile {
    check(context.contentResolver.persistedUriPermissions.any { it.uri == tree && it.isReadPermission && it.isWritePermission }) {
      "Selected log folder has no persisted read/write grant"
    }
    val root = DocumentFile.fromTreeUri(context, tree) ?: error("Selected log tree is unavailable")
    val matches = root.listFiles().filter { it.name == "logs" }
    check(matches.size <= 1) { "Selected logs directory is ambiguous" }
    val logs = matches.singleOrNull() ?: if (create) root.createDirectory("logs") else null
    check(logs != null && logs.name == "logs" && logs.isDirectory) { "Selected logs directory is unavailable" }
    return logs
  }
  override fun files(category: AppLogCategory): List<AppLogFile> = directory(false).listFiles().mapNotNull { file ->
    val name = file.name ?: return@mapNotNull null
    val sequence = AppLogNames.sequence(context.packageName, category, name) ?: return@mapNotNull null
    if (!file.isFile || file.isVirtual) null else AppLogFile(file.uri.toString(), name, sequence, file.length())
  }
  override fun create(category: AppLogCategory, sequence: Long): AppLogFile {
    val name = AppLogNames.create(context.packageName, category, sequence) + ".txt"
    val document = directory(true).createFile("text/plain", name) ?: error("Cannot create selected log document")
    if (document.name != name || !document.isFile || document.isVirtual) {
      document.delete()
      error("Provider did not preserve the log filename")
    }
    return AppLogFile(document.uri.toString(), name, sequence, 0)
  }
  private fun owned(file: AppLogFile): DocumentFile {
    return directory(false).listFiles().singleOrNull { it.uri.toString() == file.id && it.name == file.name && it.isFile && !it.isVirtual }
      ?: error("Selected log document is no longer owned")
  }
  override fun append(file: AppLogFile, bytes: ByteArray, flush: Boolean) = appendLogDocument(context, owned(file).uri, bytes, flush)
  override fun delete(file: AppLogFile): Boolean = owned(file).delete()
}

internal class AndroidDownloadsLogDestination(private val context: Context) : AppLogDestination {
  override val key: String = "public-downloads"
  private val collection get() = MediaStore.Downloads.EXTERNAL_CONTENT_URI
  private val relativePath = "${Environment.DIRECTORY_DOWNLOADS}/Norea/logs/"
  private fun rows(uri: Uri = collection): List<AppLogFile> {
    val resolver = context.contentResolver
    return resolver.query(uri, arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE),
      "${MediaStore.MediaColumns.RELATIVE_PATH}=? AND ${MediaStore.MediaColumns.OWNER_PACKAGE_NAME}=?",
      arrayOf(relativePath, context.packageName), null)?.use { cursor ->
      buildList {
        while (cursor.moveToNext()) {
          val name = cursor.getString(1)
          val category = AppLogCategory.entries.firstOrNull { AppLogNames.sequence(context.packageName, it, name) != null } ?: continue
          val sequence = AppLogNames.sequence(context.packageName, category, name) ?: continue
          add(AppLogFile(ContentUris.withAppendedId(collection, cursor.getLong(0)).toString(), name, sequence, cursor.getLong(2)))
        }
      }
    } ?: error("Downloads inventory is unavailable")
  }
  override fun files(category: AppLogCategory): List<AppLogFile> = rows().filter { AppLogNames.sequence(context.packageName, category, it.name) != null }
  override fun create(category: AppLogCategory, sequence: Long): AppLogFile {
    val name = AppLogNames.create(context.packageName, category, sequence) + ".txt"
    val uri = context.contentResolver.insert(collection, ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, name)
      put(MediaStore.MediaColumns.MIME_TYPE, "text/plain")
      put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath)
    }) ?: error("Cannot create Downloads log")
    val file = rows(uri).singleOrNull()
    if (file == null || file.name != name) {
      val actual = context.contentResolver.query(uri,
        arrayOf(MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.OWNER_PACKAGE_NAME), null, null, null)?.use {
        if (it.moveToFirst()) "name=${it.getString(0)} owner=${it.getString(1)}" else "missing row"
      }
      context.contentResolver.delete(uri, null, null)
      error("Downloads did not preserve log ownership or filename: $actual")
    }
    return file
  }
  private fun owned(file: AppLogFile): Uri {
    val uri = Uri.parse(file.id)
    check(rows(uri).any { it.id == file.id && it.name == file.name }) { "Downloads log is no longer owned" }
    return uri
  }
  override fun append(file: AppLogFile, bytes: ByteArray, flush: Boolean) = appendLogDocument(context, owned(file), bytes, flush)
  override fun delete(file: AppLogFile): Boolean = context.contentResolver.delete(owned(file), null, null) == 1
}
