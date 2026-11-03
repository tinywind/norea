package io.github.tinywind.norea

import java.io.File
import java.io.RandomAccessFile
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

internal data class AppLogFile(val id: String, val name: String, val sequence: Long, val sizeBytes: Long)

internal interface AppLogDestination {
  val key: String
  val acceptsWrites: Boolean get() = true
  fun files(category: AppLogCategory): List<AppLogFile>
  fun create(category: AppLogCategory, sequence: Long): AppLogFile
  fun append(file: AppLogFile, bytes: ByteArray, flush: Boolean)
  fun delete(file: AppLogFile): Boolean
}

internal sealed interface AppLogWriteResult {
  data class Saved(val location: String, val limitation: String? = null) : AppLogWriteResult
  data class Unavailable(val message: String) : AppLogWriteResult
}

internal object AppLogNames {
  fun create(namespace: String, category: AppLogCategory, sequence: Long): String =
    "norea-$namespace-${category.value}-${sequence.toString().padStart(20, '0')}-" +
      "${System.currentTimeMillis()}-${UUID.randomUUID().toString().replace("-", "")}.log"

  fun sequence(namespace: String, category: AppLogCategory, name: String): Long? =
    Regex("^norea-${Regex.escape(namespace)}-${category.value}-([0-9]{20})-[0-9]+-[a-f0-9]{32}\\.log(?:\\.txt)?$")
      .matchEntire(name)?.groupValues?.get(1)?.toLongOrNull()
}

internal class AppLogFiles(
  private val namespace: String,
  private val stateDirectory: File,
  private val sequenceDirectory: File = stateDirectory,
  private val destinations: () -> List<AppLogDestination>,
) {
  fun write(category: AppLogCategory, bytes: ByteArray): AppLogWriteResult {
    if (bytes.size > APP_LOG_FILE_BYTES) return AppLogWriteResult.Unavailable("Log exceeds the file limit")
    return try {
      check(stateDirectory.isDirectory || stateDirectory.mkdirs()) { "Log state directory is unavailable" }
      val root = stateDirectory.canonicalFile
      val state = File(root, "${category.value}.state")
      check(state.canonicalFile == state.absoluteFile) { "Linked log state is not allowed" }
      synchronized(locks.getOrPut(state.path) { Any() }) {
        RandomAccessFile(state, "rw").use { file ->
          file.channel.lock().use { writeLocked(category, bytes) }
        }
      }
    } catch (error: Exception) {
      AppLogWriteResult.Unavailable("Log coordination failed: ${singleLineLogMessage(error.toString())}")
    }
  }

  private fun nextSequence(category: AppLogCategory, observed: Long): Long {
    check(sequenceDirectory.isDirectory || sequenceDirectory.mkdirs() || sequenceDirectory.isDirectory)
    val path = File(sequenceDirectory.canonicalFile, "${category.value}.sequence")
    check(path.canonicalFile == path.absoluteFile) { "Linked log sequence is not allowed" }
    return synchronized(locks.getOrPut(path.path) { Any() }) {
      RandomAccessFile(path, "rw").use { state ->
        state.channel.lock().use {
          val sequence = Math.addExact(maxOf(if (state.length() >= 8) state.readLong() else 0, observed), 1)
          state.seek(0)
          state.writeLong(sequence)
          state.fd.sync()
          sequence
        }
      }
    }
  }

  private fun writeLocked(category: AppLogCategory, bytes: ByteArray): AppLogWriteResult {
    val candidates = destinations().distinctBy { it.key }
    val failures = mutableListOf<String>()
    fun inventory(destination: AppLogDestination): List<AppLogFile> = try {
      destination.files(category).filter { AppLogNames.sequence(namespace, category, it.name) == it.sequence }
    } catch (_: Exception) { emptyList() }
    val existing = candidates.flatMap { inventory(it) }
    val observed = existing.maxOfOrNull { it.sequence } ?: 0
    for (destination in candidates.filter { it.acceptsWrites }) {
      var created: AppLogFile? = null
      try {
        val latest = if (category == AppLogCategory.RUNTIME) inventory(destination).maxByOrNull { it.sequence } else null
        val target = if (latest != null && latest.sizeBytes + bytes.size <= APP_LOG_FILE_BYTES) latest else {
          destination.create(category, nextSequence(category, observed)).also { created = it }
        }
        destination.append(target, bytes, true)
        val retained = candidates.flatMap { owner -> inventory(owner).map { owner to it } }
          .sortedWith(compareBy({ it.second.sequence }, { it.second.name }))
        retained.take((retained.size - APP_LOG_FILE_COUNT).coerceAtLeast(0)).forEach { (owner, old) ->
          try {
            if (!owner.delete(old)) failures += "Retention could not remove ${old.name}"
          } catch (error: Exception) {
            failures += "Retention failed: ${singleLineLogMessage(error.toString())}"
          }
        }
        return AppLogWriteResult.Saved(target.id, failures.takeIf { it.isNotEmpty() }?.joinToString("; "))
      } catch (error: Exception) {
        created?.let { runCatching { destination.delete(it) } }
        failures += "${destination.key}: ${singleLineLogMessage(error.toString())}"
      }
    }
    return AppLogWriteResult.Unavailable(failures.joinToString("; ").ifEmpty { "No log destination is available" })
  }

  companion object { private val locks = ConcurrentHashMap<String, Any>() }
}

internal class AppLogRootHistory(private val stateDirectory: File) {
  fun remember(selected: String?): List<String> = synchronized(lock) {
    check(stateDirectory.isDirectory || stateDirectory.mkdirs())
    val file = File(stateDirectory.canonicalFile, "roots.state")
    check(file.canonicalFile == file.absoluteFile) { "Linked log root history is not allowed" }
    RandomAccessFile(file, "rw").use { state ->
      state.channel.lock().use {
        check(state.length() <= 1_048_576) { "Log root history exceeds its limit" }
        val roots = linkedSetOf<String>()
        while (state.filePointer < state.length()) roots += state.readUTF()
        if (selected != null && roots.add(selected)) {
          state.writeUTF(selected)
          state.fd.sync()
        }
        roots.toList()
      }
    }
  }
  companion object { private val lock = Any() }
}
