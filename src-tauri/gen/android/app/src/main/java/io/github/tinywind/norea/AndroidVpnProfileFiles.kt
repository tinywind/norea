package io.github.tinywind.norea

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.security.MessageDigest

private const val VPN_PROFILE_DIRECTORY = "vpn-profiles"
private const val MAX_VPN_PROFILE_BYTES = BYTES_PER_MIB
private val VPN_PROFILE_LABEL = Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")

/** Mirrors `is_stored_file_name` in saved_profiles_stored.rs: `<host>.ovpn` for an IPv4 or lowercase domain host. */
internal fun isVpnProfileFileName(name: String): Boolean {
  val host = name.removeSuffix(".ovpn")
  if (host == name || host.isEmpty() || host.length > 253) return false
  val labels = host.split('.')
  if (labels.all { label -> label.isNotEmpty() && label.all(Char::isDigit) }) {
    return labels.size == 4 && labels.all { label -> (label == "0" || !label.startsWith('0')) && label.length <= 3 && label.toInt() <= 255 }
  }
  return labels.all(VPN_PROFILE_LABEL::matches)
}

/**
 * Applies a saved VPN profile sync planned by the Rust host to `vpn-profiles/` of the SAF
 * storage folder: deletes and publishes the planned files, then copies every other profile file
 * into a bridge temp file for import. Profile bytes move between private files, never through JS.
 */
internal class AndroidVpnProfileFiles(
  context: Context,
  private val storage: AndroidStorageDocuments,
  private val contentFiles: AndroidContentUriFiles,
) {
  private val contentResolver = context.contentResolver

  fun sync(rootUri: String, input: JSONObject): JSONObject {
    val root = storage.storageRoot(rootUri)
    check(root.canWrite()) { "the storage folder is not writable" }
    val errors = JSONArray()
    val deleted = JSONArray()
    val published = JSONArray()
    val inbound = JSONArray()
    var directory = storage.findStorageChild(root, VPN_PROFILE_DIRECTORY)?.takeIf { it.isDirectory }

    val deletions = input.getJSONArray("delete")
    for (index in 0 until deletions.length()) {
      val name = deletions.getString(index)
      require(isVpnProfileFileName(name)) { "VPN profile file name is invalid: $name" }
      val existing = directory?.let { storage.findStorageChild(it, name) }
      if (existing == null || existing.delete()) deleted.put(name) else errors.put("Cannot remove $name from the storage folder.")
    }

    val publications = input.getJSONArray("publish")
    val publishedNames = mutableSetOf<String>()
    if (publications.length() > 0 && directory == null) {
      directory = storage.ensureStorageDirectory(root, VPN_PROFILE_DIRECTORY)
    }
    for (index in 0 until publications.length()) {
      val entry = publications.getJSONObject(index)
      val name = entry.getString("fileName")
      runCatching { publish(rootUri, name, entry.getString("inputPath")) }
        .onSuccess { sha256 ->
          publishedNames.add(name)
          published.put(JSONObject().put("fileName", name).put("sha256", sha256))
        }
        .onFailure { error -> errors.put("$name: ${error.message}") }
    }

    val known = input.getJSONArray("known").let { names -> (0 until names.length()).map(names::getString).toSet() }
    directory?.let { folder ->
      for (child in storage.listStorageChildren(folder)) {
        val name = child.name
        if (!isVpnProfileFileName(name) || name in known || name in publishedNames) continue
        if ((child.byteSize ?: 0L) > MAX_VPN_PROFILE_BYTES) {
          errors.put("$name exceeds the VPN profile size limit.")
          continue
        }
        runCatching {
          contentResolver.openInputStream(child.uri)?.use { source ->
            contentFiles.copyToStorageTempFile(source, MAX_VPN_PROFILE_BYTES)
          } ?: throw IllegalStateException("Cannot open $name for reading.")
        }
          .onSuccess { file -> inbound.put(JSONObject().put("fileName", name).put("path", file.absolutePath)) }
          .onFailure { error -> errors.put("$name: ${error.message}") }
      }
    }
    return JSONObject()
      .put("ok", true)
      .put("reachable", true)
      .put("published", published)
      .put("deleted", deleted)
      .put("inbound", inbound)
      .put("errors", errors)
  }

  /** Copies under a temporary name, replaces the old file, and returns the SHA-256 read back. */
  private fun publish(rootUri: String, fileName: String, inputPath: String): String {
    require(isVpnProfileFileName(fileName)) { "VPN profile file name is invalid: $fileName" }
    val input = contentFiles.containedAppCacheFile(inputPath)
    require(input.isFile) { "Staged VPN profile is unavailable." }
    val partial = storage.ensureStorageFile(rootUri, "$VPN_PROFILE_DIRECTORY/.$fileName.partial", "application/octet-stream")
    try {
      input.inputStream().use { source ->
        contentResolver.openOutputStream(partial.uri, "wt")?.use { output ->
          storage.copyToWithLimit(source, output, MAX_VPN_PROFILE_BYTES)
        } ?: throw IllegalStateException("Cannot open the VPN profile for writing.")
      }
      val directory = storage.storageDocumentAt(rootUri, VPN_PROFILE_DIRECTORY)
        ?: throw IllegalStateException("The VPN profile folder is unavailable.")
      storage.findStorageChild(directory, fileName)?.let { existing ->
        check(existing.delete()) { "Cannot replace $fileName." }
      }
      check(partial.renameTo(fileName)) { "Cannot publish $fileName." }
    } catch (error: Throwable) {
      partial.delete()
      throw error
    }
    val publishedFile = storage.storageDocumentAt(rootUri, "$VPN_PROFILE_DIRECTORY/$fileName")
      ?: throw IllegalStateException("$fileName is missing after publication.")
    return contentResolver.openInputStream(publishedFile.uri)?.use(::sha256Hex)
      ?: throw IllegalStateException("Cannot read $fileName back.")
  }
}

private fun sha256Hex(input: InputStream): String {
  val digest = MessageDigest.getInstance("SHA-256")
  val buffer = ByteArray(DEFAULT_STORAGE_COPY_BUFFER_BYTES)
  while (true) {
    val read = input.read(buffer)
    if (read < 0) break
    digest.update(buffer, 0, read)
  }
  return digest.digest().joinToString("") { byte -> "%02x".format(byte) }
}
