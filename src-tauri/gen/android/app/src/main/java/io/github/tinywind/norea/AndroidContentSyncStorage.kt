package io.github.tinywind.norea

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import java.io.File
import java.security.MessageDigest

internal class AndroidContentSyncStorage(
  private val context: Context,
  private val storage: AndroidStorageDocuments,
) {
  private val snapshotGuard = AndroidContentSnapshotGuard()

  private data class SnapshotFile(
    val relativePath: String,
    val uri: Uri,
    val bytes: Long,
    val lastModified: Long,
  )

  private fun stageDirectory(stagePath: String): File {
    val root = File(context.cacheDir, "content-sync").canonicalFile
    val stage = File(stagePath).canonicalFile
    require(stage.parentFile == root && stage.isDirectory) { "Invalid content staging directory." }
    return stage
  }

  fun snapshot(rootUri: String, storageDir: String, stagePath: String) {
    val segments = validateAndroidChapterStorageRelativeDir(storageDir)
    val destination = File(stageDirectory(stagePath), "source")
    check(destination.mkdir()) { "Cannot create content snapshot." }
    try {
      snapshotGuard.snapshot(rootUri, storageDir) {
        var source = storage.storageRoot(rootUri)
        // Snapshot lookup must not recover or rename chapters changed by foreground storage.
        for (segment in segments) {
          check(!Thread.currentThread().isInterrupted) { "Content snapshot cancelled." }
          val child = storage.listStorageChildren(source)
            .firstOrNull { it.name == segment && it.isDirectory }
            ?: error("Stored chapter is missing.")
          source = storage.storageChildDocumentFile(child) ?: error("Stored chapter is missing.")
        }
        val files = snapshotFiles(source)
        if (files.any { it.relativePath.startsWith("media/") }) {
          check(File(destination, "media").mkdir()) { "Cannot create media snapshot." }
        }
        var total = 0L
        for (file in files) {
          context.contentResolver.openInputStream(file.uri)?.use { input ->
            File(destination, file.relativePath).outputStream().use { output ->
              val buffer = ByteArray(DEFAULT_STORAGE_COPY_BUFFER_BYTES)
              while (true) {
                check(!Thread.currentThread().isInterrupted) { "Content snapshot cancelled." }
                val length = input.read(buffer)
                if (length < 0) break
                total += length
                check(total <= MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) { "Chapter snapshot exceeds byte limit." }
                output.write(buffer, 0, length)
              }
            }
          } ?: error("Cannot read chapter file.")
        }
        check(files == snapshotFiles(source)) { "Chapter changed during content snapshot." }
      }
    } catch (error: Exception) {
      destination.deleteRecursively()
      throw error
    }
  }

  private fun snapshotFiles(source: DocumentFile): List<SnapshotFile> {
    val files = mutableListOf<SnapshotFile>()
    fun collect(directory: DocumentFile, relative: String) {
      check(!Thread.currentThread().isInterrupted) { "Content snapshot cancelled." }
      for (child in storage.listStorageChildren(directory)) {
        require(child.name.isNotEmpty() && child.name != "." && child.name != ".." && !child.name.contains('/') && !child.name.contains('\\')) { "Unsafe chapter file." }
        val document = storage.storageChildDocumentFile(child) ?: error("Chapter file disappeared.")
        if (child.isDirectory) {
          if (relative.isEmpty() && child.name == "media") {
            collect(document, "media/")
          }
        } else if (relative.isNotEmpty() || child.name in setOf("content.html", "content.pdf", "manifest.json", "media.zip")) {
          check(files.size < 10_000) { "Too many chapter files." }
          files.add(SnapshotFile("$relative${child.name}", document.uri, document.length(), document.lastModified()))
        }
      }
    }
    collect(source, "")
    return files.sortedBy { it.relativePath }
  }

  fun install(rootUri: String, storageDir: String, stagePath: String) = snapshotGuard.install(rootUri, storageDir) {
    installVerifiedContent(rootUri, storageDir, stagePath)
  }

  private fun installVerifiedContent(rootUri: String, storageDir: String, stagePath: String) = synchronized(storage) {
    val segments = validateAndroidChapterStorageRelativeDir(storageDir)
    val cache = File(stageDirectory(stagePath), "install")
    check(cache.isDirectory) { "Verified content is missing." }
    var parent = storage.storageRoot(rootUri)
    for (segment in segments.dropLast(1)) parent = storage.ensureStorageDirectory(parent, segment)
    val name = segments.last()
    val token = "${System.currentTimeMillis()}-${System.nanoTime()}"
    val stageName = ".norea-sync-$token.stage"
    val backupName = ".$name.norea-sync-backup"
    val existing = storage.findStorageChild(parent, name)
    storage.findStorageChild(parent, backupName)?.let { backup ->
      check(existing != null &&
        (storage.findStorageChild(existing, "content.html")?.isFile == true ||
          storage.findStorageChild(existing, "content.pdf")?.isFile == true)) {
        "Previous chapter backup retained because current content is incomplete."
      }
      check(backup.delete()) { "Cannot clear completed chapter backup." }
    }
    val staged = storage.ensureStorageDirectory(parent, stageName)
    var previous: DocumentFile? = null
    var published = false
    try {
      for (file in cache.listFiles() ?: error("Cannot list verified content.")) {
        require(file.isFile && file.name in setOf("content.html", "content.pdf", "manifest.json", "media.zip")) { "Invalid chapter artifact." }
        val target = storage.ensureStorageFile(rootUri, "${segments.dropLast(1).joinToString("/")}/$stageName/${file.name}", "application/octet-stream")
        context.contentResolver.openOutputStream(target.uri, "wt")?.use { output ->
          file.inputStream().use { it.copyTo(output, DEFAULT_STORAGE_COPY_BUFFER_BYTES) }
        } ?: error("Cannot write chapter artifact.")
        val expected = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
          val buffer = ByteArray(DEFAULT_STORAGE_COPY_BUFFER_BYTES)
          while (true) { val count = input.read(buffer); if (count < 0) break; expected.update(buffer, 0, count) }
        }
        val actual = MessageDigest.getInstance("SHA-256")
        var bytes = 0L
        context.contentResolver.openInputStream(target.uri)?.use { input ->
          val buffer = ByteArray(DEFAULT_STORAGE_COPY_BUFFER_BYTES)
          while (true) { val count = input.read(buffer); if (count < 0) break; bytes += count; actual.update(buffer, 0, count) }
        } ?: error("Cannot verify chapter artifact.")
        check(bytes == file.length() && expected.digest().contentEquals(actual.digest())) { "Chapter storage checksum mismatch." }
      }
      previous = storage.findStorageChild(parent, name)
      previous?.let { check(it.renameTo(backupName)) { "Cannot preserve previous chapter." } }
      check(staged.renameTo(name)) { "Cannot publish downloaded chapter." }
      published = true
      previous?.delete()
    } catch (error: Exception) {
      if (!published && previous?.name == backupName) {
        check(previous!!.renameTo(name)) { "Install failed; previous chapter remains in $backupName: ${error.message}" }
      }
      throw error
    } finally {
      if (!published) staged.delete()
    }
  }
}
