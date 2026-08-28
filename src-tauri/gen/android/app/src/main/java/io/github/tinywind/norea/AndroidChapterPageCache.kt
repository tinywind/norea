package io.github.tinywind.norea

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.URI
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicLong

internal enum class ChapterPageCachePolicy {
  PREFER_CACHE,
  RELOAD,
}

internal fun chapterPageCachePolicy(value: String?): ChapterPageCachePolicy? =
  when (value) {
    "prefer-cache" -> ChapterPageCachePolicy.PREFER_CACHE
    "reload" -> ChapterPageCachePolicy.RELOAD
    else -> null
  }

internal fun fragmentlessChapterPageUrl(url: String): String? {
  val withoutFragment = url.substringBefore('#')
  val queryStart = withoutFragment.indexOf('?')
  val normalizedUrl = if (queryStart == -1) {
    withoutFragment
  } else {
    val base = withoutFragment.substring(0, queryStart)
    val query = withoutFragment.substring(queryStart + 1)
      .split('&')
      .filterNot { parameter ->
        parameter.substringBefore('=') == RESERVED_CAPTURE_QUERY_PARAMETER
      }
      .joinToString("&")
    if (query.isEmpty()) base else "$base?$query"
  }
  val uri = runCatching { URI(normalizedUrl) }.getOrNull() ?: return null
  if (!uri.scheme.equals("http", ignoreCase = true) &&
    !uri.scheme.equals("https", ignoreCase = true)
  ) {
    return null
  }
  if (uri.host.isNullOrBlank()) return null
  return normalizedUrl
}

internal data class ChapterPageCacheKey(
  val sourceId: String,
  val url: String,
)

internal fun normalizedChapterPageCacheKey(
  key: ChapterPageCacheKey,
): ChapterPageCacheKey? {
  val sourceId = key.sourceId
  val sourceIdBytes = sourceId.toByteArray(Charsets.UTF_8)
  if (sourceId.trim().isEmpty() || sourceIdBytes.size > MAX_CACHE_SOURCE_ID_BYTES) return null
  val url = fragmentlessChapterPageUrl(key.url) ?: return null
  if (url.toByteArray(Charsets.UTF_8).size > MAX_CACHE_URL_BYTES) return null
  return ChapterPageCacheKey(sourceId, url)
}

internal data class ChapterPageCacheEntry(
  val url: String,
  val html: String,
  val isChapterPage: Boolean,
  val aliasUrls: Set<String> = setOf(url),
)

internal data class ChapterPageCacheWriteToken(
  val cacheId: String,
  val globalGeneration: Long,
  val sourceGeneration: Long,
  val keyGeneration: Long,
)

internal data class ChapterPageSnapshotMetadata(
  val url: String,
  val contentType: String,
  val byteSize: Int,
  val mainFrameFailed: Boolean,
  val mainFrameStatus: Int?,
  val challenge: Boolean,
)

internal fun isCacheableChapterPageSnapshot(
  metadata: ChapterPageSnapshotMetadata,
  maxBytes: Int,
): Boolean {
  val contentType = metadata.contentType.substringBefore(';').trim().lowercase()
  return fragmentlessChapterPageUrl(metadata.url) != null &&
    contentType in setOf("text/html", "application/xhtml+xml") &&
    metadata.byteSize in 1..maxBytes &&
    !metadata.mainFrameFailed &&
    (metadata.mainFrameStatus == null || metadata.mainFrameStatus in 200..299) &&
    !metadata.challenge
}

internal data class ChapterPageCacheFlightLease(
  val key: ChapterPageCacheKey,
  val id: Long,
)

internal class ChapterPageCacheFlights {
  private class Flight(
    var lease: ChapterPageCacheFlightLease,
    val keys: MutableSet<ChapterPageCacheKey>,
    val followers: MutableList<(ChapterPageCacheEntry?) -> Unit>,
  )

  private val flights = mutableMapOf<ChapterPageCacheKey, Flight>()
  private var nextId = 0L

  @Synchronized
  fun beginOrFollow(
    key: ChapterPageCacheKey,
    onCompleted: (ChapterPageCacheEntry?) -> Unit,
  ): ChapterPageCacheFlightLease? {
    val normalizedKey = normalizedChapterPageCacheKey(key) ?: return null
    val existing = flights[normalizedKey]
    if (existing == null) {
      return newLease(normalizedKey).also { lease ->
        flights[normalizedKey] = Flight(lease, mutableSetOf(normalizedKey), mutableListOf())
      }
    }
    existing.followers += onCompleted
    return null
  }

