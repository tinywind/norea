package io.github.tinywind.norea

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidVpnProfileFilesTest {
  @Test
  fun acceptsHostNamedProfileFiles() {
    for (name in listOf("8.8.8.8.ovpn", "vpn.example.com.ovpn", "a-1.example.ovpn", "localhost.ovpn")) {
      assertTrue(name, isVpnProfileFileName(name))
    }
  }

  @Test
  fun rejectsPartialsForeignNamesAndUnsafePaths() {
    for (
      name in listOf(
        ".8.8.8.8.ovpn.partial",
        ".vpn.example.com.ovpn",
        "198.051.100.10.ovpn",
        "999.1.1.1.ovpn",
        "VPN.example.com.ovpn",
        "../vpn.example.com.ovpn",
        "vpn..example.com.ovpn",
        "notes.txt",
        ".ovpn",
      )
    ) {
      assertFalse(name, isVpnProfileFileName(name))
    }
  }
}
