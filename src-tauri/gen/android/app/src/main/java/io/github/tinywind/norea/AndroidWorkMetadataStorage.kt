package io.github.tinywind.norea

import android.content.ContentResolver
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

private val workCoverPattern = Regex("cover\\.(avif|bmp|gif|img|jpe?g|png|svg|webp)")
internal fun isAndroidWorkCoverFile(name: String): Boolean = workCoverPattern.matches(name)

internal class AndroidWorkMetadataStorage(
  private val resolver: ContentResolver,
  private val storage: AndroidStorageDocuments,
) {
  fun operate(root: String, input: JSONObject): JSONObject {
    val result = JSONObject().put("ok", true)
    if (input.getString("operation") == "list") {
      val paths = JSONArray()
      val contents = storage.storageDocumentAt(root, "contents") ?: return result.put("paths", paths)
      for (source in storage.listStorageChildren(contents).filter { it.isDirectory }) {
        val sourceDir = storage.storageChildDocumentFile(source) ?: continue
        for (work in storage.listStorageChildren(sourceDir).filter { it.isDirectory }) {
          val workDir = storage.storageChildDocumentFile(work) ?: continue
          val names = storage.listStorageChildren(workDir).map { it.name }.toSet()
          if ("novel.json" in names || "novel.json.bak" in names) {
            paths.put("contents/${source.name}/${work.name}/novel.json")
          }
        }
      }
      return result.put("paths", paths)
    }
    val path = input.getString("path")
    val parts = path.split('/')
    require(parts.size == 4 && parts[0] == "contents" && parts.all {
      it.isNotEmpty() && it != "." && it != ".." && !it.endsWith('.') && !it.endsWith(' ') &&
        it.none { c -> c.code < 32 || c in "<>:\"/\\|?*" }
    }) { "Work metadata path is invalid." }
    if (input.getString("operation") == "chapters") {
      require(parts.last() == "novel.json") { "Chapter scan requires a work path." }
      val paths = JSONArray()
      val workPath = parts.dropLast(1).joinToString("/")
      val skipped = input.optJSONArray("skipChapterDirectories")
      val skippedDirectories = if (skipped == null) emptySet() else (0 until skipped.length()).map { skipped.getString(it) }.toSet()
      val work = storage.storageDocumentAt(root, workPath) ?: return result.put("paths", paths)
      for (child in storage.listStorageChildren(work).filter { it.isDirectory }) {
        if ("$workPath/${child.name}" in skippedDirectories) continue
        if (!Regex("[0-9]+(?:\\.[0-9]+)?-.+").matches(child.name)) continue
        val chapter = storage.storageChildDocumentFile(child) ?: continue
        val files = storage.listStorageChildren(chapter).associateBy { it.name }
        for (name in listOf("content.pdf", "content.html")) {
          val file = files[name] ?: continue
          val size = file.byteSize ?: storage.storageChildDocumentFile(file)?.length() ?: 0
          if (!file.mimeType.isNullOrEmpty() && !file.isDirectory && size > 0) {
            paths.put("$workPath/${child.name}/$name")
            break
          }
        }
      }
      return result.put("paths", paths)
    }
    val name = parts.last()
    require(name == "novel.json" || isAndroidWorkCoverFile(name)) {
      "Work metadata filename is invalid."
    }
    val limit = if (name.endsWith(".json")) 16 * 1024 * 1024 else 10 * 1024 * 1024
    when (input.getString("operation")) {
      "cover" -> {
        require(name == "novel.json") { "Cover lookup requires a work path." }
        val work = storage.storageDocumentAt(root, parts.dropLast(1).joinToString("/"))
          ?: return result.put("cover", JSONObject.NULL)
        val metadata = operate(root, JSONObject().put("operation", "read").put("path", path))
        val preferred = if (metadata.isNull("body")) null else runCatching {
          JSONObject(String(Base64.decode(metadata.getString("body"), Base64.DEFAULT), Charsets.UTF_8))
            .optJSONObject("cover")?.optString("fileName")
        }.getOrNull()
        val candidates = storage.listStorageChildren(work).filter { !it.isDirectory && isAndroidWorkCoverFile(it.name) }
          .sortedWith(compareBy({ it.name != preferred }, { it.name }))
        for (candidate in candidates) {
          val file = storage.storageChildDocumentFile(candidate) ?: continue
          val size = candidate.byteSize ?: file.length()
          if (size <= 0 || size > 10 * 1024 * 1024) continue
          return result.put("cover", JSONObject().put("fileName", candidate.name).put("modifiedAt", file.lastModified()))
        }
        result.put("cover", JSONObject.NULL)
      }
      "read" -> {
        val document = storage.storageDocumentAt(root, path)
          ?: storage.storageDocumentAt(root, "$path.bak")
          ?: return result.put("body", JSONObject.NULL)
        require(document.isFile) { "Work metadata path is not a file." }
        val bytes = storage.openStorageInputStream(root, if (document.name == "$name.bak") "$path.bak" else path)?.use { stream ->
          val output = ByteArrayOutputStream()
          val buffer = ByteArray(65536)
          while (true) {
            val count = stream.read(buffer)
            if (count < 0) break
            require(output.size() + count <= limit) { "Work metadata file exceeds its size limit." }
            output.write(buffer, 0, count)
          }
          output.toByteArray()
        } ?: error("Cannot read work metadata file.")
        result.put("body", Base64.encodeToString(bytes, Base64.NO_WRAP))
      }
      "write" -> {
        val bytes = Base64.decode(input.getString("body"), Base64.DEFAULT)
        require(bytes.isNotEmpty() && bytes.size <= limit) { "Work metadata file size is invalid." }
        if (name.endsWith(".json")) JSONObject(String(bytes, Charsets.UTF_8))
        var previous = storage.storageDocumentAt(root, path)
        val backup = storage.storageDocumentAt(root, "$path.bak")
        if (previous == null && backup != null) {
          check(backup.renameTo(name)) { "Cannot recover work metadata backup." }
          previous = backup
        } else if (backup != null) {
          check(backup.isFile && backup.delete()) { "Cannot remove work metadata backup." }
        }
        val temporary = storage.ensureStorageFile(root, "$path.tmp", "application/octet-stream")
        resolver.openOutputStream(temporary.uri, "wt")?.use { it.write(bytes) }
          ?: error("Cannot write work metadata temporary file.")
        if (previous != null) {
          check(previous.isFile && previous.renameTo("$name.bak")) { "Cannot backup work metadata." }
        }
        publishAndroidChapterMediaArtifactWithRollback(
          publicationErrorMessage = "Cannot publish work metadata.",
          restorationErrorMessage = "Cannot restore work metadata backup.",
          publish = { temporary.renameTo(name) },
          restore = previous?.let { old -> { old.renameTo(name) } },
        )
        if (previous != null) check(previous.delete()) { "Cannot remove previous work metadata." }
      }
      "remove" -> {
        for (suffix in listOf("", ".bak", ".tmp")) {
          val document = storage.storageDocumentAt(root, "$path$suffix") ?: continue
          check(document.isFile && document.delete()) { "Cannot remove work metadata." }
        }
      }
      else -> error("Unknown work metadata operation.")
    }
    return result
  }
}
