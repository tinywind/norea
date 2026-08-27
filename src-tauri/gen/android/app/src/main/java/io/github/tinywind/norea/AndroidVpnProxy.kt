package io.github.tinywind.norea

import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit

private const val ANDROID_VPN_PROXY_APPLY_TIMEOUT_SECONDS = 10L
private const val NOREA_ANDROID_APP_HOST = "tauri.localhost"
private val androidVpnProxyCallbackExecutor = Executor { runnable -> runnable.run() }

internal fun androidVpnLoopbackProxyUrl(rawPort: Any?): String {
  val port = when (rawPort) {
    is Byte -> rawPort.toLong()
    is Short -> rawPort.toLong()
    is Int -> rawPort.toLong()
    is Long -> rawPort
    else -> throw IllegalArgumentException("Android VPN proxy port is invalid.")
  }
  require(port in 1L..65_535L) { "Android VPN proxy port is invalid." }
  return "http://127.0.0.1:$port"
}

internal fun configureAndroidVpnWebViewProxy(rawPort: Any?) {
  check(WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
    "Android WebView proxy override is unavailable."
  }

  val proxyConfig = ProxyConfig.Builder()
    .addProxyRule(androidVpnLoopbackProxyUrl(rawPort))
    .removeImplicitRules()
    .addBypassRule(NOREA_ANDROID_APP_HOST)
    .build()
  val applied = CountDownLatch(1)
  ProxyController.getInstance().setProxyOverride(
    proxyConfig,
    androidVpnProxyCallbackExecutor,
    applied::countDown,
  )

  val completed = try {
    applied.await(ANDROID_VPN_PROXY_APPLY_TIMEOUT_SECONDS, TimeUnit.SECONDS)
  } catch (error: InterruptedException) {
    Thread.currentThread().interrupt()
    throw IllegalStateException("Android WebView proxy configuration was interrupted.", error)
  }
  check(completed) { "Android WebView proxy configuration timed out." }
}
