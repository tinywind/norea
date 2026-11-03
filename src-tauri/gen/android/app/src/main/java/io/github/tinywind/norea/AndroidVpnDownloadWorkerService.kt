package io.github.tinywind.norea

import android.app.Activity
import android.app.Application
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.webkit.WebViewFeature
import java.util.concurrent.Executors
import org.json.JSONObject

internal object AndroidVpnWorkerProcess {
  private var initializedSlot: Int? = null
  var service: AndroidVpnDownloadWorkerService? = null

  @Synchronized
  fun initialize(slot: Int) {
    check(Build.VERSION.SDK_INT >= 28) { "VPN browser workers require Android 9 or newer." }
    check(Application.getProcessName().endsWith(":vpn_download_$slot")) { "VPN worker process is invalid." }
    initializedSlot?.let { check(it == slot); return }
    WebView.setDataDirectorySuffix("norea_vpn_download_$slot")
    initializedSlot = slot
  }
}

class AndroidVpnDownloadWorker0Service : AndroidVpnDownloadWorkerService(0)
class AndroidVpnDownloadWorker1Service : AndroidVpnDownloadWorkerService(1)
class AndroidVpnDownloadWorker2Service : AndroidVpnDownloadWorkerService(2)
class AndroidVpnDownloadWorker3Service : AndroidVpnDownloadWorkerService(3)
class AndroidVpnDownloadWorker4Service : AndroidVpnDownloadWorkerService(4)
class AndroidVpnDownloadWorker5Service : AndroidVpnDownloadWorkerService(5)
class AndroidVpnDownloadWorker6Service : AndroidVpnDownloadWorkerService(6)
class AndroidVpnDownloadWorker7Service : AndroidVpnDownloadWorkerService(7)
class AndroidVpnDownloadWorker8Service : AndroidVpnDownloadWorkerService(8)
class AndroidVpnDownloadWorker9Service : AndroidVpnDownloadWorkerService(9)

internal fun androidVpnDownloadWorkerServiceClass(slot: Int): Class<out AndroidVpnDownloadWorkerService> = when (slot) {
  0 -> AndroidVpnDownloadWorker0Service::class.java
  1 -> AndroidVpnDownloadWorker1Service::class.java
  2 -> AndroidVpnDownloadWorker2Service::class.java
  3 -> AndroidVpnDownloadWorker3Service::class.java
  4 -> AndroidVpnDownloadWorker4Service::class.java
  5 -> AndroidVpnDownloadWorker5Service::class.java
  6 -> AndroidVpnDownloadWorker6Service::class.java
  7 -> AndroidVpnDownloadWorker7Service::class.java
  8 -> AndroidVpnDownloadWorker8Service::class.java
  9 -> AndroidVpnDownloadWorker9Service::class.java
  else -> throw IllegalArgumentException("VPN worker slot is invalid.")
}

abstract class AndroidVpnDownloadWorkerService(private val slot: Int) : Service() {
  private data class Call(val id: String, val method: String)
  private val handler = Handler(Looper.getMainLooper())
  private val lease = AndroidVpnWorkerLease(slot)
  private val session = BridgeSession()
  private val proxyExecutor = Executors.newSingleThreadExecutor()
  private val calls = mutableMapOf<Long, Call>()
  private val requestTickets = mutableMapOf<String, Long>()
  private val deferredNavigations = mutableMapOf<Long, () -> Unit>()
  private val transport by lazy { AndroidVpnWorkerTransport(this) }
  private val messenger = Messenger(Handler(Looper.getMainLooper()) { message -> receive(message); true })
  private var client: Messenger? = null
  private var clientDeath: IBinder.DeathRecipient? = null
  private var receiving = 0
  private var executionActive = false
  private var destroyed = false
  private var scraper: AndroidScraperBridge? = null
  private var dummy: WebView? = null
  private var container: FrameLayout? = null
  private var manualActivity: Activity? = null
  private var manualVisible = false
  private var manualRevision = 0L

  override fun onCreate() {
    AndroidVpnWorkerProcess.initialize(slot)
    super.onCreate()
    AndroidVpnWorkerProcess.service = this
  }

  override fun onBind(intent: Intent?): IBinder = messenger.binder

  override fun onUnbind(intent: Intent?): Boolean {
    releaseClient()
    return false
  }

