package io.github.tinywind.norea

import java.io.InputStream
import java.io.OutputStream
import java.net.URI
import java.security.MessageDigest

private const val MAX_SAFE_WORKER_GENERATION = 9_007_199_254_740_991L
internal const val MAX_VPN_DOWNLOAD_WORKERS = 10

internal fun androidVpnWorkerCapabilities(apiLevel: Int, multiProfile: Boolean, proxyOverride: Boolean): Map<String, Any> {
  val supported = apiLevel >= 28 && multiProfile && proxyOverride
  return mapOf("supported" to supported, "parallelSupported" to supported, "maxWorkers" to if (supported) MAX_VPN_DOWNLOAD_WORKERS else 0)
}

internal data class AndroidVpnWorkerQueue(val slot: Int, val generation: Long)

internal fun androidVpnWorkerCloseAlreadySettled(generation: Long, currentGeneration: Long?): Boolean =
  currentGeneration == null || generation < currentGeneration

internal data class AndroidVpnWorkerConfiguration(
  val slot: Int,
  val generation: Long,
  val sourceId: String,
  val profileId: String,
  val proxyPort: Int,
)

internal fun androidVpnWorkerBrowserHiddenDetail(configuration: AndroidVpnWorkerConfiguration): Map<String, String> =
  mapOf("queue" to "vpn:${configuration.slot}:${configuration.generation}", "sourceId" to configuration.sourceId)

private fun workerInteger(value: Any?): Long = when (value) {
  is Byte -> value.toLong()
  is Short -> value.toLong()
  is Int -> value.toLong()
  is Long -> value
  else -> throw IllegalArgumentException("VPN worker integer is invalid.")
}

internal fun parseAndroidVpnWorkerQueue(value: String): AndroidVpnWorkerQueue {
  val match = Regex("vpn:([0-9]):([1-9][0-9]{0,15})").matchEntire(value)
    ?: throw IllegalArgumentException("VPN worker queue is invalid.")
  val generation = match.groupValues[2].toLong()
  require(generation <= MAX_SAFE_WORKER_GENERATION) { "VPN worker generation is invalid." }
  return AndroidVpnWorkerQueue(match.groupValues[1].toInt(), generation)
}

internal fun androidVpnWorkerConfiguration(
  slot: Any?,
  generation: Any?,
  sourceId: String,
  profileId: String,
  proxyPort: Any?,
): AndroidVpnWorkerConfiguration {
  val slotNumber = workerInteger(slot)
  val generationNumber = workerInteger(generation)
  val portNumber = workerInteger(proxyPort)
  require(slotNumber >= 0L && slotNumber < MAX_VPN_DOWNLOAD_WORKERS) { "VPN worker slot is invalid." }
  require(generationNumber in 1L..MAX_SAFE_WORKER_GENERATION) { "VPN worker generation is invalid." }
  require(portNumber in 1L..65_535L) { "VPN worker proxy port is invalid." }
  for (identity in listOf(sourceId, profileId)) {
    require(identity.isNotBlank() && identity.toByteArray(Charsets.UTF_8).size <= 512) {
      "VPN worker source and profile identities must contain 1 to 512 UTF-8 bytes."
    }
  }
  return AndroidVpnWorkerConfiguration(slotNumber.toInt(), generationNumber, sourceId, profileId, portNumber.toInt())
}

internal fun androidScraperProfileName(sourceId: String, namespace: String? = null): String {
  val identity = if (namespace == null) sourceId else "${namespace.length}:$namespace${sourceId.length}:$sourceId"
  val digest = MessageDigest.getInstance("SHA-256").digest(identity.toByteArray(Charsets.UTF_8))
  val hex = digest.joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
  return if (namespace == null) "norea-source-$hex" else "norea-vpn-source-$hex"
}

internal fun androidVpnWorkerAppOrigin(raw: Any?): String {
  require(raw is String && raw.length in 1..4096) { "VPN worker app origin is missing." }
  val uri = runCatching { URI(raw) }.getOrNull()
  require(uri != null && uri.scheme?.lowercase() in setOf("http", "https") &&
    !uri.host.isNullOrBlank() && uri.rawUserInfo == null && uri.port in -1..65_535) {
    "VPN worker app origin is invalid."
  }
  return URI(uri.scheme.lowercase(), null, uri.host.lowercase(), uri.port, null, null, null).toASCIIString()
}

internal fun androidVpnWorkerCapability(method: String): String = when (method) {
  "extract" -> BridgeCapabilities.SCRAPER_EXTRACT
  "fetch" -> BridgeCapabilities.SCRAPER_FETCH
  "navigate" -> BridgeCapabilities.SCRAPER_NAVIGATE
  "clearCookies" -> BridgeCapabilities.SCRAPER_CLEAR_COOKIES
  "currentUrl" -> BridgeCapabilities.SCRAPER_CURRENT_URL
  "currentOrigin" -> BridgeCapabilities.SCRAPER_CURRENT_ORIGIN
  "cancel", "cancelBackground" -> BridgeCapabilities.SCRAPER_CANCEL
  else -> throw IllegalArgumentException("VPN worker command is unsupported.")
}

