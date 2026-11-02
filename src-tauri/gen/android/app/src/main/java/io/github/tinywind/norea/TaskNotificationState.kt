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

internal const val TASK_VPN_RANGE_NOTIFICATION_ID = 1203

internal fun taskVpnDownloadNotificationIdentity(planId: String, rangeId: String) =
  TaskNotificationIdentity(TASK_VPN_RANGE_NOTIFICATION_ID, "vpn/${planId.length}:$planId/${rangeId.length}:$rangeId")

internal fun taskRemovedVpnDownloadNotificationIdentities(previousTags: Set<String>, currentTags: Set<String>) =
  (previousTags - currentTags).map { TaskNotificationIdentity(TASK_VPN_RANGE_NOTIFICATION_ID, it) }

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

private const val TASK_NOTIFICATION_MAX_SAFE_INTEGER = 9_007_199_254_740_991L

internal fun taskNotificationIdentifier(value: Any?, maxLength: Int = 512): String? =
  (value as? String)?.takeIf { id ->
    id.any { !it.isWhitespace() && it != '\uFEFF' } && id.length <= maxLength && id.none { it.code < 32 || it.code == 127 }
  }

private fun taskNotificationInteger(value: Any?, minimum: Long): Long? {
  val number = value as? Number ?: return null
  val integer = number.toLong()
  return integer.takeIf {
    it in minimum..TASK_NOTIFICATION_MAX_SAFE_INTEGER && number.toDouble().isFinite() && number.toDouble() == it.toDouble()
  }
}

internal data class TaskNotificationAction(
  val type: String,
  val groupKey: String? = null,
  val sourceId: String? = null,
  val scopeKey: String? = null,
  val revision: Long? = null,
  val planId: String? = null,
  val rangeId: String? = null,
  val profileId: String? = null,
  val generation: Long? = null,
  val checkpoint: Long? = null,
) {
  fun accepts(target: TaskNotificationActionTarget): Boolean = when (type) {
    "openTasks" -> target == TaskNotificationActionTarget.ACTIVITY
    "pause", "resume" -> target == TaskNotificationActionTarget.CONTROL &&
      TaskNotificationGroup.fromKey(groupKey ?: "") != null
    "verifySource" -> target == TaskNotificationActionTarget.ACTIVITY &&
      taskNotificationIdentifier(sourceId) != null && taskNotificationIdentifier(scopeKey, 2048) != null &&
      revision != null && revision in 1..TASK_NOTIFICATION_MAX_SAFE_INTEGER
    "verifyVpnDownload" -> target == TaskNotificationActionTarget.ACTIVITY &&
      taskNotificationIdentifier(planId, 128) != null && taskNotificationIdentifier(sourceId) != null &&
      taskNotificationIdentifier(rangeId, 128) != null && taskNotificationIdentifier(profileId, 128) != null &&
      generation != null && generation in 1..TASK_NOTIFICATION_MAX_SAFE_INTEGER &&
      checkpoint != null && checkpoint in 0..TASK_NOTIFICATION_MAX_SAFE_INTEGER
    else -> false
  }

  companion object {
    fun openTasks() = TaskNotificationAction(type = "openTasks")
    fun pause(groupKey: String) = TaskNotificationAction(type = "pause", groupKey = groupKey)
    fun resume(groupKey: String) = TaskNotificationAction(type = "resume", groupKey = groupKey)
    fun verifySource(sourceId: String, scopeKey: String, revision: Long) =
      TaskNotificationAction("verifySource", sourceId = sourceId, scopeKey = scopeKey, revision = revision)
    fun verifyVpnDownload(planId: String, sourceId: String, rangeId: String, profileId: String, generation: Long, checkpoint: Long) =
      TaskNotificationAction("verifyVpnDownload", planId = planId, sourceId = sourceId, rangeId = rangeId,
        profileId = profileId, generation = generation, checkpoint = checkpoint)
  }
}

internal fun taskNotificationActionFromFields(field: (String) -> Any?): TaskNotificationAction? {
  val action = when (field("type")) {
    "openTasks" -> TaskNotificationAction.openTasks()
    "pause" -> TaskNotificationAction.pause(field("groupKey") as? String ?: return null)
    "resume" -> TaskNotificationAction.resume(field("groupKey") as? String ?: return null)
    "verifySource" -> TaskNotificationAction.verifySource(
      field("sourceId") as? String ?: return null,
      field("scopeKey") as? String ?: return null,
      taskNotificationInteger(field("revision"), 1) ?: return null,
    )
    "verifyVpnDownload" -> TaskNotificationAction.verifyVpnDownload(
      field("planId") as? String ?: return null,
      field("sourceId") as? String ?: return null,
      field("rangeId") as? String ?: return null,
      field("profileId") as? String ?: return null,
      taskNotificationInteger(field("generation"), 1) ?: return null,
      taskNotificationInteger(field("checkpoint"), 0) ?: return null,
    )
    else -> return null
  }
  return action.takeIf { it.accepts(TaskNotificationActionTarget.ACTIVITY) || it.accepts(TaskNotificationActionTarget.CONTROL) }
}

internal fun TaskNotificationAction.toFields(): Map<String, Any> = buildMap {
  put("type", type)
  groupKey?.let { put("groupKey", it) }
  sourceId?.let { put("sourceId", it) }
  scopeKey?.let { put("scopeKey", it) }
  revision?.let { put("revision", it) }
  planId?.let { put("planId", it) }
  rangeId?.let { put("rangeId", it) }
  profileId?.let { put("profileId", it) }
  generation?.let { put("generation", it) }
  checkpoint?.let { put("checkpoint", it) }
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
