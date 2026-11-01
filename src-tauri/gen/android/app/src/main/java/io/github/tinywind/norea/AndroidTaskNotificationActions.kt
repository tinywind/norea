package io.github.tinywind.norea

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import java.lang.ref.WeakReference
import org.json.JSONArray
import org.json.JSONObject

internal fun TaskNotificationAction.toJson(): JSONObject = JSONObject().apply {
  put("type", type)
  groupKey?.let { put("groupKey", it) }
  sourceId?.let { put("sourceId", it) }
  scopeKey?.let { put("scopeKey", it) }
  revision?.let { put("revision", it) }
}

private fun notificationActionFromJson(json: JSONObject): TaskNotificationAction? {
  val action = TaskNotificationAction(
    type = json.optString("type"),
    groupKey = json.optString("groupKey").takeIf { it.isNotEmpty() },
    sourceId = json.optString("sourceId").takeIf { it.isNotEmpty() },
    scopeKey = json.optString("scopeKey").takeIf { it.isNotEmpty() },
    revision = json.takeIf { it.has("revision") }?.optLong("revision", -1),
  )
  return action.takeIf {
    it.accepts(TaskNotificationActionTarget.ACTIVITY) || it.accepts(TaskNotificationActionTarget.CONTROL)
  }
}

internal object AndroidTaskNotificationActions {
  private const val ACTION_OPEN = "io.github.tinywind.norea.task.OPEN"
  private const val ACTION_CONTROL = "io.github.tinywind.norea.task.CONTROL"
  private const val EXTRA_TOKEN = "noreaTaskActionToken"
  private const val PREFERENCES = "task-notification-actions"
  private var actionRegistry: TaskNotificationActionRegistry? = null
  private var listener: WeakReference<() -> Unit>? = null

  fun attach(callback: () -> Unit) { listener = WeakReference(callback) }

  fun detach(callback: () -> Unit) {
    if (listener?.get() === callback) listener = null
  }

  fun activityIntent(
    context: Context,
    identity: String,
    action: TaskNotificationAction = TaskNotificationAction.openTasks(),
  ): PendingIntent {
    val token = registry(context).token(identity, action)
    return activityPendingIntent(context, identity, token)
  }

  private fun activityPendingIntent(context: Context, identity: String, token: String): PendingIntent =
    PendingIntent.getActivity(
      context,
      0,
      Intent(context, MainActivity::class.java).apply {
        this.action = ACTION_OPEN
        addCategory("${context.packageName}.task.$identity")
        putExtra(EXTRA_TOKEN, token)
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      },
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

  fun controlIntent(context: Context, group: TaskNotificationGroup, paused: Boolean): PendingIntent {
    val action = if (paused) TaskNotificationAction.resume(group.key) else TaskNotificationAction.pause(group.key)
    val identity = "group/${group.key}/control"
    val token = registry(context).token(identity, action)
    return controlPendingIntent(context, identity, token)
  }

  private fun controlPendingIntent(context: Context, identity: String, token: String): PendingIntent =
    PendingIntent.getBroadcast(
      context,
      0,
      Intent(context, TaskNotificationActionReceiver::class.java).apply {
        this.action = ACTION_CONTROL
        addCategory("${context.packageName}.task.$identity")
        putExtra(EXTRA_TOKEN, token)
      },
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

  fun acceptActivityIntent(context: Context, intent: Intent?) {
    if (intent?.action != ACTION_OPEN) return
    val token = intent.getStringExtra(EXTRA_TOKEN) ?: return
    intent.removeExtra(EXTRA_TOKEN)
    enqueue(context, token, TaskNotificationActionTarget.ACTIVITY)
  }

  fun acceptControlIntent(context: Context, intent: Intent?) {
    if (intent?.action != ACTION_CONTROL) return
    val token = intent.getStringExtra(EXTRA_TOKEN) ?: return
    enqueue(context, token, TaskNotificationActionTarget.CONTROL)
  }

  fun retainIdentities(context: Context, identities: Set<String>) {
    val completionIdentities = TaskNotificationGroup.entries.map { "completion/${it.key}" }
    registry(context).retainIdentities(identities + completionIdentities + "execution")
  }

  fun removeGroupActions(context: Context) { registry(context).removeGroupActions() }

  fun drain(context: Context): String = JSONArray().apply {
    registry(context).drain().forEach { put(it.toJson()) }
  }.toString()

  private fun enqueue(context: Context, token: String, target: TaskNotificationActionTarget) {
    val accepted = registry(context).enqueue(token, target) ?: return
    when (target) {
      TaskNotificationActionTarget.ACTIVITY -> activityPendingIntent(context, accepted.identity, accepted.token)
      TaskNotificationActionTarget.CONTROL -> controlPendingIntent(context, accepted.identity, accepted.token)
    }
    Handler(Looper.getMainLooper()).post { listener?.get()?.invoke() }
  }

  @Synchronized
  private fun registry(context: Context): TaskNotificationActionRegistry {
    actionRegistry?.let { return it }
    val preferences = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    val initial = runCatching {
      val json = JSONObject(preferences.getString("state", null) ?: "{}")
      val tokens = json.optJSONArray("tokens") ?: JSONArray()
      val pending = json.optJSONArray("pending") ?: JSONArray()
      TaskNotificationActionState(
        tokens = (0 until tokens.length()).mapNotNull { index ->
          val entry = tokens.optJSONObject(index) ?: return@mapNotNull null
          val action = entry.optJSONObject("action")?.let(::notificationActionFromJson)
            ?: return@mapNotNull null
          val identity = entry.optString("identity").takeIf { it.isNotEmpty() }
            ?: return@mapNotNull null
          val token = entry.optString("token").takeIf { it.isNotEmpty() }
            ?: return@mapNotNull null
          TaskNotificationActionToken(identity, token, action)
        },
        pending = (0 until pending.length()).mapNotNull { index ->
          pending.optJSONObject(index)?.let(::notificationActionFromJson)
        },
      )
    }.getOrElse { TaskNotificationActionState() }
    return TaskNotificationActionRegistry(initial = initial, persist = { state ->
      val tokens = JSONArray().apply {
        state.tokens.forEach { record ->
          put(JSONObject().put("identity", record.identity).put("token", record.token).put("action", record.action.toJson()))
        }
      }
      val pending = JSONArray().apply { state.pending.forEach { put(it.toJson()) } }
      val json = JSONObject().put("tokens", tokens).put("pending", pending)
      check(preferences.edit().putString("state", json.toString()).commit()) {
        "Notification actions could not be persisted"
      }
    }).also { actionRegistry = it }
  }
}

class TaskNotificationActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    AndroidTaskNotificationActions.acceptControlIntent(context, intent)
  }
}