  @Synchronized
  fun replaceLeader(key: ChapterPageCacheKey): ChapterPageCacheFlightLease? {
    val normalizedKey = normalizedChapterPageCacheKey(key) ?: return null
    val lease = newLease(normalizedKey)
    val existing = flights[normalizedKey]
    if (existing == null) {
      flights[normalizedKey] = Flight(lease, mutableSetOf(normalizedKey), mutableListOf())
    } else {
      existing.lease = lease
    }
    return lease
  }

  @Synchronized
  fun addAlias(
    lease: ChapterPageCacheFlightLease,
    alias: ChapterPageCacheKey,
  ) {
    val normalizedAlias = normalizedChapterPageCacheKey(alias) ?: return
    val flight = flights[lease.key]?.takeIf { it.lease == lease } ?: return
    val existing = flights[normalizedAlias]
    if (existing != null && existing !== flight) {
      flight.followers += existing.followers
      existing.keys.forEach { key ->
        flight.keys += key
        flights[key] = flight
      }
    }
    flight.keys += normalizedAlias
    flights[normalizedAlias] = flight
  }

  fun complete(lease: ChapterPageCacheFlightLease, entry: ChapterPageCacheEntry?) {
    val callbacks = synchronized(this) {
      val flight = flights[lease.key]
      if (flight?.lease != lease) return
      flight.keys.forEach { key ->
        if (flights[key] === flight) flights.remove(key)
      }
      flight.followers
    }
    callbacks.forEach { callback -> callback(entry) }
  }

  fun clear() {
    val callbacks = synchronized(this) {
      flights.values.toSet().flatMap(Flight::followers).also { flights.clear() }
    }
    callbacks.forEach { callback -> callback(null) }
  }

  private fun newLease(key: ChapterPageCacheKey): ChapterPageCacheFlightLease {
    nextId += 1L
    return ChapterPageCacheFlightLease(key, nextId)
  }
}

