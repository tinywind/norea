package io.github.tinywind.norea

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidScraperVpnSessionTest {
  @Test
  fun expiresOnlyCloudflareTechnicalCookiesAndKeepsTheirIdentityAttributes() {
    for (name in listOf("cf_clearance", "__cf_bm", "_cfuvid", "__cfwaitingroom", "cf_chl_2", "cf_chl_prog", "__cf_chl_tk")) {
      assertEquals(
        "$name=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Domain=.source.test; Path=/; Secure; Partitioned",
        androidScraperVpnCookieExpiration("$name=opaque; Domain=.source.test; Path=/; HttpOnly; Secure; SameSite=None; Partitioned"),
      )
    }
    for (name in listOf("sessionid", "auth_token", "remember_me", "cf_user", "CF_CLEARANCE")) {
      assertNull(androidScraperVpnCookieExpiration("$name=login; Path=/; Secure"))
    }
  }

  @Test
  fun unchangedMainRouteDoesNotClearCookiesOrBypassCache() {
    val session = AndroidScraperVpnSession()
    var cleanup = false
    var bypass: Boolean? = null
    session.prepare("source", "https://source.test/chapter/1", { cleanup = true }) {
      bypass = it.getOrThrow()
    }
    assertFalse(cleanup)
    assertEquals(false, bypass)
  }

  @Test
  fun firstWorkerRequestWaitsForCookieCallbacksAndBypassesOnlyItsFirstAction() {
    val session = AndroidScraperVpnSession(resetInitially = true)
    var complete: ((Result<Unit>) -> Unit)? = null
    val results = mutableListOf<Boolean>()
    session.prepare("source", "https://source.test/chapter/1", { complete = it }) {
      results.add(it.getOrThrow())
    }
    assertTrue(results.isEmpty())
    assertFalse(session.isReady("source", "https://source.test/chapter/2"))
    complete!!(Result.success(Unit))
    assertEquals(listOf(true), results)
    assertTrue(session.isReady("source", "https://source.test/chapter/2"))
    session.prepare("source", "https://source.test/chapter/2", { error("Unexpected cleanup") }) {
      results.add(it.getOrThrow())
    }
    assertEquals(listOf(true, false), results)
  }

  @Test
  fun aRouteChangeAlsoCleansPreviouslyClosedSourcesWhenTheyAreNextUsed() {
    val session = AndroidScraperVpnSession(resetInitially = true)
    val cleared = mutableListOf<String>()
    fun request(source: String, url: String) {
      session.prepare(source, url, { cleared.add(source); it(Result.success(Unit)) }) { it.getOrThrow() }
    }
    request("first", "https://first.test/chapter/1")
    request("second", "https://second.test/chapter/1")
    session.reset()
    request("first", "https://first.test/chapter/2")
    assertFalse(session.isReady("second", "https://second.test/chapter/2"))
    request("second", "https://second.test/chapter/2")
    assertEquals(listOf("first", "second", "first", "second"), cleared)
  }

  @Test
  fun concurrentQueuesWaitForTheSameCookieCleanupInsteadOfRacingIt() {
    val session = AndroidScraperVpnSession(resetInitially = true)
    var complete: ((Result<Unit>) -> Unit)? = null
    val results = mutableListOf<Boolean>()
    session.prepare("source", "https://source.test/chapter/1", { complete = it }) { results.add(it.getOrThrow()) }
    session.prepare("source", "https://source.test/chapter/2", { error("Duplicate cleanup") }) { results.add(it.getOrThrow()) }
    assertTrue(results.isEmpty())
    complete!!(Result.success(Unit))
    assertEquals(listOf(true, true), results)
  }

  @Test
  fun anOldCleanupCannotReleaseRequestsAfterAnotherRouteChange() {
    val session = AndroidScraperVpnSession(resetInitially = true)
    var previous: ((Result<Unit>) -> Unit)? = null
    var current: ((Result<Unit>) -> Unit)? = null
    val results = mutableListOf<Result<Boolean>>()
    session.prepare("source", "https://source.test/chapter/1", { previous = it }) { results.add(it) }
    session.reset()
    assertTrue(results.single().isFailure)
    session.prepare("source", "https://source.test/chapter/2", { current = it }) { results.add(it) }
    previous!!(Result.success(Unit))
    assertEquals(1, results.size)
    assertFalse(session.isReady("source", "https://source.test/chapter/2"))
    current!!(Result.success(Unit))
    assertEquals(true, results.last().getOrThrow())
  }

  @Test
  fun eachUrlRefreshesOncePerRouteWhileRepeatedUrlsReuseTheUpdatedCache() {
    val session = AndroidScraperVpnSession()
    assertFalse(session.needsFreshResponse("source", "https://source.test/first"))
    session.reset()
    assertTrue(session.needsFreshResponse("source", "https://source.test/first"))
    assertTrue(session.needsFreshResponse("source", "https://source.test/second"))
    session.recordFreshResponse("source", "https://source.test/first")
    assertFalse(session.needsFreshResponse("source", "https://source.test/first#page2"))
    assertTrue(session.needsFreshResponse("source", "https://source.test/second"))
    assertTrue(session.needsFreshResponse("other", "https://source.test/first"))
    session.recordFreshResponse("source", "https://source.test/second")
    assertFalse(session.needsFreshResponse("source", "https://source.test/second"))
    session.reset()
    assertTrue(session.needsFreshResponse("source", "https://source.test/first"))
  }

  @Test
  fun failedCookieCleanupDoesNotPermitNetworkWorkAndCanBeRetried() {
    val session = AndroidScraperVpnSession(resetInitially = true)
    val failure = IllegalStateException("Cookie expiration rejected")
    var error: Throwable? = null
    session.prepare("source", "https://source.test/", { it(Result.failure(failure)) }) { error = it.exceptionOrNull() }
    assertEquals(failure, error)
    assertFalse(session.isReady("source", "https://source.test/"))
    var bypass: Boolean? = null
    session.prepare("source", "https://source.test/", { it(Result.success(Unit)) }) { bypass = it.getOrThrow() }
    assertEquals(true, bypass)
  }
}