  override fun onDestroy() {
    destroyed = true
    releaseClient()
    transport.close()
    proxyExecutor.shutdownNow()
    handler.removeCallbacksAndMessages(null)
    if (AndroidVpnWorkerProcess.service === this) AndroidVpnWorkerProcess.service = null
    super.onDestroy()
  }

  private fun receive(message: Message) {
    if (message.sendingUid != Process.myUid() || destroyed) {
      discardPayload(message)
      return
    }
    if (message.what == VPN_WORKER_EXECUTION) {
      if (client?.binder != message.replyTo?.binder) return
      executionActive = message.arg1 == 1
      if (executionActive) scraper?.resumeBackgroundWorkWebViews()
      else scraper?.suspendWorkerWork(manualVisible)
      return
    }
    if (message.what != VPN_WORKER_REQUEST || message.replyTo == null) {
      discardPayload(message)
      return
    }
    val reply = message.replyTo
    if (client != null && client?.binder != reply.binder) {
      discardPayload(message)
      return
    }
    if (client == null) {
      client = reply
      val death = IBinder.DeathRecipient { handler.post { if (client?.binder == reply.binder) releaseClient() } }
      clientDeath = death
      runCatching { reply.binder.linkToDeath(death, 0) }.onFailure { releaseClient(); discardPayload(message); return }
    }
    if (calls.size + receiving >= VPN_WORKER_MAX_PENDING) {
      discardPayload(message)
      reply(message.data.getLong("ticket"), workerError("VPN worker request limit reached."))
      return
    }
    receiving += 1
    transport.receive(message, VPN_WORKER_REQUEST_LIMIT) { ticket, payload ->
      receiving -= 1
      if (client?.binder != reply.binder) return@receive
      payload.fold(
        onSuccess = { value ->
          runCatching { dispatch(ticket, JSONObject(value)) }
            .onFailure { error -> reply(ticket, workerError(error.message ?: "VPN worker request failed.")) }
        },
        onFailure = { error -> reply(ticket, workerError(error.message ?: "VPN worker transfer failed.")) },
      )
    }
  }

  private fun dispatch(ticket: Long, json: JSONObject) {
    val id = json.getString("id")
    require(id.isNotBlank() && id.toByteArray(Charsets.UTF_8).size <= 512) { "VPN worker request id is invalid." }
    val method = json.getString("method")
    require(!calls.containsKey(ticket)) { "VPN worker request ticket is duplicated." }
    calls[ticket] = Call(id, method)
    if (method == "configureWorker") {
      configure(ticket, json)
      return
    }
    val queue = parseAndroidVpnWorkerQueue(json.getString("queue"))
    val configuration = if (!androidVpnWorkerRequiresReady(method)) lease.requireConfiguration(queue, json.getString("sourceId"))
      else lease.requireRequest(queue, json.getString("sourceId"))
    when (method) {
      "closeWorker" -> {
        val manualWasOpen = lease.manualOpen
        cancelCalls("VPN worker closed.", except = ticket)
        lease.close()
        destroyBrowser()
        if (manualWasOpen) notifyManualClosed(configuration.generation)
        reply(ticket, workerSuccess(true))
      }
      "showWorker" -> {
        showManual(configuration, allowNewBrowser = false)
        reply(ticket, workerSuccess(JSONObject().put("manualOpen", true)))
      }
      else -> {
        val capability = androidVpnWorkerCapability(method)
        if (method == "navigate") showManual(configuration, allowNewBrowser = true)
        check(method == "navigate" || androidVpnWorkerMayExecute(method, executionActive, lease.manualOpen, manualVisible)) {
          "VPN worker requires active task execution and a closed manual browser for downloads."
        }
        val bridge = scraper
        if (bridge == null && method in setOf("cancel", "cancelBackground")) {
          reply(ticket, workerSuccess(true))
          return
        }
        checkNotNull(bridge) { "VPN worker browser is unavailable." }
        json.put("queue", if (method == "navigate") "immediate" else "pool:0")
        json.put("_bridge", JSONObject()
          .put("sessionToken", session.sessionToken)
          .put("capability", capability)
          .put("nonce", session.newNonce()))
        if (method == "cancel") {
          json.put("id", json.optString("targetId", id))
          bridge.cancel(json.toString())
          bridge.afterPendingCommands { reply(ticket, workerSuccess(true)) }
          return
        }
        if (method == "cancelBackground") {
          bridge.cancelBackground(json.toString())
          bridge.afterPendingCommands { reply(ticket, workerSuccess(true)) }
          return
        }
        require(!requestTickets.containsKey(id)) { "VPN worker request id is duplicated." }
        requestTickets[id] = ticket
        val payload = json.toString()
        when (method) {
          "extract" -> bridge.extract(payload)
          "fetch" -> bridge.fetch(payload)
          "navigate" -> {
            if (manualVisible) bridge.navigate(payload)
            else deferredNavigations[ticket] = { if (calls.containsKey(ticket)) bridge.navigate(payload) }
          }
          "clearCookies" -> bridge.clearCookies(payload)
          "currentUrl" -> bridge.currentUrl(payload)
          "currentOrigin" -> bridge.currentOrigin(payload)
        }
      }
    }
  }

