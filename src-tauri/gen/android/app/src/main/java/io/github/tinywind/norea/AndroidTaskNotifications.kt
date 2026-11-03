package io.github.tinywind.norea

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import io.github.tinywind.norea.AppLog as Log
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject

internal data class AndroidTaskNotificationGroup(
  val group: TaskNotificationGroup,
  val title: String,
  val body: String,
  val paused: Boolean,
  val progress: TaskNotificationProgress?,
  val pauseLabel: String,
  val resumeLabel: String,
)

internal data class AndroidTaskNotificationChallenge(
  val sourceId: String,
  val scopeKey: String,
  val revision: Long,
  val title: String,
  val body: String,
  val actionLabel: String,
)

internal data class AndroidTaskNotificationCompletion(val key: String, val title: String, val body: String)

internal data class AndroidTaskNotificationRange(
  val planId: String,
  val rangeId: String,
  val title: String,
  val body: String,
  val actionLabel: String,
  val action: TaskNotificationAction,
) {
  val identity: TaskNotificationIdentity get() = taskVpnDownloadNotificationIdentity(planId, rangeId)
}

internal fun taskVpnDownloadNotificationFromFields(
  field: (String) -> Any?,
  action: TaskNotificationAction?,
): AndroidTaskNotificationRange? {
  val planId = taskNotificationIdentifier(field("planId"), 128) ?: return null
  val rangeId = taskNotificationIdentifier(field("rangeId"), 128) ?: return null
  if (action == null || !action.accepts(TaskNotificationActionTarget.ACTIVITY)) return null
  if (action.type != "openTasks" && (action.type != "verifyVpnDownload" || action.planId != planId || action.rangeId != rangeId)) return null
  return AndroidTaskNotificationRange(planId, rangeId, field("title") as? String ?: "",
    field("body") as? String ?: "", field("actionLabel") as? String ?: "", action)
}

internal data class AndroidTaskNotificationChannels(
  val verificationName: String,
  val verificationDescription: String,
  val resultsName: String,
  val resultsDescription: String,
)

internal data class AndroidTaskNotificationPayload(
  val title: String,
  val quiet: Boolean,
  val requestPermission: Boolean,
  val executionActive: Boolean,
  val working: Boolean,
  val groups: List<AndroidTaskNotificationGroup>,
  val challenges: List<AndroidTaskNotificationChallenge>,
  val completions: List<AndroidTaskNotificationCompletion>,
  val channels: AndroidTaskNotificationChannels?,
  val ranges: List<AndroidTaskNotificationRange> = emptyList(),
) {
  companion object {
    fun parse(payload: String): AndroidTaskNotificationPayload {
      val json = JSONObject(payload)
      fun objects(name: String): List<JSONObject> {
        val entries = json.optJSONArray(name) ?: JSONArray()
        return (0 until entries.length()).mapNotNull { entries.optJSONObject(it) }
      }
      return AndroidTaskNotificationPayload(
        channels = json.optJSONObject("channels")?.let {
          AndroidTaskNotificationChannels(
            it.getString("verificationName"), it.getString("verificationDescription"),
            it.getString("resultsName"), it.getString("resultsDescription"),
          )
        },
        title = json.optString("title", "Norea tasks"),
        quiet = json.optBoolean("quiet", false),
        requestPermission = json.optBoolean("requestPermission", false),
        executionActive = json.optBoolean("executionActive", false),
        working = json.optBoolean("working", false),
        groups = objects("groups").mapNotNull { entry ->
          val group = TaskNotificationGroup.fromKey(entry.optString("key")) ?: return@mapNotNull null
          val progress = entry.optJSONObject("progress")
          AndroidTaskNotificationGroup(
            group,
            entry.optString("title"),
            entry.optString("body"),
            entry.optBoolean("paused", false),
            progress?.let {
              taskNotificationProgress(
                it.optInt("current", -1),
                it.takeIf { value -> value.has("total") }?.optInt("total", -1),
              )
            },
            entry.optString("pauseLabel"),
            entry.optString("resumeLabel"),
          )
        }.distinctBy { it.group },
        challenges = objects("challenges").mapNotNull { entry ->
          val sourceId = entry.optString("sourceId").takeIf { it.isNotBlank() } ?: return@mapNotNull null
          val scopeKey = entry.optString("scopeKey").takeIf { it.isNotBlank() } ?: return@mapNotNull null
          val revision = entry.optLong("revision", -1).takeIf { it >= 0 } ?: return@mapNotNull null
          AndroidTaskNotificationChallenge(
            sourceId, scopeKey, revision,
            entry.optString("title"), entry.optString("body"), entry.optString("actionLabel"),
          )
        }.distinctBy { it.sourceId },
        ranges = objects("ranges").mapNotNull { entry ->
          taskVpnDownloadNotificationFromFields(entry::opt, entry.optJSONObject("action")?.let(::notificationActionFromJson))
        }.distinctBy { it.identity },
        completions = objects("completions").mapNotNull { entry ->
          val key = entry.optString("key").takeIf { it.isNotBlank() } ?: return@mapNotNull null
          AndroidTaskNotificationCompletion(key, entry.optString("title"), entry.optString("body"))
        }.distinctBy { it.key },
      )
    }
  }
}

