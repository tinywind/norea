package io.github.tinywind.norea

import android.content.Context
import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.os.Build
import android.os.Process
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.ConcurrentHashMap
import java.io.File
import java.io.RandomAccessFile
import kotlin.system.exitProcess

internal class AppExitReportHistory(private val directory: File) {
  fun captureIfNew(identity: String, capture: () -> AppLogWriteResult): AppLogWriteResult? {
    check(directory.isDirectory || directory.mkdirs() || directory.isDirectory)
    val file = File(directory.canonicalFile, "exit-recovery.state")
    check(file.canonicalFile == file.absoluteFile) { "Linked exit recovery cursor is not allowed" }
    return synchronized(locks.getOrPut(file.path) { Any() }) {
      RandomAccessFile(file, "rw").use { cursor -> cursor.channel.lock().use lock@{
        check(cursor.length() <= 65_536) { "Exit recovery cursor exceeds its limit" }
        val seen = linkedSetOf<String>()
        while (cursor.filePointer < cursor.length()) seen += cursor.readUTF()
        if (identity in seen) return@lock null
        val result = capture()
        if (result is AppLogWriteResult.Saved) {
          seen += identity
          cursor.seek(0)
          cursor.setLength(0)
          seen.toList().takeLast(128).forEach(cursor::writeUTF)
          cursor.fd.sync()
        }
        result
      } }
    }
  }
  companion object { private val locks = ConcurrentHashMap<String, Any>() }
}

internal class AppUncaughtExceptionHandler(
  private val previous: Thread.UncaughtExceptionHandler?,
  private val capture: (Thread, Throwable) -> Unit,
  private val terminate: () -> Unit,
) : Thread.UncaughtExceptionHandler {
  override fun uncaughtException(thread: Thread, error: Throwable) {
    try { capture(thread, error) } catch (_: Throwable) {
      System.err.println("Norea could not record the uncaught exception")
    } finally {
      if (previous != null) previous.uncaughtException(thread, error) else terminate()
    }
  }
}

internal object AndroidCrashReports {
  private val installed = AtomicBoolean()
  fun installUncaughtHandler(context: Context) {
    if (!installed.compareAndSet(false, true)) return
    Thread.setDefaultUncaughtExceptionHandler(AppUncaughtExceptionHandler(Thread.getDefaultUncaughtExceptionHandler(), { thread, error ->
      AndroidAppLogging.writeCrash("java-uncaught", error.toString(), "thread=${thread.name}\n${AppLogPolicy.throwableDetail(error)}")
    }, { Process.killProcess(Process.myPid()); exitProcess(10) }))
  }

  fun collectPreviousCrashes(context: Context) {
    if (Build.VERSION.SDK_INT < 30) return
    try { AndroidExitHistory.collect(context) } catch (error: Exception) {
      System.err.println("Norea previous exit recovery unavailable: ${singleLineLogMessage(error.toString())}")
    }
  }
}

@androidx.annotation.RequiresApi(30)
private object AndroidExitHistory {
  fun collect(context: Context) {
    val manager = context.getSystemService(ActivityManager::class.java) ?: return
    val history = AppExitReportHistory(AndroidLogDestinations(context).stateDirectory)
    val exits = manager.getHistoricalProcessExitReasons(context.packageName, 0, 32).sortedBy { it.timestamp }
    for (exit in exits) {
      val reason = when (exit.reason) {
        ApplicationExitInfo.REASON_CRASH_NATIVE -> "native-crash"
        ApplicationExitInfo.REASON_CRASH -> "java-crash"
        ApplicationExitInfo.REASON_ANR -> "anr"
        else -> continue
      }
      val process = exit.processName
      if (process != null && process != context.packageName && !process.startsWith("${context.packageName}:")) continue
      val result = history.captureIfNew("${exit.timestamp}:${exit.pid}:${exit.reason}") {
        val metadata = "recovery_context=current collection process\ncrashed_build=unavailable\n" +
          "crashed_pid=${exit.pid}\ncrashed_process=${process ?: "unavailable"}\n" +
          "exit_utc_millis=${exit.timestamp}\nexit_reason=$reason\nexit_status=${exit.status}\n" +
          "os_description=${exit.description ?: "unavailable"}\n"
        val trace = if (exit.reason == ApplicationExitInfo.REASON_CRASH_NATIVE) {
          if (Build.VERSION.SDK_INT < 31) "Native tombstone unavailable: Android API 31 is required"
          else {
            val parsed = runCatching {
              exit.traceInputStream?.use(::readNativeCrashTrace)
                ?: NativeCrashTraceResult.Unavailable("OS did not retain a native trace")
            }.getOrElse { NativeCrashTraceResult.Unavailable("OS native trace could not be read: ${singleLineLogMessage(it.toString())}") }
            nativeCrashTraceText(parsed)
          }
        } else "OS exit metadata only; no Java/ANR stack was recovered from the OS"
        AndroidAppLogging.writeCrash("android-exit-$reason", "Recovered $reason for PID ${exit.pid}", metadata + trace)
      }
      if (result is AppLogWriteResult.Unavailable) System.err.println("Norea previous exit report unavailable: ${singleLineLogMessage(result.message)}")
    }
  }
}
