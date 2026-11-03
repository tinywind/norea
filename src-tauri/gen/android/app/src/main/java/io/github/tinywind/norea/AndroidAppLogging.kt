package io.github.tinywind.norea

import android.app.Application
import android.content.Context
import android.os.Build
import android.os.FileObserver
import android.os.Process
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

internal class AppLogLevelStore(private val directory: File) {
  fun read(): AppLogLevel {
    val file = File(directory.canonicalFile, "level.state")
    if (!file.exists()) return AppLogLevel.INFO
    check(file.canonicalFile == file.absoluteFile) { "Linked log level is not allowed" }
    return synchronized(lock) {
      RandomAccessFile(file, "r").use { state ->
        state.channel.lock(0, Long.MAX_VALUE, true).use { AppLogLevel.parse(state.readUTF()) }
      }
    }
  }

  fun write(level: AppLogLevel) = locked { file ->
    file.setLength(0)
    file.writeUTF(level.value)
    file.fd.sync()
  }

  private fun <T> locked(operation: (RandomAccessFile) -> T): T = synchronized(lock) {
    check(directory.isDirectory || directory.mkdirs() || directory.isDirectory)
    val file = File(directory.canonicalFile, "level.state")
    check(file.canonicalFile == file.absoluteFile) { "Linked log level is not allowed" }
    RandomAccessFile(file, "rw").use { state -> state.channel.lock().use { operation(state) } }
  }
  companion object { private val lock = Any() }
}

internal class AppLogRuntime(
  private val identity: AppLogIdentity,
  private val currentLevel: () -> AppLogLevel,
  private val persistedLevel: () -> AppLogLevel,
  private val write: (ByteArray) -> Unit,
) {
  private data class Queued(val level: AppLogLevel, val bytes: ByteArray)
  private val queue = ArrayBlockingQueue<Queued>(256)
  private val dropped = AtomicLong()

  init {
    Thread({
      while (!Thread.currentThread().isInterrupted) {
        try {
          val record = queue.take()
          if (!persistedLevel().accepts(record.level)) continue
          val count = dropped.getAndSet(0)
          if (count > 0) write(AppLogPolicy.runtime(identity, AppRuntimeRecord(AppLogLevel.ERROR,
            "logging", Thread.currentThread().name, "Dropped $count runtime log records after queue saturation", System.currentTimeMillis())))
          write(record.bytes)
        } catch (_: InterruptedException) {
          Thread.currentThread().interrupt()
        } catch (error: Exception) {
          System.err.println("Norea runtime log write failed: ${singleLineLogMessage(error.toString())}")
        }
      }
    }, "norea-runtime-logs").apply { isDaemon = true; start() }
  }

  fun enqueue(record: AppRuntimeRecord): Boolean {
    if (!currentLevel().accepts(record.level)) return false
    val accepted = queue.offer(Queued(record.level, AppLogPolicy.runtime(identity, record)))
    if (!accepted) dropped.incrementAndGet()
    return accepted
  }
}

internal class AppCrashPublisher(
  private val stage: (ByteArray) -> AppLogWriteResult,
  private val publish: (ByteArray) -> AppLogWriteResult,
  private val discard: (AppLogWriteResult.Saved) -> Unit,
) {
  private val executor = ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, SynchronousQueue(),
    { task -> Thread(task, "norea-crash-publication").apply { isDaemon = true } }, ThreadPoolExecutor.AbortPolicy())

  fun write(bytes: ByteArray): AppLogWriteResult {
    val staged = try { stage(bytes) } catch (error: Exception) { AppLogWriteResult.Unavailable(error.toString()) }
    val future = try {
      executor.submit<AppLogWriteResult> {
        val result = publish(bytes)
        if (result is AppLogWriteResult.Saved && staged is AppLogWriteResult.Saved) runCatching { discard(staged) }
        result
      }
    } catch (_: RejectedExecutionException) { return staged }
    return try {
      val result = future.get(1_500, TimeUnit.MILLISECONDS)
      if (result is AppLogWriteResult.Saved) result else staged
    } catch (_: Exception) { staged }
  }
}

internal object AndroidAppLogging {
  private class Installed(val context: Context) {
    val destinations = AndroidLogDestinations(context)
    val levelStore = AppLogLevelStore(destinations.stateDirectory)
    @Volatile var level: AppLogLevel? = null
    @Volatile var volatileLevel = false