internal object AndroidTaskNotifications {
  private const val PROGRESS_CHANNEL_ID = "task-progress"
  private const val QUIET_CHANNEL_ID = "task-background"
  private const val CHALLENGE_CHANNEL_ID = "task-source-verification"
  private const val COMPLETION_CHANNEL_ID = "task-results"
  private const val PREFERENCES = "task-notifications"
  private var channelsReady = false

  private var localizedChannels: AndroidTaskNotificationChannels? = null

  fun ensureChannels(context: Context, channels: AndroidTaskNotificationChannels? = null) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    fun channel(id: String, name: String, description: String, importance: Int) =
      NotificationChannel(id, name, importance).apply {
        this.description = description
        setShowBadge(false)
      }
    if (!channelsReady) {
      manager(context).createNotificationChannels(listOf(
        channel(PROGRESS_CHANNEL_ID, "Task progress", "Progress for downloads and library tasks.", NotificationManager.IMPORTANCE_LOW),
        channel(QUIET_CHANNEL_ID, "Background tasks", "Keeps app tasks running while progress notifications are off.", NotificationManager.IMPORTANCE_MIN),
      ))
      channelsReady = true
    }
    if (channels != null && channels != localizedChannels) {
      manager(context).createNotificationChannels(listOf(
        channel(CHALLENGE_CHANNEL_ID, channels.verificationName, channels.verificationDescription, NotificationManager.IMPORTANCE_DEFAULT),
        channel(COMPLETION_CHANNEL_ID, channels.resultsName, channels.resultsDescription, NotificationManager.IMPORTANCE_DEFAULT),
      ))
      localizedChannels = channels
    }
  }

  fun update(context: Context, payload: AndroidTaskNotificationPayload): Boolean {
    ensureChannels(context, payload.channels)
    val identities = payload.groups.flatMap { listOf("group/${it.group.key}/open", "group/${it.group.key}/control") }.toSet() +
      payload.challenges.map { "source/${it.sourceId}" }.toSet() + payload.ranges.map { it.identity.tag }.toSet()
    AndroidTaskNotificationActions.retainIdentities(context, identities)
    val groups = payload.groups.associate { it.group.notificationId to groupNotification(context, it) }
    val plan = taskNotificationRuntimePlan(
      executionActive = payload.executionActive && !TaskBackgroundExecution.policy.suspended,
      working = payload.working,
      groups = payload.groups.map { it.group },
    )
    if (plan.anchorId == null) {
      TaskForegroundService.stop(context)
    } else {
      val notification = groups[plan.anchorId] ?: quietNotification(context, payload.title, payload.quiet)
      try {
        TaskForegroundService.update(context, plan.anchorId, notification, plan.holdWakeLock, groups)
      } catch (error: RuntimeException) {
        Log.w("NoreaTasks", "Background service start rejected", error)
        TaskBackgroundExecution.suspend()
        TaskForegroundService.stop(context)
      }
    }
    val executionActive = plan.anchorId != null && !TaskBackgroundExecution.policy.suspended
    groups.filterKeys { !executionActive || it != plan.anchorId }.forEach { (id, notification) ->
      notify(context, id, notification)
    }
    TaskNotificationGroup.entries.filter { it.notificationId !in groups }.forEach {
      manager(context).cancel(it.notificationId)
    }
    if (plan.anchorId != TASK_QUIET_NOTIFICATION_ID) manager(context).cancel(TASK_QUIET_NOTIFICATION_ID)
    reconcileChallenges(context, payload.challenges)
    reconcileRanges(context, payload.ranges)
    payload.completions.forEach { completion ->
      val notification = base(context, COMPLETION_CHANNEL_ID, completion.title, completion.body)
        .setSmallIcon(android.R.drawable.stat_sys_download_done)
        .setContentIntent(AndroidTaskNotificationActions.activityIntent(context, "completion/${completion.key}"))
        .setAutoCancel(true)
        .setOnlyAlertOnce(true)
        .build()
      val identity = taskCompletionNotificationIdentity(completion.key)
      notify(context, identity.id, notification, identity.tag)
    }
    return executionActive
  }

  fun stopRuntime(context: Context) {
    TaskForegroundService.stop(context)
    TaskNotificationGroup.entries.forEach { manager(context).cancel(it.notificationId) }
    manager(context).cancel(TASK_QUIET_NOTIFICATION_ID)
    AndroidTaskNotificationActions.removeGroupActions(context)
  }

  private fun groupNotification(context: Context, group: AndroidTaskNotificationGroup): Notification {
    val builder = base(context, PROGRESS_CHANNEL_ID, group.title, group.body)
      .setContentIntent(AndroidTaskNotificationActions.activityIntent(context, "group/${group.group.key}/open"))
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .addAction(
        if (group.paused) android.R.drawable.ic_media_play else android.R.drawable.ic_media_pause,
        if (group.paused) group.resumeLabel else group.pauseLabel,
        AndroidTaskNotificationActions.controlIntent(context, group.group, group.paused),
      )
    group.progress?.let { builder.setProgress(it.total, it.current, false) }
    return builder.build()
  }

  private fun quietNotification(context: Context, title: String, quiet: Boolean): Notification =
    base(context, if (quiet) QUIET_CHANNEL_ID else PROGRESS_CHANNEL_ID, title, "")
      .setContentIntent(AndroidTaskNotificationActions.activityIntent(context, "execution"))
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(if (quiet) NotificationCompat.PRIORITY_MIN else NotificationCompat.PRIORITY_LOW)
      .build()

  private fun reconcileChallenges(context: Context, challenges: List<AndroidTaskNotificationChallenge>) {
    val preferences = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    val previous = preferences.getStringSet("challengeSources", emptySet()).orEmpty().toSet()
    val current = challenges.map { it.sourceId }.toSet()
    (previous - current).forEach {
      val identity = taskSourceNotificationIdentity(it)
      manager(context).cancel(identity.tag, identity.id)
    }
    challenges.forEach { challenge ->
      val intent = AndroidTaskNotificationActions.activityIntent(
        context,
        "source/${challenge.sourceId}",
        TaskNotificationAction.verifySource(challenge.sourceId, challenge.scopeKey, challenge.revision),
      )
      val notification = base(context, CHALLENGE_CHANNEL_ID, challenge.title, challenge.body)
        .setSmallIcon(android.R.drawable.stat_sys_warning)
        .setContentIntent(intent)
        .setCategory(NotificationCompat.CATEGORY_ERROR)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .addAction(android.R.drawable.ic_menu_view, challenge.actionLabel, intent)
        .build()
      val identity = taskSourceNotificationIdentity(challenge.sourceId)
      notify(context, identity.id, notification, identity.tag)
    }
    preferences.edit().putStringSet("challengeSources", current).apply()
  }

  private fun reconcileRanges(context: Context, ranges: List<AndroidTaskNotificationRange>) {
    val preferences = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    val previous = preferences.getStringSet("rangeNotificationTags", emptySet()).orEmpty().toSet()
    val current = ranges.map { it.identity.tag }.toSet()
    taskRemovedVpnDownloadNotificationIdentities(previous, current).forEach { identity ->
      manager(context).cancel(identity.tag, identity.id)
    }
    ranges.forEach { range ->
      val identity = range.identity
      val intent = AndroidTaskNotificationActions.activityIntent(context, identity.tag, range.action)
      val notification = base(context, CHALLENGE_CHANNEL_ID, range.title, range.body)
        .setSmallIcon(android.R.drawable.stat_sys_warning)
        .setContentIntent(intent)
        .setCategory(NotificationCompat.CATEGORY_ERROR)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .addAction(android.R.drawable.ic_menu_view, range.actionLabel, intent)
        .build()
      notify(context, identity.id, notification, identity.tag)
    }
    preferences.edit().putStringSet("rangeNotificationTags", current).apply()
  }

  private fun base(context: Context, channel: String, title: String, body: String): NotificationCompat.Builder =
    NotificationCompat.Builder(context, channel)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))

  private fun notify(context: Context, id: Int, notification: Notification, tag: String? = null) {
    try {
      manager(context).notify(tag, id, notification)
    } catch (error: SecurityException) {
      Log.w("NoreaTasks", "Notification permission is unavailable", error)
    }
  }

  private fun manager(context: Context): NotificationManager = context.getSystemService(NotificationManager::class.java)
}
