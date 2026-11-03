package io.github.tinywind.norea

import android.content.Context
import org.json.JSONObject

private const val AUTO_BACKUP_DIRECTORY = "backups"
private const val MAX_AUTO_BACKUP_KEEP = 50
private val AUTO_BACKUP_NAME = Regex("^norea-auto-backup-\\d{14}\\.zip$")

internal fun isAutoBackupName(name: String): Boolean = AUTO_BACKUP_NAME.matches(name)

/** Automatic backups beyond the newest `keep`; other files are never listed. */
internal fun autoBackupNamesToPrune(names: List<String>, keep: Int): List<String> =
  names.filter(::isAutoBackupName).sortedDescending().drop(keep)

/**
 * Publishes automatic backups into `backups/` of the SAF storage folder: the
 * archive is copied under a temporary name, renamed into place, and only then
 * are the oldest automatic backups beyond `keep` deleted.
 */
internal class AndroidAutoBackups(
  context: Context,
  private val storage: AndroidStorageDocuments,
  private val contentFiles: AndroidContentUriFiles,
) {
  private val contentResolver = context.contentResolver

  fun publish(rootUri: String, inputPath: String, fileName: String, keep: Int): JSONObject {
    require(isAutoBackupName(fileName)) { "Automatic backup name is invalid: $fileName" }
    require(keep in 1..MAX_AUTO_BACKUP_KEEP) { "Automatic backup keep count is invalid: $keep" }
    val input = contentFiles.containedAppCacheFile(inputPath)
    require(input.isFile) { "Automatic backup temp file is unavailable." }
    val root = storage.storageRoot(rootUri)
    require(root.canWrite()) { "Android storage folder is not writable." }
    val directory = storage.ensureStorageDirectory(root, AUTO_BACKUP_DIRECTORY)
    val partialName = ".$fileName.partial"
    val partial = storage.ensureStorageFile(rootUri, "$AUTO_BACKUP_DIRECTORY/$partialName", "application/octet-stream")
    try {
      input.inputStream().use { source ->
        contentResolver.openOutputStream(partial.uri, "wt")?.use { output -> source.copyTo(output) }
          ?: throw IllegalStateException("Cannot open the automatic backup for writing.")
      }
      storage.findStorageChild(directory, fileName)?.let { existing ->
        check(existing.delete()) { "Cannot replace the automatic backup $fileName." }
      }
      check(partial.renameTo(fileName)) { "Cannot publish the automatic backup $fileName." }
    } catch (error: Throwable) {
      partial.delete()
      throw error
    }
    val pruned = autoBackupNamesToPrune(storage.listStorageChildren(directory).map { it.name }, keep)
    for (name in pruned) {
      storage.findStorageChild(directory, name)?.let { old ->
        check(old.delete()) { "Cannot remove the old automatic backup $name." }
      }
    }
    return JSONObject().put("ok", true).put("fileName", fileName).put("pruned", pruned.size)
  }
}
