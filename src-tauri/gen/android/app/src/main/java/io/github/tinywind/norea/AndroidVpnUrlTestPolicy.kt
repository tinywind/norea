package io.github.tinywind.norea

import android.net.http.SslError

internal const val VPN_URL_TEST_LOAD = 1
internal const val VPN_URL_TEST_RESULT = 2
internal const val ANDROID_VPN_URL_TEST_PROCESS = ":vpn_url_test"
internal const val ANDROID_VPN_URL_TEST_DATA_DIRECTORY_SUFFIX = "norea_vpn_url_test"
internal const val ANDROID_VPN_URL_TEST_MAX_PAGE_TIMEOUT_MS = 60_000
private const val ANDROID_VPN_URL_TEST_PROFILE_PREFIX = "norea-vpn-url-test-"

/**
 * Reads the main document's status and the Cloudflare challenge page markers after the page
 * loads. Cloudflare also injects challenge-platform scripts into ordinary pages, so the host
 * counts the markers only for Cloudflare error responses.
 */
internal const val ANDROID_VPN_URL_TEST_PROBE = """(function () {
  var entry = window.performance && performance.getEntriesByType ? performance.getEntriesByType("navigation")[0] : null;
  var status = entry && entry.responseStatus > 0 ? entry.responseStatus : null;
  var title = (document.title || "").trim().toLowerCase();
  var challenge = typeof window._cf_chl_opt !== "undefined" || title === "just a moment..." ||
    document.querySelector('#challenge-form, [id^="cf-chl-"], [class*="cf-chl-"], script[src*="/cdn-cgi/challenge-platform/"], script[src*="challenges.cloudflare.com"], iframe[src*="challenges.cloudflare.com"]') !== null;
  return { status: status, challenge: challenge };
})();"""

/** Each test gets a profile name no earlier test used, so it starts with no site data. */
internal fun androidVpnUrlTestProfileName(token: String): String = ANDROID_VPN_URL_TEST_PROFILE_PREFIX + token

internal fun isAndroidVpnUrlTestProfile(name: String): Boolean =
  name.startsWith(ANDROID_VPN_URL_TEST_PROFILE_PREFIX) && name.length > ANDROID_VPN_URL_TEST_PROFILE_PREFIX.length

/**
 * The test browser process stays bound for the next load of the run only after it answered a
 * load that was not cancelled; a cancel, a timeout, or a lost process releases it.
 */
internal fun androidVpnUrlTestKeepsBrowser(answered: Boolean, cancelled: Boolean): Boolean = answered && !cancelled

/** The test follows the server redirects of the page it loads and blocks every other navigation. */
internal fun androidVpnUrlTestFollowsNavigation(isForMainFrame: Boolean, isRedirect: Boolean, scheme: String?): Boolean =
  isForMainFrame && isRedirect && scheme?.lowercase() in setOf("http", "https")

internal fun androidVpnUrlTestHeader(headers: Map<String, String>?, name: String): String? =
  headers?.entries?.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value

internal fun androidVpnUrlTestCertificateError(primaryError: Int): String = when (primaryError) {
  SslError.SSL_NOTYETVALID -> "The site's TLS certificate is not valid yet."
  SslError.SSL_EXPIRED -> "The site's TLS certificate has expired."
  SslError.SSL_IDMISMATCH -> "The site's TLS certificate does not match its host name."
  SslError.SSL_UNTRUSTED -> "The site's TLS certificate is not trusted."
  SslError.SSL_DATE_INVALID -> "The site's TLS certificate date is invalid."
  else -> "The site's TLS certificate is invalid."
}
