package io.github.tinywind.norea

import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidContentSnapshotGuardTest {
  private val root = "content://storage/root"
  private val chapter = "contents/source/Book/1-One"

  @Test
  fun installationInvalidatesAnInProgressSnapshotWithoutWaitingForItsCopy() {
    val guard = AndroidContentSnapshotGuard()
    val worker = Executors.newFixedThreadPool(2)
    val copyStarted = CountDownLatch(1)
    val releaseCopy = CountDownLatch(1)
    try {
      val snapshot = worker.submit<String> {
        guard.snapshot(root, chapter) {
          copyStarted.countDown()
          releaseCopy.await()
          "copied"
        }
      }
      assertTrue(copyStarted.await(5, TimeUnit.SECONDS))
      val installation = worker.submit<String> { guard.install(root, chapter) { "installed" } }
      assertEquals("installed", installation.get(1, TimeUnit.SECONDS))

      releaseCopy.countDown()
      val failure = assertThrows(ExecutionException::class.java) {
        snapshot.get(5, TimeUnit.SECONDS)
      }
      assertTrue(failure.cause is IllegalStateException)
      assertEquals("fresh", guard.snapshot(root, chapter) { "fresh" })
    } finally {
      releaseCopy.countDown()
      worker.shutdownNow()
    }
  }

  @Test
  fun snapshotDoesNotStartReadingDuringAnInstallation() {
    val guard = AndroidContentSnapshotGuard()
    guard.install(root, chapter) {
      assertThrows(IllegalStateException::class.java) {
        guard.snapshot(root, chapter) { throw AssertionError("Snapshot read started during install.") }
      }
    }
    assertEquals("fresh", guard.snapshot(root, chapter) { "fresh" })
  }

  @Test
  fun installationsForAnotherChapterOrRootDoNotInvalidateTheSnapshot() {
    val guard = AndroidContentSnapshotGuard()
    assertEquals("copied", guard.snapshot(root, chapter) {
      guard.install(root, "contents/source/Book/2-Two") { }
      guard.install("content://storage/other", chapter) { }
      "copied"
    })
  }

  @Test
  fun failedInstallationInvalidatesTheSnapshotAndReleasesItsActiveState() {
    val guard = AndroidContentSnapshotGuard()
    assertThrows(IllegalStateException::class.java) {
      guard.snapshot(root, chapter) {
        assertThrows(IOException::class.java) {
          guard.install(root, chapter) { throw IOException("Cannot publish chapter.") }
        }
      }
    }
    assertEquals("fresh", guard.snapshot(root, chapter) { "fresh" })
  }
}
