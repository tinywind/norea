package io.github.tinywind.norea

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process
import android.os.SystemClock
import androidx.annotation.Keep
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import org.json.JSONObject

private const val ANDROID_VPN_URL_TEST_SETUP_TIMEOUT_MS = 20_000L
private const val ANDROID_VPN_URL_TEST_EXIT_TIMEOUT_MS = 5_000L
// Covers several dead servers in a row (each up to a 20 s connect plus close) so a run keeps one browser process.
private const val ANDROID_VPN_URL_TEST_IDLE_TIMEOUT_MS = 120_000L

/**
 * Main-process side of VPN URL tests. Rust calls [load] from a blocking thread while its test
 * tunnel is up. The `:vpn_url_test` process is bound on the first load of a run and kept for the
 * following loads, because some Android builds refuse to start a process for an app that is not
 * in the foreground. It is released after an idle period, a cancel, or a failed load, and exits.
 */
@Keep
object AndroidVpnUrlTestBridge {
  private class Test(
    val id: Long,
    val url: String,
    val proxyPort: Int,
    val userAgent: String,
    val pageTimeoutMs: Int,
  ) {
    val result = CompletableFuture<String>()
    @Volatile var delivered = false
    @Volatile var cancelled = false
    // Main thread only.
    var answered = false
  }

  private class Connection : ServiceConnection {
    var bound = true
    var remote: Messenger? = null
    var binder: IBinder? = null

    override fun onServiceConnected(name: ComponentName, service: IBinder) = onConnected(this, service)
    override fun onServiceDisconnected(name: ComponentName) = onLost(this)
    override fun onBindingDied(name: ComponentName) = onLost(this)
  }

  private val handler = Handler(Looper.getMainLooper())
  private val receiver = Messenger(Handler(Looper.getMainLooper()) { message -> receive(message); true })
  private val idle = Runnable { if (current == null) connection?.let(::release) }
  private val lock = Any()
  @Volatile private var context: Context? = null
  // Guarded by lock.
  private var active: Test? = null
  private var cancelledThrough = 0L
  // Main thread only.
  private var connection: Connection? = null
  private var current: Test? = null
  @Volatile private var previousProcess: IBinder? = null

  init {
    System.loadLibrary("app_lib")
  }

  @JvmStatic
  private external fun register()

  @Synchronized
  fun start(context: Context) {
    if (this.context != null) return
    this.context = context.applicationContext
    register()
  }

