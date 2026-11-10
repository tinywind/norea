package io.github.tinywind.norea

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process
import android.os.SystemClock
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.webkit.WebViewFeature
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject

internal class AndroidVpnDownloadWorkers(
  private val activity: Activity,
  private val webView: WebView,
  private val bridgeSession: BridgeSession,
  private val isForeground: () -> Boolean,
) {
  private data class Pending(val id: String, val method: String, val worker: Worker, val timeout: Runnable)
  private val handler = Handler(Looper.getMainLooper())
  private val transport = AndroidVpnWorkerTransport(activity)
  private val nextTicket = AtomicLong()
  private val submitted = ConcurrentHashMap<Long, String>()
  private val pending = mutableMapOf<Long, Pending>()
  private val deferredSources = mutableMapOf<Long, JSONObject>()
  private val bootstrapTick = Runnable { drainDeferredSources() }
  private val workers = arrayOfNulls<Worker>(MAX_VPN_DOWNLOAD_WORKERS)
  private val lastGenerations = LongArray(MAX_VPN_DOWNLOAD_WORKERS)
  private val lastConfigurations = arrayOfNulls<AndroidVpnWorkerConfiguration>(MAX_VPN_DOWNLOAD_WORKERS)
  private var executionActive = false
  @Volatile private var closed = false

  private inner class Worker(var configuration: AndroidVpnWorkerConfiguration) : ServiceConnection {
    var remote: Messenger? = null
    var bound = false
    var ready = false
    var executionBootstrap = AndroidVpnWorkerExecutionBootstrap()
    val manualState = AndroidVpnWorkerManualState(configuration.generation)
    val manualOpen: Boolean get() = manualState.open
    var deferredConfiguration: Pair<Long, String>? = null
    val receiver = Messenger(Handler(Looper.getMainLooper()) { message -> receive(this, message); true })

    override fun onServiceConnected(name: ComponentName, service: IBinder) {
      if (closed || workers[configuration.slot] !== this || !bound) { unbind(this); return }
      remote = Messenger(service)
      deferredConfiguration?.let { (ticket, payload) -> send(this, ticket, payload) }
      deferredConfiguration = null
    }

    override fun onServiceDisconnected(name: ComponentName) = failWorker(this, "VPN worker process disconnected.")
    override fun onBindingDied(name: ComponentName) = failWorker(this, "VPN worker binding died.")
    override fun onNullBinding(name: ComponentName) = failWorker(this, "VPN worker binding was rejected.")
  }

  @JavascriptInterface
  fun capabilities(): String {
    val api = Build.VERSION.SDK_INT
    val result = runCatching {
      androidVpnWorkerCapabilities(
        api,
        api >= 28 && WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE),
        api >= 28 && WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE),
      )
    }.getOrElse { androidVpnWorkerCapabilities(api, false, false) }
    return JSONObject(result).toString()
  }

  @JavascriptInterface
  fun request(payload: String) {
    val ticket = nextTicket.incrementAndGet()
    var id: String? = null
    runCatching {
      require(payload.length.toLong() <= VPN_WORKER_REQUEST_LIMIT && payload.toByteArray(Charsets.UTF_8).size.toLong() <= VPN_WORKER_REQUEST_LIMIT) {
        "VPN worker request exceeds its byte limit."
      }
      val json = JSONObject(payload)
      id = (json.opt("id") as? String)?.takeIf { it.isNotBlank() && it.toByteArray(Charsets.UTF_8).size <= 512 }
      require(id != null) { "VPN worker request id is invalid." }
      bridgeSession.validateAuthenticated(BridgeCapabilities.VPN_WORKER, bridgeAuthorityFields(json))
      check(!closed) { "VPN worker bridge is closed." }
      require(submitted.size < VPN_WORKER_MAX_PENDING * MAX_VPN_DOWNLOAD_WORKERS) { "VPN worker request limit reached." }
      // The remote process mints its own authority; the UI session never crosses this boundary.
      for (field in listOf("_bridge", "bridge", "bridgeToken", "capability", "nonce")) json.remove(field)
      submitted[ticket] = id!!
      handler.post {
        val requestId = submitted.remove(ticket) ?: return@post
        if (closed) { resolve(requestId, workerError("VPN worker bridge is closed.")); return@post }
        runCatching { dispatch(ticket, requestId, json) }.onFailure { error ->
          finish(ticket, workerError(error.message ?: "VPN worker request failed."), fallbackId = requestId)
        }
      }
    }.onFailure { error -> id?.let { requestId -> handler.post { resolve(requestId, workerError(error.message ?: "VPN worker request failed.")) } } }
  }

  private fun dispatch(ticket: Long, id: String, json: JSONObject) {
    check(Build.VERSION.SDK_INT >= 28) { "VPN browser workers require Android 9 or newer." }
    val method = json.opt("method") as? String ?: throw IllegalArgumentException("VPN worker method is missing.")
    if (method == "configureWorker" || method == "ensureWorker") {
      configure(ticket, id, json, method == "ensureWorker")
      return
    }
    if (method !in setOf("closeWorker", "showWorker")) androidVpnWorkerCapability(method)
    val queue = parseAndroidVpnWorkerQueue(json.getString("queue"))
    if (method == "closeWorker" && lastConfigurations[queue.slot]?.generation == queue.generation) {
      require(json.opt("sourceId") == lastConfigurations[queue.slot]?.sourceId) { "VPN worker source does not match its configuration." }
      lastConfigurations[queue.slot] = null
    }
    if (method == "closeWorker" && androidVpnWorkerCloseAlreadySettled(queue.generation, workers[queue.slot]?.configuration?.generation)) {
      settleClosedRoute(queue, id)
      return
    }
    val worker = workers[queue.slot] ?: throw IllegalStateException("VPN worker is not configured or has disconnected.")
    check(worker.ready || !androidVpnWorkerRequiresReady(method)) { "VPN worker is not ready." }
    require(worker.configuration.generation == queue.generation) { "VPN worker generation is stale." }
    require(json.opt("sourceId") == worker.configuration.sourceId) { "VPN worker source does not match its configuration." }
    if (method == "cancel") {
      val targetId = json.optString("targetId", id)
      val held = deferredSources.keys.firstOrNull { pending[it]?.let { request -> request.worker === worker && request.id == targetId } == true }
      if (held != null) {
        finish(held, workerError(json.optString("message", "VPN worker request cancelled.")))
        if (id != targetId) resolve(id, workerSuccess(true))
        return
      }
      if (pending.values.any { it.worker === worker && it.id == targetId && it.method == "configureWorker" }) {
        failWorker(worker, json.optString("message", "VPN worker configuration cancelled."))
        if (id != targetId) resolve(id, workerSuccess(true))
        return
      }
    }
    if (method == "cancelBackground") rejectDeferredSources(worker, json.optString("message", "VPN worker background work cancelled."))
    if (method in setOf("cancel", "cancelBackground") && worker.remote == null) {
      resolve(id, workerSuccess(true))
      return
    }
    if (method == "closeWorker") {
      worker.ready = false
      cancelPending(worker, "VPN worker closed.")
      if (worker.remote == null) {
        failWorker(worker, "VPN worker closed.")
        settleClosedRoute(queue, id)
        return
      }
    }
    if (method in setOf("extract", "fetch")) {
      val bootstrap = bootstrapDecision(worker)
      check(bootstrap != AndroidVpnWorkerBootstrapDecision.REJECT) { "VPN worker task execution anchor is unavailable." }
      addPending(ticket, id, method, worker, json)
      if (bootstrap == AndroidVpnWorkerBootstrapDecision.WAIT) {
        deferredSources[ticket] = json
        scheduleBootstrapTick()
        return
      }
      sendExecutionState(worker)
      send(worker, ticket, json.toString())
      return
    }
    if (method !in setOf("closeWorker", "showWorker")) {
      check(androidVpnWorkerMayExecute(method, executionAnchorReady(), worker.manualOpen || method == "navigate")) {
        "VPN worker requires active task execution and a closed manual browser for downloads."
      }
    }
    addPending(ticket, id, method, worker, json)
    if (method == "showWorker" || method == "navigate") worker.manualState.expectOpen()
    send(worker, ticket, json.toString())
  }

  private fun configure(ticket: Long, id: String, json: JSONObject, restoring: Boolean = false) {
    val configuration = androidVpnWorkerConfiguration(
      json.opt("slot"), json.opt("generation"),
      json.opt("sourceId") as? String ?: "", json.opt("profileId") as? String ?: "", json.opt("proxyPort"),
      json.optString("profileHash"), json.optBoolean("rotateFingerprintOnVpnChange", false),
    )
    json.put("_appOrigin", androidVpnWorkerAppOrigin(webView.url))
    check(workers.indices.none { it != configuration.slot && workers[it] != null }) { "Only one shared-profile browser worker may run at a time." }
    var previous = workers[configuration.slot]
    if (restoring) {
      require(lastConfigurations[configuration.slot]?.copy(rotateFingerprintOnVpnChange = configuration.rotateFingerprintOnVpnChange) == configuration) { "VPN worker recovery route is stale." }
      if (previous?.remote?.binder?.isBinderAlive == false) {
        failWorker(previous, "VPN worker process disconnected.")
        previous = null
      }
      if (previous?.ready == true && previous.configuration.copy(rotateFingerprintOnVpnChange = configuration.rotateFingerprintOnVpnChange) == configuration) {
        resolve(id, workerSuccess(true))
        return
      }
      check(previous == null) { "VPN worker configuration is still pending." }
      json.put("method", "configureWorker")
    } else {
      require(configuration.generation > lastGenerations[configuration.slot]) { "VPN worker generation is stale." }
    }
    check(previous?.manualOpen != true) { "VPN worker manual browser must close before replacing its IP." }
    require(pending.values.none { it.id == id && it.worker !== previous }) { "VPN worker request id is duplicated." }
    val worker = previous ?: Worker(configuration).also { workers[configuration.slot] = it }
    cancelPending(worker, "VPN worker reconfigured.")
    lastGenerations[configuration.slot] = configuration.generation
    lastConfigurations[configuration.slot] = configuration
    worker.configuration = configuration
    worker.executionBootstrap = AndroidVpnWorkerExecutionBootstrap()
    worker.manualState.beginGeneration(configuration.generation)
    worker.ready = false
    addPending(ticket, id, "configureWorker", worker, json)
    if (worker.remote != null) {
      send(worker, ticket, json.toString())
      return
    }
    worker.deferredConfiguration = ticket to json.toString()
    if (worker.bound) return
    val service = androidVpnDownloadWorkerServiceClass(configuration.slot)
    try {
      val manualActivityFlag = if (Build.VERSION.SDK_INT >= 34) Context.BIND_ALLOW_ACTIVITY_STARTS else 0
      worker.bound = activity.bindService(
        Intent(activity, service), worker, Context.BIND_AUTO_CREATE or Context.BIND_IMPORTANT or manualActivityFlag,
      )
      check(worker.bound) { "VPN worker service could not be bound." }
    } catch (error: RuntimeException) {
      failWorker(worker, error.message ?: "VPN worker binding failed.")
    }
  }

  private fun addPending(ticket: Long, id: String, method: String, worker: Worker, json: JSONObject) {
    require(pending.values.count { it.worker === worker } < VPN_WORKER_MAX_PENDING) { "VPN worker request limit reached." }
    require(method == "cancel" || pending.values.none { it.id == id }) { "VPN worker request id is duplicated." }
    val timeout = Runnable { failWorker(worker, "VPN worker response timed out.") }
    pending[ticket] = Pending(id, method, worker, timeout)
    val timeoutMs = if (method == "configureWorker") 75_000L else
      json.optLong("timeoutMs", 60_000L).coerceIn(1L, Long.MAX_VALUE - 30_000L) + 30_000L
    handler.postDelayed(timeout, timeoutMs)
  }

  private fun send(worker: Worker, ticket: Long, payload: String) {
    val remote = worker.remote ?: return
    transport.send(remote, VPN_WORKER_REQUEST, ticket, payload, VPN_WORKER_REQUEST_LIMIT, worker.receiver) { error ->
      if (workers[worker.configuration.slot] === worker) failWorker(worker, error.message ?: "VPN worker transfer failed.")
    }
  }

  private fun receive(worker: Worker, message: Message) {
    if (message.sendingUid != Process.myUid() || closed || workers[worker.configuration.slot] !== worker) {
      discardPayload(message)
      return
    }
    if (message.what == VPN_WORKER_MANUAL_CLOSED) {
      if (worker.manualState.apply(message.data.getLong("generation"), message.data.getLong("revision"), false)) {
        val detail = JSONObject(androidVpnWorkerBrowserHiddenDetail(worker.configuration))
        webView.evaluateJavascript(
          "window.dispatchEvent(new CustomEvent('norea-vpn-worker-browser-hidden', {detail: $detail}));", null,
        )
      }
      return
    }
    if (message.what == VPN_WORKER_TRANSFER_FAILED) {
      failWorker(worker, "VPN worker response transfer failed.")
      return
    }
    if (message.what != VPN_WORKER_RESPONSE || pending[message.data.getLong("ticket")]?.worker !== worker) {
      discardPayload(message)
      return
    }
    transport.receive(message, VPN_WORKER_RESPONSE_LIMIT) { ticket, result ->
      val request = pending[ticket]?.takeIf { it.worker === worker } ?: return@receive
      result.fold(
        onSuccess = { envelope ->
          val json = runCatching { JSONObject(envelope) }.getOrNull()
          if (json == null || !json.has("ok")) { failWorker(worker, "VPN worker response is invalid."); return@fold }
          if (request.method == "configureWorker") {
            worker.ready = json.optBoolean("ok") && json.optJSONObject("result")?.optBoolean("configured") == true
            finish(ticket, envelope)
            if (worker.ready) sendExecutionState(worker) else failWorker(worker, "VPN worker configuration failed.")
          } else if (request.method == "closeWorker") {
            finish(ticket, envelope)
            failWorker(worker, "VPN worker closed.")
          } else {
            if (json.has("manualOpen")) worker.manualState.apply(
              json.optLong("generation"), json.optLong("manualRevision"), json.optBoolean("manualOpen"),
            )
            finish(ticket, envelope)
          }
        },
        onFailure = { error -> failWorker(worker, error.message ?: "VPN worker response transfer failed.") },
      )
    }
  }

  fun setBackgroundExecutionActive(active: Boolean) {
    if (closed) return
    executionActive = active
    workers.filterNotNull().forEach { worker ->
      if (!active) {
        worker.executionBootstrap.revoke()
        rejectDeferredSources(worker, "VPN worker background execution stopped.")
      }
      sendExecutionState(worker)
    }
    if (active) drainDeferredSources()
  }

  fun onForegroundChanged() = drainDeferredSources()

  private fun executionAnchorReady(): Boolean =
    executionActive && !TaskBackgroundExecution.policy.suspended && TaskForegroundService.isExecutionAnchored()

  private fun bootstrapDecision(worker: Worker): AndroidVpnWorkerBootstrapDecision = worker.executionBootstrap.decision(
    SystemClock.elapsedRealtime(), executionAnchorReady(), isForeground(), TaskBackgroundExecution.policy.suspended, worker.manualOpen,
  )

  private fun scheduleBootstrapTick() {
    handler.removeCallbacks(bootstrapTick)
    if (deferredSources.isNotEmpty()) handler.postDelayed(bootstrapTick, 25L)
  }

  private fun drainDeferredSources() {
    handler.removeCallbacks(bootstrapTick)
    deferredSources.toList().forEach { (ticket, payload) ->
      val request = pending[ticket] ?: return@forEach
      when (bootstrapDecision(request.worker)) {
        AndroidVpnWorkerBootstrapDecision.READY -> {
          deferredSources.remove(ticket)
          sendExecutionState(request.worker)
          send(request.worker, ticket, payload.toString())
        }
        AndroidVpnWorkerBootstrapDecision.WAIT -> Unit
        AndroidVpnWorkerBootstrapDecision.REJECT -> finish(ticket, workerError("VPN worker task execution anchor is unavailable."))
      }
    }
    scheduleBootstrapTick()
  }

  private fun rejectDeferredSources(worker: Worker, message: String) {
    deferredSources.keys.toList().filter { pending[it]?.worker === worker }.forEach { finish(it, workerError(message)) }
  }

  private fun sendExecutionState(worker: Worker) {
    if (!worker.ready) return
    runCatching { worker.remote?.send(Message.obtain(null, VPN_WORKER_EXECUTION, if (executionAnchorReady()) 1 else 0, 0).apply {
      replyTo = worker.receiver
    }) }.onFailure { failWorker(worker, "VPN worker execution state could not be delivered.") }
  }

  private fun cancelPending(worker: Worker, message: String) {
    pending.entries.filter { it.value.worker === worker }.map { it.key }.forEach { finish(it, workerError(message)) }
  }

  private fun failWorker(worker: Worker, message: String) {
    worker.ready = false
    worker.remote = null
    worker.deferredConfiguration = null
    cancelPending(worker, message)
    if (workers[worker.configuration.slot] === worker) workers[worker.configuration.slot] = null
    unbind(worker)
  }

  private fun settleClosedRoute(queue: AndroidVpnWorkerQueue, id: String) {
    AndroidSiteBrowserOwner.release("vpn:${queue.slot}:${queue.generation}") { result ->
      resolve(id, result.fold({ workerSuccess(true) }, {
        workerError(it.message ?: "The shared worker browser route could not close.")
      }))
    }
  }

  private fun unbind(worker: Worker) {
    if (!worker.bound) return
    worker.bound = false
    runCatching { activity.unbindService(worker) }
  }

  private fun finish(ticket: Long, envelope: String, fallbackId: String? = null) {
    deferredSources.remove(ticket)
    if (deferredSources.isEmpty()) handler.removeCallbacks(bootstrapTick)
    val request = pending.remove(ticket)
    request?.let { handler.removeCallbacks(it.timeout) }
    val id = request?.id ?: fallbackId ?: return
    resolve(id, envelope)
  }

  private fun resolve(id: String, envelope: String) {
    webView.evaluateJavascript("window.__noreaAndroidScraperResolve(${JSONObject.quote(id)}, ${JSONObject.quote(envelope)});", null)
  }

  fun destroy() {
    closed = true
    submitted.entries.toList().forEach { (ticket, id) ->
      if (submitted.remove(ticket) != null) resolve(id, workerError("VPN worker bridge destroyed."))
    }
    workers.filterNotNull().forEach { failWorker(it, "VPN worker bridge destroyed.") }
    transport.close()
  }

  private fun discardPayload(message: Message) {
    @Suppress("DEPRECATION") // The app supports Android versions before typed getParcelable.
    val descriptor = message.data.getParcelable<android.os.ParcelFileDescriptor>("payload")
    runCatching { descriptor?.close() }
  }
}
