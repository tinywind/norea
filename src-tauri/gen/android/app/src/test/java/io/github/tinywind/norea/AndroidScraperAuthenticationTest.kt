package io.github.tinywind.norea

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidScraperAuthenticationTest {
  @Test
  fun authenticationAndFollowingDownloadsKeepTheBlockedBrowserSession() {
    val foreground = AndroidScraperState("immediate").apply { sourceId = "other-source" }
    val worker = AndroidScraperState("pool:1").apply {
      sourceId = "novel-source"
      pendingChallengeUrl = "https://source.test/chapter/32"
      currentUrl = pendingChallengeUrl
    }
    val queues = mutableMapOf("immediate" to foreground, "pool:1" to worker)

    assertTrue(promoteScraperAuthentication(queues, "novel-source"))
    assertSame(worker, queues["immediate"])
    assertEquals("immediate", worker.key)
    assertEquals("pool:1", worker.authenticationReturnQueue)
    assertEquals("https://source.test/chapter/32", worker.currentUrl)

    worker.pendingChallengeUrl = null
    assertTrue(restoreScraperAuthentication(queues))
    assertSame(worker, queues["pool:1"])
    assertSame(foreground, queues["immediate"])
    assertEquals("pool:1", worker.key)
    assertEquals("other-source", foreground.sourceId)
  }

  @Test
  fun neverTransfersAnActiveWorkerOrAnUnrelatedSource() {
    val foreground = AndroidScraperState("immediate")
    val worker = AndroidScraperState("pool:0").apply {
      sourceId = "novel-source"
      pendingChallengeUrl = "https://source.test/chapter/32"
      busy = true
    }
    val queues = mutableMapOf("immediate" to foreground, "pool:0" to worker)

    assertFalse(promoteScraperAuthentication(queues, "novel-source"))
    worker.busy = false
    assertFalse(promoteScraperAuthentication(queues, "comic-source"))
    foreground.blankNavigationInProgress = true
    assertFalse(promoteScraperAuthentication(queues, "novel-source"))
    assertSame(worker, queues["pool:0"])
    assertSame(foreground, queues["immediate"])
  }

  @Test
  fun neverReturnsABrowserWhileVerificationIsRunning() {
    val worker = AndroidScraperState("pool:0").apply {
      sourceId = "novel-source"
      pendingChallengeUrl = "https://source.test/chapter/32"
    }
    val queues = mutableMapOf("immediate" to AndroidScraperState("immediate"), "pool:0" to worker)
    assertTrue(promoteScraperAuthentication(queues, "novel-source"))
    worker.busy = true
    assertFalse(restoreScraperAuthentication(queues))
    assertSame(worker, queues["immediate"])
    worker.busy = false
    assertTrue(restoreScraperAuthentication(queues))
    assertSame(worker, queues["pool:0"])
  }

  @Test
  fun followsTheResumedSourceWhenItsWorkerAssignmentChanges() {
    val previousForeground = AndroidScraperState("immediate")
    val authenticated = AndroidScraperState("pool:0").apply {
      sourceId = "novel-source"
      pendingChallengeUrl = "https://source.test/chapter/32"
    }
    val nextWorker = AndroidScraperState("pool:1")
    val queues = mutableMapOf(
      "immediate" to previousForeground,
      "pool:0" to authenticated,
      "pool:1" to nextWorker,
    )

    assertTrue(promoteScraperAuthentication(queues, "novel-source"))
    assertTrue(restoreScraperAuthentication(queues, "pool:1"))
    assertSame(authenticated, queues["pool:1"])
    assertSame(previousForeground, queues["pool:0"])
    assertSame(nextWorker, queues["immediate"])
    assertEquals("pool:1", authenticated.key)
    assertEquals(null, authenticated.authenticationReturnQueue)
  }
}
