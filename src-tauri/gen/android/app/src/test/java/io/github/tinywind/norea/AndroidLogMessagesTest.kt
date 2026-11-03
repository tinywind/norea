package io.github.tinywind.norea

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidLogMessagesTest {
  @Test
  fun fileAndUriValuesCannotCreateAnotherLogLine() {
    val message = "read path=chapter\r\nE/Forged: accepted\nroot=content://books"
    val logged = singleLineLogMessage(message)

    assertEquals(1, logged.lineSequence().count())
    assertEquals("read path=chapter\\r\\nE/Forged: accepted\\nroot=content://books", logged)
  }

  @Test
  fun exceptionDetailsStayPresentWithoutUnescapedStackTraceLines() {
    val error = IllegalStateException("selected-file\nE/Forged: accepted")
    val logged = singleLineLogMessage("read failed ${error.stackTraceToString()}")

    assertFalse(logged.contains('\n'))
    assertFalse(logged.contains('\r'))
    assertTrue(logged.contains("IllegalStateException: selected-file\\nE/Forged: accepted"))
    assertTrue(logged.contains("AndroidLogMessagesTest"))
  }

  @Test
  fun ordinaryPathsAndUnicodeTextRemainUnchanged() {
    val message = "path=books/Chapter 1.epub title=Unicode\u2014text root=content://books"
    assertEquals(message, singleLineLogMessage(message))
  }

  @Test
  fun credentialsAreRemovedBeforeMessagesReachLocalFiles() {
    val message = "Authorization: Bearer synthetic-auth-secret\n" +
      "Cookie: session=synthetic-cookie-secret\n" +
      "password=synthetic-password-secret url=https://user:synthetic-url-secret@example.com/?token=synthetic-token-secret"
    val logged = singleLineLogMessage(message)

    listOf("synthetic-auth-secret", "synthetic-cookie-secret", "synthetic-password-secret",
      "synthetic-url-secret", "synthetic-token-secret").forEach {
      assertFalse("Secret remained in diagnostic output: $it", logged.contains(it))
    }
    assertTrue(logged.contains("[REDACTED]"))
  }

  @Test
  fun oversizedRuntimeMessagesStayWithinTheUtf8Budget() {
    val logged = singleLineLogMessage("\uD83D\uDE00".repeat(20_000))

    assertTrue(logged.toByteArray(Charsets.UTF_8).size <= 16_384)
    assertTrue(logged.endsWith("[truncated]"))
    assertFalse(logged.contains('\uFFFD'))
  }
}