    @Synchronized fun persistedLevel(): AppLogLevel {
      if (!volatileLevel) level = runCatching { levelStore.read() }.getOrElse {
        System.err.println("Norea native log level unavailable: ${singleLineLogMessage(it.toString())}")
        AppLogLevel.OFF
      }
      return level ?: AppLogLevel.OFF
    }
    val identity = AppLogIdentity(context.packageName, BuildConfig.VERSION_NAME,
      "Android SDK ${Build.VERSION.SDK_INT}", Process.myPid(),
      if (Build.VERSION.SDK_INT >= 28) Application.getProcessName() else "unavailable")
    val store = AppLogFiles(context.packageName, destinations.stateDirectory, destinations = destinations::candidates)
    val stagedDestination = AndroidDirectoryLogDestination(File(context.applicationInfo.dataDir, "cache"), "norea-crash-pending", context.packageName)
    val stageStore = AppLogFiles(context.packageName, File(destinations.stateDirectory, "staging"), destinations.stateDirectory) { listOf(stagedDestination) }
    val crashes = AppCrashPublisher({ stageStore.write(AppLogCategory.CRASH, it) }, { store.write(AppLogCategory.CRASH, it) }, { saved ->
      val name = File(saved.location).name
      AppLogNames.sequence(context.packageName, AppLogCategory.CRASH, name)?.let { sequence ->
        stagedDestination.delete(AppLogFile(saved.location, name, sequence, 0))
      }
    })
    val runtime = AppLogRuntime(identity, { level ?: AppLogLevel.TRACE }, ::persistedLevel) { bytes ->
      val result = store.write(AppLogCategory.RUNTIME, bytes)
      if (result is AppLogWriteResult.Unavailable) System.err.println("Norea log storage unavailable: ${result.message}")
    }
    @Suppress("DEPRECATION") // The path constructor supports Android API 24-28.
    val observer = object : FileObserver(destinations.stateDirectory.path, CLOSE_WRITE or MOVED_TO) {
      override fun onEvent(event: Int, path: String?) {
        if (path == "level.state") persistedLevel()
      }
    }
  }

  @Volatile private var installed: Installed? = null

  @Synchronized fun install(context: Context) {
    if (installed != null) return
    val state = Installed(context.applicationContext)
    installed = state
    AndroidCrashReports.installUncaughtHandler(context)
    Thread({
      state.persistedLevel()
      runCatching { state.destinations.stateDirectory.mkdirs(); state.observer.startWatching() }
      state.persistedLevel()
      enqueueRuntime("info", "application", Thread.currentThread().name, "Local application logging initialized")
      runCatching {
        state.stagedDestination.files(AppLogCategory.CRASH).sortedBy { it.sequence }.forEach { file ->
          val bytes = state.stagedDestination.read(file)
          if (state.store.write(AppLogCategory.CRASH, bytes) is AppLogWriteResult.Saved) state.stagedDestination.delete(file)
        }
      }.onFailure { System.err.println("Norea pending crash publication unavailable: ${singleLineLogMessage(it.toString())}") }
    }, "norea-pending-crashes").apply { isDaemon = true; start() }
    Thread({ AndroidCrashReports.collectPreviousCrashes(state.context) }, "norea-previous-exits")
      .apply { isDaemon = true; start() }
  }

  fun currentLevel(): String = installed?.level?.value ?: "off"

  fun setLevel(value: String) {
    val level = AppLogLevel.parse(value)
    val state = installed ?: error("Application logging is not installed")
    synchronized(state) {
      state.level = level
      state.volatileLevel = true
      state.levelStore.write(level)
      state.volatileLevel = false
    }
  }

  fun enqueueRuntime(level: String, target: String, thread: String, message: String): Boolean {
    val state = installed ?: return false
    return state.runtime.enqueue(AppRuntimeRecord(AppLogLevel.parse(level), target, thread, message, System.currentTimeMillis()))
  }

  fun writeCrash(kind: String, message: String, detail: String): AppLogWriteResult {
    val state = installed ?: return AppLogWriteResult.Unavailable("Application logging is not installed")
    return state.crashes.write(AppLogPolicy.crash(state.identity, kind, message, detail))
  }
}
