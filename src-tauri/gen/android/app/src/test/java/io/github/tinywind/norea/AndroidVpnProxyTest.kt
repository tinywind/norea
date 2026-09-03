package io.github.tinywind.norea

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AndroidVpnProxyTest {
  @Test
  fun createsLoopbackProxyUrlsForValidPorts() {
    assertEquals("http://127.0.0.1:1", androidVpnLoopbackProxyUrl(1))
    assertEquals("http://127.0.0.1:65535", androidVpnLoopbackProxyUrl(65_535L))
  }

  @Test
  fun rejectsInvalidProxyPorts() {
    listOf(null, 0, 65_536, -1, 1.5, "8080").forEach { value ->
      assertThrows(IllegalArgumentException::class.java) {
        androidVpnLoopbackProxyUrl(value)
      }
    }
  }
}
