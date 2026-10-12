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
  fun destroyInterruptsBothWorkersAndRejectsNewOperations() {
    val executors = AndroidStorageExecutors()
    val operationsStarted = CountDownLatch(2)
    val operationsInterrupted = CountDownLatch(2)
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
      assertTrue(operationsStarted.await(5, TimeUnit.SECONDS))

      executors.destroy()
      assertTrue(operationsInterrupted.await(5, TimeUnit.SECONDS))
      assertThrows(RejectedExecutionException::class.java) {
        executors.foreground.execute { }
      }
      assertThrows(RejectedExecutionException::class.java) {
        executors.snapshots.execute { }
      }
    } finally {
      releaseOperations.countDown()
      executors.destroy()
    }
  }
}
