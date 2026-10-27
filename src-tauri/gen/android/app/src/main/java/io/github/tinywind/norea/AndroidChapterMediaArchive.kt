package io.github.tinywind.norea

import java.io.DataInputStream
import java.io.EOFException
import java.io.File
import java.io.RandomAccessFile
import java.io.InputStream
import java.io.OutputStream
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipException
import java.util.zip.ZipFile
import java.util.Locale
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

internal const val ANDROID_CHAPTER_MEDIA_MAX_ENTRY_BYTES = 256L * 1024L * 1024L
internal const val ANDROID_CHAPTER_MEDIA_MAX_ENTRIES = 100_000
internal const val ANDROID_CHAPTER_MEDIA_MAX_TOTAL_BYTES = 2L * 1024L * 1024L * 1024L
internal const val ANDROID_CHAPTER_MEDIA_COPY_BUFFER_BYTES = 64 * 1024
internal const val CHAPTER_MEDIA_ARCHIVE_BACKUP_FILE = "media.zip.bak"
internal const val CHAPTER_MEDIA_ARCHIVE_FILE = "media.zip"
internal const val CHAPTER_MEDIA_ARCHIVE_ROLLBACK_FILE = "media.zip.rollback"
internal const val CHAPTER_MEDIA_ARCHIVE_TEMP_FILE = "media.zip.tmp.zip"
internal const val CHAPTER_MEDIA_MANIFEST_BACKUP_FILE = "manifest.json.bak"
internal const val CHAPTER_MEDIA_MANIFEST_FILE = "manifest.json"
internal const val CHAPTER_MEDIA_MANIFEST_TEMP_FILE = "manifest.json.tmp"

internal fun androidChapterMediaArchiveStagingFileName(
  recoverySourceFileName: String?,
  hasBackup: Boolean,
  hasRollback: Boolean,
): String {
  require(
    recoverySourceFileName == null ||
      recoverySourceFileName == CHAPTER_MEDIA_ARCHIVE_FILE ||
      recoverySourceFileName == CHAPTER_MEDIA_ARCHIVE_BACKUP_FILE ||
      recoverySourceFileName == CHAPTER_MEDIA_ARCHIVE_ROLLBACK_FILE,
  ) {
    "Android chapter media archive recovery source is invalid."
  }
  return when {
    recoverySourceFileName == CHAPTER_MEDIA_ARCHIVE_BACKUP_FILE ->
      CHAPTER_MEDIA_ARCHIVE_ROLLBACK_FILE
    recoverySourceFileName == CHAPTER_MEDIA_ARCHIVE_ROLLBACK_FILE ->
      CHAPTER_MEDIA_ARCHIVE_BACKUP_FILE
    !hasRollback -> CHAPTER_MEDIA_ARCHIVE_ROLLBACK_FILE
    !hasBackup -> CHAPTER_MEDIA_ARCHIVE_BACKUP_FILE
    else -> CHAPTER_MEDIA_ARCHIVE_ROLLBACK_FILE
  }
}

internal data class AndroidChapterMediaManifestFile(
  val bytes: Long,
  val fileName: String,
  val path: String,
  val status: String,
)

internal data class AndroidChapterMediaStoredFile(
  val fileName: String,
  val bytes: Long,
)

internal data class AndroidChapterMediaLooseFile(
  val fileName: String,
  val bytes: Long,
  val isRegularFile: Boolean = true,
)

private fun isSafeAndroidChapterMediaFileName(fileName: String): Boolean =
  fileName.isNotEmpty() &&
    fileName == fileName.trim() &&
    fileName != "." &&
    fileName != ".." &&
    !fileName.contains('/') &&
    !fileName.contains('\\') &&
    !fileName.contains('\u0000') &&
    fileName.all { character ->
      character.isLetterOrDigit() ||
        character == '.' ||
        character == '_' ||
        character == '-'
    }

private fun requireAndroidChapterMediaStoredFiles(
  storedFiles: List<AndroidChapterMediaStoredFile>,
) {
  require(storedFiles.size <= ANDROID_CHAPTER_MEDIA_MAX_ENTRIES) {
    "Chapter media manifest has too many stored files."
  }
  val fileNames = mutableSetOf<String>()
  var totalBytes = 0L
  storedFiles.forEach { file ->
    require(isSafeAndroidChapterMediaFileName(file.fileName)) {
      "Chapter media manifest contains an unsafe stored file name."
    }
    require(fileNames.add(file.fileName)) {
      "Chapter media manifest contains a duplicate stored file name."
    }
    require(file.bytes in 0L..ANDROID_CHAPTER_MEDIA_MAX_ENTRY_BYTES) {
      "Chapter media manifest stored file size is invalid."
    }
    totalBytes = Math.addExact(totalBytes, file.bytes)
    require(totalBytes <= ANDROID_CHAPTER_MEDIA_MAX_TOTAL_BYTES) {
      "Chapter media manifest stored files exceed the total byte limit."
    }
  }
}

