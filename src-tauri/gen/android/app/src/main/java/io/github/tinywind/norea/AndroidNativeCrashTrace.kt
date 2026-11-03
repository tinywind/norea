package io.github.tinywind.norea

import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

internal data class NativeCrashFrame(val module: String?, val function: String?, val buildId: String?, val relativePc: String?)

internal sealed interface NativeCrashTraceResult {
  data class Summary(val signal: String?, val abortReason: String?, val frames: List<NativeCrashFrame>, val limitation: String?) : NativeCrashTraceResult
  data class Unavailable(val reason: String) : NativeCrashTraceResult
}

private class NativeTraceMalformed(message: String) : Exception(message)

private class NativeTraceCursor(
  private val bytes: ByteArray,
  private var position: Int,
  private val end: Int,
  private val limitations: MutableSet<String>,
) {
  val hasNext: Boolean get() = position < end
  fun varint(): Long {
    var value = 0L
    repeat(10) { index ->
      if (position >= end) throw NativeTraceMalformed("Incomplete protobuf varint")
      val byte = bytes[position++].toInt() and 0xff
      if (index == 9 && byte and 0xfe != 0) throw NativeTraceMalformed("Protobuf varint overflow")
      value = value or ((byte and 0x7f).toLong() shl (index * 7))
      if (byte and 0x80 == 0) return value
    }
    throw NativeTraceMalformed("Unterminated protobuf varint")
  }
  fun fields(read: (Int, Int) -> Unit) {
    while (hasNext) {
      val tag = varint()
      val number = tag ushr 3
      if (number !in 1..536_870_911L) throw NativeTraceMalformed("Invalid protobuf field number")
      read(number.toInt(), (tag and 7).toInt())
    }
  }
  private fun advance(length: Long): Int {
    if (length < 0 || length > end - position) throw NativeTraceMalformed("Truncated protobuf field")
    val start = position
    position += length.toInt()
    return start
  }
  fun uint(wire: Int): Long {
    if (wire != 0) throw NativeTraceMalformed("Unexpected protobuf integer encoding")
    return varint()
  }
  fun message(wire: Int): NativeTraceCursor {
    if (wire != 2) throw NativeTraceMalformed("Unexpected protobuf message encoding")
    val length = varint()
    val start = advance(length)
    return NativeTraceCursor(bytes, start, position, limitations)
  }
  fun string(wire: Int): String {
    val content = message(wire)
    val value = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT)
      .decode(ByteBuffer.wrap(bytes, content.position, content.end - content.position)).toString()
    if (value.toByteArray().size > 4_096) limitations += "Native trace text truncated"
    return AppLogPolicy.bounded(AppLogPolicy.redact(value), 4_096)
  }
  fun skip(wire: Int) {
    when (wire) {
      0 -> varint()
      1 -> advance(8)
      2 -> advance(varint())
      5 -> advance(4)
      else -> throw NativeTraceMalformed("Unsupported protobuf wire type")
    }
  }
}

private class NativeTraceDiagnostics {
  private data class NativeThread(val id: Long?, val frames: List<NativeCrashFrame>)
  val limitations = linkedSetOf<String>()
  private var signal: String? = null
  private var abortReason: String? = null
  private var crashingThread: Long? = null
  private val threads = linkedMapOf<Long, NativeThread>()

  private fun signal(cursor: NativeTraceCursor): String? {
    var number: Long? = null
    var name: String? = null
    var code: String? = null
    cursor.fields { field, wire -> when (field) {
      1 -> number = cursor.uint(wire)
      2 -> name = cursor.string(wire)
      4 -> code = cursor.string(wire)
      else -> cursor.skip(wire)
    } }
    val label = when {
      !name.isNullOrBlank() && number != null -> "$name (${number!!.toInt()})"
      !name.isNullOrBlank() -> name
      number != null && number != 0L -> "signal ${number!!.toInt()}"
      else -> null
    }
    return if (code.isNullOrBlank()) label else "${label ?: "signal unavailable"} / $code"
  }

  private fun readFrame(cursor: NativeTraceCursor): NativeCrashFrame {
    var module: String? = null
    var function: String? = null
    var buildId: String? = null
    var relativePc: String? = null
    cursor.fields { field, wire -> when (field) {
      1 -> relativePc = "0x${java.lang.Long.toHexString(cursor.uint(wire))}"
      4 -> function = cursor.string(wire).takeIf { it.isNotBlank() }
      6 -> module = cursor.string(wire).takeIf { it.isNotBlank() }
      8 -> buildId = cursor.string(wire).takeIf { it.isNotBlank() }
      else -> cursor.skip(wire)
    } }
    return NativeCrashFrame(module, function, buildId, relativePc)
  }

