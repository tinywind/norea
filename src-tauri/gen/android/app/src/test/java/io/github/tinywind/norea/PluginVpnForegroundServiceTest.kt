package io.github.tinywind.norea

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PluginVpnForegroundServiceTest {
  private val active = mapOf(
    "active" to true,
    "title" to "Plugin VPN connected",
    "body" to "203.0.113.10",
    "channelName" to "Plugin VPN",
    "channelDescription" to "Keeps the plugin VPN connected.",
  )

  @Test
  fun keepsTheServiceForAnActiveRequest() {
    assertEquals(
      PluginVpnKeepAliveRequest("Plugin VPN connected", "203.0.113.10", "Plugin VPN", "Keeps the plugin VPN connected."),
      pluginVpnKeepAliveRequestFromFields(active::get),
    )
  }

  @Test
  fun stopsTheServiceUnlessTheRequestIsActive() {
    listOf(false, null, "true", 1).forEach { value ->
      val fields = active + ("active" to value)
      assertNull(pluginVpnKeepAliveRequestFromFields(fields::get))
    }
  }

  @Test
  fun stopsTheServiceWithoutNotificationOrChannelText() {
    listOf("title", "channelName").forEach { name ->
      assertNull(pluginVpnKeepAliveRequestFromFields((active + (name to " "))::get))
      assertNull(pluginVpnKeepAliveRequestFromFields((active - name)::get))
    }
  }

  @Test
  fun leavesAnUnknownHostAndChannelDescriptionEmpty() {
    val fields = active - "body" - "channelDescription"
    assertEquals(
      PluginVpnKeepAliveRequest("Plugin VPN connected", "", "Plugin VPN", ""),
      pluginVpnKeepAliveRequestFromFields(fields::get),
    )
  }
}