  private fun configure(ticket: Long, json: JSONObject) {
    val configuration = androidVpnWorkerConfiguration(
      json.opt("slot"), json.opt("generation"), json.getString("sourceId"),
      json.getString("profileId"), json.opt("proxyPort"),
    )
    val appOrigin = androidVpnWorkerAppOrigin(json.opt("_appOrigin"))
    check(WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) { "VPN workers require WebView multi-profile support." }
    lease.beginConfigure(configuration)
    cancelCalls("VPN worker reconfigured.", except = ticket)
    destroyBrowser()
    val surface = FrameLayout(this)
    val host = WebView(this).apply { visibility = View.INVISIBLE }
    surface.addView(host, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    container = surface
    dummy = host
    proxyExecutor.execute {
      val result = runCatching { configureAndroidVpnWebViewProxy(configuration.proxyPort) }
      handler.post {
        if (destroyed || lease.configuration?.generation != configuration.generation || !calls.containsKey(ticket)) return@post
        result.fold(
          onSuccess = {
            runCatching {
              scraper = AndroidScraperBridge(
                host, session,
                output = { id, envelope ->
                  if (lease.configuration?.generation == configuration.generation) {
                    requestTickets[id]?.let { request ->
                      if (calls[request]?.method == "navigate") scraper?.layoutWorkerBrowser()
                      reply(request, envelope)
                    }
                  }
                },
                profileNamespace = configuration.profileId,
                surfaceContainer = surface,
                onBrowserHidden = { manualActivity?.finish() },
                commandAllowed = { command ->
                  lease.configuration?.generation == configuration.generation &&
                    androidVpnWorkerMayExecute(command.optString("method"), executionActive, lease.manualOpen, manualVisible)
                },
                appUrl = appOrigin,
              )
              surface.addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
                if (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop) scraper?.layoutWorkerBrowser()
              }
              layoutDetachedContainer()
              lease.markReady(configuration.generation)
              if (executionActive) scraper?.resumeBackgroundWorkWebViews()
              reply(ticket, workerSuccess(JSONObject().put("configured", true).put("manualOpen", false)))
            }.onFailure { error ->
              lease.close()
              destroyBrowser()
              reply(ticket, workerError(error.message ?: "VPN worker initialization failed."))
            }
          },
          onFailure = { error ->
            lease.close()
            reply(ticket, workerError(error.message ?: "VPN worker proxy configuration failed."))
          },
        )
      }
    }
  }

