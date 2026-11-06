package io.github.tinywind.norea

import android.net.http.SslError
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidVpnUrlTestPolicyTest {
  @Test
  fun urlTestServiceRunsInItsOwnPrivateProcessApartFromDownloadWorkers() {
    val root = generateSequence(File(".").canonicalFile) { it.parentFile }
      .first { File(it, "src-tauri/gen/android/app/src/main/AndroidManifest.xml").isFile }
    val document = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder()
      .parse(File(root, "src-tauri/gen/android/app/src/main/AndroidManifest.xml"))
    val android = "http://schemas.android.com/apk/res/android"
    val nodes = document.getElementsByTagName("service")
    val services = (0 until nodes.length).map { nodes.item(it) as org.w3c.dom.Element }
    val service = services.single { it.getAttributeNS(android, "name") == ".AndroidVpnUrlTestService" }
    assertEquals("false", service.getAttributeNS(android, "exported"))
    assertEquals(ANDROID_VPN_URL_TEST_PROCESS, service.getAttributeNS(android, "process"))
    assertEquals(1, services.count { it.getAttributeNS(android, "process") == ANDROID_VPN_URL_TEST_PROCESS })
    assertEquals("io.github.tinywind.norea.AndroidVpnUrlTestService", AndroidVpnUrlTestService::class.java.name)
  }

  @Test
  fun keepsTheTestBrowserBoundOnlyAfterAnAnsweredLoadThatWasNotCancelled() {
    assertTrue(androidVpnUrlTestKeepsBrowser(answered = true, cancelled = false))
    assertFalse("a cancel ends the run", androidVpnUrlTestKeepsBrowser(answered = true, cancelled = true))
    assertFalse("a timeout or a lost process", androidVpnUrlTestKeepsBrowser(answered = false, cancelled = false))
    assertFalse(androidVpnUrlTestKeepsBrowser(answered = false, cancelled = true))
  }

  @Test
  fun followsOnlyServerRedirectsOfTheMainPage() {
    assertTrue(androidVpnUrlTestFollowsNavigation(isForMainFrame = true, isRedirect = true, scheme = "https"))
    assertTrue(androidVpnUrlTestFollowsNavigation(isForMainFrame = true, isRedirect = true, scheme = "HTTP"))
    assertFalse("script, meta refresh, and form navigations", androidVpnUrlTestFollowsNavigation(true, false, "https"))
    assertFalse("redirects to other schemes", androidVpnUrlTestFollowsNavigation(true, true, "intent"))
    assertFalse(androidVpnUrlTestFollowsNavigation(true, true, null))
    assertFalse("subframe navigations to other schemes", androidVpnUrlTestFollowsNavigation(false, true, "https"))
  }

  @Test
  fun readsResponseHeadersRegardlessOfCase() {
    val headers = mapOf("Server" to "cloudflare", "CF-Mitigated" to "challenge")
    assertEquals("cloudflare", androidVpnUrlTestHeader(headers, "server"))
    assertEquals("challenge", androidVpnUrlTestHeader(headers, "cf-mitigated"))
    assertNull(androidVpnUrlTestHeader(headers, "content-type"))
    assertNull(androidVpnUrlTestHeader(null, "server"))
  }

  @Test
  fun recognizesOnlyNamedTestProfilesAsStale() {
    val name = androidVpnUrlTestProfileName("0b5e5e43-4f2a-4f8e-9d55-2f0d7a6c1b3e")
    assertTrue(isAndroidVpnUrlTestProfile(name))
    assertFalse(isAndroidVpnUrlTestProfile(androidVpnUrlTestProfileName("")))
    assertFalse(isAndroidVpnUrlTestProfile("Default"))
    assertFalse(isAndroidVpnUrlTestProfile(androidScraperProfileName("source")))
    assertFalse(isAndroidVpnUrlTestProfile(androidScraperProfileName("source", "profile")))
  }

  @Test
  fun describesCertificateErrors() {
    assertEquals("The site's TLS certificate is not trusted.", androidVpnUrlTestCertificateError(SslError.SSL_UNTRUSTED))
    assertEquals("The site's TLS certificate has expired.", androidVpnUrlTestCertificateError(SslError.SSL_EXPIRED))
    assertEquals("The site's TLS certificate is invalid.", androidVpnUrlTestCertificateError(99))
  }
}
