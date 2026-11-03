package io.github.tinywind.norea

import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class AndroidLogDestinationsTest {
  @get:Rule val temporary = TemporaryFolder()

  @Test
  fun remembersSelectedRootsAcrossReopeningWithoutDuplicatingThem() {
    val state = temporary.newFolder("state")
    assertEquals(listOf("content://qa/tree/first"), AppLogRootHistory(state).remember("content://qa/tree/first"))
    assertEquals(listOf("content://qa/tree/first", "/selected/second"), AppLogRootHistory(state).remember("/selected/second"))
    assertEquals(listOf("content://qa/tree/first", "/selected/second"), AppLogRootHistory(state).remember("content://qa/tree/first"))
  }

  @Test
  fun linkedHistoryCannotModifyAnUnrelatedFile() {
    val state = temporary.newFolder("state")
    val sentinel = temporary.newFile("sentinel").apply { writeText("keep") }
    Files.createSymbolicLink(File(state, "roots.state").toPath(), sentinel.toPath())
    assertThrows(IllegalStateException::class.java) { AppLogRootHistory(state).remember("/selected") }
    assertEquals("keep", sentinel.readText())
  }

  @Test
  fun historicalRootsParticipateInRetentionButCannotBecomeWriteFallbacks() {
    val oldRoot = temporary.newFolder("old")
    val old = TestLogDestination(oldRoot, "io.test.logs")
    val readOnly = object : AppLogDestination by old { override val acceptsWrites = false }
    val result = AppLogFiles("io.test.logs", temporary.newFolder("state")) { listOf(readOnly) }
      .write(AppLogCategory.CRASH, "do-not-write".toByteArray())
    assertTrue(result is AppLogWriteResult.Unavailable)
    assertTrue(oldRoot.listFiles()!!.isEmpty())
  }
}
