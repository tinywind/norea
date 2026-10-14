package io.github.tinywind.norea

import java.util.concurrent.CountDownLatch
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidStorageExecutorsTest {
  @Test
  fun foregroundStorageCompletesWhileFolderScanIsBlocked() {
    val executors = AndroidStorageExecutors()
    val scanStarted = CountDownLatch(1)
    val releaseScan = CountDownLatch(1)
    try {
      val scan = executors.scans.submit {
        scanStarted.countDown()
        releaseScan.await()
      }
      assertTrue(scanStarted.await(5, TimeUnit.SECONDS))
      assertEquals("read", executors.foreground.submit<String> { "read" }.get(1, TimeUnit.SECONDS))
      releaseScan.countDown()
      scan.get(5, TimeUnit.SECONDS)
    } finally {
      releaseScan.countDown()
      executors.destroy()
    }
  }
  @Test
  fun foregroundStorageCompletesWhileSnapshotIsBlocked() {
    val executors = AndroidStorageExecutors()
    val snapshotStarted = CountDownLatch(1)
    val releaseSnapshot = CountDownLatch(1)
    try {
      val snapshot = executors.snapshots.submit {
        snapshotStarted.countDown()
        releaseSnapshot.await()
      }
      assertTrue(snapshotStarted.await(5, TimeUnit.SECONDS))

      val foreground = executors.foreground.submit<String> { "stored" }
      assertEquals("stored", foreground.get(1, TimeUnit.SECONDS))

      releaseSnapshot.countDown()
      snapshot.get(5, TimeUnit.SECONDS)
    } finally {
      releaseSnapshot.countDown()
      executors.destroy()
    }
  }

  @Test
  fun snapshotsHaveOneWorkerAndOneWaitingSlot() {
    val executors = AndroidStorageExecutors()
    val snapshotStarted = CountDownLatch(1)
    val releaseSnapshot = CountDownLatch(1)
    try {
      executors.snapshots.execute {
        snapshotStarted.countDown()
        releaseSnapshot.await()
      }
      assertTrue(snapshotStarted.await(5, TimeUnit.SECONDS))
      val waiting = executors.snapshots.submit<String> { "copied" }

      assertThrows(RejectedExecutionException::class.java) {
        executors.snapshots.execute { }
      }

      releaseSnapshot.countDown()
      assertEquals("copied", waiting.get(5, TimeUnit.SECONDS))
    } finally {
      releaseSnapshot.countDown()
      executors.destroy()
    }
  }

  @Test
  fun destroyInterruptsAllWorkersAndRejectsNewOperations() {
    val executors = AndroidStorageExecutors()
    val operationsStarted = CountDownLatch(3)
    val operationsInterrupted = CountDownLatch(3)
    val releaseOperations = CountDownLatch(1)
    val operation = Runnable {
      operationsStarted.countDown()
      try {
        releaseOperations.await()
      } catch (_: InterruptedException) {
        operationsInterrupted.countDown()
      }
    }
    try {
      executors.foreground.execute(operation)
      executors.snapshots.execute(operation)
      executors.scans.execute(operation)
      assertTrue(operationsStarted.await(5, TimeUnit.SECONDS))

      executors.destroy()
      assertTrue(operationsInterrupted.await(5, TimeUnit.SECONDS))
      assertThrows(RejectedExecutionException::class.java) {
        executors.foreground.execute { }
      }
      assertThrows(RejectedExecutionException::class.java) {
        executors.snapshots.execute { }
      }
      assertThrows(RejectedExecutionException::class.java) {
        executors.scans.execute { }
      }
    } finally {
      releaseOperations.countDown()
      executors.destroy()
    }
  }
}