internal fun androidChapterMediaStoredFiles(
  manifestFiles: List<AndroidChapterMediaManifestFile>,
): List<AndroidChapterMediaStoredFile> {
  require(manifestFiles.size <= ANDROID_CHAPTER_MEDIA_MAX_ENTRIES) {
    "Chapter media manifest has too many files."
  }
  val storedFiles = manifestFiles.mapNotNull { file ->
    require(file.status == "remote" || file.status == "stored") {
      "Chapter media manifest contains an invalid file status."
    }
    if (file.status == "remote") return@mapNotNull null
    require(isSafeAndroidChapterMediaFileName(file.fileName)) {
      "Chapter media manifest contains an unsafe stored file name."
    }
    require(file.path == "media/${file.fileName}") {
      "Chapter media manifest stored path does not match its file name."
    }
    AndroidChapterMediaStoredFile(file.fileName, file.bytes)
  }.sortedBy(AndroidChapterMediaStoredFile::fileName)
  requireAndroidChapterMediaStoredFiles(storedFiles)
  return storedFiles
}

internal data class AndroidChapterMediaDeclaredFile(val fileName: String, val path: String)

private fun isSafeAndroidChapterMediaArchivePath(path: String): Boolean {
  if (path.isEmpty() || path.any { it == '\\' || it == ':' || it == '\u0000' }) return false
  return path.split('/').all { part ->
    val device = part.substringBefore('.').uppercase(Locale.ROOT)
    part.isNotEmpty() && part != "." && part != ".." && !part.endsWith('.') && !part.endsWith(' ') &&
      part.none { it.isISOControl() || it in "<>\"|?*" } &&
      device !in setOf("CON", "PRN", "AUX", "NUL") &&
      !(device.length == 4 && (device.startsWith("COM") || device.startsWith("LPT")) && device[3] in '1'..'9')
  }
}

internal fun androidChapterMediaDeclaredFileNames(
  manifestFiles: List<AndroidChapterMediaDeclaredFile>,
): Set<String> {
  require(manifestFiles.size <= ANDROID_CHAPTER_MEDIA_MAX_ENTRIES) {
    "Chapter media manifest has too many files."
  }
  val names = linkedSetOf<String>()
  val foldedNames = mutableSetOf<String>()
  for (file in manifestFiles) {
    require(isSafeAndroidChapterMediaFileName(file.fileName) &&
      file.fileName.all { it.code < 128 } && isSafeAndroidChapterMediaArchivePath(file.fileName)) {
      "Chapter media manifest contains an unsafe file name."
    }
    require(file.path.isEmpty() || file.path == "media/${file.fileName}") {
      "Chapter media manifest path does not match its file name."
    }
    require(foldedNames.add(file.fileName.lowercase(Locale.ROOT))) {
      "Chapter media manifest contains a duplicate file name."
    }
    names.add(file.fileName)
  }
  return names
}

