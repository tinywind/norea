package io.github.tinywind.norea

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardOpenOption
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.CyclicBarrier
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class AppLogFilesTest {
  @get:Rule val temporary = TemporaryFolder()
  private val namespace = "io.test.logs"

  private fun store(root: File, state: File = File(temporary.root, "state")) =
    AppLogFiles(namespace, state) { listOf(TestLogDestination(root, namespace)) }

  private fun files(root: File, category: String) = root.listFiles().orEmpty()
    .filter { it.isFile && it.name.startsWith("norea-$namespace-$category-") }.sortedBy { it.name }

  private fun fullRecord(marker: String): ByteArray = ByteArray(1_048_576) { ' '.code.toByte() }.also {
    (marker + "\n").toByteArray().copyInto(it)
  }

  @Test
  fun rotatesBeforeOverflowAndRetainsTenIncludingTheActiveFile() {
    val root = temporary.newFolder("logs")
    val log = store(root)
    repeat(12) { assertTrue(log.write(AppLogCategory.RUNTIME, fullRecord("record-$it")) is AppLogWriteResult.Saved) }
    val retained = files(root, "runtime")
    assertEquals(10, retained.size)
    assertTrue(retained.all { it.length() <= 1_048_576 })
    val text = retained.joinToString { it.readText() }
    assertFalse(text.contains("record-0\n"))
    assertFalse(text.contains("record-1\n"))
    assertTrue(text.contains("record-11\n"))
  }

  @Test
  fun reopeningAppendsAndKeepsCrashRetentionIndependent() {
    val root = temporary.newFolder("logs")
    store(root).write(AppLogCategory.RUNTIME, "before\n".toByteArray())
    store(root).write(AppLogCategory.RUNTIME, "after\n".toByteArray())
    assertEquals(listOf("before\nafter\n"), files(root, "runtime").map { it.readText() })
    repeat(12) { store(root).write(AppLogCategory.CRASH, "crash-$it\n".toByteArray()) }
    assertEquals(10, files(root, "crash").size)
    assertFalse(files(root, "crash").joinToString { it.readText() }.contains("crash-0\n"))
    assertEquals(1, files(root, "runtime").size)
  }

  @Test
  fun creationOrderDoesNotDependOnMutableModificationTimes() {
    val root = temporary.newFolder("logs")
    repeat(10) { store(root).write(AppLogCategory.CRASH, "crash-$it".toByteArray()) }
    files(root, "crash").forEachIndexed { index, file -> file.setLastModified((10 - index).toLong() * 1000) }
    store(root).write(AppLogCategory.CRASH, "newest".toByteArray())
    val text = files(root, "crash").joinToString { it.readText() }
    assertFalse(text.contains("crash-0"))
    assertTrue(text.contains("crash-9"))
    assertTrue(text.contains("newest"))
  }

  @Test
  fun stateDirectoryCreatedByAnotherWriterRemainsUsable() {
    val root = temporary.newFolder("logs")
    val state = object : File(temporary.root, "state") {
      override fun mkdirs(): Boolean {
        check(super.mkdirs())
        return false
      }
    }
    val result = store(root, state).write(AppLogCategory.RUNTIME, "line\n".toByteArray())
    assertTrue(result.toString(), result is AppLogWriteResult.Saved)
    assertEquals("line\n", files(root, "runtime").single().readText())
  }

  @Test
  fun concurrentStoresDoNotLoseRecordsOrReuseSequences() {
    val root = temporary.newFolder("logs")
    val pool = Executors.newFixedThreadPool(6)
    try {
      pool.invokeAll((0 until 60).map { index -> Callable {
        assertTrue(store(root).write(AppLogCategory.RUNTIME, "line-$index\n".toByteArray()) is AppLogWriteResult.Saved)
      } }).forEach { it.get() }
      val lines = files(root, "runtime").flatMap { it.readLines() }
      assertEquals(60, lines.size)
      assertEquals((0 until 60).map { "line-$it" }.toSet(), lines.toSet())
    } finally { pool.shutdownNow() }
  }

  @Test
  fun retriesTheRecordAfterPartialAppendFailureAndPrunesAcrossDestinations() {
    val first = temporary.newFolder("first")
    val second = temporary.newFolder("second")
    val primary = TestLogDestination(first, namespace)
    val fallback = TestLogDestination(second, namespace)
    val log = AppLogFiles(namespace, File(temporary.root, "state")) { listOf(primary, fallback) }
    repeat(10) { log.write(AppLogCategory.CRASH, "old-$it".toByteArray()) }
    primary.failAppend = true
    val saved = log.write(AppLogCategory.CRASH, "fallback-record".toByteArray())
    assertTrue(saved is AppLogWriteResult.Saved)
    assertEquals("fallback-record", files(second, "crash").single().readText())
    assertEquals(10, files(first, "crash").size + files(second, "crash").size)
  }

  @Test
  fun doesNotDeleteUnrelatedOrLinkedFilesAndReportsTotalFailure() {
    val root = temporary.newFolder("logs")
    val sentinel = temporary.newFile("sentinel").also { it.writeText("keep") }
    File(root, "other.log").writeText("other")
    val link = File(root, "norea-$namespace-crash-00000000000000000001-1000-${"a".repeat(32)}.log")
    Files.createSymbolicLink(link.toPath(), sentinel.toPath())
    repeat(12) { store(root).write(AppLogCategory.CRASH, "crash-$it".toByteArray()) }
    assertEquals("keep", sentinel.readText())
    assertEquals("other", File(root, "other.log").readText())
    assertTrue(Files.isSymbolicLink(link.toPath()))
    val broken = TestLogDestination(root, namespace).also { it.failAppend = true }
    val result = AppLogFiles(namespace, File(temporary.root, "broken-state")) { listOf(broken) }
      .write(AppLogCategory.CRASH, "not-saved".toByteArray())
    assertTrue(result is AppLogWriteResult.Unavailable)
  }
  @Test
  fun independentEmergencyAndPublicCoordinationStillShareCreationOrder() {
    val root = temporary.newFolder("logs")
    val shared = temporary.newFolder("sequences")
    val barrier = CyclicBarrier(2)
    val destination = TestLogDestination(root, namespace)
    val coordinated = object : AppLogDestination by destination {
      override fun create(category: AppLogCategory, sequence: Long): AppLogFile {
        barrier.await()
        return destination.create(category, sequence)
      }
    }
    val pool = Executors.newFixedThreadPool(2)
    try {
      pool.invokeAll((0..1).map { index -> Callable {
        AppLogFiles(namespace, File(temporary.root, "coordination-$index"), shared) { listOf(coordinated) }
          .write(AppLogCategory.CRASH, "report-$index".toByteArray())
      } }).forEach { assertTrue(it.get() is AppLogWriteResult.Saved) }
      val names = files(root, "crash").map { it.name }
      assertEquals(2, names.size)
      assertTrue(names.any { it.contains("-00000000000000000001-") })
      assertTrue(names.any { it.contains("-00000000000000000002-") })
    } finally { pool.shutdownNow() }
  }
}

internal class TestLogDestination(private val root: File, private val namespace: String) : AppLogDestination {
  override val key: String get() = root.absolutePath
  var failAppend = false
  override fun files(category: AppLogCategory): List<AppLogFile> = root.listFiles().orEmpty().mapNotNull { file ->
    if (!Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS)) null
    else AppLogNames.sequence(namespace, category, file.name)?.let { AppLogFile(file.path, file.name, it, file.length()) }
  }
  override fun create(category: AppLogCategory, sequence: Long): AppLogFile {
    val name = AppLogNames.create(namespace, category, sequence)
    val path = File(root, name).toPath()
    Files.newOutputStream(path, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE).close()
    return AppLogFile(path.toString(), name, sequence, 0)
  }
  override fun append(file: AppLogFile, bytes: ByteArray, flush: Boolean) {
    if (failAppend) {
      Files.write(File(file.id).toPath(), bytes.take(2).toByteArray(), StandardOpenOption.APPEND)
      throw IOException("Injected partial append failure")
    }
    Files.write(File(file.id).toPath(), bytes, StandardOpenOption.APPEND)
  }
  override fun delete(file: AppLogFile): Boolean = Files.deleteIfExists(File(file.id).toPath())
}
