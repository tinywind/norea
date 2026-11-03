package io.github.tinywind.norea

import androidx.annotation.Keep

@Keep
object AndroidAppLoggingBridge {
  init { System.loadLibrary("app_lib") }
  @JvmStatic external fun register()

  @JvmStatic fun enqueueRuntime(level: String, target: String, thread: String, message: String): Boolean {
    val parsed = AppLogLevel.parse(level)
    val accepted = AndroidAppLogging.enqueueRuntime(level, target, thread, message)
    if (!AppLogLevel.parse(AndroidAppLogging.currentLevel()).accepts(parsed)) return accepted
    val priority = when (parsed) {
      AppLogLevel.TRACE -> android.util.Log.VERBOSE
      AppLogLevel.DEBUG -> android.util.Log.DEBUG
      AppLogLevel.INFO -> android.util.Log.INFO
      AppLogLevel.WARN -> android.util.Log.WARN
      else -> android.util.Log.ERROR
    }
    android.util.Log.println(priority, target, singleLineLogMessage(message))
    return accepted
  }

  @JvmStatic fun writeCrash(kind: String, message: String, detail: String): String? =
    when (val result = AndroidAppLogging.writeCrash(kind, message, detail)) {
      is AppLogWriteResult.Saved -> result.location
      is AppLogWriteResult.Unavailable -> {
        System.err.println("Norea crash report unavailable: ${singleLineLogMessage(result.message)}")
        null
      }
    }

  @JvmStatic fun setLevel(level: String) = AndroidAppLogging.setLevel(level)
  @JvmStatic fun currentLevel(): String = AndroidAppLogging.currentLevel()
}
