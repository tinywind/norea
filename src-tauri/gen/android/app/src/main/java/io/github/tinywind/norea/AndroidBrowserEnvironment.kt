package io.github.tinywind.norea

import android.content.Context
import android.os.Build
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.webkit.CustomHeader
import androidx.webkit.ScriptHandler
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.security.SecureRandom
import java.util.WeakHashMap
import org.json.JSONObject

internal const val REQUESTED_WITH_HEADER = "X-Requested-With"
internal const val SUPPRESSED_REQUESTED_WITH_VALUE = ""
internal const val REQUESTED_WITH_ORIGIN_WILDCARD = "*"
private const val CHROMIUM_BRAND = "Chromium"
private const val ANDROID_WEBVIEW_BRAND = "Android WebView"
private const val GOOGLE_CHROME_BRAND = "Google Chrome"
private const val FALLBACK_GREASE_BRAND = "Not;A=Brand"
private const val FALLBACK_GREASE_MAJOR = "99"
private const val FALLBACK_GREASE_FULL = "99.0.0.0"

internal fun suppressedRequestedWithCustomHeader(): CustomHeader =
  CustomHeader(
    REQUESTED_WITH_HEADER,
    SUPPRESSED_REQUESTED_WITH_VALUE,
    setOf(REQUESTED_WITH_ORIGIN_WILDCARD),
  )

/**
 * Suppresses WebView's automatic package-name X-Requested-With header via
 * Profile.addCustomHeader (androidx.webkit 1.15+ / WebView 142+, where the
 * deprecated allowlist API is a no-op). Returning false lets callers rely on
 * top-level loadUrl headers on older providers.
 */
internal fun applyRequestedWithSuppression(
  isFeatureSupported: (String) -> Boolean,
  getProfileHeaders: () -> Set<CustomHeader>,
  addProfileHeader: (CustomHeader) -> Unit,
): Boolean {
  if (!isFeatureSupported(WebViewFeature.MULTI_PROFILE) ||
    !isFeatureSupported(WebViewFeature.CUSTOM_REQUEST_HEADERS)
  ) {
    return false
  }
  val header = suppressedRequestedWithCustomHeader()
  val alreadyConfigured = getProfileHeaders().any { existing ->
    existing.name.equals(header.name, ignoreCase = true) &&
      existing.value == header.value &&
      REQUESTED_WITH_ORIGIN_WILDCARD in existing.rules
  }
  if (!alreadyConfigured) {
    addProfileHeader(header)
  }
  return true
}

/**
 * Headers for top-level HTTP(S) site navigations. Passing an empty
 * X-Requested-With header also suppresses the package-name default on older
 * WebView providers without CUSTOM_REQUEST_HEADERS and is deduplicated by
 * Chromium when the profile header is also active.
 */
internal fun siteNavigationHeaders(url: String, bypassCache: Boolean = false): Map<String, String> {
  if (!url.startsWith("http://", ignoreCase = true) && !url.startsWith("https://", ignoreCase = true)) {
    return emptyMap()
  }
  return buildMap {
    put(REQUESTED_WITH_HEADER, SUPPRESSED_REQUESTED_WITH_VALUE)
    if (bypassCache) {
      put("Cache-Control", "no-cache")
      put("Pragma", "no-cache")
    }
  }
}

/**
 * Updates the Chromium and browser brand entries while preserving WebView's
 * version-seeded GREASE brand and brand order when present.
 */
internal fun buildUserAgentBrandVersionList(
  existingBrands: List<UserAgentMetadata.BrandVersion>,
  version: String,
  maskAsChrome: Boolean,
): List<UserAgentMetadata.BrandVersion> {
  val major = version.substringBefore('.')
  val browserBrand = if (maskAsChrome) GOOGLE_CHROME_BRAND else ANDROID_WEBVIEW_BRAND
  val result = mutableListOf<UserAgentMetadata.BrandVersion>()
  var seenChromium = false
  var seenBrowserBrand = false
  var seenGrease = false

  fun versioned(brand: String): UserAgentMetadata.BrandVersion =
    UserAgentMetadata.BrandVersion.Builder()
      .setBrand(brand)
      .setMajorVersion(major)
      .setFullVersion(version)
      .build()

  for (entry in existingBrands) {
    when (entry.brand) {
      CHROMIUM_BRAND -> if (!seenChromium) {
        result.add(versioned(CHROMIUM_BRAND))
        seenChromium = true
      }
      ANDROID_WEBVIEW_BRAND, GOOGLE_CHROME_BRAND -> if (!seenBrowserBrand) {
        result.add(versioned(browserBrand))
        seenBrowserBrand = true
      }
      else -> if (entry.brand.isNotBlank()) {
        result.add(entry)
        seenGrease = true
      }
    }
  }

  if (!seenGrease) {
    result.add(
      0,
      UserAgentMetadata.BrandVersion.Builder()
        .setBrand(FALLBACK_GREASE_BRAND)
        .setMajorVersion(FALLBACK_GREASE_MAJOR)
        .setFullVersion(FALLBACK_GREASE_FULL)
        .build(),
    )
  }
  if (!seenChromium) {
    result.add(versioned(CHROMIUM_BRAND))
  }
  if (!seenBrowserBrand) {
    result.add(versioned(browserBrand))
  }
  return result
}

