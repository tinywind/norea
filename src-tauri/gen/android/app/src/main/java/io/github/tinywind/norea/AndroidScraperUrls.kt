package io.github.tinywind.norea

import android.net.Uri
import android.util.Log

internal const val SCRAPER_LOG_TAG = "NoreaScraper"

private const val PARKED_PAGE_FRAGMENT = "norea-parked"
private val HTTP_ORIGIN_PREFIX = Regex("""^(https?://[^/?#]+)""", RegexOption.IGNORE_CASE)
private val HTTP_URL_IN_LOG_MESSAGE = Regex("""(?i)\bhttps?://[^\s"'<>]+""")
private val MALFORMED_URL_USER_INFO = Regex("""(?i)^([a-z][a-z\d+.-]*://)[^/@\s]+@""")

/**
 * Resting page for an idle scraper WebView. Parking on an empty document at the
 * previous origin instead of `about:blank` drops the old page while the next
 * plugin fetch to the same site can skip the context navigation.
 */
internal fun scraperParkingUrl(currentUrl: String?): String? {
  if (currentUrl.isNullOrBlank()) return null
  val origin = HTTP_ORIGIN_PREFIX.find(currentUrl)?.groupValues?.get(1) ?: return null
  return "$origin/#$PARKED_PAGE_FRAGMENT"
}

/**
 * Reduces an http(s) URL to its origin, or to origin plus path while
 * `setprop log.tag.NoreaScraper VERBOSE` is active, so queries, fragments, and
 * credentials never reach logcat or bridge error strings.
 */
internal fun urlForLog(url: String?): String {
  if (url.isNullOrBlank()) return "<none>"
  val parsed = runCatching { Uri.parse(url) }.getOrNull()
  val scheme = parsed?.scheme?.lowercase()
  if (parsed != null && (scheme == "http" || scheme == "https")) {
    val origin = originUrl(parsed)
    if (origin != null) {
      return if (Log.isLoggable(SCRAPER_LOG_TAG, Log.VERBOSE)) {
        origin + parsed.encodedPath.orEmpty()
      } else {
        origin
      }
    }
  }
  if (!scheme.isNullOrBlank()) return "<$scheme-url>"

  val secretBoundary = listOf(url.indexOf('?'), url.indexOf('#'))
    .filter { it >= 0 }
    .minOrNull()
  val withoutSecrets = if (secretBoundary == null) url else url.substring(0, secretBoundary)
  return MALFORMED_URL_USER_INFO.replaceFirst(withoutSecrets, "\$1")
}

internal fun redactUrlsForLog(message: String): String {
  return HTTP_URL_IN_LOG_MESSAGE.replace(message) { match -> urlForLog(match.value) }
}

internal fun isHttpUrl(url: String): Boolean {
  val uri = Uri.parse(url)
  return uri.scheme == "http" || uri.scheme == "https"
}

internal fun fetchContextUrl(url: String, contextUrl: String?): String? {
  val requestUri = Uri.parse(url)
  val requestOrigin = originUrl(requestUri) ?: return contextUrl
  if (contextUrl == null) return requestOrigin
  val configuredContextUri = Uri.parse(contextUrl)
  return if (sameOrigin(requestUri, configuredContextUri)) {
    contextUrl
  } else {
    requestOrigin
  }
}

internal fun originUrl(uri: Uri): String? {
  val scheme = uri.scheme?.lowercase() ?: return null
  if (scheme != "http" && scheme != "https") return null
  val host = uri.host?.lowercase()?.takeIf { it.isNotBlank() } ?: return null
  val defaultPort = effectivePortForScheme(scheme)
  val port = uri.port
  if (port < -1 || port > 65_535) return null
  val portPart = if (port != -1 && port != defaultPort) ":$port" else ""
  val serializedHost = if (host.contains(':')) {
    "[${host.removePrefix("[").removeSuffix("]")}]"
  } else {
    host
  }
  return "$scheme://$serializedHost$portPart"
}

internal fun sameOrigin(left: String?, right: String): Boolean {
  if (left == null) return false
  return sameOrigin(Uri.parse(left), Uri.parse(right))
}

internal fun sameOrigin(leftUri: Uri, rightUri: Uri): Boolean {
  return leftUri.scheme == rightUri.scheme &&
    leftUri.host.equals(rightUri.host, ignoreCase = true) &&
    effectivePort(leftUri) == effectivePort(rightUri)
}

internal fun effectivePort(uri: Uri): Int {
  if (uri.port != -1) return uri.port
  return effectivePortForScheme(uri.scheme)
}

private fun effectivePortForScheme(scheme: String?): Int {
  return when (scheme) {
    "http" -> 80
    "https" -> 443
    else -> -1
  }
}
