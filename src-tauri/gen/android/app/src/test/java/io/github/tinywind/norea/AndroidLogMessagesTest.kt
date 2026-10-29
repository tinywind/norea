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
}