  /** Loads [url] once in the test browser process and returns what the load observed as JSON. */
  @Keep
  @JvmStatic
  fun load(id: Long, url: String, proxyPort: Int, userAgent: String, pageTimeoutMs: Int): String {
    check(Looper.myLooper() != Looper.getMainLooper()) { "VPN URL tests must not block the main thread." }
    require(pageTimeoutMs in 1..ANDROID_VPN_URL_TEST_MAX_PAGE_TIMEOUT_MS) { "VPN URL test page timeout is invalid." }
    if (Build.VERSION.SDK_INT < 28) return failure("VPN URL tests require Android 9 or newer.")
    val context = checkNotNull(context) { "VPN URL test bridge is not started." }
    if (!awaitPreviousProcessExit()) return failure("The previous VPN URL test browser is still closing.")
    val test = Test(id, url, proxyPort, userAgent, pageTimeoutMs)
    synchronized(lock) {
      if (id <= cancelledThrough) return cancelled()
      check(active == null) { "Another VPN URL test is running." }
      active = test
    }
    try {
      handler.post { begin(context, test) }
      return try {
        test.result.get(pageTimeoutMs + ANDROID_VPN_URL_TEST_SETUP_TIMEOUT_MS, TimeUnit.MILLISECONDS)
      } catch (_: TimeoutException) {
        if (test.delivered) failure("The VPN URL test browser did not answer in time.") else browserUnavailable()
      }
    } finally {
      synchronized(lock) { if (active === test) active = null }
      val settled = CountDownLatch(1)
      handler.post { finish(test); settled.countDown() }
      settled.await(ANDROID_VPN_URL_TEST_EXIT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    }
  }

  /** Ends the wait of [load] for [id], or makes a later [load] of it return at once. */
  @Keep
  @JvmStatic
  fun cancel(id: Long) {
    val test = synchronized(lock) {
      cancelledThrough = maxOf(cancelledThrough, id)
      active?.takeIf { it.id == id }
    }
    test?.cancelled = true
    test?.result?.complete(cancelled())
  }

  private fun awaitPreviousProcessExit(): Boolean {
    val binder = previousProcess ?: return true
    val deadline = SystemClock.elapsedRealtime() + ANDROID_VPN_URL_TEST_EXIT_TIMEOUT_MS
    // isBinderAlive only changes on a death notice, and unbinding drops the framework's, so ping instead.
    while (binder.pingBinder()) {
      if (SystemClock.elapsedRealtime() >= deadline) return false
      Thread.sleep(50)
    }
    previousProcess = null
    return true
  }

  private fun begin(context: Context, test: Test) {
    handler.removeCallbacks(idle)
    if (test.result.isDone) return
    current = test
    val bound = connection ?: bind(context)
    if (bound == null) {
      test.result.complete(browserUnavailable())
      return
    }
    bound.remote?.let { remote -> send(bound, remote, test) }
  }

  private fun bind(context: Context): Connection? {
    val created = Connection()
    val bound = runCatching {
      context.bindService(
        Intent(context, AndroidVpnUrlTestService::class.java), created,
        Context.BIND_AUTO_CREATE or Context.BIND_IMPORTANT,
      )
    }.getOrDefault(false)
    if (!bound) {
      // The connection is released even when the system refused to start the service.
      created.bound = false
      runCatching { context.unbindService(created) }
      return null
    }
    connection = created
    return created
  }

  private fun onConnected(bound: Connection, service: IBinder) {
    if (connection !== bound) return
    val remote = Messenger(service)
    bound.binder = service
    bound.remote = remote
    current?.takeIf { !it.result.isDone }?.let { test -> send(bound, remote, test) }
  }

  private fun send(bound: Connection, remote: Messenger, test: Test) {
    val message = Message.obtain(null, VPN_URL_TEST_LOAD).apply {
      replyTo = receiver
      data = Bundle().apply {
        putLong("ticket", test.id)
        putString("url", test.url)
        putInt("proxyPort", test.proxyPort)
        putString("userAgent", test.userAgent)
        putInt("pageTimeoutMs", test.pageTimeoutMs)
      }
    }
    runCatching { remote.send(message) }
      .onSuccess { test.delivered = true }
      .onFailure {
        test.result.complete(failure("The VPN URL test browser could not be reached."))
        release(bound)
      }
  }

  private fun receive(message: Message) {
    if (message.sendingUid != Process.myUid() || message.what != VPN_URL_TEST_RESULT) return
    val test = current?.takeIf { it.id == message.data.getLong("ticket") } ?: return
    test.answered = true
    test.result.complete(message.data.getString("observation") ?: failure("The VPN URL test browser sent no result."))
  }

  private fun onLost(lost: Connection) {
    if (connection !== lost) return
    current?.result?.complete(failure("The VPN URL test browser stopped unexpectedly."))
    release(lost)
  }

  private fun finish(test: Test) {
    if (current === test) current = null
    val bound = connection ?: return
    if (androidVpnUrlTestKeepsBrowser(test.answered, test.cancelled)) {
      handler.postDelayed(idle, ANDROID_VPN_URL_TEST_IDLE_TIMEOUT_MS)
    } else {
      release(bound)
    }
  }

  private fun release(bound: Connection) {
    handler.removeCallbacks(idle)
    if (connection === bound) connection = null
    if (!bound.bound) return
    bound.bound = false
    bound.binder?.let { previousProcess = it }
    runCatching { context?.unbindService(bound) }
  }

  private fun failure(reason: String): String = androidVpnUrlTestFailure(reason).toString()

  private fun browserUnavailable(): String = JSONObject().put("kind", "browserUnavailable").toString()

  private fun cancelled(): String = JSONObject().put("kind", "cancelled").toString()
}
