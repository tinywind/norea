package io.github.tinywind.norea

import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode

private val pluginStorageIdPattern = Regex("[a-z0-9]+(?:-[a-z0-9]+)*")
private val storageDeviceNamePattern = Regex("(?:con|prn|aux|nul|com[0-9]|lpt[0-9])", RegexOption.IGNORE_CASE)
private val storageArtifactSuffixes = listOf(".tmp", ".bak", ".part", ".partial", ".norea-sync-backup")

internal fun isAndroidStorageId(value: String): Boolean {
  if (value.isEmpty() || value.first() in ". " || value.last() in ". " ||
    value.any { it.code < 32 || it in "<>:\"/\\|?*" }) return false
  var index = 0
  while (index < value.length) {
    val character = value[index]
    if (character.isHighSurrogate()) {
      if (index + 1 >= value.length || !value[index + 1].isLowSurrogate()) return false
      index += 2
    } else {
      if (character.isLowSurrogate()) return false
      index++
    }
  }
  return value.toByteArray(Charsets.UTF_8).size <= 240 &&
    !storageDeviceNamePattern.matches(value.substringBefore('.')) &&
    storageArtifactSuffixes.none { value.endsWith(it, ignoreCase = true) }
}

internal fun isAndroidPluginStorageId(value: String): Boolean =
  isAndroidStorageId(value) && pluginStorageIdPattern.matches(value)

internal fun isAndroidChapterDirectoryName(value: String): Boolean {
  val number = value.toDoubleOrNull() ?: return false
  if (!number.isFinite() || number < 0 || number >= 1e21 || (number > 0 && number < 1e-6)) return false
  // Keep Android Java versions aligned with JavaScript's shortest decimal representation.
  val decimal = BigDecimal(number)
  for (precision in 1..17) {
    val shortest = decimal.round(MathContext(precision, RoundingMode.HALF_EVEN))
    if (shortest.toDouble() == number) return shortest.stripTrailingZeros().toPlainString() == value
  }
  return false
}
