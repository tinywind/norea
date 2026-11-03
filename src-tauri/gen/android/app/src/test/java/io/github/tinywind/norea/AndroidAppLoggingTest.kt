package io.github.tinywind.norea

import java.io.File
import java.io.IOException
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class AndroidAppLoggingTest {
  @Test
  fun nativeLevelReadsResolveTheTrustedParentAliasLikeWritesDo() {
    val directory = temporary.newFolder("actual-levels")
    val alias = File(temporary.root, "aliased-levels")
    java.nio.file.Files.createSymbolicLink(alias.toPath(), directory.toPath())
    AppLogLevelStore(alias).write(AppLogLevel.DEBUG)
    assertEquals(AppLogLevel.DEBUG, AppLogLevelStore(alias).read())
  }

  @get:Rule val temporary = TemporaryFolder()
  private val identity = AppLogIdentity("io.test.logs", "0.2.0", "Android", 42, "main")
  private fun record(message: String) = AppRuntimeRecord(AppLogLevel.INFO, "test", "caller", message, 0)

  @Test
  fun persistedOffAppliesToNewStoresAndIndependentWriters() {
    val state = temporary.newFolder("levels")
    assertEquals(AppLogLevel.INFO, AppLogLevelStore(state).read())
    AppLogLevelStore(state).write(AppLogLevel.OFF)
    assertEquals(AppLogLevel.OFF, AppLogLevelStore(state).read())
    AppLogLevelStore(state).write(AppLogLevel.DEBUG)
    assertEquals(AppLogLevel.DEBUG, AppLogLevelStore(state).read())
  }

  @Test
  fun queuedRuntimeRecordsRecheckThePersistedLevelBeforeWriting() {
    val level = AtomicReference(AppLogLevel.INFO)
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val checkedQueued = CountDownLatch(1)
    val file = temporary.newFile("runtime")
    var checks = 0
    val runtime = AppLogRuntime(identity, level::get, {
      if (++checks == 2) checkedQueued.countDown()
      level.get()
    }) { bytes ->
      entered.countDown()
      assertTrue(release.await(10, TimeUnit.SECONDS))
      file.appendBytes(bytes)
    }
    assertTrue(runtime.enqueue(record("first-record")))
    assertTrue(entered.await(10, TimeUnit.SECONDS))
    assertTrue(runtime.enqueue(record("must-be-filtered")))
    level.set(AppLogLevel.OFF)
    release.countDown()
    assertTrue(checkedQueued.await(10, TimeUnit.SECONDS))
    assertFalse(runtime.enqueue(record("off-record")))
    assertTrue(file.readText().contains("first-record"))
    assertFalse(file.readText().contains("must-be-filtered"))
    assertFalse(file.readText().contains("off-record"))
  }

  @Test
  fun saturationIsBoundedAndTheConsumerReportsDroppedRecords() {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val drained = CountDownLatch(258)
    val written = Collections.synchronizedList(mutableListOf<String>())
    val runtime = AppLogRuntime(identity, { AppLogLevel.TRACE }, { AppLogLevel.TRACE }) { bytes ->
      entered.countDown()
      assertTrue(release.await(10, TimeUnit.SECONDS))
      written += bytes.toString(Charsets.UTF_8)
      drained.countDown()
    }
    runtime.enqueue(record("held"))
    assertTrue(entered.await(10, TimeUnit.SECONDS))
    repeat(256) { assertTrue(runtime.enqueue(record("queued-$it"))) }
    assertFalse(runtime.enqueue(record("dropped")))
    release.countDown()
    assertTrue(drained.await(10, TimeUnit.SECONDS))
    assertEquals(258, written.size)
    assertTrue(written.any { it.contains("Dropped 1 runtime log records") })
  }

  @Test
  fun stalledPublicPublicationKeepsAFlushedIndependentCrashFile() {
    val root = temporary.newFolder("staged")
    val store = AppLogFiles("io.test.logs", temporary.newFolder("stage-state")) { listOf(TestLogDestination(root, "io.test.logs")) }
    val blocked = CountDownLatch(1)
    val release = CountDownLatch(1)
    val publisher = AppCrashPublisher({ store.write(AppLogCategory.CRASH, it) }, {
      blocked.countDown()
      release.await(10, TimeUnit.SECONDS)
      AppLogWriteResult.Unavailable("Public provider is blocked")
    }, {})
    try {
      val started = System.nanoTime()
      val result = publisher.write("fatal-proof".toByteArray())
      assertTrue("Crash capture exceeded its public-publication deadline",
        TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < 2_500)
      assertTrue(blocked.await(10, TimeUnit.SECONDS))
      assertTrue(result is AppLogWriteResult.Saved)
      assertEquals("fatal-proof", File((result as AppLogWriteResult.Saved).location).readText())
      assertTrue(publisher.write("second-fatal-proof".toByteArray()) is AppLogWriteResult.Saved)
      assertEquals(2, root.listFiles()!!.size)
    } finally { release.countDown() }
  }
}
