package io.github.tinywind.norea

import android.content.Context
import androidx.documentfile.provider.DocumentFile
import java.io.File
import java.security.MessageDigest

internal class AndroidContentSyncStorage(
  private val context: Context,
  private val storage: AndroidStorageDocuments,
) {
  private fun stageDirectory(stagePath: String): File {
    val root = File(context.cacheDir, "content-sync").canonicalFile
    val stage = File(stagePath).canonicalFile
    require(stage.parentFile == root && stage.isDirectory) { "Invalid content staging directory." }
    return stage
  }

  fun snapshot(rootUri: String, storageDir: String, stagePath: String) {
    validateAndroidChapterStorageRelativeDir(storageDir)
    val destination = File(stageDirectory(stagePath), "source")
    check(destination.mkdir()) { "Cannot create content snapshot." }
    val source = storage.storageDocumentAt(rootUri, storageDir)
      ?: error("Stored chapter is missing.")
    var count = 0
    var total = 0L
    fun copy(directory: DocumentFile, target: File, relative: String) {
      for (child in storage.listStorageChildren(directory)) {
        require(child.name.isNotEmpty() && child.name != "." && child.name != ".." && !child.name.contains('/') && !child.name.contains('\\')) { "Unsafe chapter file." }
        val childRelative = "$relative/${child.name}"
        val document = storage.storageChildDocumentFile(child) ?: error("Chapter file disappeared.")
        if (child.isDirectory) {
          if (relative == storageDir && child.name == "media") {
            val nested = File(target, child.name)
            check(nested.mkdir()) { "Cannot create media snapshot." }
            copy(document, nested, childRelative)
          }
        } else if (relative != storageDir || child.name in setOf("content.html", "content.pdf", "manifest.json", "media.zip")) {
          check(++count <= 10_000) { "Too many chapter files." }
          storage.openStorageInputStream(rootUri, childRelative, document)?.use { input ->
            File(target, child.name).outputStream().use { output ->
              val buffer = ByteArray(DEFAULT_STORAGE_COPY_BUFFER_BYTES)
              while (true) {
                val length = input.read(buffer)
                if (length < 0) break
                total += length
                check(total <= MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) { "Chapter snapshot exceeds byte limit." }
                output.write(buffer, 0, length)
              }
              output.fd.sync()
            }
          } ?: error("Cannot read chapter file.")
        }
      }
    }
    copy(source, destination, storageDir)
  }

  fun install(rootUri: String, storageDir: String, stagePath: String) = synchronized(storage) {
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
