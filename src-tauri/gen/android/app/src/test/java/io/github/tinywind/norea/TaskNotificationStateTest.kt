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

  @Test
  fun resultTargetsKeepOnlyTheirTypedRowIdsAcrossPersistence() {
    for (fields in listOf(
      mapOf<String, Any>("type" to "openAttention"),
      mapOf<String, Any>("type" to "openUpdates"),
      mapOf<String, Any>("type" to "openBackupSettings"),
      mapOf<String, Any>("type" to "openNovel", "novelId" to 3L),
      mapOf<String, Any>("type" to "openChapter", "novelId" to 3L, "chapterId" to 9L),
    )) {
      val action = taskNotificationActionFromFields((fields + ("url" to "https://untrusted.test"))::get)!!
      assertTrue(action.accepts(TaskNotificationActionTarget.ACTIVITY))
      assertFalse(action.accepts(TaskNotificationActionTarget.CONTROL))
      assertEquals(fields, action.toFields())
    }
    for (id in listOf<Any?>(0L, -1L, 1.5, 9_007_199_254_740_992L, "3", null)) {
      assertNull(taskNotificationActionFromFields(mapOf("type" to "openNovel", "novelId" to id)::get))
      assertNull(taskNotificationActionFromFields(mapOf("type" to "openChapter", "novelId" to 3L, "chapterId" to id)::get))
    }
  }

  @Test
  fun aResultOpensItsTargetAndFallsBackToTheQueue() {
    val chapter = TaskNotificationAction.openChapter(3, 9)
    assertEquals(chapter, taskCompletionNotificationAction(chapter))
    assertEquals(TaskNotificationAction.openUpdates(), taskCompletionNotificationAction(TaskNotificationAction.openUpdates()))
    assertEquals(TaskNotificationAction.openAttention(), taskCompletionNotificationAction(TaskNotificationAction.openAttention()))
    assertEquals(
      TaskNotificationAction.openBackupSettings(),
      taskCompletionNotificationAction(TaskNotificationAction.openBackupSettings()),
    )
    assertEquals(TaskNotificationAction.openTasks(), taskCompletionNotificationAction(null))
    assertEquals(TaskNotificationAction.openTasks(), taskCompletionNotificationAction(TaskNotificationAction.pause("downloads")))
    assertEquals(
      TaskNotificationAction.openTasks(),
      taskCompletionNotificationAction(TaskNotificationAction.verifySource("source-a", "scope", 1)),
    )
  }

  @Test
  fun aNewResultTargetInvalidatesTheEarlierResultTap() {
    var serial = 0
    val actions = TaskNotificationActionRegistry(tokenFactory = { "token-${++serial}" })
    val old = actions.token("completion/downloads", TaskNotificationAction.openNovel(3))
    val current = actions.token("completion/downloads", TaskNotificationAction.openChapter(4, 9))

    assertNull(actions.enqueue(old, TaskNotificationActionTarget.ACTIVITY))
    assertNotNull(actions.enqueue(current, TaskNotificationActionTarget.ACTIVITY))
    assertEquals(listOf(TaskNotificationAction.openChapter(4, 9)), actions.drain())
  }

  private fun vpnActionFields(rangeId: String = "range-a"): Map<String, Any> = mapOf(
    "type" to "verifyVpnDownload", "planId" to "plan-a", "sourceId" to "source-a", "rangeId" to rangeId,
    "profileId" to "profile-a", "generation" to 7L, "checkpoint" to 0L,
  )

  @Test
  fun vpnActionsKeepTheirExactOwnerAcrossPersistenceAndColdDelivery() {
    val fields = vpnActionFields()
    val action = taskNotificationActionFromFields(fields::get)!!
    assertTrue(action.accepts(TaskNotificationActionTarget.ACTIVITY))
    assertFalse(action.accepts(TaskNotificationActionTarget.CONTROL))
    assertEquals(fields, action.toFields())
    var persisted = TaskNotificationActionState()
    var serial = 0
    val first = TaskNotificationActionRegistry(tokenFactory = { "token-${++serial}" }, persist = { persisted = it })
    val token = first.token("range/plan-a/range-a", action)
    assertNotNull(first.enqueue(token, TaskNotificationActionTarget.ACTIVITY))
    assertNull(first.enqueue(token, TaskNotificationActionTarget.ACTIVITY))
    val restored = TaskNotificationActionState(
      tokens = persisted.tokens.map { it.copy(action = taskNotificationActionFromFields(it.action.toFields()::get)!!) },
      pending = persisted.pending.map { taskNotificationActionFromFields(it.toFields()::get)!! },
    )
    val restarted = TaskNotificationActionRegistry(initial = restored, persist = { persisted = it })
    assertEquals(listOf(fields), restarted.drain().map { it.toFields() })
    assertTrue(TaskNotificationActionRegistry(initial = persisted).drain().isEmpty())
  }

  @Test
  fun resolvingOneSameSourceRangeKeepsItsSiblingTokenAndCardIdentity() {
    var serial = 0
    val actions = TaskNotificationActionRegistry(tokenFactory = { "token-${++serial}" })
    val first = taskVpnDownloadNotificationIdentity("plan-a", "range-a")
    val second = taskVpnDownloadNotificationIdentity("plan-a", "range-b")
    assertNotEquals(first, second)
    assertNotEquals(first, taskVpnDownloadNotificationIdentity("plan-b", "range-a"))
    assertNotEquals(first, taskSourceNotificationIdentity("source-a"))
    assertNotEquals(taskVpnDownloadNotificationIdentity("plan/a", "range"), taskVpnDownloadNotificationIdentity("plan", "a/range"))
    val tokenA = actions.token(first.tag, taskNotificationActionFromFields(vpnActionFields()::get)!!)
    val actionB = taskNotificationActionFromFields(vpnActionFields("range-b")::get)!!
    val tokenB = actions.token(second.tag, actionB)
    actions.retainIdentities(setOf(second.tag))
    assertNull(actions.enqueue(tokenA, TaskNotificationActionTarget.ACTIVITY))
    assertNotNull(actions.enqueue(tokenB, TaskNotificationActionTarget.ACTIVITY))
    assertEquals(listOf(actionB), actions.drain())
    assertEquals(listOf(first), taskRemovedVpnDownloadNotificationIdentities(setOf(first.tag, second.tag), setOf(second.tag)))
  }

  @Test
  fun changedVpnProfileGenerationOrCheckpointInvalidatesOnlyThatRangeToken() {
    for (replacement in listOf(mapOf("profileId" to "profile-b"), mapOf("generation" to 8L), mapOf("checkpoint" to 1L))) {
      var serial = 0
      val actions = TaskNotificationActionRegistry(tokenFactory = { "token-${++serial}" })
      val identity = taskVpnDownloadNotificationIdentity("plan-a", "range-a").tag
      val original = taskNotificationActionFromFields(vpnActionFields()::get)!!
      val old = actions.token(identity, original)
      val updated = taskNotificationActionFromFields((vpnActionFields() + replacement)::get)!!
      val current = actions.token(identity, updated)
      assertNull(actions.enqueue(old, TaskNotificationActionTarget.ACTIVITY))
      assertNotNull(actions.enqueue(current, TaskNotificationActionTarget.ACTIVITY))
      assertEquals(listOf(updated), actions.drain())
    }
  }

  @Test
  fun vpnActionParsingRejectsUnboundedIdentitiesAndNonSafeNumbersWithoutCoercion() {
    for (key in listOf("planId", "sourceId", "rangeId", "profileId")) {
      val limit = if (key == "sourceId") 512 else 128
      for (invalid in listOf(null, "", " ", "\uFEFF", " \uFEFF ", "x".repeat(limit + 1), "bad\u0000id", "bad\u007fid", 1)) {
        assertNull("$key=$invalid", taskNotificationActionFromFields((vpnActionFields() + (key to invalid))::get))
      }
      assertNotNull(taskNotificationActionFromFields((vpnActionFields() + (key to "x".repeat(limit)))::get))
      assertEquals(" exact-id ", taskNotificationActionFromFields((vpnActionFields() + (key to " exact-id "))::get)!!.toFields()[key])
    }
    for (key in listOf("generation", "checkpoint")) {
      for (invalid in listOf(null, -1L, 1.5, "7", true, Double.NaN, Double.POSITIVE_INFINITY, 9_007_199_254_740_992L)) {
        assertNull("$key=$invalid", taskNotificationActionFromFields((vpnActionFields() + (key to invalid))::get))
      }
      assertNotNull(taskNotificationActionFromFields((vpnActionFields() + (key to 9_007_199_254_740_991L))::get))
    }
    assertNull(taskNotificationActionFromFields((vpnActionFields() + ("generation" to 0L))::get))
    assertNotNull(taskNotificationActionFromFields((vpnActionFields() + ("checkpoint" to 0L))::get))
  }

  @Test
  fun notificationActionsNeverCarryInjectedUrlsCommandsOrUnknownTypes() {
    val fields = vpnActionFields() + mapOf("url" to "https://untrusted.test", "command" to "run", "scopeKey" to "forged")
    assertEquals(vpnActionFields(), taskNotificationActionFromFields(fields::get)!!.toFields())
    assertEquals(mapOf("type" to "openTasks"), taskNotificationActionFromFields((fields + ("type" to "openTasks"))::get)!!.toFields())
    assertNull(taskNotificationActionFromFields((fields + ("type" to "runScript"))::get))
    assertFalse(TaskNotificationAction.verifySource("source-a", "scope", 0).accepts(TaskNotificationActionTarget.ACTIVITY))
    assertFalse(TaskNotificationAction.verifySource("x".repeat(513), "scope", 1).accepts(TaskNotificationActionTarget.ACTIVITY))
    assertFalse(TaskNotificationAction.verifySource("source-a", "x".repeat(2049), 1).accepts(TaskNotificationActionTarget.ACTIVITY))
  }

  @Test
  fun contentSyncGroupAnchorsExecutionWithoutAcceptingPauseControls() {
    val plan = taskNotificationRuntimePlan(
      executionActive = true,
      working = true,
      groups = listOf(TaskNotificationGroup.CONTENT_SYNC),
    )
    assertEquals(1105, plan.anchorId)
    assertFalse(plan.quietAnchor)
    assertTrue(plan.holdWakeLock)
    assertFalse(TaskNotificationGroup.CONTENT_SYNC.pausable)
    assertFalse(TaskNotificationAction.pause("contentSync").accepts(TaskNotificationActionTarget.CONTROL))
    assertFalse(TaskNotificationAction.resume("contentSync").accepts(TaskNotificationActionTarget.CONTROL))
    assertNull(taskNotificationActionFromFields(mapOf("type" to "pause", "groupKey" to "contentSync")::get))
    assertNull(taskNotificationActionFromFields(mapOf("type" to "resume", "groupKey" to "contentSync")::get))
    assertEquals(TaskNotificationAction.openBackupSettings(), defaultGroupOpenAction(TaskNotificationGroup.CONTENT_SYNC))
    assertEquals(TaskNotificationAction.openTasks(), defaultGroupOpenAction(TaskNotificationGroup.DOWNLOADS))
  }

  @Test
  fun syncQuietAnchorAppliesOnlyWhenExecutionIsAnchoredQuietly() {
    val quietSync = taskNotificationRuntimePlan(
      executionActive = true,
      working = true,
      groups = emptyList(),
      syncQuietAnchor = true,
    )
    assertEquals(TASK_QUIET_NOTIFICATION_ID, quietSync.anchorId)
    assertTrue(quietSync.quietAnchor)
    assertTrue(quietSync.syncQuietAnchor)
    assertTrue(quietSync.holdWakeLock)

    val quietTask = taskNotificationRuntimePlan(
      executionActive = true,
      working = true,
      groups = emptyList(),
      syncQuietAnchor = false,
    )
    assertTrue(quietTask.quietAnchor)
    assertFalse(quietTask.syncQuietAnchor)

    val visibleGroup = taskNotificationRuntimePlan(
      executionActive = true,
      working = true,
      groups = listOf(TaskNotificationGroup.CONTENT_SYNC),
      syncQuietAnchor = true,
    )
    assertFalse(visibleGroup.quietAnchor)
    assertFalse(visibleGroup.syncQuietAnchor)

    val stopped = taskNotificationRuntimePlan(
      executionActive = false,
      working = true,
      groups = emptyList(),
      syncQuietAnchor = true,
    )
    assertNull(stopped.anchorId)
    assertFalse(stopped.syncQuietAnchor)
  }

  @Test
  fun backgroundDownloadFinishConvertsActiveFgsIntoBoundedSyncHandoffAnchor() {
    // Active DOWNLOADS FGS finishing with a completion notice converts to a bounded quiet sync anchor.
    val handoffWithCompletion = decideBackgroundUploadAnchor(
      executionActive = false,
      hasTransientNotices = true,
      preemptiveAnchorActive = false,
      isForegroundServiceActive = true,
      pendingBackgroundUpload = true,
      activityActive = false,
    )
    assertEquals(
      BackgroundUploadAnchorDecision(BackgroundUploadAnchorAction.HOLD_SYNC_ANCHOR, armTimeout = true),
      handoffWithCompletion,
    )

    // Even in quiet/off mode with no completion notice, converting from DOWNLOADS must run an update
    // so the download notification card and scraper WebViews are released onto the quiet sync anchor.
    val handoffWithoutNotices = decideBackgroundUploadAnchor(
      executionActive = false,
      hasTransientNotices = false,
      preemptiveAnchorActive = false,
      isForegroundServiceActive = true,
      pendingBackgroundUpload = true,
      activityActive = false,
    )
    assertEquals(
      BackgroundUploadAnchorDecision(BackgroundUploadAnchorAction.HOLD_SYNC_ANCHOR, armTimeout = true),
      handoffWithoutNotices,
    )

    // Once already anchored on the quiet sync fallback, empty updates are no-ops and notices do not reset the timeout.
    assertEquals(
      BackgroundUploadAnchorDecision(BackgroundUploadAnchorAction.KEEP_EXISTING_NOOP, armTimeout = false),
      decideBackgroundUploadAnchor(
        executionActive = false,
        hasTransientNotices = false,
        preemptiveAnchorActive = true,
        isForegroundServiceActive = true,
        pendingBackgroundUpload = true,
        activityActive = false,
      ),
    )
    assertEquals(
      BackgroundUploadAnchorDecision(BackgroundUploadAnchorAction.HOLD_SYNC_ANCHOR, armTimeout = false),
      decideBackgroundUploadAnchor(
        executionActive = false,
        hasTransientNotices = true,
        preemptiveAnchorActive = true,
        isForegroundServiceActive = true,
        pendingBackgroundUpload = true,
        activityActive = false,
      ),
    )

    // Active execution, foreground activity, cleared upload hint, offline/suspended state, or inactive FGS pass through.
    for (decision in listOf(
      decideBackgroundUploadAnchor(true, false, true, true, true, false),
      decideBackgroundUploadAnchor(false, false, false, true, true, true),
      decideBackgroundUploadAnchor(false, false, false, true, false, false),
      decideBackgroundUploadAnchor(false, false, false, false, true, false),
      decideBackgroundUploadAnchor(false, false, true, true, true, false, executionSuspended = true),
      decideBackgroundUploadAnchor(false, false, true, true, true, false, networkConnected = false),
    )) {
      assertEquals(
        BackgroundUploadAnchorDecision(BackgroundUploadAnchorAction.PASS_THROUGH, armTimeout = false),
        decision,
      )
    }
  }
}
