package io.github.tinywind.norea

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class AndroidTaskNotificationRangesTest {
  private fun action(rangeId: String = "range-a") = taskNotificationActionFromFields(mapOf(
    "type" to "verifyVpnDownload", "planId" to "plan-a", "sourceId" to "source-a", "rangeId" to rangeId,
    "profileId" to "profile-a", "generation" to 7, "checkpoint" to 0,
  )::get)!!

  private fun fields(rangeId: String = "range-a"): Map<String, Any> = mapOf(
    "planId" to "plan-a", "rangeId" to rangeId, "title" to "Paused work", "body" to "Complete verification",
    "actionLabel" to "Verify source", "id" to "source/forged", "url" to "https://untrusted.test", "command" to "run",
  )

  @Test
  fun rangePayloadsKeepSameSourceOwnersSeparateAndRemoveOnlyTheSettledSibling() {
    val first = taskVpnDownloadNotificationFromFields(fields()::get, action())!!
    val second = taskVpnDownloadNotificationFromFields(fields("range-b")::get, action("range-b"))!!
    assertEquals(TaskNotificationIdentity(1203, "vpn/6:plan-a/7:range-a"), first.identity)
    assertEquals(TaskNotificationIdentity(1203, "vpn/6:plan-a/7:range-b"), second.identity)
    assertEquals("Paused work", first.title)
    assertEquals("Complete verification", first.body)
    assertEquals("Verify source", first.actionLabel)
    val previous = setOf(first.identity.tag, second.identity.tag)
    assertEquals(listOf(first.identity), taskRemovedVpnDownloadNotificationIdentities(previous, setOf(second.identity.tag)))
    assertEquals(emptyList<TaskNotificationIdentity>(), taskRemovedVpnDownloadNotificationIdentities(setOf(second.identity.tag), setOf(second.identity.tag)))
  }

  @Test
  fun exhaustedRangePayloadsOnlyOpenTasksAndNeverBecomeSourceOrControlActions() {
    val exhausted = taskVpnDownloadNotificationFromFields(fields()::get, TaskNotificationAction.openTasks())!!
    assertEquals(TaskNotificationAction.openTasks(), exhausted.action)
    for (unsafe in listOf(TaskNotificationAction.verifySource("source-a", "scope", 1), TaskNotificationAction.resume("downloads"), TaskNotificationAction("runScript"))) {
      assertNull(taskVpnDownloadNotificationFromFields(fields()::get, unsafe))
    }
    assertNull(taskVpnDownloadNotificationFromFields(fields()::get, null))
  }

  @Test
  fun rangePayloadRejectsAnActionForADifferentOwnerOrAnInvalidCardIdentity() {
    assertNull(taskVpnDownloadNotificationFromFields(fields()::get, action("range-b")))
    assertNull(taskVpnDownloadNotificationFromFields((fields() + ("planId" to "another-plan"))::get, action()))
    for (key in listOf("planId", "rangeId")) {
      for (invalid in listOf("", " ", "x".repeat(129), "bad\nidentity", 42)) {
        assertNull(taskVpnDownloadNotificationFromFields((fields() + (key to invalid))::get, TaskNotificationAction.openTasks()))
      }
    }
    assertNotNull(taskVpnDownloadNotificationFromFields(fields()::get, action()))
  }
}
