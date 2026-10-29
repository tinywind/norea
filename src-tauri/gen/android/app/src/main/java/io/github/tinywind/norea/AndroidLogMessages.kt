package io.github.tinywind.norea

internal fun singleLineLogMessage(message: String): String =
  message.replace("\r", "\\r").replace("\n", "\\n")
