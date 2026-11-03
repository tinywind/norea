package io.github.tinywind.norea

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.io.PrintWriter
import java.io.Writer

internal const val APP_LOG_FILE_BYTES = 1_048_576
internal const val APP_LOG_RECORD_BYTES = 16_384
internal const val APP_LOG_FILE_COUNT = 10

internal enum class AppLogCategory(val value: String) { RUNTIME("runtime"), CRASH("crash") }

internal enum class AppLogLevel(val value: String) {
  TRACE("trace"), DEBUG("debug"), INFO("info"), WARN("warn"), ERROR("error"), OFF("off");

  fun accepts(level: AppLogLevel): Boolean = this != OFF && level != OFF && level.ordinal >= ordinal

  companion object {
    fun parse(value: String): AppLogLevel = entries.firstOrNull { it.value == value }
      ?: throw IllegalArgumentException("Invalid log level")
  }
}

internal data class AppLogIdentity(
  val applicationId: String,
  val version: String,
  val platform: String,
  val processId: Int,
  val processName: String,
)

internal data class AppRuntimeRecord(
  val level: AppLogLevel,
  val target: String,
  val thread: String,
  val message: String,
  val utcMillis: Long,
)

internal object AppLogPolicy {
  private fun timestamp(millis: Long): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT)
    .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(millis))
  private val privateBlocks = Regex(
    "(?is)-----BEGIN [^-\\r\\n]*(?:PRIVATE KEY|OPENVPN)[^-\\r\\n]*-----.*?(?:-----END [^-\\r\\n]*-----|\\z)|" +
      "<(key|cert|tls-auth|tls-crypt|auth-user-pass)>.*?(?:</\\1>|\\z)",
  )
  private val headers = Regex("(?im)\\b(authorization|proxy-authorization|set-cookie|cookie)\\s*:\\s*[^\\r\\n]*")
  private val fields = Regex(
    "(?i)([\\\"']?(?:password|passwd|access[_-]?token|refresh[_-]?token|token|secret|api[_-]?key|" +
      "private[_-]?key|client[_-]?secret|credential|authorization|proxy-authorization|cookie|set-cookie)[\\\"']?\\s*[:=]\\s*)" +
      "(?:\\\"[^\\\"\\r\\n]*\\\"|'[^'\\r\\n]*'|[^\\s,;&\\r\\n]+)",
  )
  private val bearer = Regex("(?i)\\bBearer[ \\t]+[^\\s\\\"'<> ,;]+")
  private val urls = Regex("(?i)(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*://[^\\s\\\"'<>]+")
  private val userInfo = Regex("(?i)^([a-z][a-z0-9+.-]*://)[^/@]+@")

  fun redact(text: String): String {
    val input = text.take(APP_LOG_FILE_BYTES * 2)
    val blocks = privateBlocks.replace(input, "[REDACTED]")
    val safeHeaders = headers.replace(blocks) { "${it.groupValues[1]}: [REDACTED]" }
    val safeFields = fields.replace(safeHeaders) { "${it.groupValues[1]}[REDACTED]" }
    return urls.replace(bearer.replace(safeFields, "Bearer [REDACTED]")) { match ->
      val url = userInfo.replace(match.value, "$1[REDACTED]@")
      val end = listOf(url.indexOf('?'), url.indexOf('#')).filter { it >= 0 }.minOrNull()
      if (end == null) url else url.substring(0, end) + "?[REDACTED]"
    }
  }

  fun throwableDetail(error: Throwable): String {
    val text = StringBuilder()
    var truncated = false
    val writer = object : Writer() {
      override fun write(buffer: CharArray, offset: Int, length: Int) {
        val take = minOf(length, (APP_LOG_FILE_BYTES - text.length).coerceAtLeast(0))
        text.append(buffer, offset, take)
        if (take != length) truncated = true
      }
      override fun flush() {}
      override fun close() {}
    }
    error.printStackTrace(PrintWriter(writer))
    return bounded(redact(text.toString()) + if (truncated) "[truncated]" else "", APP_LOG_FILE_BYTES)
  }

  fun bounded(text: String, maxBytes: Int): String {
    if (text.toByteArray(Charsets.UTF_8).size <= maxBytes) return text
    val marker = "[truncated]"
    val limit = maxBytes - marker.length
    var end = 0
    var bytes = 0
    while (end < text.length) {
      val point = text.codePointAt(end)
      val size = when { point <= 0x7f -> 1; point <= 0x7ff -> 2; point <= 0xffff -> 3; else -> 4 }
      if (bytes + size > limit) break
      bytes += size
      end += Character.charCount(point)
    }
    return text.substring(0, end) + marker
  }

  fun runtime(identity: AppLogIdentity, record: AppRuntimeRecord): ByteArray {
    val header = "${timestamp(record.utcMillis)} ${record.level.value.uppercase()} " +
      "app=${identity.applicationId} version=${identity.version} platform=${identity.platform} " +
      "pid=${identity.processId} process=${identity.processName} thread=${record.thread} target=${record.target} "
    val line = redact(header + record.message).replace("\r", "\\r").replace("\n", "\\n")
    return (bounded(line, APP_LOG_RECORD_BYTES - 1) + "\n").toByteArray(Charsets.UTF_8)
  }

  fun crash(identity: AppLogIdentity, kind: String, message: String, detail: String): ByteArray {
    val text = "${timestamp(System.currentTimeMillis())} crash=${kind}\n" +
      "app=${identity.applicationId} version=${identity.version} platform=${identity.platform} " +
      "pid=${identity.processId} process=${identity.processName} thread=${Thread.currentThread().name}\n" +
      "${bounded(redact(message), APP_LOG_RECORD_BYTES)}\n$detail\n"
    return (bounded(redact(text), APP_LOG_FILE_BYTES - 1) + "\n").toByteArray(Charsets.UTF_8)
  }
}
