package io.github.tinywind.norea

import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.ContentResolver
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.ServiceConnection
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Bundle
import android.os.FileObserver
import android.os.IBinder
import android.os.Message
import android.os.Messenger
import android.os.Process
import android.os.SystemClock
import android.provider.DocumentsContract
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.Executors
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONArray
import org.json.JSONObject

@RunWith(AndroidJUnit4::class)
class AndroidAppLoggingDeviceTest {
  private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
  private val context get() = instrumentation.targetContext

  private fun isolatedContext(): Context {
    check(context.packageName == "io.github.tinywind.norea.qalogs20261102.debug") { "Refuse non-QA application" }
    return context
  }

  private fun withRoot(value: String, block: (Context) -> Unit) {
    val app = isolatedContext()
    val config = File(app.applicationInfo.dataDir, "chapter-media-storage-root.txt")
    val previous = if (config.isFile) config.readBytes() else null
    config.writeText(value)
    try { block(app) } finally {
      if (previous == null) config.delete() else config.writeBytes(previous)
    }
  }

  private fun write(app: Context, category: AppLogCategory, message: String): AppLogWriteResult {
    val destinations = AndroidLogDestinations(app)
    return AppLogFiles(app.packageName, destinations.stateDirectory, destinations = destinations::candidates)
      .write(category, message.toByteArray())
  }

  private fun savedText(result: AppLogWriteResult): String {
    assertTrue(result.toString(), result is AppLogWriteResult.Saved)
    val location = (result as AppLogWriteResult.Saved).location
    return if (location.startsWith("content://")) context.contentResolver.openInputStream(Uri.parse(location))!!.bufferedReader().use { it.readText() }
      else File(location).readText()
  }

