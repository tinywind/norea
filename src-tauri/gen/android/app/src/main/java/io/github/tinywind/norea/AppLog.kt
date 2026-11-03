package io.github.tinywind.norea

internal object AppLog {
  const val VERBOSE = android.util.Log.VERBOSE
  fun isLoggable(tag: String, level: Int): Boolean = android.util.Log.isLoggable(tag, level)

  fun d(tag: String, message: String): Int = emit(AppLogLevel.DEBUG, tag, message, null)
  fun w(tag: String, message: String): Int = emit(AppLogLevel.WARN, tag, message, null)
  fun w(tag: String, message: String, error: Throwable): Int = emit(AppLogLevel.WARN, tag, message, error)

  private fun emit(level: AppLogLevel, tag: String, message: String, error: Throwable?): Int {
    val detail = if (error == null) message else "$message\n${AppLogPolicy.throwableDetail(error)}"
    val safe = singleLineLogMessage(detail)
    AndroidAppLogging.enqueueRuntime(level.value, tag, Thread.currentThread().name, safe)
    if (!AppLogLevel.parse(AndroidAppLogging.currentLevel()).accepts(level)) return 0
    return android.util.Log.println(if (level == AppLogLevel.DEBUG) android.util.Log.DEBUG else android.util.Log.WARN, tag, safe)
  }
}
