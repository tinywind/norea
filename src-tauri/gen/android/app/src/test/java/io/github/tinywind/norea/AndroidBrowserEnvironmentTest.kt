package io.github.tinywind.norea

import androidx.webkit.CustomHeader
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebViewFeature
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidBrowserEnvironmentTest {
  private fun brand(name: String, major: String, full: String): UserAgentMetadata.BrandVersion =
    UserAgentMetadata.BrandVersion.Builder()
      .setBrand(name)
      .setMajorVersion(major)
      .setFullVersion(full)
      .build()

  @Test
  fun suppressesRequestedWithHeaderWhenMultiProfileAndCustomHeadersAreSupported() {
    val added = mutableListOf<CustomHeader>()
    val supportedFeatures = setOf(
      WebViewFeature.MULTI_PROFILE,
      WebViewFeature.CUSTOM_REQUEST_HEADERS,
    )

    val applied = applyRequestedWithSuppression(
      isFeatureSupported = { it in supportedFeatures },
      getProfileHeaders = { emptySet() },
      addProfileHeader = { added.add(it) },
    )

    assertTrue(applied)
    assertEquals(
      listOf(CustomHeader("X-Requested-With", "", setOf("*"))),
      added,
    )
  }

  @Test
  fun skipsDuplicateRequestedWithHeaderWhenWildcardRuleAlreadyExists() {
    val added = mutableListOf<CustomHeader>()
    val existing = setOf(CustomHeader("x-requested-with", "", setOf("*")))

    val applied = applyRequestedWithSuppression(
      isFeatureSupported = { true },
      getProfileHeaders = { existing },
      addProfileHeader = { added.add(it) },
    )

    assertTrue(applied)
    assertTrue(added.isEmpty())
  }

  @Test
  fun addsWildcardRequestedWithHeaderWhenExistingRuleIsOriginScoped() {
    val added = mutableListOf<CustomHeader>()
    val existing = setOf(CustomHeader("X-Requested-With", "", setOf("https://example.com")))

    val applied = applyRequestedWithSuppression(
      isFeatureSupported = { true },
      getProfileHeaders = { existing },
      addProfileHeader = { added.add(it) },
    )

    assertTrue(applied)
    assertEquals(listOf(suppressedRequestedWithCustomHeader()), added)
  }

  @Test
  fun skipsRequestedWithSuppressionWhenMultiProfileIsUnsupported() {
    var profileTouched = false

    val applied = applyRequestedWithSuppression(
      isFeatureSupported = { it == WebViewFeature.CUSTOM_REQUEST_HEADERS },
      getProfileHeaders = {
        profileTouched = true
        emptySet()
      },
      addProfileHeader = { profileTouched = true },
    )

    assertFalse(applied)
    assertFalse(profileTouched)
  }

  @Test
  fun skipsRequestedWithSuppressionWhenCustomRequestHeadersIsUnsupported() {
    var profileTouched = false

    val applied = applyRequestedWithSuppression(
      isFeatureSupported = { it == WebViewFeature.MULTI_PROFILE },
      getProfileHeaders = {
        profileTouched = true
        emptySet()
      },
      addProfileHeader = { profileTouched = true },
    )

    assertFalse(applied)
    assertFalse(profileTouched)
  }

  @Test
  fun siteNavigationHeadersSuppressesRequestedWithForHttpAndHttpsUrls() {
    assertEquals(
      mapOf("X-Requested-With" to ""),
      siteNavigationHeaders("https://example.com/chapter/1"),
    )
    assertEquals(
      mapOf("X-Requested-With" to ""),
      siteNavigationHeaders("HTTP://example.com/chapter/1"),
    )
    assertEquals(
      mapOf(
        "X-Requested-With" to "",
        "Cache-Control" to "no-cache",
        "Pragma" to "no-cache",
      ),
      siteNavigationHeaders("https://example.com/chapter/1", bypassCache = true),
    )
  }

  @Test
  fun siteNavigationHeadersSkipsNonHttpUrls() {
    assertEquals(emptyMap<String, String>(), siteNavigationHeaders("about:blank"))
    assertEquals(emptyMap<String, String>(), siteNavigationHeaders("about:blank", bypassCache = true))
    assertEquals(emptyMap<String, String>(), siteNavigationHeaders("data:text/html,ok"))
    assertEquals(emptyMap<String, String>(), siteNavigationHeaders(""))
  }

  @Test
  fun buildUserAgentBrandVersionListPreservesGreaseBrandAndOrder() {
    val existing = listOf(
      brand("Not:A-Brand", "99", "99.0.0.0"),
      brand("Android WebView", "157", "157.0.8103.52"),
      brand("Chromium", "157", "157.0.8103.52"),
    )

    val masked = buildUserAgentBrandVersionList(existing, "157.0.8103.52", maskAsChrome = true)
    assertEquals(
      listOf(
        brand("Not:A-Brand", "99", "99.0.0.0"),
        brand("Google Chrome", "157", "157.0.8103.52"),
        brand("Chromium", "157", "157.0.8103.52"),
      ),
      masked,
    )

    val unmasked = buildUserAgentBrandVersionList(existing, "157.0.8103.52", maskAsChrome = false)
    assertEquals(
      listOf(
        brand("Not:A-Brand", "99", "99.0.0.0"),
        brand("Android WebView", "157", "157.0.8103.52"),
        brand("Chromium", "157", "157.0.8103.52"),
      ),
      unmasked,
    )
  }

  @Test
  fun buildUserAgentBrandVersionListIsIdempotentAcrossRepeatedAppliesAndToggles() {
    val initial = listOf(
      brand("Chromium", "156", "156.0.7000.1"),
      brand("Not/A)Brand", "8", "8.0.0.0"),
      brand("Android WebView", "156", "156.0.7000.1"),
    )

    val firstMasked = buildUserAgentBrandVersionList(initial, "157.0.8103.52", maskAsChrome = true)
    val secondMasked = buildUserAgentBrandVersionList(firstMasked, "157.0.8103.52", maskAsChrome = true)
    val restored = buildUserAgentBrandVersionList(secondMasked, "157.0.8103.52", maskAsChrome = false)
    val remasked = buildUserAgentBrandVersionList(restored, "157.0.8103.52", maskAsChrome = true)

    assertEquals(firstMasked, secondMasked)
    assertEquals(firstMasked, remasked)
    assertEquals(
      listOf(
        brand("Chromium", "157", "157.0.8103.52"),
        brand("Not/A)Brand", "8", "8.0.0.0"),
        brand("Android WebView", "157", "157.0.8103.52"),
      ),
      restored,
    )
  }

  @Test
  fun buildUserAgentBrandVersionListAddsFallbackGreaseWhenMissing() {
    val fromEmpty = buildUserAgentBrandVersionList(emptyList(), "157.0.8103.52", maskAsChrome = true)
    assertEquals(
      listOf(
        brand("Not;A=Brand", "99", "99.0.0.0"),
        brand("Chromium", "157", "157.0.8103.52"),
        brand("Google Chrome", "157", "157.0.8103.52"),
      ),
      fromEmpty,
    )

    val withoutGrease = buildUserAgentBrandVersionList(
      listOf(
        brand("Chromium", "157", "157.0.8103.52"),
        brand("Android WebView", "157", "157.0.8103.52"),
      ),
      "157.0.8103.52",
      maskAsChrome = false,
    )
    assertEquals(
      listOf(
        brand("Not;A=Brand", "99", "99.0.0.0"),
        brand("Chromium", "157", "157.0.8103.52"),
        brand("Android WebView", "157", "157.0.8103.52"),
      ),
      withoutGrease,
    )
  }
}
