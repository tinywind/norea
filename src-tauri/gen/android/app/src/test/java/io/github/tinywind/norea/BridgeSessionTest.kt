package io.github.tinywind.norea

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeSessionTest {
  @Test
  fun acceptsLegacyCallsWithoutAuthorityFields() {
    val session = BridgeSession()

    val authority = session.validate(
      BridgeCapabilities.SCRAPER_FETCH,
      BridgeAuthorityFields(),
    )

    assertTrue(authority.legacy)
    assertEquals(BridgeCapabilities.SCRAPER_FETCH, authority.capability)
  }

  @Test
  fun acceptsMatchingCapabilityAndSingleUseNonce() {
    val session = BridgeSession()
    val nonce = session.newNonce()

    val authority = session.validate(
      BridgeCapabilities.UPDATE_OPEN_APK,
      BridgeAuthorityFields(
        token = session.sessionToken,
        capability = BridgeCapabilities.UPDATE_OPEN_APK,
        nonce = nonce,
      ),
    )

    assertFalse(authority.legacy)
    assertEquals(nonce, authority.nonce)
  }

  @Test
  fun rejectsNonceReplay() {
    val session = BridgeSession()
    val fields = BridgeAuthorityFields(
      token = session.sessionToken,
      capability = BridgeCapabilities.SCRAPER_EXTRACT,
      nonce = session.newNonce(),
    )

    session.validate(BridgeCapabilities.SCRAPER_EXTRACT, fields)

    assertThrows(IllegalArgumentException::class.java) {
      session.validate(BridgeCapabilities.SCRAPER_EXTRACT, fields)
    }
  }

  @Test
  fun rejectsWrongCapability() {
    val session = BridgeSession()

    assertThrows(IllegalArgumentException::class.java) {
      session.validate(
        BridgeCapabilities.SCRAPER_FETCH,
        BridgeAuthorityFields(
          token = session.sessionToken,
          capability = BridgeCapabilities.UPDATE_OPEN_APK,
          nonce = session.newNonce(),
        ),
      )
    }
  }

  @Test
  fun rejectsWrongToken() {
    val session = BridgeSession()

    assertThrows(IllegalArgumentException::class.java) {
      session.validate(
        BridgeCapabilities.UPDATE_OPEN_APK,
        BridgeAuthorityFields(
          token = "wrong-token",
          capability = BridgeCapabilities.UPDATE_OPEN_APK,
          nonce = session.newNonce(),
        ),
      )
    }
  }
}