internal class AndroidChapterPageCache(
  private val directory: File,
  private val maxEntryBytes: Int = DEFAULT_MAX_ENTRY_BYTES,
) {
  private data class CacheHeader(
    val isChapterPage: Boolean,
    val sourceId: String,
    val keyUrl: String,
    val documentUrl: String,
    val aliasUrls: Set<String>,
  )

  private val generation = AtomicLong(0)
  private val sourceGenerations = mutableMapOf<String, Long>()
  private val keyGenerations = mutableMapOf<String, Long>()

  fun advanceGeneration(): Long = generation.incrementAndGet()

  @Synchronized
  fun writeToken(key: ChapterPageCacheKey): ChapterPageCacheWriteToken? {
    val normalizedKey = normalizedChapterPageCacheKey(key) ?: return null
    val cacheId = cacheId(normalizedKey)
    return ChapterPageCacheWriteToken(
      cacheId = cacheId,
      globalGeneration = generation.get(),
      sourceGeneration = sourceGenerations[normalizedKey.sourceId] ?: 0L,
      keyGeneration = keyGenerations[cacheId] ?: 0L,
    )
  }

  @Synchronized
  fun isCurrentWriteToken(
    key: ChapterPageCacheKey,
    writeToken: ChapterPageCacheWriteToken?,
  ): Boolean {
    val normalizedKey = normalizedChapterPageCacheKey(key) ?: return false
    return isCurrent(normalizedKey, writeToken)
  }

  @Synchronized
  fun advanceKeyGenerations(keys: Collection<ChapterPageCacheKey>) {
    keys.mapNotNull(::normalizedChapterPageCacheKey).forEach { key ->
      val cacheId = cacheId(key)
      keyGenerations[cacheId] = (keyGenerations[cacheId] ?: 0L) + 1L
    }
  }

  @Synchronized
  fun advanceSourceGenerations(sourceIds: Collection<String>) {
    sourceIds.filter(::isValidSourceId)
      .forEach { sourceId ->
        sourceGenerations[sourceId] = (sourceGenerations[sourceId] ?: 0L) + 1L
      }
  }

  @Synchronized
  fun read(key: ChapterPageCacheKey): ChapterPageCacheEntry? {
    val normalizedKey = normalizedChapterPageCacheKey(key) ?: return null
    val file = fileFor(normalizedKey)
    if (!file.isFile) return null
    return runCatching {
      DataInputStream(BufferedInputStream(FileInputStream(file))).use { input ->
        val header = input.readHeader()
        val html = input.readSizedString(maxEntryBytes)
        require(header.sourceId == normalizedKey.sourceId)
        require(header.keyUrl == normalizedKey.url)
        require(input.read() == -1)
        ChapterPageCacheEntry(
          url = header.documentUrl,
          html = html,
          isChapterPage = header.isChapterPage,
          aliasUrls = header.aliasUrls,
        )
      }
    }.getOrElse {
      file.delete()
      null
    }
  }

  @Synchronized
  fun write(
    key: ChapterPageCacheKey,
    html: String,
    isChapterPage: Boolean,
    writeToken: ChapterPageCacheWriteToken?,
    documentUrl: String = key.url,
    documentWriteToken: ChapterPageCacheWriteToken? = writeToken,
  ): Boolean {
    val normalizedKey = normalizedChapterPageCacheKey(key) ?: return false
    val documentKey = normalizedChapterPageCacheKey(
      ChapterPageCacheKey(normalizedKey.sourceId, documentUrl),
    ) ?: return false
    val aliasKeys = linkedSetOf(normalizedKey, documentKey)
    val aliasUrls = aliasKeys.mapTo(linkedSetOf(), ChapterPageCacheKey::url)
    val htmlBytes = html.toByteArray(Charsets.UTF_8)
    if (htmlBytes.isEmpty() || htmlBytes.size > maxEntryBytes) return false
    if (!isCurrent(normalizedKey, writeToken)) return false
    if (!isCurrent(documentKey, documentWriteToken)) return false
    if (!directory.exists() && !directory.mkdirs()) return false

    val existingEntries = aliasKeys.mapNotNull(::read)
    if (existingEntries.any { entry -> !aliasUrls.containsAll(entry.aliasUrls) }) return false
    val sourceIdBytes = normalizedKey.sourceId.toByteArray(Charsets.UTF_8)
    val documentUrlBytes = documentKey.url.toByteArray(Charsets.UTF_8)
    val aliasUrlBytes = aliasUrls.map { url -> url.toByteArray(Charsets.UTF_8) }
    val existingIsChapterPage = existingEntries.any(ChapterPageCacheEntry::isChapterPage)
    val targets = aliasKeys.associateWith(::fileFor)
    val wrote = runCatching {
      targets.forEach { (aliasKey, target) ->
        DataOutputStream(BufferedOutputStream(FileOutputStream(target))).use { output ->
          output.writeInt(CACHE_MAGIC)
          output.writeInt(CACHE_VERSION)
          output.writeBoolean(isChapterPage || existingIsChapterPage)
          output.writeSizedBytes(sourceIdBytes)
          output.writeSizedBytes(aliasKey.url.toByteArray(Charsets.UTF_8))
          output.writeSizedBytes(documentUrlBytes)
          output.writeInt(aliasUrlBytes.size)
          for (bytes in aliasUrlBytes) {
            output.writeSizedBytes(bytes)
          }
          output.writeSizedBytes(htmlBytes)
        }
      }
      true
    }.getOrElse {
      targets.values.forEach(File::delete)
      false
    }
    if (
      !wrote ||
      (isCurrent(normalizedKey, writeToken) && isCurrent(documentKey, documentWriteToken))
    ) {
      return wrote
    }
    targets.values.forEach(File::delete)
    return false
  }

  @Synchronized
  fun invalidate(keys: Collection<ChapterPageCacheKey>): Set<ChapterPageCacheKey> {
    val targets = keys.mapNotNull(::normalizedChapterPageCacheKey).toSet()
    if (targets.isEmpty() || !directory.isDirectory) return targets
    val files = cacheFiles()
    val headers = files.associateWith(::headerFor)
    val matchingHeaders = headers.values.filterNotNull().filter { header ->
      targets.any { target ->
        target.sourceId == header.sourceId && target.url in header.aliasUrls
      }
    }
    val aliasKeys = matchingHeaders.flatMap { header ->
      header.aliasUrls.map { url -> ChapterPageCacheKey(header.sourceId, url) }
    }.toSet()
    advanceKeyGenerations(aliasKeys - targets)
    headers.forEach { (file, header) ->
      if (header == null || header in matchingHeaders) deleteOrThrow(file)
    }
    return targets + aliasKeys
  }

  @Synchronized
  fun invalidateSources(sourceIds: Collection<String>) {
    val targets = sourceIds.filter(::isValidSourceId).toSet()
    if (targets.isEmpty() || !directory.isDirectory) return
    cacheFiles().forEach { file ->
      val header = headerFor(file)
      if (header == null || header.sourceId in targets) deleteOrThrow(file)
    }
  }

  @Synchronized
  fun clear() {
    if (directory.exists() && !directory.deleteRecursively()) {
      throw IOException("Could not delete chapter page cache directory: ${directory.absolutePath}")
    }
    sourceGenerations.clear()
    keyGenerations.clear()
  }

  private fun cacheFiles(): List<File> {
    val files = directory.listFiles()
      ?: throw IOException("Could not list chapter page cache directory: ${directory.absolutePath}")
    return files.filter { file -> file.extension == CACHE_FILE_EXTENSION }
  }

  private fun headerFor(file: File): CacheHeader? =
    runCatching {
      DataInputStream(BufferedInputStream(FileInputStream(file))).use { input ->
        input.readHeader()
      }
    }.getOrNull()

  private fun DataInputStream.readHeader(): CacheHeader {
    require(readInt() == CACHE_MAGIC)
    require(readInt() == CACHE_VERSION)
    val isChapterPage = readBoolean()
    val sourceId = readSizedString(MAX_CACHE_SOURCE_ID_BYTES)
    val keyUrl = readSizedString(MAX_CACHE_URL_BYTES)
    val documentUrl = readSizedString(MAX_CACHE_URL_BYTES)
    val aliasCount = readInt()
    require(aliasCount in 1..MAX_CACHE_ALIAS_URLS)
    val aliasUrls = linkedSetOf<String>()
    repeat(aliasCount) {
      aliasUrls += readSizedString(MAX_CACHE_URL_BYTES)
    }
    require(isValidSourceId(sourceId))
    require(fragmentlessChapterPageUrl(keyUrl) == keyUrl)
    require(fragmentlessChapterPageUrl(documentUrl) == documentUrl)
    require(keyUrl in aliasUrls)
    require(documentUrl in aliasUrls)
    return CacheHeader(isChapterPage, sourceId, keyUrl, documentUrl, aliasUrls)
  }

  private fun deleteOrThrow(file: File) {
    if (file.exists() && !file.delete()) {
      throw IOException("Could not delete chapter page cache entry: ${file.absolutePath}")
    }
  }

  private fun fileFor(key: ChapterPageCacheKey): File {
    return File(directory, "${cacheId(key)}.$CACHE_FILE_EXTENSION")
  }

  private fun cacheId(key: ChapterPageCacheKey): String {
    val digest = MessageDigest.getInstance("SHA-256")
    digest.update(key.sourceId.toByteArray(Charsets.UTF_8))
    digest.update(0)
    digest.update(key.url.toByteArray(Charsets.UTF_8))
    return digest.digest().joinToString(separator = "") { byte ->
      "%02x".format(byte.toInt() and 0xff)
    }
  }

  private fun isCurrent(
    key: ChapterPageCacheKey,
    writeToken: ChapterPageCacheWriteToken?,
  ): Boolean {
    if (writeToken == null) return false
    val cacheId = cacheId(key)
    return writeToken.cacheId == cacheId &&
      writeToken.globalGeneration == generation.get() &&
      writeToken.sourceGeneration == (sourceGenerations[key.sourceId] ?: 0L) &&
      writeToken.keyGeneration == (keyGenerations[cacheId] ?: 0L)
  }

  private fun DataInputStream.readSizedString(maxBytes: Int): String {
    val size = readInt()
    require(size in 0..maxBytes)
    val bytes = ByteArray(size)
    readFully(bytes)
    return bytes.toString(Charsets.UTF_8)
  }

  private fun DataOutputStream.writeSizedBytes(bytes: ByteArray) {
    writeInt(bytes.size)
    write(bytes)
  }

  companion object {
    const val DEFAULT_MAX_ENTRY_BYTES = 8 * 1024 * 1024
    private const val CACHE_FILE_EXTENSION = "page"
    private const val CACHE_MAGIC = 0x4e4f5245
    private const val CACHE_VERSION = 3
    private const val MAX_CACHE_ALIAS_URLS = 2
  }
}

private fun isValidSourceId(sourceId: String): Boolean {
  val bytes = sourceId.toByteArray(Charsets.UTF_8)
  return sourceId.trim().isNotEmpty() && bytes.size <= MAX_CACHE_SOURCE_ID_BYTES
}

private const val MAX_CACHE_SOURCE_ID_BYTES = 512
private const val MAX_CACHE_URL_BYTES = 256 * 1024
private const val RESERVED_CAPTURE_QUERY_PARAMETER = "_norea_capture"
