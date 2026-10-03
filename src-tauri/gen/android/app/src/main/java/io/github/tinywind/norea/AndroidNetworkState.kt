package io.github.tinywind.norea

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import androidx.annotation.Keep

@Keep
object AndroidNetworkState {
  private var started = false

  @JvmStatic
  private external fun publish(connectivity: Int, route: String)

  @Synchronized
  fun start(context: Context) {
    if (started) return
    val manager = context.getSystemService(ConnectivityManager::class.java)
    val callback = object : ConnectivityManager.NetworkCallback() {
      private var current: Network? = null
      private var capabilities: NetworkCapabilities? = null
      private var blocked: Boolean? = null

      override fun onAvailable(network: Network) {
        current = network
        capabilities = null
        blocked = if (Build.VERSION.SDK_INT >= 29) null else false
        publish(0, network.toString())
      }

      override fun onCapabilitiesChanged(network: Network, value: NetworkCapabilities) {
        if (network != current) return
        capabilities = value
        update()
      }

      override fun onBlockedStatusChanged(network: Network, value: Boolean) {
        if (network != current) return
        blocked = value
        update()
      }

      override fun onLost(network: Network) {
        if (network != current) return
        current = null
        capabilities = null
        publish(1, "")
      }

      private fun update() {
        val caps = capabilities
        val state = when {
          blocked == true -> 2
          caps == null || blocked == null -> 0
          caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) -> 3
          else -> 2
        }
        publish(state, current?.toString() ?: "")
      }
    }
    // Only observe the app's default route, including an external VPN's policy.
    if (manager.activeNetwork == null) publish(1, "")
    manager.registerDefaultNetworkCallback(callback)
    started = true
  }
}
