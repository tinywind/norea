package io.github.tinywind.norea

import java.io.EOFException
import java.io.File
import java.io.FilterInputStream
import java.io.InputStream
import java.util.Locale
import java.util.zip.CRC32
import java.util.zip.ZipException
import java.util.zip.ZipFile
import java.util.zip.ZipInputStream

private const val MAX_REPAIR_ARCHIVE_BYTES = 512L * 1024L * 1024L

private class AndroidChapterMediaRepairBudget {
  private var bytes = 0L

  fun consume(count: Long) {
    require(count >= 0 && count <= ANDROID_CHAPTER_MEDIA_MAX_TOTAL_BYTES - bytes) {
      "Chapter media repair exceeds the total byte limit."
    }
    bytes += count
  }
}

internal fun recoverAndroidChapterMediaArchive(
  archive: ZipFile,
  expected: List<AndroidChapterMediaStoredFile>,
  temporary: File,
  accept: (String, File, Long) -> Unit,
) {
  require(File(archive.name).length() <= MAX_REPAIR_ARCHIVE_BYTES) {
    "Chapter media repair archive exceeds the byte limit."
  }
  require(archive.size() <= ANDROID_CHAPTER_MEDIA_MAX_ENTRIES) { "Chapter media archive has too many entries." }
  val declared = AndroidChapterMediaRepairBudget()
  val entries = archive.entries().asSequence().onEach { entry ->
    require(entry.size in 0L..ANDROID_CHAPTER_MEDIA_MAX_ENTRY_BYTES) {
      "Chapter media entry exceeds the byte limit."
    }
    declared.consume(entry.size)
  }.groupBy { it.name.lowercase(Locale.ROOT) }
  val expanded = AndroidChapterMediaRepairBudget()
  for (file in expected) {
    val entry = entries[file.fileName.lowercase(Locale.ROOT)]?.singleOrNull() ?: continue
    if (entry.name != file.fileName || entry.isDirectory || entry.size <= 0) continue
    if (file.bytes > 0 && file.bytes != entry.size) continue
    val valid = try {
      val crc = CRC32()
      val bytes = archive.getInputStream(entry).use { input ->
        copyAndroidRepairEntry(input, temporary, crc, expanded)
      }
      bytes == entry.size && crc.value == entry.crc
    } catch (_: ZipException) {
      false
    } catch (_: EOFException) {
      false
    }
    if (valid) accept(file.fileName, temporary, entry.size)
  }
}

// A truncated central directory can still contain complete local entries.
internal fun recoverAndroidChapterMediaStream(
  input: InputStream,
  expected: List<AndroidChapterMediaStoredFile>,
  temporary: File,
  accept: (String, File, Long) -> Unit,
) {
  val files = expected.associateBy { it.fileName }
  val seen = mutableSetOf<String>()
  val candidates = mutableMapOf<String, Pair<File, Long>>()
  val ambiguous = mutableSetOf<String>()
  val expanded = AndroidChapterMediaRepairBudget()
  var entries = 0
  try {
    ZipInputStream(AndroidChapterMediaRepairInputStream(input).buffered()).use { archive ->
      try {
        while (true) {
          val entry = archive.nextEntry ?: break
          require(++entries <= ANDROID_CHAPTER_MEDIA_MAX_ENTRIES) { "Chapter media archive has too many entries." }
          val name = entry.name.lowercase(Locale.ROOT)
          if (!seen.add(name)) {
            ambiguous.add(name)
            candidates.remove(name)?.first?.delete()
          }
          val file = files[entry.name]?.takeUnless { entry.isDirectory || name in ambiguous }
          val bytes = copyAndroidRepairEntry(archive, temporary.takeIf { file != null }, CRC32(), expanded)
          archive.closeEntry()
          if (file != null && bytes > 0 && (file.bytes == 0L || file.bytes == bytes)) {
            val staged = File.createTempFile("chapter-media-repair-entry-", ".tmp", temporary.parentFile)
            candidates[name] = staged to bytes
            temporary.copyTo(staged, overwrite = true)
          }
        }
      } catch (_: ZipException) {
        // Only the fully read and CRC-validated prefix can be reused.
      } catch (_: EOFException) {
        // Keep completed entries when a later entry was interrupted.
      }
    }
    for (file in expected) {
      val candidate = candidates[file.fileName.lowercase(Locale.ROOT)] ?: continue
      accept(file.fileName, candidate.first, candidate.second)
    }
  } finally {
    candidates.values.forEach { it.first.delete() }
  }
}

private class AndroidChapterMediaRepairInputStream(input: InputStream) : FilterInputStream(input) {
  private var bytes = 0L

  override fun read(): Int = super.read().also { value -> if (value >= 0) consume(1) }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
    `in`.read(buffer, offset, length).also { count -> if (count > 0) consume(count) }

  private fun consume(count: Int) {
    bytes += count
    require(bytes <= MAX_REPAIR_ARCHIVE_BYTES) { "Chapter media repair archive exceeds the byte limit." }
  }
}

private fun copyAndroidRepairEntry(
  input: InputStream,
  temporary: File?,
  crc: CRC32,
  expanded: AndroidChapterMediaRepairBudget,
): Long {
  var bytes = 0L
  val output = temporary?.outputStream()
  try {
    val buffer = ByteArray(ANDROID_CHAPTER_MEDIA_COPY_BUFFER_BYTES)
    while (true) {
      val count = input.read(buffer)
      if (count < 0) break
      expanded.consume(count.toLong())
      bytes += count
      require(bytes <= ANDROID_CHAPTER_MEDIA_MAX_ENTRY_BYTES) { "Chapter media entry exceeds the byte limit." }
      crc.update(buffer, 0, count)
      output?.write(buffer, 0, count)
    }
  } finally {
    output?.close()
  }
  return bytes
}