internal fun androidVpnWorkerRequiresReady(method: String): Boolean =
  method !in setOf("closeWorker", "cancel", "cancelBackground")

internal fun androidVpnWorkerMayExecute(
  method: String,
  executionActive: Boolean,
  manualOpen: Boolean,
  manualVisible: Boolean = manualOpen,
): Boolean = when (method) {
  "extract", "fetch" -> executionActive && !manualOpen
  "navigate", "clearCookies" -> executionActive || (manualOpen && manualVisible)
  "currentUrl", "currentOrigin", "cancel", "cancelBackground" -> true
  else -> false
}

internal class AndroidVpnWorkerLease(private val slot: Int) {
  var configuration: AndroidVpnWorkerConfiguration? = null
    private set
  private var lastGeneration = 0L
  private var ready = false
  private var manualToken: String? = null
  private var manualOwner: Any? = null
  val manualOpen: Boolean get() = manualToken != null

  fun beginConfigure(next: AndroidVpnWorkerConfiguration) {
    require(next.slot == slot && next.generation > lastGeneration) { "VPN worker generation is stale." }
    check(!manualOpen) { "VPN worker manual browser must close before replacing its IP." }
    lastGeneration = next.generation
    configuration = next
    ready = false
  }

  fun markReady(generation: Long) {
    check(configuration?.generation == generation) { "VPN worker configuration is stale." }
    ready = true
  }

  fun requireRequest(queue: AndroidVpnWorkerQueue, sourceId: String): AndroidVpnWorkerConfiguration {
    check(ready) { "VPN worker is not configured or has disconnected." }
    return requireConfiguration(queue, sourceId)
  }

  fun requireConfiguration(queue: AndroidVpnWorkerQueue, sourceId: String): AndroidVpnWorkerConfiguration {
    val current = checkNotNull(configuration) { "VPN worker is not configured or has disconnected." }
    require(queue.slot == slot && queue.generation == current.generation) { "VPN worker generation is stale." }
    require(sourceId == current.sourceId) { "VPN worker source does not match its configuration." }
    return current
  }

  fun reserveManual(queue: AndroidVpnWorkerQueue, sourceId: String, token: String) {
    requireRequest(queue, sourceId)
    check(!manualOpen) { "VPN worker manual browser is already open." }
    manualToken = token
  }

  fun attachManual(generation: Long, token: String, owner: Any): Boolean {
    if (!ready || configuration?.generation != generation || token != manualToken || manualOwner != null) return false
    manualOwner = owner
    return true
  }

  fun detachManual(generation: Long, owner: Any): Boolean {
    if (configuration?.generation != generation || manualOwner !== owner) return false
    manualOwner = null
    manualToken = null
    return true
  }

  fun cancelManualReservation(generation: Long, token: String): Boolean {
    if (configuration?.generation != generation || manualToken != token || manualOwner != null) return false
    manualToken = null
    return true
  }

  fun close() {
    ready = false
    configuration = null
    manualToken = null
    manualOwner = null
  }

  fun died() = close()
}

internal class AndroidVpnWorkerManualState(private var generation: Long) {
  private var revision = 0L
  var open = false
    private set

  fun expectOpen() { open = true }

  fun beginGeneration(next: Long) {
    generation = next
    revision = 0
    open = false
  }

  fun apply(generation: Long, revision: Long, open: Boolean): Boolean {
    if (generation != this.generation || revision < this.revision) return false
    this.revision = revision
    this.open = open
    return true
  }
}

internal enum class AndroidVpnWorkerBootstrapDecision { READY, WAIT, REJECT }

internal class AndroidVpnWorkerExecutionBootstrap {
  private var firstWaitAt: Long? = null
  private var used = false
  private var revoked = false

  fun decision(
    nowMs: Long,
    anchorActive: Boolean,
    foreground: Boolean,
    suspended: Boolean,
    manualOpen: Boolean,
  ): AndroidVpnWorkerBootstrapDecision {
    if (suspended || manualOpen) return AndroidVpnWorkerBootstrapDecision.REJECT
    if (anchorActive) {
      used = true
      return AndroidVpnWorkerBootstrapDecision.READY
    }
    if (used || revoked || !foreground) return AndroidVpnWorkerBootstrapDecision.REJECT
    val started = firstWaitAt ?: nowMs.also { firstWaitAt = it }
    return if (nowMs - started < 2_000L) AndroidVpnWorkerBootstrapDecision.WAIT else AndroidVpnWorkerBootstrapDecision.REJECT
  }

  fun revoke() { revoked = true }
}

internal fun copyAndroidVpnWorkerPayload(input: InputStream, output: OutputStream, limit: Long): Long {
  val buffer = ByteArray(16 * 1024)
  var total = 0L
  while (true) {
    val count = input.read(buffer)
    if (count < 0) return total
    require(count.toLong() <= limit - total) { "VPN worker payload exceeds its byte limit." }
    output.write(buffer, 0, count)
    total += count
  }
}
