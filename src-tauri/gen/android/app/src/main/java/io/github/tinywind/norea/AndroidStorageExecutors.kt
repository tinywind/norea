package io.github.tinywind.norea

import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

internal class AndroidStorageExecutors {
  val foreground = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "NoreaStorageBridge").apply { isDaemon = true }
  }
  val scans = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "NoreaStorageScan").apply {
      isDaemon = true
      priority = Thread.MIN_PRIORITY
    }
  }
  val snapshots = ThreadPoolExecutor(
    1,
    1,
    0L,
    TimeUnit.MILLISECONDS,
    ArrayBlockingQueue<Runnable>(1),
    { runnable ->
      Thread(runnable, "NoreaContentSnapshot").apply {
        isDaemon = true
        priority = Thread.MIN_PRIORITY
      }
    },
  )

  fun destroy() {
    foreground.shutdownNow()
    scans.shutdownNow()
    snapshots.shutdownNow()
  }
}