  private fun showManual(configuration: AndroidVpnWorkerConfiguration, allowNewBrowser: Boolean) {
    if (lease.manualOpen) return
    val bridge = checkNotNull(scraper)
    check(bridge.showWorkerBrowser(configuration.sourceId, allowNewBrowser)) { "VPN worker has no idle browser session to show." }
    val token = session.newNonce()
    lease.reserveManual(AndroidVpnWorkerQueue(slot, configuration.generation), configuration.sourceId, token)
    manualRevision += 1
    val activity = androidVpnDownloadWorkerActivityClass(slot)
    try {
      startActivity(Intent(this, activity).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        putExtra("generation", configuration.generation)
        putExtra("manualToken", token)
      })
      handler.postDelayed({
        if (lease.cancelManualReservation(configuration.generation, token)) {
          bridge.releaseWorkerBrowser()
          if (!executionActive) bridge.suspendWorkerWork(manualOpen = false)
          notifyManualClosed(configuration.generation)
        }
      }, 15_000L)
    } catch (error: RuntimeException) {
      lease.cancelManualReservation(configuration.generation, token)
      bridge.releaseWorkerBrowser()
      notifyManualClosed(configuration.generation)
      throw error
    }
  }

  internal fun attachManual(activity: Activity, generation: Long, token: String): Boolean {
    val surface = container ?: return false
    if (!lease.attachManual(generation, token, activity)) return false
    manualActivity = activity
    (surface.parent as? ViewGroup)?.removeView(surface)
    activity.setContentView(surface)
    scraper?.layoutWorkerBrowser()
    return true
  }

  internal fun setManualVisible(activity: Activity, generation: Long, visible: Boolean) {
    if (manualActivity !== activity || lease.configuration?.generation != generation) return
    manualVisible = visible
    if (visible) {
      scraper?.resumeBackgroundWorkWebViews()
      val navigations = deferredNavigations.values.toList()
      deferredNavigations.clear()
      navigations.forEach { it() }
    } else if (!executionActive) {
      deferredNavigations.keys.toList().forEach { reply(it, workerError("VPN worker manual browser is hidden.")) }
      scraper?.suspendWorkerWork(manualOpen = false)
    }
  }

  internal fun detachManual(activity: Activity, generation: Long) {
    if (!lease.detachManual(generation, activity)) return
    manualActivity = null
    manualVisible = false
    container?.let { (it.parent as? ViewGroup)?.removeView(it) }
    scraper?.releaseWorkerBrowser()
    layoutDetachedContainer()
    if (executionActive) scraper?.resumeBackgroundWorkWebViews()
    else scraper?.suspendWorkerWork(manualOpen = false)
    notifyManualClosed(generation)
  }

  internal fun handleManualBack(activity: Activity, generation: Long): Boolean =
    manualActivity === activity && lease.configuration?.generation == generation && scraper?.handleBackPressed() == true

  private fun layoutDetachedContainer() {
    val surface = container ?: return
    if (surface.isAttachedToWindow) return
    val metrics = resources.displayMetrics
    surface.measure(
      View.MeasureSpec.makeMeasureSpec(metrics.widthPixels.coerceAtLeast(2), View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(metrics.heightPixels.coerceAtLeast(2), View.MeasureSpec.EXACTLY),
    )
    surface.layout(0, 0, surface.measuredWidth, surface.measuredHeight)
  }

  private fun notifyManualClosed(generation: Long) {
    manualRevision += 1
    runCatching { client?.send(Message.obtain(null, VPN_WORKER_MANUAL_CLOSED).apply {
      data = android.os.Bundle().apply { putLong("generation", generation); putLong("revision", manualRevision) }
    }) }
  }

  private fun cancelCalls(message: String, except: Long? = null) {
    calls.keys.toList().filter { it != except }.forEach { reply(it, workerError(message)) }
  }

  private fun destroyBrowser() {
    manualActivity?.finish()
    manualActivity = null
    manualVisible = false
    scraper?.destroy()
    scraper = null
    dummy?.destroy()
    dummy = null
    container?.let { surface -> (surface.parent as? ViewGroup)?.removeView(surface); surface.removeAllViews() }
    container = null
  }

  private fun releaseClient() {
    cancelCalls("VPN worker client disconnected.")
    lease.died()
    destroyBrowser()
    clientDeath?.let { death -> runCatching { client?.binder?.unlinkToDeath(death, 0) } }
    clientDeath = null
    client = null
    executionActive = false
  }

  private fun reply(ticket: Long, envelope: String) {
    deferredNavigations.remove(ticket)
    val call = calls.remove(ticket)
    call?.let { if (requestTickets[it.id] == ticket) requestTickets.remove(it.id) }
    val response = if (call?.method in setOf("navigate", "showWorker")) {
      JSONObject(envelope).put("manualOpen", lease.manualOpen).put("manualRevision", manualRevision)
        .put("generation", lease.configuration?.generation ?: 0).toString()
    } else envelope
    val destination = client ?: return
    transport.send(destination, VPN_WORKER_RESPONSE, ticket, response, VPN_WORKER_RESPONSE_LIMIT,
      onError = {
        runCatching { destination.send(Message.obtain(null, VPN_WORKER_TRANSFER_FAILED)) }
        releaseClient()
      })
  }

  private fun discardPayload(message: Message) {
    @Suppress("DEPRECATION") // The app supports Android versions before typed getParcelable.
    val descriptor = message.data.getParcelable<android.os.ParcelFileDescriptor>("payload")
    runCatching { descriptor?.close() }
  }
}

internal fun workerSuccess(result: Any): String = JSONObject().put("ok", true).put("result", result).toString()
internal fun workerError(message: String): String = JSONObject().put("ok", false).put("error", message).toString()