/**
 * One persisted environment for every site WebView. The app's own UI WebView
 * never calls apply(). A route owner commits a new environment before it opens
 * the gate for the next profile; navigation and reconnects do not rotate it.
 */
internal object AndroidBrowserEnvironment {
  private const val PREFERENCES = "norea_shared_browser_environment"
  private const val ENVIRONMENT = "environment_v1"
  private const val ROTATE = "rotate_on_vpn_change"
  private const val GENERATED_FOR = "generated_for_route"
  private val random = SecureRandom()
  private val scripts = WeakHashMap<WebView, ScriptHandler>()
  @Volatile private var loaded = false
  @Volatile private var environment: JSONObject? = null
  @Volatile private var rotate = false
  private var generatedFor: String? = null

  fun isSupported(): Boolean =
    WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)

  @Synchronized
  private fun load(context: Context) {
    if (loaded) return
    val preferences = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    rotate = preferences.getBoolean(ROTATE, false)
    generatedFor = preferences.getString(GENERATED_FOR, null)
    environment = preferences.getString(ENVIRONMENT, null)?.let { serialized ->
      runCatching { JSONObject(serialized).takeIf { valid(it) } }.getOrNull()
    }
    loaded = true
  }

  fun rotationEnabled(context: Context): Boolean {
    load(context)
    return rotate
  }

  /**
   * Returns true only when existing site WebViews must be recreated.
   * Settings changes take effect on the next real route transition.
   */
  @Synchronized
  fun configure(context: Context, rotateOnTransition: Boolean, changedRoute: Boolean, transitionIdentity: String? = null): Boolean {
    load(context)
    check(!rotateOnTransition || isSupported()) {
      "This WebView provider cannot apply a consistent browser environment."
    }
    require(transitionIdentity == null || transitionIdentity == "direct" || transitionIdentity.matches(Regex("[a-f0-9]{64}"))) {
      "The browser environment route identity is invalid."
    }
    val next = if (!rotateOnTransition && !isSupported()) {
      // An explicit Off must remain usable after a WebView provider downgrade.
      null
    } else if (changedRoute) {
      if (!rotateOnTransition) null
      else if (transitionIdentity != null && generatedFor == transitionIdentity && environment != null) environment
      else create(context)
    } else environment
    val changed = next?.toString() != environment?.toString()
    val preferences = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    val edit = preferences.edit().putBoolean(ROTATE, rotateOnTransition)
    if (changedRoute) {
      if (transitionIdentity == null) edit.remove(GENERATED_FOR) else edit.putString(GENERATED_FOR, transitionIdentity)
    }
    if (next == null) edit.remove(ENVIRONMENT) else edit.putString(ENVIRONMENT, next.toString())
    check(edit.commit()) { "Could not persist the shared browser environment." }
    rotate = rotateOnTransition
    if (changedRoute) generatedFor = transitionIdentity
    environment = next
    return changed
  }

  private fun valid(value: JSONObject): Boolean =
    value.optInt("version") == 1 &&
      value.optString("seed").matches(Regex("[0-9a-f]{32}")) &&
      value.optInt("hardwareConcurrency") in 2..16 &&
      value.optInt("deviceMemory") in listOf(2, 4, 8) &&
      value.optInt("screenWidth") in 320..4096 &&
      value.optInt("screenHeight") in 320..8192 &&
      value.optString("model").isNotBlank() &&
      value.optString("renderer").isNotBlank()

  private data class Device(val model: String, val renderer: String)
  private val devices = listOf(
    Device("SM-X710", "ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)"),
    Device("SM-X810", "ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)"),
    Device("Lenovo TB371FC", "ANGLE (Qualcomm, Adreno (TM) 730, OpenGL ES 3.2)"),
    Device("Lenovo TB322FC", "ANGLE (Qualcomm, Adreno (TM) 750, OpenGL ES 3.2)"),
  )

  private fun create(context: Context): JSONObject {
    val device = devices[random.nextInt(devices.size)]
    val metrics = context.resources.displayMetrics
    val width = (metrics.widthPixels / metrics.density).toInt().coerceAtLeast(320)
    val height = (metrics.heightPixels / metrics.density).toInt().coerceAtLeast(320)
    val seed = ByteArray(16).also(random::nextBytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    return JSONObject()
      .put("version", 1)
      .put("seed", seed)
      .put("model", device.model)
      .put("platformVersion", Build.VERSION.RELEASE)
      .put("platform", "Linux armv8l")
      .put("hardwareConcurrency", listOf(4, 8)[random.nextInt(2)])
      .put("deviceMemory", listOf(4, 8)[random.nextInt(2)])
      .put("maxTouchPoints", listOf(5, 10)[random.nextInt(2)])
      // The browser can occupy a smaller window than its reported screen.
      .put("screenWidth", (width + 16 * random.nextInt(5)).coerceAtMost(4096))
      .put("screenHeight", (height + 16 * random.nextInt(9)).coerceAtMost(8192))
      .put("colorDepth", 24)
      .put("vendor", "Google Inc. (Qualcomm)")
      .put("renderer", device.renderer)
  }

  /**
   * Source-specific UA strings would split the same site's identity again.
   * Use the installed engine version for all views, including URL tests.
   */
  @Suppress("UNUSED_PARAMETER")
  fun apply(webView: WebView, userAgent: String?) {
    load(webView.context)
    val profile by lazy(LazyThreadSafetyMode.NONE) { WebViewCompat.getProfile(webView) }
    applyRequestedWithSuppression(
      isFeatureSupported = WebViewFeature::isFeatureSupported,
      getProfileHeaders = { profile.getCustomHeaders(REQUESTED_WITH_HEADER, SUPPRESSED_REQUESTED_WITH_VALUE) },
      addProfileHeader = { profile.addCustomHeader(it) },
    )
    val current = environment
    val defaultUa = WebSettings.getDefaultUserAgent(webView.context)
    val version = Regex("Chrome/([0-9.]+)").find(defaultUa)?.groupValues?.get(1)
    val ua = if (current != null && version != null) {
      "Mozilla/5.0 (Linux; Android ${current.getString("platformVersion")}; ${current.getString("model")}) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$version Safari/537.36"
    } else defaultUa
    webView.settings.userAgentString = ua
    if (WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA) && version != null) {
      val existingMetadata = WebSettingsCompat.getUserAgentMetadata(webView.settings)
      val builder = UserAgentMetadata.Builder(existingMetadata)
        .setFullVersion(version)
        .setPlatform("Android")
        .setPlatformVersion(current?.getString("platformVersion") ?: Build.VERSION.RELEASE)
        .setModel(current?.getString("model") ?: Build.MODEL)
        .setArchitecture(if (current != null || Build.SUPPORTED_ABIS.firstOrNull()?.contains("arm") == true) "arm" else "x86")
        .setBitness(if (Build.SUPPORTED_64_BIT_ABIS.isNotEmpty()) 64 else 32)
        .setWow64(false)
        .setMobile(ua.contains("Mobile"))
        .setFormFactors(listOf(if (ua.contains("Mobile")) "Mobile" else "Tablet"))
        .setBrandVersionList(
          buildUserAgentBrandVersionList(
            existingBrands = existingMetadata.brandVersionList,
            version = version,
            maskAsChrome = current != null,
          ),
        )
      WebSettingsCompat.setUserAgentMetadata(webView.settings, builder.build())
    }
    scripts.remove(webView)?.remove()
    if (current != null) {
      check(isSupported()) { "The saved browser environment needs a newer WebView provider." }
      val source = webView.resources.openRawResource(R.raw.browser_environment)
        .bufferedReader().use { it.readText() }
        .replace("__NOREA_BROWSER_ENVIRONMENT_JSON__", current.toString())
      scripts[webView] = WebViewCompat.addDocumentStartJavaScript(webView, source, setOf("*"))
    }
  }
}