private fun validateAndroidChapterMediaArchiveEntryKinds(file: File, archive: ZipFile) {
  require(file.length() in 22L..(512L * 1024L * 1024L)) {
    "Chapter media archive size is invalid."
  }
  fun unsignedShort(bytes: ByteArray, offset: Int): Int =
    (bytes[offset].toInt() and 255) or ((bytes[offset + 1].toInt() and 255) shl 8)
  fun unsignedInt(bytes: ByteArray, offset: Int): Long =
    unsignedShort(bytes, offset).toLong() or (unsignedShort(bytes, offset + 2).toLong() shl 16)

  RandomAccessFile(file, "r").use { input ->
    val tail = ByteArray(minOf(input.length(), 65_557L).toInt())
    input.seek(input.length() - tail.size)
    input.readFully(tail)
    val end = (tail.size - 22 downTo 0).firstOrNull { offset ->
      unsignedInt(tail, offset) == 0x06054b50L &&
        offset + 22 + unsignedShort(tail, offset + 20) == tail.size
    } ?: throw IllegalArgumentException("Chapter media archive has no valid end record.")
    val entryCount = unsignedShort(tail, end + 10)
    require(unsignedShort(tail, end + 4) == 0 && unsignedShort(tail, end + 6) == 0 &&
      unsignedShort(tail, end + 8) == entryCount && entryCount != 0xffff &&
      entryCount == archive.size()) {
      "Chapter media archive has unsupported directory metadata."
    }
    val directorySize = unsignedInt(tail, end + 12)
    val directoryOffset = unsignedInt(tail, end + 16)
    val directoryEnd = directoryOffset + directorySize
    require(directoryEnd == input.length() - tail.size + end) {
      "Chapter media archive directory is invalid."
    }
    input.seek(directoryOffset)
    val entries = archive.entries()
    repeat(entryCount) {
      require(input.filePointer + 46 <= directoryEnd) {
        "Chapter media archive directory entry is truncated."
      }
      val header = ByteArray(46)
      input.readFully(header)
      require(unsignedInt(header, 0) == 0x02014b50L && unsignedShort(header, 34) == 0 &&
        unsignedShort(header, 8) and 1 == 0 && unsignedInt(header, 42) < directoryOffset) {
        "Chapter media archive entry metadata is invalid."
      }
      val attributes = unsignedInt(header, 38)
      val mode = (attributes ushr 16).toInt() and 0xf000
      val entry = entries.nextElement()
      require(if (entry.isDirectory) mode == 0 || mode == 0x4000
        else (mode == 0 || mode == 0x8000) && attributes and 0x10L == 0L) {
        "Chapter media archive contains a non-regular entry."
      }
      val next = input.filePointer + unsignedShort(header, 28) +
        unsignedShort(header, 30) + unsignedShort(header, 32)
      require(next <= directoryEnd) { "Chapter media archive entry exceeds its directory." }
      input.seek(next)
    }
    require(input.filePointer == directoryEnd) {
      "Chapter media archive directory length is invalid."
    }
  }
}

internal fun validateAndroidChapterMediaInventory(
  declaredNames: Set<String>,
  archive: ZipFile,
  archiveFile: File,
) {
  require(archive.size() <= ANDROID_CHAPTER_MEDIA_MAX_ENTRIES) {
    "Chapter media archive has too many files."
  }
  validateAndroidChapterMediaArchiveEntryKinds(archiveFile, archive)
  val names = mutableSetOf<String>()
  val foldedNames = mutableSetOf<String>()
  var totalBytes = 0L
  for (entry in archive.entries()) {
    val name = entry.name
    require(isSafeAndroidChapterMediaArchivePath(if (entry.isDirectory) name.removeSuffix("/") else name)) {
      "Chapter media archive contains an unsafe entry."
    }
    require(foldedNames.add(name.lowercase(Locale.ROOT))) {
      "Chapter media archive contains a duplicate entry."
    }
    require(entry.size >= 0L) { "Chapter media archive entry size is invalid." }
    totalBytes = Math.addExact(totalBytes, entry.size)
    require(totalBytes <= ANDROID_CHAPTER_MEDIA_MAX_TOTAL_BYTES) {
      "Chapter media archive exceeds the total byte limit."
    }
    if (!entry.isDirectory) {
      archive.getInputStream(entry).use { }
      names.add(name)
    }
  }
  require(names.containsAll(declaredNames)) {
    "Chapter media archive is missing a declared manifest entry."
  }
}

internal fun validateAndroidChapterMediaLooseFiles(
  storedFiles: List<AndroidChapterMediaStoredFile>,
  looseFiles: List<AndroidChapterMediaLooseFile>,
  requireAllStoredFiles: Boolean,
) {
  requireAndroidChapterMediaStoredFiles(storedFiles)
  val expectedByName = storedFiles.associateBy(AndroidChapterMediaStoredFile::fileName)
  val looseNames = mutableSetOf<String>()
  looseFiles.forEach { loose ->
    require(loose.isRegularFile && isSafeAndroidChapterMediaFileName(loose.fileName)) {
      "Chapter media staging directory contains an unsupported entry."
    }
    require(!loose.fileName.endsWith(".part")) {
      "Chapter media staging directory contains a partial file."
    }
    require(looseNames.add(loose.fileName)) {
      "Chapter media staging directory contains a duplicate file name."
    }
    val expected = expectedByName[loose.fileName]
      ?: throw IllegalArgumentException(
        "Chapter media staging directory contains an unexpected file.",
      )
    require(loose.bytes == expected.bytes) {
      "Chapter media staged file size does not match its manifest entry."
    }
  }
  if (requireAllStoredFiles) {
    require(looseNames == expectedByName.keys) {
      "Chapter media staging directory is missing a stored manifest file."
    }
  }
}