  private fun grant(action: String) {
    val finished = CountDownLatch(1)
    var outcome: String? = null
    isolatedContext().sendOrderedBroadcast(Intent("io.github.tinywind.norea.qalogs.$action")
      .setComponent(ComponentName(instrumentation.context.packageName, LogGrantReceiver::class.java.name)),
      null, object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) { outcome = resultData; finished.countDown() }
      }, Handler(Looper.getMainLooper()), 0, null, null)
    assertTrue("Grant receiver did not finish", finished.await(10, TimeUnit.SECONDS))
    assertEquals("ok", outcome)
  }

  @Test
  fun selectedRawRootReceivesFilesAndLinkedLogsDirectoryIsRefused() {
    val root = File(isolatedContext().filesDir, "log-test-raw").apply { mkdirs() }
    withRoot(root.path) { app ->
      val result = write(app, AppLogCategory.CRASH, "raw-destination-proof")
      assertEquals("raw-destination-proof", savedText(result))
      assertTrue((result as AppLogWriteResult.Saved).location.startsWith(File(root, "logs").path))
    }
    val linkedRoot = File(context.filesDir, "log-test-linked").apply { mkdirs() }
    val sentinel = File(context.filesDir, "log-test-sentinel").apply { mkdirs() }
    val link = File(linkedRoot, "logs")
    if (!link.exists()) android.system.Os.symlink(sentinel.path, link.path)
    withRoot(linkedRoot.path) { app ->
      val result = write(app, AppLogCategory.CRASH, "linked-root-fallback") as AppLogWriteResult.Saved
      assertEquals("linked-root-fallback", savedText(result))
      assertFalse(result.location.startsWith(linkedRoot.path))
      assertTrue(sentinel.listFiles().orEmpty().isEmpty())
    }
  }

  @Test
  fun failedPrimaryUsesRealPublicDownloadsAndProviderDenialUsesPrivateTemp() {
    val blocked = File(isolatedContext().filesDir, "log-test-blocked").apply { writeText("owned blocker") }
    withRoot(blocked.path) { app ->
      val result = write(app, AppLogCategory.CRASH, "downloads-destination-proof") as AppLogWriteResult.Saved
      assertTrue(result.toString(), result.location.startsWith("content://media/"))
      assertEquals("downloads-destination-proof", savedText(result))
      val denied = object : ContextWrapper(app) {
        override fun getContentResolver(): ContentResolver = throw SecurityException("Injected provider denial")
      }
      val temporary = write(denied, AppLogCategory.CRASH, "temporary-destination-proof") as AppLogWriteResult.Saved
      assertTrue(temporary.location, temporary.location.startsWith(app.cacheDir.canonicalPath))
      assertEquals("temporary-destination-proof", savedText(temporary))
    }
  }

  @Test
  fun persistedSafGrantIsUsedAndActualRevocationFallsBack() {
    val app = isolatedContext()
    val tree = DocumentsContract.buildTreeDocumentUri(LogDocumentsProvider.AUTHORITY, "root")
    val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
    grant("GRANT")
    app.contentResolver.takePersistableUriPermission(tree, flags)
    try {
      withRoot(tree.toString()) {
        val saf = write(it, AppLogCategory.CRASH, "saf-destination-proof") as AppLogWriteResult.Saved
        assertTrue(saf.location, saf.location.startsWith("content://${LogDocumentsProvider.AUTHORITY}/"))
        assertEquals("saf-destination-proof", savedText(saf))
        grant("REVOKE")
        val fallback = write(it, AppLogCategory.CRASH, "revoked-grant-proof") as AppLogWriteResult.Saved
        assertTrue(fallback.toString(), fallback.location.startsWith("content://media/"))
        assertEquals("revoked-grant-proof", savedText(fallback))
      }
    } finally {
      runCatching { app.contentResolver.releasePersistableUriPermission(tree, flags) }
      grant("REVOKE")
    }
  }

  @Test
  fun changedPrimaryStillPrunesThePreviouslyUsedAccessibleRoot() {
    val first = File(isolatedContext().filesDir, "log-test-history-first").apply { mkdirs() }
    val second = File(context.filesDir, "log-test-history-second").apply { mkdirs() }
    withRoot(first.path) { app -> repeat(10) { write(app, AppLogCategory.CRASH, "history-$it") } }
    withRoot(second.path) { app -> write(app, AppLogCategory.CRASH, "history-newest") }
    val files = listOf(first, second).flatMap { File(it, "logs").listFiles().orEmpty().toList() }
      .filter { it.isFile && it.name.startsWith("norea-${context.packageName}-crash-") }
    assertTrue("Unpruned accessible roots: ${files.size}", files.size <= 10)
    assertTrue(files.any { it.readText() == "history-newest" })
  }

  private fun awaitCondition(description: String, condition: () -> Boolean) {
    val deadline = SystemClock.elapsedRealtime() + 30_000
    while (!condition()) {
      check(SystemClock.elapsedRealtime() < deadline) { "Timed out: $description" }
      SystemClock.sleep(10)
    }
  }

  private fun secondary(command: Int, data: Bundle = Bundle()): Bundle {
    val connected = CountDownLatch(1)
    val completed = CountDownLatch(1)
    var peer: Messenger? = null
    var reply: Bundle? = null
    val connection = object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName, service: IBinder) { peer = Messenger(service); connected.countDown() }
      override fun onServiceDisconnected(name: ComponentName) {}
    }
    val intent = Intent().setClassName(isolatedContext().packageName, "io.github.tinywind.norea.LogTestWriterService")
    assertTrue("Secondary log producer is unavailable", context.bindService(intent, connection, Context.BIND_AUTO_CREATE))
    try {
      assertTrue(connected.await(10, TimeUnit.SECONDS))
      val receiver = Messenger(object : Handler(Looper.getMainLooper()) {
        override fun handleMessage(message: Message) { reply = message.data; completed.countDown() }
      })
      peer!!.send(Message.obtain(null, command).apply { this.data = data; replyTo = receiver })
      assertTrue("Secondary producer did not finish", completed.await(45, TimeUnit.SECONDS))
      val result = reply!!
      assertFalse(result.getString("error"), result.containsKey("error"))
      return result
    } finally { context.unbindService(connection) }
  }

  private fun owned(root: File, category: String): List<File> = File(root, "logs").listFiles().orEmpty()
    .filter { it.isFile && it.name.startsWith("norea-${context.packageName}-$category-") }

  @Test
  @Suppress("DEPRECATION") // Verify API-24-compatible FileObserver behavior on the device.
  fun readingTheNativeLevelDoesNotAnnounceAnotherLevelWrite() {
    val directory = File(isolatedContext().filesDir, "log-test-level-observer").apply { mkdirs() }
    val store = AppLogLevelStore(directory)
    store.write(AppLogLevel.OFF)
    val wrote = CountDownLatch(1)
    val observer = object : FileObserver(directory.path, CLOSE_WRITE) {
      override fun onEvent(event: Int, path: String?) { if (path == "level.state") wrote.countDown() }
    }
    observer.startWatching()
    try {
      assertEquals(AppLogLevel.OFF, store.read())
      assertFalse("Reading the mirror caused another CLOSE_WRITE", wrote.await(300, TimeUnit.MILLISECONDS))
    } finally { observer.stopWatching() }
  }

  @Test
  fun independentProcessesShareNativeLevelsAndRetainTenRuntimeAndTenCrashFiles() {
    val app = isolatedContext()
    val root = File(app.filesDir, "log-test-process-${System.nanoTime()}").apply { mkdirs() }
    val sentinel = File(root, "unrelated.log").apply { writeText("keep unrelated") }
    val previousLevel = AndroidAppLogging.currentLevel()
    withRoot(root.path) {
      try {
        AndroidAppLogging.setLevel("off")
        awaitCondition("secondary process loads off") { secondary(2).getString("level") == "off" }
        assertFalse(AndroidAppLogging.enqueueRuntime("error", "qa", "main-producer", "off-must-not-exist"))
        AndroidAppLogging.setLevel("trace")
        awaitCondition("secondary process loads trace") { secondary(2).getString("level") == "trace" }
        val executor = Executors.newSingleThreadExecutor()
        val worker = executor.submit<Bundle> { secondary(1, Bundle().apply { putString("marker", "secondary-volume"); putInt("count", 600) }) }
        try {
          repeat(600) { index ->
            val text = "main-volume-$index " + "x".repeat(12_200)
            awaitCondition("enqueue main volume") { AndroidAppLogging.enqueueRuntime("info", "qa", "main-producer", text) }
          }
          val result = worker.get(60, TimeUnit.SECONDS)
          assertNotEquals(Process.myPid(), result.getInt("pid"))
          awaitCondition("both producers drain") {
            val text = owned(root, "runtime").joinToString { it.readText() }
            text.contains("main-volume-599 ") && text.contains("secondary-volume-599 ")
          }
          val runtime = owned(root, "runtime")
          assertEquals(10, runtime.size)
          assertTrue(runtime.all { it.length() in 1..1_048_576L })
          val text = runtime.joinToString { it.readText() }
          assertFalse(text.contains("main-volume-0 "))
          assertFalse(text.contains("secondary-volume-0 "))
          assertTrue(text.contains("pid=${Process.myPid()} "))
          assertTrue(text.contains("pid=${result.getInt("pid")} "))
          assertFalse(text.contains("off-must-not-exist"))
          repeat(12) { index ->
            assertTrue(AndroidAppLogging.writeCrash("qa-report", "report-$index-proof", "independent crash retention") is AppLogWriteResult.Saved)
          }
          assertEquals(10, owned(root, "crash").size)
          assertEquals(10, owned(root, "runtime").size)
          val reports = owned(root, "crash").joinToString { it.readText() }
          assertFalse(reports.contains("report-0-proof"))
          assertTrue(reports.contains("report-11-proof"))
          assertTrue(owned(root, "crash").all { it.length() <= 1_048_576 })
          assertEquals("keep unrelated", sentinel.readText())
          println("LOCAL_LOG_ACCEPTANCE main_pid=${Process.myPid()} secondary_pid=${result.getInt("pid")} generated_records=1200 generated_payload_bytes=14640000 runtime_files=${runtime.size} crash_files=10 retained_runtime_bytes=${runtime.sumOf { it.length() }}")
        } finally { executor.shutdownNow() }
      } finally { AndroidAppLogging.setLevel(previousLevel) }
    }
  }

  @Test
  fun prepareControlledNativeExitAtOff() {
    org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("controlledCrash") == "native")
    val app = isolatedContext()
    val blocker = File(app.filesDir, "log-acceptance-primary-blocker").apply { writeText("owned QA blocker") }
    File(app.applicationInfo.dataDir, "chapter-media-storage-root.txt").writeText(blocker.path)
    AndroidAppLogging.setLevel("off")
    val result = secondary(3)
    println("LOCAL_LOG_NATIVE_EXIT requested_pid=${result.getInt("pid")} level=off")
  }

  @Test
  fun createOwnedStartupPanicFixtureAtOff() {
    org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("controlledCrash") == "startup")
    isolatedContext()
    AndroidAppLogging.setLevel("off")
    assertTrue(secondary(4, Bundle().apply { putBoolean("enabled", true) }).getBoolean("enabled"))
  }

  @Test
  fun removeOwnedStartupPanicFixture() {
    org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("controlledCrash") == "cleanup")
    isolatedContext()
    assertFalse(secondary(4, Bundle().apply { putBoolean("enabled", false) }).getBoolean("enabled"))
  }

  @Test
  fun recoveredCrashReportsContainEvidenceAndDoNotDuplicateOnRepeatedCollection() {
    val app = isolatedContext()
    val expected = InstrumentationRegistry.getArguments().getString("expectedKind")
    fun reports(): Map<String, String> = AndroidLogDestinations(app).candidates()
      .flatMap { destination -> runCatching { destination.files(AppLogCategory.CRASH) }.getOrDefault(emptyList()) }
      .associate { file -> file.id to savedText(AppLogWriteResult.Saved(file.id)) }
    AndroidCrashReports.collectPreviousCrashes(app)
    val first = reports()
    if (expected != null) assertTrue("Expected $expected in ${first.values.joinToString().take(4_096)}", first.values.any { it.contains("crash=$expected\n") })
    AndroidCrashReports.collectPreviousCrashes(app)
    assertEquals("Repeated exit collection published a duplicate report", first, reports())
    assertTrue(first.values.all { it.toByteArray(Charsets.UTF_8).size <= 1_048_576 })
    println("LOCAL_LOG_REPORTS " + JSONArray(first.entries.map { (location, text) ->
      JSONObject().put("location", location).put("bytes", text.toByteArray(Charsets.UTF_8).size).put("text", text.take(24_000))
    }))
  }

}
