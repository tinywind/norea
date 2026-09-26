package io.github.tinywind.norea

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Test

class TaskBackgroundExecutionTest {
  @Test
  fun quotaSuspensionRequiresForegroundBeforeRestart() {
    val policy = BackgroundExecutionPolicy()
    assertFalse(policy.suspended)
    policy.suspend()
    assertTrue(policy.suspended)
    policy.suspend()
    assertTrue(policy.suspended)
    policy.foreground()
    assertFalse(policy.suspended)
  }

  @Test
  fun onlyTheCurrentActivityReceivesSuspension() {
    var first = 0
    var second = 0
    val old: () -> Unit = { first += 1 }
    val current: () -> Unit = { second += 1 }
    TaskBackgroundExecution.attach(old)
    TaskBackgroundExecution.attach(current)
    TaskBackgroundExecution.detach(old)
    TaskBackgroundExecution.suspend()
    assertEquals(0, first)
    assertEquals(1, second)
    TaskBackgroundExecution.detach(current)
    TaskBackgroundExecution.suspend()
    assertEquals(1, second)
    TaskBackgroundExecution.policy.foreground()
  }
}