private fun copyAndroidChapterMediaFile(
  input: InputStream,
  output: OutputStream,
  expectedBytes: Long,
) {
  val buffer = ByteArray(ANDROID_CHAPTER_MEDIA_COPY_BUFFER_BYTES)
  var copied = 0L
  while (true) {
    val read = input.read(buffer)
    if (read < 0) break
    copied = Math.addExact(copied, read.toLong())
    require(copied <= expectedBytes) {
      "Chapter media file is larger than its manifest entry."
    }
    output.write(buffer, 0, read)
  }
  require(copied == expectedBytes) {
    "Chapter media file is smaller than its manifest entry."
  }
}

internal fun writeAndroidChapterMediaArchive(
  storedFiles: List<AndroidChapterMediaStoredFile>,
  output: OutputStream,
  openFile: (String) -> InputStream?,
) {
  mergeAndroidChapterMediaArchive(
    storedFiles = storedFiles,
    looseFileNames = storedFiles.mapTo(mutableSetOf()) { it.fileName },
    existingArchive = null,
    output = output,
    openLooseFile = openFile,
  )
}

private fun consumeAndroidChapterMediaArchiveEntry(
  zip: ZipInputStream,
  entry: ZipEntry,
  expectedBytes: Long?,
  output: OutputStream?,
): Long {
  require(entry.size < 0L || entry.size <= ANDROID_CHAPTER_MEDIA_MAX_ENTRY_BYTES) {
    "Chapter media archive entry exceeds the byte limit."
  }
  if (expectedBytes != null) {
    require(entry.size < 0L || entry.size == expectedBytes) {
      "Chapter media archive entry size does not match its manifest entry."
    }
  }
  val crc = CRC32()
  val buffer = ByteArray(ANDROID_CHAPTER_MEDIA_COPY_BUFFER_BYTES)
  var bytes = 0L
  while (true) {
    val read = zip.read(buffer)
    if (read < 0) break
    bytes = Math.addExact(bytes, read.toLong())
    require(bytes <= (expectedBytes ?: ANDROID_CHAPTER_MEDIA_MAX_ENTRY_BYTES)) {
      "Chapter media archive entry exceeds its byte limit."
    }
    crc.update(buffer, 0, read)
    output?.write(buffer, 0, read)
  }
  if (expectedBytes != null) {
    require(bytes == expectedBytes) {
      "Chapter media archive entry size does not match its manifest entry."
    }
  }
  require(entry.crc < 0L || entry.crc == crc.value) {
    "Chapter media archive entry CRC is invalid."
  }
  return bytes
}

internal fun mergeAndroidChapterMediaArchive(
  storedFiles: List<AndroidChapterMediaStoredFile>,
  looseFileNames: Set<String>,
  existingArchive: InputStream?,
  output: OutputStream,
  openLooseFile: (String) -> InputStream?,
) {
  requireAndroidChapterMediaStoredFiles(storedFiles)
  val expectedByName = storedFiles.associateBy(AndroidChapterMediaStoredFile::fileName)
  require(looseFileNames.all(expectedByName::containsKey)) {
    "Chapter media staging set contains an unexpected file."
  }
  ZipOutputStream(output.buffered()).use { zip ->
    val sourcedNames = mutableSetOf<String>()
    existingArchive?.use { input ->
      ZipInputStream(input.buffered()).use { previousZip ->
        val previousNames = mutableSetOf<String>()
        var previousBytes = 0L
        var entry = previousZip.nextEntry
        while (entry != null) {
          require(!entry.isDirectory) {
            "Chapter media archive contains a directory entry."
          }
          val entryName = entry.name
          require(isSafeAndroidChapterMediaFileName(entryName)) {
            "Chapter media archive contains an unsafe entry name."
          }
          require(previousNames.add(entryName)) {
            "Chapter media archive contains a duplicate entry."
          }
          val expected = expectedByName[entryName]
            ?: throw IllegalArgumentException(
              "Chapter media archive contains an unexpected entry.",
            )
          val useLooseFile = entryName in looseFileNames
          if (!useLooseFile) {
            require(sourcedNames.add(entryName)) {
              "Chapter media archive contains a duplicate stored entry."
            }
            zip.putNextEntry(ZipEntry(entryName))
          }
          val copied = consumeAndroidChapterMediaArchiveEntry(
            previousZip,
            entry,
            expectedBytes = if (useLooseFile) null else expected.bytes,
            output = if (useLooseFile) null else zip,
          )
          previousBytes = Math.addExact(previousBytes, copied)
          require(previousBytes <= ANDROID_CHAPTER_MEDIA_MAX_TOTAL_BYTES) {
            "Chapter media archive exceeds the total byte limit."
          }
          previousZip.closeEntry()
          if (!useLooseFile) zip.closeEntry()
          entry = previousZip.nextEntry
        }
      }
    }

    storedFiles.filter { it.fileName in looseFileNames }.forEach { file ->
      require(sourcedNames.add(file.fileName)) {
        "Chapter media archive contains a duplicate stored entry."
      }
      zip.putNextEntry(ZipEntry(file.fileName))
      val input = openLooseFile(file.fileName)
        ?: throw IllegalStateException("Cannot open staged chapter media file.")
      input.use { source ->
        copyAndroidChapterMediaFile(source, zip, file.bytes)
      }
      zip.closeEntry()
    }
    require(sourcedNames == expectedByName.keys) {
      "Chapter media sources are missing a stored manifest entry."
    }
  }
}