  private fun readThread(cursor: NativeTraceCursor): NativeThread {
    var id: Long? = null
    var count = 0
    val frames = mutableListOf<NativeCrashFrame>()
    cursor.fields { field, wire -> when (field) {
      1 -> id = cursor.uint(wire)
      4 -> {
        if (++count > 128) { cursor.skip(wire); limitations += "Native backtrace frame limit reached" }
        else {
          val frame = readFrame(cursor.message(wire))
          if (frame.module != null || frame.function != null || frame.buildId != null || frame.relativePc != null) frames += frame
        }
      }
      else -> cursor.skip(wire)
    } }
    return NativeThread(id, frames)
  }

  private fun readThreadEntry(cursor: NativeTraceCursor) {
    var key: Long? = null
    var thread: NativeThread? = null
    cursor.fields { field, wire -> when (field) {
      1 -> key = cursor.uint(wire)
      2 -> thread = readThread(cursor.message(wire))
      else -> cursor.skip(wire)
    } }
    val identity = key
    val value = thread
    if (identity != null && value != null) threads[identity] = value
  }

  fun read(cursor: NativeTraceCursor) {
    cursor.fields { field, wire -> when (field) {
      6 -> crashingThread = cursor.uint(wire)
      10 -> signal = signal(cursor.message(wire))
      14 -> abortReason = cursor.string(wire)
      16 -> if (threads.size >= 128) { cursor.skip(wire); limitations += "Native thread limit reached" }
        else readThreadEntry(cursor.message(wire))
      else -> cursor.skip(wire)
    } }
  }

  fun result(): NativeCrashTraceResult {
    val crashed = crashingThread?.let { threads[it] }
    val frames = if (crashed != null && (crashed.id == null || crashed.id == crashingThread)) crashed.frames else emptyList()
    if (signal == null && abortReason.isNullOrBlank() && frames.isEmpty()) return NativeCrashTraceResult.Unavailable(
      limitations.joinToString("; ").ifEmpty { "Native trace has no supported diagnostics" })
    if (frames.isEmpty()) limitations += if (crashingThread == null) "Crashing thread ID unavailable" else "Crashing thread backtrace unavailable"
    return NativeCrashTraceResult.Summary(signal, abortReason, frames, limitations.joinToString("; ").takeIf { it.isNotEmpty() })
  }
}

internal fun readNativeCrashTrace(input: InputStream): NativeCrashTraceResult {
  val bytes = ByteArray(APP_LOG_FILE_BYTES + 1)
  var count = 0
  val diagnostics = NativeTraceDiagnostics()
  try {
    while (count < bytes.size) {
      val read = input.read(bytes, count, bytes.size - count)
      if (read < 0) break
      if (read == 0) { diagnostics.limitations += "Native trace stream made no progress"; break }
      count += read
    }
    if (count > APP_LOG_FILE_BYTES) diagnostics.limitations += "Native trace truncated at 1 MiB"
    diagnostics.read(NativeTraceCursor(bytes, 0, minOf(count, APP_LOG_FILE_BYTES), diagnostics.limitations))
  } catch (error: Exception) {
    diagnostics.limitations += "Malformed or unavailable native trace: ${singleLineLogMessage(error.toString())}"
  }
  return diagnostics.result()
}

internal fun nativeCrashTraceText(result: NativeCrashTraceResult): String = when (result) {
  is NativeCrashTraceResult.Unavailable -> "Native tombstone unavailable: ${result.reason}\n"
  is NativeCrashTraceResult.Summary -> buildString {
    append("Native tombstone: protobuf diagnostic fields only\n")
    append("signal=${result.signal ?: "unavailable"}\nabort_reason=${result.abortReason ?: "unavailable"}\n")
    result.frames.forEachIndexed { index, frame ->
      append("#$index module=${frame.module ?: "unavailable"} function=${frame.function ?: "unavailable"} ")
      append("relative_pc=${frame.relativePc ?: "unavailable"} build_id=${frame.buildId ?: "unavailable"}\n")
    }
    if (result.limitation != null) append("Trace limitation: ${result.limitation}\n")
  }
}
