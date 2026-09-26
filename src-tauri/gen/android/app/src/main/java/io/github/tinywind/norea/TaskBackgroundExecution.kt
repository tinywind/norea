package io.github.tinywind.norea

import java.lang.ref.WeakReference

/** Platform suspension is not a user cancellation and must not discard queued work. */
internal class BackgroundExecutionPolicy {
  @Volatile
  var suspended: Boolean = false
    private set

  fun suspend() { suspended = true }
  fun foreground() { suspended = false }
}

internal object TaskBackgroundExecution {
  val policy = BackgroundExecutionPolicy()
  private var listener: WeakReference<() -> Unit>? = null

  fun attach(callback: () -> Unit) { listener = WeakReference(callback) }
  fun detach(callback: () -> Unit) {
    if (listener?.get() === callback) listener = null
  }
  fun suspend() {
    policy.suspend()
    listener?.get()?.invoke()
  }
}
