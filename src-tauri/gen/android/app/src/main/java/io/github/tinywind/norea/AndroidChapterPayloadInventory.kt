package io.github.tinywind.norea

import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.security.MessageDigest
import java.util.zip.CRC32

internal val ANDROID_CHAPTER_PAYLOAD_NAMES = setOf(
  "content.html", "content.pdf", ".chapter-content.partial", ".chapter-content.partial.tmp",
  "content.html.tmp", "content.pdf.tmp", "media.zip.tmp",
  CHAPTER_MEDIA_ARCHIVE_FILE, CHAPTER_MEDIA_ARCHIVE_TEMP_FILE,
  CHAPTER_MEDIA_ARCHIVE_BACKUP_FILE, CHAPTER_MEDIA_ARCHIVE_ROLLBACK_FILE,
)

internal data class AndroidChapterPayloadHash(val sha256: String, val bytes: Long, val crc: Long)

internal fun hashAndroidChapterPayload(input: InputStream, limit: Long): AndroidChapterPayloadHash {
  val digest = MessageDigest.getInstance("SHA-256")
  val crc = CRC32()
  val buffer = ByteArray(64 * 1024)
  var bytes = 0L
  while (true) {
    val count = input.read(buffer)
    if (count < 0) break
    bytes = Math.addExact(bytes, count.toLong())
    require(bytes <= limit) { "Chapter payload exceeds the byte limit." }
    digest.update(buffer, 0, count)
    crc.update(buffer, 0, count)
  }
  return AndroidChapterPayloadHash(digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }, bytes, crc.value)
}

internal fun <T> resolveAndroidChapterDirectory(
  root: T,
  segments: List<String>,
  child: (T, String) -> T?,
): T? {
  var current = root
  for (segment in segments) {
    check(child(current, ".$segment.norea-sync-backup") == null) { "Interrupted chapter storage installation requires recovery." }
    current = child(current, segment) ?: return null
  }
  return current
}

internal fun requireStableAndroidChapterPayload(before: String?, after: String?) {
  check(before == after) { "Chapter payload changed during inspection." }
}

internal fun inspectAndroidChapterArchive(block: () -> Unit): Boolean = try {
  block()
  true
} catch (_: java.util.zip.ZipException) {
  false
} catch (_: java.io.EOFException) {
  false
} catch (_: IllegalArgumentException) {
  false
}

internal fun androidChapterDeleteInspectionError(error: Exception, errors: List<Pair<String, String>>): IllegalStateException {
  val details = errors.joinToString("; ") { (path, message) -> "$path: $message" }
  val suffix = if (details.isEmpty()) "" else " Deletion errors: $details"
  return IllegalStateException("Cannot inspect remaining chapter payload: ${error.message ?: error.javaClass.simpleName}.$suffix", error)
}

