package io.github.tinywind.norea

import java.io.ByteArrayInputStream
import org.junit.Assert.*
import org.junit.Test

class AndroidNativeCrashTraceTest {
  private fun hex(value: String): ByteArray = value.trim().split(Regex("\\s+")).map { it.toInt(16).toByte() }.toByteArray()
  private val signal = "52 0b 08 06 12 07 53 49 47 41 42 52 54"
  private val thread = "82 01 28 08 2a 12 24 08 2a 12 04 6d 61 69 6e " +
    "22 1a 08 10 22 05 63 72 61 73 68 32 09 6c 69 62 61 70 70 2e 73 6f 42 04 61 62 63 64"

  @Test
  fun decodesOnlyTheCrashingThreadsDiagnosticFields() {
    val bytes = hex("30 2a $signal 72 0b 66 61 74 61 6c 2d 70 72 6f 6f 66 $thread")
    val result = readNativeCrashTrace(ByteArrayInputStream(bytes)) as NativeCrashTraceResult.Summary
    assertEquals("SIGABRT (6)", result.signal)
    assertEquals("fatal-proof", result.abortReason)
    assertEquals(listOf(NativeCrashFrame("libapp.so", "crash", "abcd", "0x10")), result.frames)
    assertNull(result.limitation)
  }

  @Test
  fun fieldOrderAndUnrelatedThreadsDoNotChangeTheCrashAttribution() {
    val bytes = hex("$signal 82 01 06 08 07 12 02 08 07 $thread 30 2a a0 06 7b")
    val result = readNativeCrashTrace(ByteArrayInputStream(bytes)) as NativeCrashTraceResult.Summary
    assertEquals(listOf(NativeCrashFrame("libapp.so", "crash", "abcd", "0x10")), result.frames)
    assertEquals("SIGABRT (6)", result.signal)
  }

  @Test
  fun rawMemoryPayloadsNeverBecomePublicDiagnosticText() {
    val memoryThread = "82 01 47 08 2a 12 43 08 2a 12 04 6d 61 69 6e " +
      "22 1a 08 10 22 05 63 72 61 73 68 32 09 6c 69 62 61 70 70 2e 73 6f 42 04 61 62 63 64 " +
      "2a 1d 0a 02 78 30 22 17 73 79 6e 74 68 65 74 69 63 2d 6d 65 6d 6f 72 79 2d 73 65 63 72 65 74"
    val result = readNativeCrashTrace(ByteArrayInputStream(hex("30 2a $signal $memoryThread"))) as NativeCrashTraceResult.Summary
    assertEquals(1, result.frames.size)
    assertEquals("crash", result.frames.single().function)
    assertFalse(result.toString().contains("synthetic-memory-secret"))
  }

  @Test
  fun missingCrashingThreadIdentityIsLabeledInsteadOfGuessing() {
    val result = readNativeCrashTrace(ByteArrayInputStream(hex("$signal $thread"))) as NativeCrashTraceResult.Summary
    assertTrue(result.frames.isEmpty())
    assertNotNull(result.limitation)
  }

  @Test
  fun malformedLengthsVarintsAndUtf8AreExplicitlyUnavailable() {
    listOf("80", "52 7f 08 06", "72 02 c3 28", "ff ff ff ff ff ff ff ff ff 7f").forEach { value ->
      val result = readNativeCrashTrace(ByteArrayInputStream(hex(value)))
      assertTrue("Malformed trace looked valid: $value -> $result", result is NativeCrashTraceResult.Unavailable)
    }
  }

  @Test
  fun oversizedInputIsBoundedButRetainsAvailableEarlierFrames() {
    val input = hex("30 2a $signal $thread b2 06 80 80 40") + ByteArray(1_048_576)
    var consumed = 0
    val stream = object : ByteArrayInputStream(input) {
      override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        val result = super.read(buffer, offset, length)
        if (result > 0) consumed += result
        return result
      }
    }
    val result = readNativeCrashTrace(stream) as NativeCrashTraceResult.Summary
    assertEquals(1, result.frames.size)
    assertEquals("crash", result.frames.single().function)
    assertNotNull(result.limitation)
    assertTrue("Consumed $consumed trace bytes", consumed <= 1_048_577)
  }
}
