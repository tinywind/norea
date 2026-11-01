package io.github.tinywind.norea

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskNotificationStateTest {
  @Test
  fun oneVisibleGroupAnchorsExecutionWithoutAnExtraNotification() {
    val plan = taskNotificationRuntimePlan(
      executionActive = true,
      working = true,
      groups = listOf(TaskNotificationGroup.LIBRARY_METADATA, TaskNotificationGroup.DOWNLOADS),
    )

    assertEquals(1101, plan.anchorId)
    assertFalse(plan.quietAnchor)
    assertTrue(plan.holdWakeLock)
  }

  @Test
  fun hiddenProgressStillKeepsExecutionWithoutHoldingAWakeLockWhilePaused() {
    val plan = taskNotificationRuntimePlan(
      executionActive = true,
      working = false,
      groups = emptyList(),
    )

    assertEquals(1001, plan.anchorId)
    assertTrue(plan.quietAnchor)
    assertFalse(plan.holdWakeLock)
  }

  @Test
  fun resultsAndPausedNotificationsDoNotKeepTheServiceRunning() {
    val plan = taskNotificationRuntimePlan(
      executionActive = false,
      working = true,
      groups = listOf(TaskNotificationGroup.DOWNLOADS),
    )

    assertNull(plan.anchorId)
    assertFalse(plan.holdWakeLock)
  }

  @Test
  fun missingOrZeroTotalsNeverProduceFalseDeterminateProgress() {
    assertNull(taskNotificationProgress(current = 0, total = null))
    assertNull(taskNotificationProgress(current = 0, total = 0))
    assertEquals(TaskNotificationProgress(current = 8, total = 8), taskNotificationProgress(11, 8))
  }

  @Test
  fun pluginNotificationsUseTheFullTagAndIdPairForPublishAndRemoval() {
    val first = taskSourceNotificationIdentity("source-a")
    val second = taskSourceNotificationIdentity("source-b")

    assertEquals(TaskNotificationIdentity(id = 1201, tag = "source/source-a"), first)
    assertEquals(1201, second.id)
    assertNotEquals(first, second)
    assertEquals(first, taskSourceNotificationIdentity("source-a"))
    assertNotEquals(first, taskCompletionNotificationIdentity("downloads"))
  }

  @Test
  fun groupControlsAndPluginChallengesNeverShareAnActionToken() {
    var serial = 0
    val actions = TaskNotificationActionRegistry(tokenFactory = { "token-${++serial}" })
    val download = actions.token("group/downloads/pause", TaskNotificationAction.pause("downloads"))
    val metadata = actions.token("group/libraryMetadata/pause", TaskNotificationAction.pause("libraryMetadata"))
    val challenge = actions.token("source/source-a", TaskNotificationAction.verifySource("source-a", "novel:1", 7))

    assertNotEquals(download, metadata)
    assertNotEquals(download, challenge)
    assertNotNull(actions.enqueue(download, TaskNotificationActionTarget.CONTROL))
    assertEquals(listOf(TaskNotificationAction.pause("downloads")), actions.drain())
  }

  @Test
  fun exportedActivityRejectsForgedAndControlActionTokens() {
    val actions = TaskNotificationActionRegistry(tokenFactory = { "private-token" })
    actions.token("group/downloads/pause", TaskNotificationAction.pause("downloads"))

    assertNull(actions.enqueue("forged-token", TaskNotificationActionTarget.ACTIVITY))
    assertNull(actions.enqueue("private-token", TaskNotificationActionTarget.ACTIVITY))
    assertTrue(actions.drain().isEmpty())
  }

  @Test
  fun challengeReplacementInvalidatesThePreviousRevision() {
    var serial = 0
    val actions = TaskNotificationActionRegistry(tokenFactory = { "token-${++serial}" })
    val old = actions.token("source/source-a", TaskNotificationAction.verifySource("source-a", "novel:1", 7))
    val current = actions.token("source/source-a", TaskNotificationAction.verifySource("source-a", "novel:2", 8))

    assertNull(actions.enqueue(old, TaskNotificationActionTarget.ACTIVITY))
    assertNotNull(actions.enqueue(current, TaskNotificationActionTarget.ACTIVITY))
    assertEquals(listOf(TaskNotificationAction.verifySource("source-a", "novel:2", 8)), actions.drain())
  }

  @Test
  fun coldStartDeliversPersistedActionsOnceWhenTheFrontendDrains() {
    var persisted = TaskNotificationActionState()
    val first = TaskNotificationActionRegistry(
      tokenFactory = { "private-token" },
      persist = { persisted = it },
    )
    val token = first.token("source/source-a", TaskNotificationAction.verifySource("source-a", "source:abc", 12))
    assertNotNull(first.enqueue(token, TaskNotificationActionTarget.ACTIVITY))

    val restarted = TaskNotificationActionRegistry(initial = persisted, persist = { persisted = it })
    assertEquals(
      listOf(TaskNotificationAction.verifySource("source-a", "source:abc", 12)),
      restarted.drain(),
    )
    assertTrue(TaskNotificationActionRegistry(initial = persisted).drain().isEmpty())
  }

  @Test
  fun anActivityRecreationCannotReplayATapButANewTapStillWorks() {
    var serial = 0
    val actions = TaskNotificationActionRegistry(tokenFactory = { "token-${++serial}" })
    val action = TaskNotificationAction.verifySource("source-a", "scope", 1)
    val first = actions.token("source/source-a", action)

    assertNotNull(actions.enqueue(first, TaskNotificationActionTarget.ACTIVITY))
    assertNull(actions.enqueue(first, TaskNotificationActionTarget.ACTIVITY))
    val refreshed = actions.token("source/source-a", action)
    assertNotEquals(first, refreshed)
    assertNotNull(actions.enqueue(refreshed, TaskNotificationActionTarget.ACTIVITY))
    assertEquals(listOf(action, action), actions.drain())
  }

  @Test
  fun resolvedChallengesRejectTheirOldNotificationAction() {
    val actions = TaskNotificationActionRegistry(tokenFactory = { "private-token" })
    val token = actions.token("source/source-a", TaskNotificationAction.verifySource("source-a", "scope", 1))
    actions.retainIdentities(emptySet())

    assertNull(actions.enqueue(token, TaskNotificationActionTarget.ACTIVITY))
    assertTrue(actions.drain().isEmpty())
  }
}