internal class AndroidChapterPayloadInventory(
  private val storage: AndroidStorageDocuments,
  private val mediaStore: AndroidChapterMediaStore,
) {
  private data class PayloadFile(val path: String, val document: DocumentFile)
  private data class Inspection(val json: JSONObject, val files: List<PayloadFile>)
  private data class PhysicalSnapshot(
    val entries: Map<String, DocumentFile>,
    val files: List<PayloadFile>,
    val hashes: Map<String, AndroidChapterPayloadHash>,
    val manifestRaw: ByteArray?,
    val payloadBytes: Long,
    val fingerprint: String,
  )

  private fun children(directory: DocumentFile): Map<String, DocumentFile> {
    require(directory.isDirectory && directory.canRead()) { "Chapter storage directory is not readable." }
    val result = mutableMapOf<String, DocumentFile>()
    for (child in storage.listStorageChildren(directory)) {
      require(!result.containsKey(child.name)) { "Ambiguous Android storage entry: ${child.name}" }
      result[child.name] = storage.storageChildDocumentFile(child)
        ?: throw IllegalStateException("Cannot resolve Android storage entry: ${child.name}")
    }
    return result
  }

  private fun directory(rootUri: String, path: String): DocumentFile? {
    val segments = storage.safeStorageSegments(path)
    require(segments.joinToString("/") == path) { "Chapter storage path is not canonical." }
    val current = resolveAndroidChapterDirectory(storage.storageRoot(rootUri), segments, storage::findStorageChildWithoutRecovery) ?: return null
    require(current.isDirectory && current.canRead()) { "Chapter storage directory is not readable: $path" }
    return current
  }

  private fun read(rootUri: String, file: PayloadFile, limit: Long): AndroidChapterPayloadHash {
    require(file.document.isFile && file.document.canRead()) { "Chapter payload is not readable: ${file.path}" }
    return storage.openStorageInputStream(rootUri, file.path, file.document)?.use { hashAndroidChapterPayload(it, limit) }
      ?: throw IllegalStateException("Cannot open chapter payload: ${file.path}")
  }

  private fun physicalSnapshot(rootUri: String, path: String): PhysicalSnapshot? {
    val directory = directory(rootUri, path) ?: return null
    val entries = children(directory)
    val files = mutableListOf<PayloadFile>()
    for (name in ANDROID_CHAPTER_PAYLOAD_NAMES.sorted()) {
      entries[name]?.let { files.add(PayloadFile("$path/$name", it)) }
    }
    entries["media"]?.let { media ->
      for ((name, document) in children(media).toSortedMap()) {
        if (name.matches(Regex("[A-Za-z0-9_-][A-Za-z0-9._-]*"))) {
          require(document.isFile) { "Managed media entry is not a file: $name" }
          files.add(PayloadFile("$path/media/$name", document))
          require(files.size <= ANDROID_CHAPTER_MEDIA_MAX_ENTRIES) { "Chapter payload has too many files." }
        }
      }
    }
    val fingerprint = MessageDigest.getInstance("SHA-256")
    fun add(value: String) { fingerprint.update(value.toByteArray(Charsets.UTF_8)); fingerprint.update(0) }
    add(rootUri); add(path); add(directory.uri.toString())
    var payloadBytes = 0L
    val hashes = mutableMapOf<String, AndroidChapterPayloadHash>()
    for (file in files) {
      val value = read(rootUri, file, 512L * BYTES_PER_MIB)
      payloadBytes = Math.addExact(payloadBytes, value.bytes)
      require(payloadBytes <= ANDROID_CHAPTER_MEDIA_MAX_TOTAL_BYTES) { "Chapter payload exceeds the total byte limit." }
      hashes[file.path.removePrefix("$path/")] = value
      add(file.path); add(file.document.uri.toString()); add(value.sha256); add(value.bytes.toString())
    }
    val manifest = entries[CHAPTER_MEDIA_MANIFEST_FILE]
    val raw = if (manifest != null) {
      val file = PayloadFile("$path/$CHAPTER_MEDIA_MANIFEST_FILE", manifest)
      require(manifest.isFile && manifest.canRead()) { "Chapter manifest is not readable." }
      val bytes = storage.openStorageInputStream(rootUri, file.path, manifest)?.use {
        storage.readBytesWithLimit(it, 8L * BYTES_PER_MIB)
      } ?: throw IllegalStateException("Cannot read chapter manifest.")
      val value = bytes.inputStream().use { hashAndroidChapterPayload(it, 8L * BYTES_PER_MIB) }
      add(file.path); add(file.document.uri.toString()); add(value.sha256)
      bytes
    } else {
      add("manifest absent")
      null
    }
    return PhysicalSnapshot(entries, files, hashes, raw, payloadBytes,
      fingerprint.digest().joinToString("") { "%02x".format(it.toInt() and 255) })
  }

  private fun inspect(rootUri: String, path: String): Inspection {
    val physical = physicalSnapshot(rootUri, path)
    if (physical == null) {
      requireStableAndroidChapterPayload(null, physicalSnapshot(rootUri, path)?.fingerprint)
      val fingerprint = MessageDigest.getInstance("SHA-256")
      for (value in listOf(rootUri, path, "missing")) {
        fingerprint.update(value.toByteArray(Charsets.UTF_8)); fingerprint.update(0)
      }
      return Inspection(JSONObject()
        .put("body", JSONObject.NULL).put("expectedAssetKeys", JSONObject.NULL)
        .put("storedAssets", JSONArray()).put("payloadBytes", 0L)
        .put("contentBytes", 0L).put("mediaBytes", 0L).put("mediaComplete", false)
        .put("fingerprint", fingerprint.digest().joinToString("") { "%02x".format(it.toInt() and 255) }), emptyList())
    }
    val entries = physical.entries
    val files = physical.files
    val hashes = physical.hashes
    val manifest = entries[CHAPTER_MEDIA_MANIFEST_FILE]
    var expected: List<String>? = physical.manifestRaw?.let { raw ->
      try {
        val json = JSONObject(raw.toString(Charsets.UTF_8))
        val parsed = mediaStore.parseChapterMediaManifest(json)
        require(parsed.files.all { it.path == "media/${it.fileName}" }) { "Invalid manifest path." }
        val urls = json.getJSONObject("media").getJSONArray("files")
        require((0 until urls.length()).map { urls.getJSONObject(it).getString("sourceUrl") }.toSet().size == urls.length()) { "Duplicate media source URL." }
        androidChapterMediaDeclaredFileNames(parsed.files.map {
          AndroidChapterMediaDeclaredFile(it.fileName, it.path)
        }).map { "media/$it" }.sorted()
      } catch (_: IllegalArgumentException) { null } catch (_: org.json.JSONException) { null }
    }
    val assets = sortedMapOf<String, AndroidChapterPayloadHash>()
    fun assetName(name: String): Boolean = name.matches(Regex("[A-Za-z0-9_-][A-Za-z0-9._-]*")) &&
      !name.lowercase().endsWith(".part")
    for ((name, value) in hashes) {
      if (name.startsWith("media/") && assetName(name.removePrefix("media/")) && value.bytes > 0) assets[name] = value
    }
    entries[CHAPTER_MEDIA_ARCHIVE_FILE]?.let { archive ->
      val validArchive = inspectAndroidChapterArchive {
        storage.inspectChapterMediaZip(rootUri, "$path/$CHAPTER_MEDIA_ARCHIVE_FILE", archive) { zip, file ->
          validateAndroidChapterMediaInventory(emptySet(), zip, file)
          var total = 0L
          for (entry in zip.entries()) {
            val key = "media/${entry.name}"
            if (entry.isDirectory || !assetName(entry.name)) continue
            try {
              val value = zip.getInputStream(entry).use { hashAndroidChapterPayload(it, ANDROID_CHAPTER_MEDIA_MAX_ENTRY_BYTES) }
              total = Math.addExact(total, value.bytes)
              require(total <= ANDROID_CHAPTER_MEDIA_MAX_TOTAL_BYTES) { "Chapter media exceeds the total byte limit." }
              if (value.bytes > 0 && value.bytes == entry.size && value.crc == entry.crc) {
                val existing = assets[key]
                check(existing == null || (existing.bytes == value.bytes && existing.sha256 == value.sha256)) {
                  "Conflicting copies of chapter media: $key"
                }
                assets[key] = value
              }
            } catch (_: java.util.zip.ZipException) { } catch (_: java.io.EOFException) { }
          }
        }
      }
      if (!validArchive) expected = null
    }
    requireStableAndroidChapterPayload(physical.fingerprint, physicalSnapshot(rootUri, path)?.fingerprint)
    fun valueJson(value: AndroidChapterPayloadHash) = JSONObject().put("sha256", value.sha256).put("bytes", value.bytes)
    require(!(hashes.containsKey("content.html") && hashes.containsKey("content.pdf"))) {
      "Multiple published chapter bodies are present."
    }
    val body = listOf("content.html", "content.pdf", ".chapter-content.partial").firstNotNullOfOrNull { hashes[it] }?.takeIf { it.bytes > 0 }
    val stored = JSONArray()
    assets.forEach { (key, value) -> stored.put(valueJson(value).put("key", key)) }
    val json = JSONObject()
      .put("body", body?.let(::valueJson) ?: JSONObject.NULL)
      .put("expectedAssetKeys", expected?.let { JSONArray(it) } ?: JSONObject.NULL)
      .put("storedAssets", stored)
      .put("payloadBytes", physical.payloadBytes)
      .put("contentBytes", body?.bytes ?: 0L)
      .put("mediaBytes", hashes[CHAPTER_MEDIA_ARCHIVE_FILE]?.bytes ?: 0L)
      .put("mediaComplete", if (manifest == null) entries[CHAPTER_MEDIA_ARCHIVE_FILE] == null else expected != null && expected.all { it in assets })
      .put("fingerprint", physical.fingerprint)
    return Inspection(json, files)
  }

  fun inspectSnapshot(rootUri: String, path: String): JSONObject = inspect(rootUri, path).json

  fun deletePayload(rootUri: String, path: String, expectedFingerprint: String): JSONObject {
    val before = inspect(rootUri, path)
    require(before.json.getString("fingerprint") == expectedFingerprint) { "Chapter payload fingerprint is stale." }
    val errors = JSONArray()
    val errorDetails = mutableListOf<Pair<String, String>>()
    for (file in before.files) {
      try {
        if (!file.document.delete()) throw IllegalStateException("Storage provider rejected deletion.")
      } catch (error: Exception) {
        val message = error.message ?: "Deletion failed."
        errorDetails.add(file.path to message)
        errors.put(JSONObject().put("path", file.path).put("message", message))
      }
    }
    val snapshot = try {
      inspect(rootUri, path).json
    } catch (error: Exception) {
      throw androidChapterDeleteInspectionError(error, errorDetails)
    }
    return JSONObject().put("snapshot", snapshot).put("errors", errors)
  }
}
