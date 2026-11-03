package io.github.tinywind.norea

import java.io.IOException
import java.io.File
import java.nio.file.Files
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class AndroidCrashReportsTest {
  @get:Rule val temporary = TemporaryFolder()
  @Test
  fun crashFailureStillChainsTheOriginalFatalHandlerExactlyOnce() {
    val failure = IllegalStateException("original-failure")
    var chained = 0
    val previous = Thread.UncaughtExceptionHandler { thread, error ->
      assertSame(Thread.currentThread(), thread)
      assertSame(failure, error)
      chained++
    }
    AppUncaughtExceptionHandler(previous, { _, _ -> throw IOException("No writable storage") }, {})
      .uncaughtException(Thread.currentThread(), failure)
    assertEquals(1, chained)
  }

  @Test
  fun throwableDetailsKeepCausesAndSuppressedFailuresButBoundHugeStacks() {
    val failure = IllegalStateException("outer", IOException("root-cause"))
    failure.addSuppressed(IllegalArgumentException("suppressed-proof"))
    val text = AppLogPolicy.throwableDetail(failure)
    assertTrue(text.contains("root-cause"))
    assertTrue(text.contains("Suppressed: java.lang.IllegalArgumentException: suppressed-proof"))
    assertTrue(text.contains("AndroidCrashReportsTest"))
    val huge = IllegalStateException("x".repeat(2_000_000))
    assertTrue(AppLogPolicy.throwableDetail(huge).toByteArray().size <= 1_048_576)
    assertTrue(AppLogPolicy.throwableDetail(huge).contains("[truncated]"))
  }

  @Test
  fun recoveredExitIsDeduplicatedOnlyAfterTheReportIsActuallySaved() {
    val state = temporary.newFolder("exit-state")
    val logs = temporary.newFolder("reports")
    val destination = TestLogDestination(logs, "test")
    val store = AppLogFiles("test", temporary.newFolder("log-state")) { listOf(destination) }
    destination.failAppend = true
    val failed = AppExitReportHistory(state).captureIfNew("100:42:5") { store.write(AppLogCategory.CRASH, "failed".toByteArray()) }
    assertTrue(failed is AppLogWriteResult.Unavailable)
    destination.failAppend = false
    assertTrue(AppExitReportHistory(state).captureIfNew("100:42:5") {
      store.write(AppLogCategory.CRASH, "saved-exit-proof".toByteArray())
    } is AppLogWriteResult.Saved)
    assertNull(AppExitReportHistory(state).captureIfNew("100:42:5") {
      store.write(AppLogCategory.CRASH, "duplicate-exit-proof".toByteArray())
    })
    assertEquals(listOf("saved-exit-proof"), logs.listFiles()!!.map { it.readText() })
  }

  @Test
  fun independentCollectorsDoNotCreateTwoReportsForTheSameExit() {
    val state = temporary.newFolder("exit-state")
    val logs = temporary.newFolder("reports")
    val store = AppLogFiles("test", temporary.newFolder("log-state")) { listOf(TestLogDestination(logs, "test")) }
    val executor = Executors.newFixedThreadPool(2)
    try {
      executor.invokeAll((0..1).map { Callable {
        AppExitReportHistory(state).captureIfNew("100:42:5") { store.write(AppLogCategory.CRASH, "exit-proof".toByteArray()) }
      } }).forEach { it.get() }
      assertEquals(1, logs.listFiles()!!.size)
    } finally { executor.shutdownNow() }
  }

  @Test
  fun recoveryCursorDoesNotFollowALinkToUnrelatedPrivateData() {
    val state = temporary.newFolder("exit-state")
    val sentinel = temporary.newFile("sentinel").apply { writeText("keep original") }
    Files.createSymbolicLink(File(state, "exit-recovery.state").toPath(), sentinel.toPath())
    assertThrows(IllegalStateException::class.java) {
      AppExitReportHistory(state).captureIfNew("100:42:5") { throw AssertionError("Linked cursor must be refused before capture") }
    }
    assertEquals("keep original", sentinel.readText())
  }
}