internal fun validateAndroidChapterMediaArchive(
  storedFiles: List<AndroidChapterMediaStoredFile>,
  input: InputStream,
) {
  requireAndroidChapterMediaStoredFiles(storedFiles)
  if (storedFiles.isEmpty()) {
    DataInputStream(input.buffered()).use { stream ->
      val end = ByteArray(22)
      stream.readFully(end)
      require(
        end[0] == 0x50.toByte() && end[1] == 0x4b.toByte() &&
          end[2] == 0x05.toByte() && end[3] == 0x06.toByte() &&
          (4 until 20).all { end[it] == 0.toByte() },
      ) {
        "Empty chapter media archive has an invalid end record."
      }
      val commentLength = (end[20].toInt() and 255) or ((end[21].toInt() and 255) shl 8)
      stream.readFully(ByteArray(commentLength))
      require(stream.read() == -1) { "Empty chapter media archive contains trailing data." }
    }
    return
  }
  val expectedByName = storedFiles.associateBy(AndroidChapterMediaStoredFile::fileName)
  val seenNames = mutableSetOf<String>()
  var totalBytes = 0L
  ZipInputStream(input.buffered()).use { zip ->
    var entry = zip.nextEntry
    while (entry != null) {
      require(!entry.isDirectory) {
        "Chapter media archive contains a directory entry."
      }
      val entryName = entry.name
      require(isSafeAndroidChapterMediaFileName(entryName)) {
        "Chapter media archive contains an unsafe entry name."
      }
      require(seenNames.add(entryName)) {
        "Chapter media archive contains a duplicate entry."
      }
      val expected = expectedByName[entryName]
        ?: throw IllegalArgumentException("Chapter media archive contains an unexpected entry.")
      val copied = consumeAndroidChapterMediaArchiveEntry(
        zip,
        entry,
        expectedBytes = expected.bytes,
        output = null,
      )
      totalBytes = Math.addExact(totalBytes, copied)
      require(totalBytes <= ANDROID_CHAPTER_MEDIA_MAX_TOTAL_BYTES) {
        "Chapter media archive exceeds the total byte limit."
      }
      zip.closeEntry()
      entry = zip.nextEntry
    }
  }
  require(seenNames == expectedByName.keys) {
    "Chapter media archive is missing a stored manifest entry."
  }
}

internal fun readAndroidChapterMediaArchiveEntrySizes(
  input: InputStream,
  requestedFileNames: Set<String>,
): Map<String, Long> {
  require(requestedFileNames.size <= ANDROID_CHAPTER_MEDIA_MAX_ENTRIES) {
    "Chapter media archive size request has too many files."
  }
  requestedFileNames.forEach { fileName ->
    require(isSafeAndroidChapterMediaFileName(fileName)) {
      "Chapter media archive size request contains an unsafe file name."
    }
  }

  val sizes = linkedMapOf<String, Long>()
  val seenNames = mutableSetOf<String>()
  var totalBytes = 0L
  ZipInputStream(input.buffered()).use { zip ->
    var entry = zip.nextEntry
    while (entry != null) {
      require(!entry.isDirectory) {
        "Chapter media archive contains a directory entry."
      }
      val entryName = entry.name
      require(isSafeAndroidChapterMediaFileName(entryName)) {
        "Chapter media archive contains an unsafe entry name."
      }
      require(seenNames.add(entryName)) {
        "Chapter media archive contains a duplicate entry."
      }
      val copied = consumeAndroidChapterMediaArchiveEntry(
        zip,
        entry,
        expectedBytes = null,
        output = null,
      )
      totalBytes = Math.addExact(totalBytes, copied)
      require(totalBytes <= ANDROID_CHAPTER_MEDIA_MAX_TOTAL_BYTES) {
        "Chapter media archive exceeds the total byte limit."
      }
      if (entryName in requestedFileNames) sizes[entryName] = copied
      zip.closeEntry()
      entry = zip.nextEntry
    }
  }
  return sizes
}
