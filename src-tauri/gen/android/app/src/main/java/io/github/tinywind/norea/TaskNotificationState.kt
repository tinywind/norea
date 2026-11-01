package io.github.tinywind.norea

import java.util.UUID

internal enum class TaskNotificationGroup(val key: String, val notificationId: Int) {
  DOWNLOADS("downloads", 1101),
  LIBRARY_METADATA("libraryMetadata", 1102),
  LIBRARY_UPDATES("libraryUpdates", 1103),
  SEARCH("search", 1104);

  companion object {
    fun fromKey(key: String): TaskNotificationGroup? = entries.find { it.key == key }
  }
}

internal const val TASK_QUIET_NOTIFICATION_ID = 1001

internal data class TaskNotificationIdentity(val id: Int, val tag: String)

internal fun taskSourceNotificationIdentity(sourceId: String) =
  TaskNotificationIdentity(id = 1201, tag = "source/$sourceId")

internal fun taskCompletionNotificationIdentity(groupKey: String) =
  TaskNotificationIdentity(id = 1202, tag = "result/$groupKey")

internal data class TaskNotificationRuntimePlan(
  val anchorId: Int?,
  val quietAnchor: Boolean,
  val holdWakeLock: Boolean,
)

internal fun taskNotificationRuntimePlan(
  executionActive: Boolean,
  working: Boolean,
  groups: List<TaskNotificationGroup>,
): TaskNotificationRuntimePlan {
  if (!executionActive) return TaskNotificationRuntimePlan(null, false, false)
  val group = groups.minByOrNull { it.notificationId }
  return TaskNotificationRuntimePlan(
    anchorId = group?.notificationId ?: TASK_QUIET_NOTIFICATION_ID,
    quietAnchor = group == null,
    holdWakeLock = working,
  )
}

internal data class TaskNotificationProgress(val current: Int, val total: Int)

internal fun taskNotificationProgress(current: Int, total: Int?): TaskNotificationProgress? {
  if (total == null || total <= 0 || current < 0) return null
  return TaskNotificationProgress(current.coerceAtMost(total), total)
}

internal enum class TaskNotificationActionTarget { ACTIVITY, CONTROL }

internal data class TaskNotificationAction(
  val type: String,
  val groupKey: String? = null,
  val sourceId: String? = null,
  val scopeKey: String? = null,
  val revision: Long? = null,
) {
  fun accepts(target: TaskNotificationActionTarget): Boolean = when (type) {
    "openTasks" -> target == TaskNotificationActionTarget.ACTIVITY
    "pause", "resume" -> target == TaskNotificationActionTarget.CONTROL &&
      TaskNotificationGroup.fromKey(groupKey ?: "") != null
    "verifySource" -> target == TaskNotificationActionTarget.ACTIVITY &&
      !sourceId.isNullOrBlank() && !scopeKey.isNullOrBlank() && revision != null && revision >= 0
    else -> false
  }

  companion object {
    fun openTasks() = TaskNotificationAction(type = "openTasks")
    fun pause(groupKey: String) = TaskNotificationAction(type = "pause", groupKey = groupKey)
    fun resume(groupKey: String) = TaskNotificationAction(type = "resume", groupKey = groupKey)
    fun verifySource(sourceId: String, scopeKey: String, revision: Long) =
      TaskNotificationAction("verifySource", sourceId = sourceId, scopeKey = scopeKey, revision = revision)
  }
}

internal data class TaskNotificationActionToken(
  val identity: String,
  val token: String,
  val action: TaskNotificationAction,
)

internal data class TaskNotificationActionState(
  val tokens: List<TaskNotificationActionToken> = emptyList(),
  val pending: List<TaskNotificationAction> = emptyList(),
)

internal class TaskNotificationActionRegistry(
  initial: TaskNotificationActionState = TaskNotificationActionState(),
  private val tokenFactory: () -> String = { UUID.randomUUID().toString() },
  private val persist: (TaskNotificationActionState) -> Unit = {},
) {
  private var state = initial

  @Synchronized
  fun token(identity: String, action: TaskNotificationAction): String {
    val current = state.tokens.find { it.identity == identity }
    if (current?.action == action) return current.token
    val record = TaskNotificationActionToken(identity, tokenFactory(), action)
    save(state.copy(tokens = state.tokens.filterNot { it.identity == identity } + record))
    return record.token
  }

  @Synchronized
  fun retainIdentities(identities: Set<String>) {
    val retained = state.tokens.filter { it.identity in identities }
    if (retained.size != state.tokens.size) save(state.copy(tokens = retained))
  }

  @Synchronized
  fun removeGroupActions() {
    val retained = state.tokens.filterNot { it.identity.startsWith("group/") }
    if (retained.size != state.tokens.size) save(state.copy(tokens = retained))
  }

  @Synchronized
  fun enqueue(token: String, target: TaskNotificationActionTarget): TaskNotificationActionToken? {
    val current = state.tokens.find { it.token == token } ?: return null
    if (!current.action.accepts(target)) return null
    val renewed = current.copy(token = tokenFactory())
    save(state.copy(
      tokens = state.tokens.map { if (it.identity == current.identity) renewed else it },
      pending = state.pending + current.action,
    ))
    return renewed
  }

  @Synchronized
  fun drain(): List<TaskNotificationAction> {
    val pending = state.pending
    if (pending.isNotEmpty()) save(state.copy(pending = emptyList()))
    return pending
  }

  private fun save(next: TaskNotificationActionState) {
    persist(next)
    state = next
  }
}
