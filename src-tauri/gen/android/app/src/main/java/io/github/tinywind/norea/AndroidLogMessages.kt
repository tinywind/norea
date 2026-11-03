package io.github.tinywind.norea

internal fun singleLineLogMessage(message: String): String =
  AppLogPolicy.bounded(
    AppLogPolicy.redact(message).replace("\r", "\\r").replace("\n", "\\n"),
    APP_LOG_RECORD_BYTES,
  )
