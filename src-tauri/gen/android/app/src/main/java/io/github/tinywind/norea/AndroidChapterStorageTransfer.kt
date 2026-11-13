package io.github.tinywind.norea

import android.content.ContentResolver
import android.provider.DocumentsContract
import androidx.documentfile.provider.DocumentFile
import java.io.File
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

private fun validateAndroidContentStorageRelativeDir(
  relativePath: String,
  allowedDepths: Set<Int>,
): List<String> {
  val normalized = relativePath.replace('\\', '/')
  require(!normalized.startsWith('/') && !normalized.endsWith('/')) {
    "Android chapter storage path must be relative."
  }
  val segments = normalized.split('/')
  require(
    segments.size in allowedDepths &&
      segments.firstOrNull() == "contents" &&
      segments.all { segment ->
        segment.isNotEmpty() &&
          segment == segment.trim() &&
          segment != "." &&
          segment != ".." &&
          !segment.contains('\u0000')
      },
  ) {
    "Android chapter storage path must identify a novel or chapter directory."
  }
  return segments
}

internal fun validateAndroidChapterStorageRelativeDir(relativePath: String): List<String> =
  validateAndroidContentStorageRelativeDir(relativePath, setOf(4))

internal fun validateAndroidChapterStorageRemovalRelativeDir(relativePath: String): List<String> =
  validateAndroidContentStorageRelativeDir(relativePath, setOf(3, 4))

private fun validateAndroidChapterStorageTransferToken(token: String): String {
  require(
    token.isNotEmpty() &&
      token.length <= 128 &&
      token.all { character ->
        character.code < 128 &&
          (character.isLetterOrDigit() || character == '-' || character == '_')
      },
  ) {
    "Android chapter storage transfer token is invalid."
  }
  return token
}

internal fun resolveAndroidChapterStorageTransferToken(
  suppliedToken: String?,
  generateToken: () -> String,
): String = validateAndroidChapterStorageTransferToken(suppliedToken ?: generateToken())

internal fun androidChapterStorageTransferSiblingName(
  targetName: String,
  token: String,
  kind: String,
): String {
  require(
    targetName.isNotEmpty() &&
      targetName != "." &&
      targetName != ".." &&
      !targetName.contains('/') &&
      !targetName.contains('\\') &&
      !targetName.contains('\u0000'),
  ) {
    "Android chapter storage transfer target name is invalid."
  }
  require(kind == "stage" || kind == "backup") {
    "Android chapter storage transfer workspace kind is invalid."
  }
  return ".$targetName.norea-transfer-${validateAndroidChapterStorageTransferToken(token)}.$kind"
}

internal fun androidChapterStorageTransferMarkerName(token: String): String =
  ".norea-transfer-${validateAndroidChapterStorageTransferToken(token)}"


private const val WORK_RESET_COMPLETE = ".complete"

internal class AndroidChapterStorageTransfer(
  private val contentResolver: ContentResolver,
  private val storage: AndroidStorageDocuments,
) {
  private data class ChapterStorageTransferEntry(
    val entryId: String,
    val sourceRelativeDir: String,
    val targetRelativeDir: String,
  )

  private data class PreparedChapterStorageTransferEntry(
    val entry: ChapterStorageTransferEntry,
    val outcome: String,
    val replacedTarget: Boolean,
  )

  private data class ChapterStorageTransferPreparation(
    val token: String,
    val entries: List<PreparedChapterStorageTransferEntry>,
  )

  private data class ChapterStorageTransferArtifacts(
    val contentBytes: Long,
    val contentName: String,
    val mediaBytes: Long,
  )

  private fun chapterStorageTransferToken(): String =
    "${System.currentTimeMillis()}-${System.nanoTime().toString().replace('-', 'n')}"

  private fun parseChapterStorageTransferEntries(
    entries: JSONArray,
  ): List<ChapterStorageTransferEntry> {
    require(entries.length() > 0) { "Android chapter storage transfer is empty." }
    val entryIds = mutableSetOf<String>()
    val sources = mutableSetOf<String>()
    val targets = mutableSetOf<String>()
    return (0 until entries.length()).map { index ->
      val value = entries.getJSONObject(index)
      val entryId = value.getString("entryId").trim()
      require(entryId.isNotEmpty() && entryIds.add(entryId)) {
        "Android chapter storage transfer entry id is empty or duplicated."
      }
      val source = validateAndroidChapterStorageRelativeDir(
        value.getString("sourceRelativeDir"),
      ).joinToString("/")
      val target = validateAndroidChapterStorageRelativeDir(
        value.getString("targetRelativeDir"),
      ).joinToString("/")
      require(source != target) {
        "Android chapter storage transfer source and target must differ."
      }
      require(sources.add(source)) {
        "Android chapter storage transfer source is duplicated."
      }
      require(targets.add(target)) {
        "Android chapter storage transfer target is duplicated."
      }
      ChapterStorageTransferEntry(entryId, source, target)
    }
  }

  private fun parseChapterStorageTransferPreparation(
    preparationJson: String,
  ): ChapterStorageTransferPreparation {
    val value = JSONObject(preparationJson)
    val token = validateAndroidChapterStorageTransferToken(value.getString("token"))
    val entriesJson = value.getJSONArray("entries")
    val entries = parseChapterStorageTransferEntries(entriesJson)
    val preparedEntries = entries.mapIndexed { index, entry ->
      val prepared = entriesJson.getJSONObject(index)
      val outcome = prepared.getString("outcome")
      require(
        outcome == "copiedSource" ||
          outcome == "movedSource" ||
          outcome == "keptTarget" ||
          outcome == "sourceNotDownloaded",
      ) {
        "Android chapter storage transfer outcome is invalid."
      }
      PreparedChapterStorageTransferEntry(
        entry = entry,
        outcome = outcome,
        replacedTarget = prepared.optBoolean("replacedTarget", false),
      )
    }
    return ChapterStorageTransferPreparation(token, preparedEntries)
  }

  private fun preparedChapterStorageTransferEntryJson(
    entry: ChapterStorageTransferEntry,
    outcome: String,
    replacedTarget: Boolean,
    artifacts: ChapterStorageTransferArtifacts?,
  ): JSONObject =
    JSONObject()
      .put("entryId", entry.entryId)
      .put("sourceRelativeDir", entry.sourceRelativeDir)
      .put("targetRelativeDir", entry.targetRelativeDir)
      .put("outcome", outcome)
      .put("replacedTarget", replacedTarget)
      .put(
        "contentFile",
        artifacts?.let { "${entry.targetRelativeDir}/${it.contentName}" } ?: JSONObject.NULL,
      )
      .put("contentBytes", artifacts?.contentBytes ?: 0L)
      .put("mediaBytes", artifacts?.mediaBytes ?: 0L)

  private fun inspectChapterStorageTransferArtifacts(
    directory: DocumentFile,
    relativeDir: String,
    lookup: ChildLookup = ChildLookup(),
  ): ChapterStorageTransferArtifacts? {
    if (!directory.isDirectory) return null
    require(directory.canRead()) {
      "Android chapter storage path is not readable: $relativeDir"
    }
    val content = listOf("content.html", "content.pdf")
      .firstNotNullOfOrNull { name ->
        lookup.child(directory, name)?.also { candidate ->
          require(candidate.isFile) {
            "Android chapter storage content path is not a file: $relativeDir/$name"
          }
          require(candidate.canRead()) {
            "Android chapter storage content is not readable: $relativeDir/$name"
          }
        }
      } ?: return null
    val contentName = content.name
      ?: throw IllegalStateException("Android chapter storage content name is unavailable.")
    val mediaDirectoryBytes = lookup.child(directory, "media")?.let { media ->
      require(media.isDirectory) {
        "Android chapter storage media path is not a folder: $relativeDir/media"
      }
      storage.storageDocumentSize(media)
    } ?: 0L
    val mediaArchiveBytes = lookup.child(directory, "media.zip")?.let { archive ->
      require(archive.isFile) {
        "Android chapter storage media archive is not a file: $relativeDir/media.zip"
      }
      archive.length().coerceAtLeast(0L)
    } ?: 0L
    return ChapterStorageTransferArtifacts(
      contentBytes = content.length().coerceAtLeast(0L),
      contentName = contentName,
      mediaBytes = Math.addExact(mediaDirectoryBytes, mediaArchiveBytes),
    )
  }

  private fun ensureChapterStorageTransferParent(
    rootUri: String,
    targetSegments: List<String>,
  ): DocumentFile {
    var current = storage.storageRoot(rootUri)
    for (segment in targetSegments.dropLast(1)) {
      current = storage.ensureStorageDirectory(current, segment)
    }
    return current
  }

  private fun requireAndroidStorageEntryName(name: String?): String {
    val value = name
      ?: throw IllegalStateException("Android chapter storage entry has no name.")
    require(
      value.isNotEmpty() &&
        value == value.trim() &&
        value != "." &&
        value != ".." &&
        !value.contains('/') &&
        !value.contains('\\') &&
        !value.contains('\u0000'),
    ) {
      "Android chapter storage entry name is invalid."
    }
    return value
  }

  private fun copyChapterStorageDirectory(
    source: DocumentFile,
    targetParent: DocumentFile,
    targetName: String,
    targetRelativeDir: String,
  ): DocumentFile {
    require(source.isDirectory && source.canRead()) {
      "Android chapter storage transfer source is not a readable folder."
    }
    require(storage.findStorageChildWithoutRecovery(targetParent, targetName) == null) {
      "Android chapter storage transfer stage already exists."
    }
    val target = targetParent.createDirectory(targetName)
      ?.let { created ->
        storage.requireExactCreatedStorageName(
          created,
          targetName,
          "folder",
          "Android chapter storage transfer stage is inaccessible.",
        )
      }
      ?: throw IllegalStateException("Cannot create Android chapter storage transfer stage.")

    fun copyChildren(sourceDirectory: DocumentFile, targetDirectory: DocumentFile, path: String) {
      for (sourceChild in sourceDirectory.listFiles()) {
        val name = requireAndroidStorageEntryName(sourceChild.name)
        val childPath = "$path/$name"
        when {
          sourceChild.isDirectory -> {
            val targetChild = targetDirectory.createDirectory(name)
              ?.let { created ->
                storage.requireExactCreatedStorageName(
                  created,
                  name,
                  "folder",
                  "Android chapter storage transfer folder is inaccessible: $childPath",
                )
              }
              ?: throw IllegalStateException(
                "Cannot create Android chapter storage transfer folder: $childPath",
              )
            copyChildren(sourceChild, targetChild, childPath)
          }
          sourceChild.isFile -> {
            require(sourceChild.canRead()) {
              "Android chapter storage transfer file is not readable: $childPath"
            }
            val targetChild = storage.createStorageFile(
              targetDirectory,
              sourceChild.type ?: storage.mimeTypeForPath(childPath, "application/octet-stream"),
              name,
            )?.let { created ->
              storage.requireExactCreatedStorageName(
                created,
                name,
                "file",
                "Android chapter storage transfer file is inaccessible: $childPath",
              )
            } ?: throw IllegalStateException(
              "Cannot create Android chapter storage transfer file: $childPath",
            )
            val input = contentResolver.openInputStream(sourceChild.uri)
              ?: throw IllegalStateException(
                "Cannot open Android chapter storage transfer source: $childPath",
              )
            val output = contentResolver.openOutputStream(targetChild.uri, "wt")
              ?: throw IllegalStateException(
                "Cannot open Android chapter storage transfer target: $childPath",
              )
            input.use { sourceStream ->
              output.use { targetStream ->
                sourceStream.copyTo(targetStream, DEFAULT_STORAGE_COPY_BUFFER_BYTES)
              }
            }
          }
          else -> throw IllegalStateException(
            "Android chapter storage transfer contains an unsupported entry: $childPath",
          )
        }
      }
    }

    return try {
      copyChildren(source, target, targetRelativeDir)
      target
    } catch (error: Throwable) {
      runCatching {
        deleteChapterStorageDocument(
          target,
          "Cannot remove failed Android chapter storage transfer stage.",
        )
      }.exceptionOrNull()?.let(error::addSuppressed)
      throw error
    }
  }

  private fun deleteChapterStorageDocument(document: DocumentFile, context: String) {
    if (!document.delete()) {
      throw IllegalStateException(context)
    }
  }

  private fun renameChapterStorageDocument(
    parent: DocumentFile,
    document: DocumentFile,
    newName: String,
    context: String,
  ): DocumentFile {
    require(storage.findStorageChildWithoutRecovery(parent, newName) == null) {
      "Android chapter storage transfer target already exists: $newName"
    }
    if (!document.renameTo(newName)) {
      throw IllegalStateException(context)
    }
    return storage.findStorageChildWithoutRecovery(parent, newName)
      ?: throw IllegalStateException("Android chapter storage renamed path is inaccessible: $newName")
  }

  private val moveMarker = "{\"mode\":\"move\"}".toByteArray(Charsets.UTF_8)

  /**
   * Chapters a transfer is about to touch, written before each one and synced, so recovering an
   * interrupted transfer only has to look at those chapters instead of every planned one.
   */
  private fun transferProgressFile(token: String): File =
    File(storage.transferProgressRoot(), validateAndroidChapterStorageTransferToken(token))

  private fun recordTransferProgress(token: String, entryId: String) {
    require(!entryId.contains('\n')) { "Android chapter storage transfer entry id is invalid." }
    val file = transferProgressFile(token)
    file.parentFile?.mkdirs()
    java.io.FileOutputStream(file, true).use { output ->
      output.write("$entryId\n".toByteArray(Charsets.UTF_8))
      output.fd.sync()
    }
  }

  /** The chapters an earlier attempt touched, or null when it left no record. */
  private fun recordedTransferProgress(token: String): Set<String>? =
    transferProgressFile(token).takeIf { it.isFile }?.readLines(Charsets.UTF_8)?.filter { it.isNotEmpty() }?.toSet()

  private fun clearTransferProgress(token: String) {
    transferProgressFile(token).delete()
  }

  /**
   * Answers child lookups from one provider listing per folder. A missing child then costs no
   * provider query, which is what most checks of an interrupted transfer ask about. Any change to
   * the folders drops the listings so the next lookup reads them again.
   */
  private inner class ChildLookup {
    private val listings = HashMap<String, Map<String, AndroidStorageDocuments.StorageChildDocument>>()
    private val documents = HashMap<String, DocumentFile?>()

    fun child(parent: DocumentFile, name: String): DocumentFile? {
      val children = listings.getOrPut(parent.uri.toString()) {
        storage.listStorageChildren(parent).associateBy { it.name }
      }
      return children[name]?.let(storage::storageChildDocumentFile)
    }

    fun at(rootUri: String, relativePath: String): DocumentFile? =
      documents.getOrPut(relativePath) { storage.storageDocumentAt(rootUri, relativePath) }

    fun changed() {
      listings.clear()
      documents.clear()
    }
  }

  private fun isMovedChapter(document: DocumentFile, token: String, lookup: ChildLookup = ChildLookup()): Boolean {
    val marker = lookup.child(document, androidChapterStorageTransferMarkerName(token)) ?: return false
    return contentResolver.openInputStream(marker.uri)?.use { input ->
      val bytes = ByteArray(moveMarker.size)
      var offset = 0
      while (offset < bytes.size) {
        val count = input.read(bytes, offset, bytes.size - offset)
        if (count <= 0) return@use false
        offset += count
      }
      bytes.contentEquals(moveMarker) && input.read() == -1
    } ?: throw IllegalStateException("Cannot read Android chapter move marker.")
  }

  private fun moveChapterStorageDocument(parent: DocumentFile, document: DocumentFile, targetParent: DocumentFile): DocumentFile {
    val name = requireAndroidStorageEntryName(document.name)
    require(storage.findStorageChildWithoutRecovery(targetParent, name) == null) { "Android chapter move target is occupied: $name" }
    if (document.uri.scheme == ContentResolver.SCHEME_FILE) {
      check(File(document.uri.path!!).renameTo(File(targetParent.uri.path!!, name))) { "Cannot move Android chapter folder." }
    } else {
      checkNotNull(DocumentsContract.moveDocument(contentResolver, document.uri, parent.uri, targetParent.uri)) {
        "Cannot move Android chapter folder."
      }
    }
    return storage.findStorageChildWithoutRecovery(targetParent, name)
      ?: throw IllegalStateException("Moved Android chapter folder is inaccessible: $name")
  }

  private fun restoreChapterStorageCandidate(
    rootUri: String, entry: ChapterStorageTransferEntry, token: String, parent: DocumentFile, candidate: DocumentFile,
    lookup: ChildLookup = ChildLookup(),
  ) {
    val markerName = androidChapterStorageTransferMarkerName(token)
    val marker = lookup.child(candidate, markerName) ?: return
    lookup.changed()
    val source = storage.storageDocumentAt(rootUri, entry.sourceRelativeDir)
    if (source?.uri == candidate.uri) {
      deleteChapterStorageDocument(marker, "Cannot remove restored Android chapter move marker.")
      return
    }
    if (!isMovedChapter(candidate, token)) {
      deleteChapterStorageDocument(candidate, "Cannot remove rolled back Android chapter copy.")
      return
    }
    val sourceSegments = validateAndroidChapterStorageRelativeDir(entry.sourceRelativeDir)
    require(source == null) { "Cannot restore a moved Android chapter over an occupied source." }
    val sourceParent = ensureChapterStorageTransferParent(rootUri, sourceSegments)
    var restored = candidate
    if (parent.uri != sourceParent.uri) {
      val stageName = androidChapterStorageTransferSiblingName(entry.targetRelativeDir.substringAfterLast('/'), token, "stage")
      if (restored.name != stageName) restored = renameChapterStorageDocument(parent, restored, stageName, "Cannot stage Android chapter move rollback.")
      restored = moveChapterStorageDocument(parent, restored, sourceParent)
    }
    if (restored.name != sourceSegments.last()) {
      restored = renameChapterStorageDocument(sourceParent, restored, sourceSegments.last(), "Cannot restore Android chapter move source name.")
    }
    storage.findStorageChildWithoutRecovery(restored, markerName)?.let {
      deleteChapterStorageDocument(it, "Cannot remove restored Android chapter move marker.")
    }
  }

  private fun rollbackChapterStorageEntry(
    rootUri: String, entry: ChapterStorageTransferEntry, token: String, lookup: ChildLookup = ChildLookup(),
  ) {
    val targetSegments = validateAndroidChapterStorageRelativeDir(entry.targetRelativeDir)
    val targetParent = lookup.at(rootUri, targetSegments.dropLast(1).joinToString("/"))
    val stageName = androidChapterStorageTransferSiblingName(targetSegments.last(), token, "stage")
    if (targetParent != null) {
      lookup.child(targetParent, targetSegments.last())?.let {
        restoreChapterStorageCandidate(rootUri, entry, token, targetParent, it, lookup)
      }
      lookup.child(targetParent, stageName)?.let {
        restoreChapterStorageCandidate(rootUri, entry, token, targetParent, it, lookup)
      }
      lookup.child(targetParent, stageName)?.let {
        deleteChapterStorageDocument(it, "Cannot remove rolled back Android chapter storage stage.")
        lookup.changed()
      }
      val backupName = androidChapterStorageTransferSiblingName(targetSegments.last(), token, "backup")
      lookup.child(targetParent, backupName)?.let {
        renameChapterStorageDocument(targetParent, it, targetSegments.last(), "Cannot restore Android chapter storage backup.")
        lookup.changed()
      }
    }
    val sourceSegments = validateAndroidChapterStorageRelativeDir(entry.sourceRelativeDir)
    val sourceParent = lookup.at(rootUri, sourceSegments.dropLast(1).joinToString("/"))
    sourceParent?.let { parent ->
      lookup.child(parent, stageName)?.let { restoreChapterStorageCandidate(rootUri, entry, token, parent, it, lookup) }
      lookup.child(parent, sourceSegments.last())?.let {
        restoreChapterStorageCandidate(rootUri, entry, token, parent, it, lookup)
      }
    }
  }

  private fun moveChapterStorageDirectory(rootUri: String, entry: ChapterStorageTransferEntry, targetParent: DocumentFile, token: String): DocumentFile? {
    val source = storage.storageDocumentAt(rootUri, entry.sourceRelativeDir) ?: error("Android chapter move source disappeared.")
    if (source.uri.authority != targetParent.uri.authority) return null
    if (source.uri.scheme != ContentResolver.SCHEME_FILE) {
      val supported = contentResolver.query(source.uri, arrayOf(DocumentsContract.Document.COLUMN_FLAGS), null, null, null)?.use {
        it.moveToFirst() && it.getLong(0) and DocumentsContract.Document.FLAG_SUPPORTS_MOVE.toLong() != 0L
      } ?: false
      if (!supported) return null
    }
    val markerName = androidChapterStorageTransferMarkerName(token)
    require(storage.findStorageChildWithoutRecovery(source, markerName) == null) { "Android chapter move marker already exists." }
    val marker = checkNotNull(storage.createStorageFile(source, "application/octet-stream", markerName)) { "Cannot create Android chapter move marker." }
    storage.requireExactCreatedStorageName(marker, markerName, "file", "Android chapter move marker is inaccessible.")
    checkNotNull(contentResolver.openOutputStream(marker.uri, "wt")).use { it.write(moveMarker) }
    check(isMovedChapter(source, token)) { "Android chapter move marker could not be verified." }
    try {
      val sourceParent = checkNotNull(storage.storageDocumentAt(rootUri, entry.sourceRelativeDir.substringBeforeLast('/')))
      val stageName = androidChapterStorageTransferSiblingName(entry.targetRelativeDir.substringAfterLast('/'), token, "stage")
      val staged = renameChapterStorageDocument(sourceParent, source, stageName, "Cannot stage Android chapter folder move.")
      return moveChapterStorageDocument(sourceParent, staged, targetParent)
    } catch (error: Throwable) {
      try { rollbackChapterStorageEntry(rootUri, entry, token) }
      catch (recovery: Throwable) { error.addSuppressed(recovery); throw error }
      if (error is UnsupportedOperationException) return null
      throw error
    }
  }

  private fun prepareChapterStorageTransferEntry(
    rootUri: String,
    entry: ChapterStorageTransferEntry,
    token: String,
    requireEmptyTargets: Boolean,
    moveSource: Boolean,
  ): JSONObject {
    val targetSegments = validateAndroidChapterStorageRelativeDir(entry.targetRelativeDir)
    val targetName = targetSegments.last()
    storage.storageDocumentAt(rootUri, entry.targetRelativeDir)?.let { target ->
      require(!requireEmptyTargets) {
        "Android chapter storage transfer target must be absent: ${entry.targetRelativeDir}"
      }
      inspectChapterStorageTransferArtifacts(target, entry.targetRelativeDir)?.let { artifacts ->
        return preparedChapterStorageTransferEntryJson(
          entry,
          "keptTarget",
          false,
          artifacts,
        )
      }
    }

    val source = storage.storageDocumentAt(rootUri, entry.sourceRelativeDir)
      ?: return preparedChapterStorageTransferEntryJson(
        entry,
        "sourceNotDownloaded",
        false,
        null,
      )
    require(source.isDirectory) {
      "Android chapter storage transfer source is not a folder: ${entry.sourceRelativeDir}"
    }
    val sourceArtifacts = inspectChapterStorageTransferArtifacts(
      source,
      entry.sourceRelativeDir,
    ) ?: run {
      require(!requireEmptyTargets) {
        "Android chapter storage transfer source has unfinished content: ${entry.sourceRelativeDir}"
      }
      return preparedChapterStorageTransferEntryJson(
        entry,
        "sourceNotDownloaded",
        false,
        null,
      )
    }

    val targetParent = ensureChapterStorageTransferParent(rootUri, targetSegments)
    val stageName = androidChapterStorageTransferSiblingName(targetName, token, "stage")
    val backupName = androidChapterStorageTransferSiblingName(targetName, token, "backup")
    require(storage.findStorageChildWithoutRecovery(targetParent, stageName) == null && storage.findStorageChildWithoutRecovery(targetParent, backupName) == null) {
      "Android chapter storage transfer workspace already exists."
    }

    var replacedTarget = false
    try {
      val moved = if (moveSource) moveChapterStorageDirectory(rootUri, entry, targetParent, token) else null
      val stage = moved ?: copyChapterStorageDirectory(
        storage.storageDocumentAt(rootUri, entry.sourceRelativeDir) ?: error("Android chapter transfer source disappeared."),
        targetParent,
        stageName,
        entry.targetRelativeDir,
      )
      val markerName = androidChapterStorageTransferMarkerName(token)
      require(moved != null || storage.findStorageChildWithoutRecovery(stage, markerName) == null) {
        "Android chapter storage transfer marker already exists in copied source."
      }
      if (moved == null) {
        storage.createStorageFile(stage, "application/octet-stream", markerName)
        ?.let { marker ->
          storage.requireExactCreatedStorageName(
            marker,
            markerName,
            "file",
            "Android chapter storage transfer marker is inaccessible.",
          )
        }
        ?: throw IllegalStateException(
          "Cannot create Android chapter storage transfer marker.",
        )
      }
      val stagedArtifacts = inspectChapterStorageTransferArtifacts(
        stage,
        "${targetSegments.dropLast(1).joinToString("/")}/$stageName",
      ) ?: throw IllegalStateException(
        "Android copied chapter storage transfer has no final content.",
      )
      require(
        stagedArtifacts.contentBytes == sourceArtifacts.contentBytes &&
          stagedArtifacts.mediaBytes == sourceArtifacts.mediaBytes,
      ) {
        "Android copied chapter storage transfer failed artifact verification."
      }

      storage.findStorageChildWithoutRecovery(targetParent, targetName)?.let { racedTarget ->
        require(!requireEmptyTargets) {
          "Android chapter storage transfer target appeared during preparation."
        }
        inspectChapterStorageTransferArtifacts(
          racedTarget,
          entry.targetRelativeDir,
        )?.let { targetArtifacts ->
          if (moved != null) restoreChapterStorageCandidate(rootUri, entry, token, targetParent, stage)
          else deleteChapterStorageDocument(stage, "Cannot remove superseded Android chapter storage transfer stage.")
          return preparedChapterStorageTransferEntryJson(
            entry,
            "keptTarget",
            false,
            targetArtifacts,
          )
        }
        renameChapterStorageDocument(
          targetParent,
          racedTarget,
          backupName,
          "Cannot backup invalid Android chapter storage transfer target.",
        )
        replacedTarget = true
      }

      renameChapterStorageDocument(
        targetParent,
        stage,
        targetName,
        "Cannot publish Android chapter storage transfer.",
      )
      val published = storage.findStorageChildWithoutRecovery(targetParent, targetName)
        ?: throw IllegalStateException("Published Android chapter storage transfer is missing.")
      val publishedArtifacts = inspectChapterStorageTransferArtifacts(
        published,
        entry.targetRelativeDir,
      ) ?: throw IllegalStateException(
        "Published Android chapter storage transfer has no final content.",
      )
      return preparedChapterStorageTransferEntryJson(
        entry,
        if (moved != null) "movedSource" else "copiedSource",
        replacedTarget,
        publishedArtifacts,
      )
    } catch (error: Throwable) {
      runCatching { rollbackChapterStorageEntry(rootUri, entry, token) }.exceptionOrNull()?.let(error::addSuppressed)
      throw error
    }
  }

  fun prepareChapterStorageTransfer(
    rootUri: String,
    entriesJson: String,
    optionsJson: String = "{}",
  ): JSONObject {
    val entries = parseChapterStorageTransferEntries(JSONArray(entriesJson))
    val options = JSONObject(optionsJson)
    val suppliedToken = options.opt("token").takeUnless { it == JSONObject.NULL }
    require(suppliedToken == null || suppliedToken is String) {
      "Android chapter storage transfer token must be a string."
    }
    val strictOption = options.opt("requireEmptyTargets").takeUnless { it == JSONObject.NULL }
    require(strictOption == null || strictOption is Boolean) {
      "Android chapter storage transfer target policy must be a boolean."
    }
    val requireEmptyTargets = strictOption == true
    val moveOption = options.opt("moveSource").takeUnless { it == JSONObject.NULL }
    require(moveOption == null || moveOption is Boolean) { "Android chapter storage move policy must be a boolean." }
    val moveSource = moveOption == true
    val token = resolveAndroidChapterStorageTransferToken(suppliedToken as String?) {
      chapterStorageTransferToken()
    }
    if (requireEmptyTargets || moveSource) {
      val sources = entries.map { it.sourceRelativeDir }.toSet()
      val lookup = ChildLookup()
      for (entry in entries) {
        require(entry.targetRelativeDir !in sources) {
          "Android chapter storage transfer sources and targets must be disjoint."
        }
        val targetSegments = validateAndroidChapterStorageRelativeDir(entry.targetRelativeDir)
        val parent = lookup.at(rootUri, targetSegments.dropLast(1).joinToString("/"))
        require(!requireEmptyTargets || parent?.let { lookup.child(it, targetSegments.last()) } == null) {
          "Android chapter storage transfer target must be absent: ${entry.targetRelativeDir}"
        }
        for (kind in listOf("stage", "backup")) {
          val name = androidChapterStorageTransferSiblingName(targetSegments.last(), token, kind)
          require(parent?.let { lookup.child(it, name) } == null) {
            "Android chapter storage transfer workspace already exists."
          }
        }
        val sourceSegments = validateAndroidChapterStorageRelativeDir(entry.sourceRelativeDir)
        lookup.at(rootUri, sourceSegments.dropLast(1).joinToString("/"))?.let { lookup.child(it, sourceSegments.last()) }?.let { source ->
          require(source.isDirectory) {
            "Android chapter storage transfer source is not a folder: ${entry.sourceRelativeDir}"
          }
          require(inspectChapterStorageTransferArtifacts(source, entry.sourceRelativeDir, lookup) != null) {
            "Android chapter storage transfer source has unfinished content: ${entry.sourceRelativeDir}"
          }
        }
      }
    }
    storage.ensureContentsNoMedia(rootUri)
    val prepared = JSONArray()
    try {
      for (entry in entries) {
        recordTransferProgress(token, entry.entryId)
        prepared.put(prepareChapterStorageTransferEntry(rootUri, entry, token, requireEmptyTargets, moveSource))
      }
    } catch (error: Throwable) {
      if (prepared.length() > 0) {
        val preparation = ChapterStorageTransferPreparation(
          token,
          (0 until prepared.length()).map { index ->
            val value = prepared.getJSONObject(index)
            PreparedChapterStorageTransferEntry(
              entry = entries[index],
              outcome = value.getString("outcome"),
              replacedTarget = value.optBoolean("replacedTarget", false),
            )
          },
        )
        runCatching {
          rollbackChapterStorageTransfer(rootUri, preparation)
        }.exceptionOrNull()?.let(error::addSuppressed)
      }
      throw error
    }
    return JSONObject()
      .put("token", token)
      .put("entries", prepared)
  }

  fun finalizeChapterStorageTransfer(rootUri: String, preparationJson: String) {
    finalizeChapterStorageTransfer(
      rootUri,
      parseChapterStorageTransferPreparation(preparationJson),
    )
  }

  private fun finalizeChapterStorageTransfer(
    rootUri: String,
    preparation: ChapterStorageTransferPreparation,
  ) {
    validateAndroidChapterStorageTransferToken(preparation.token)
    val lookup = ChildLookup()
    for (prepared in preparation.entries) {
      val entry = prepared.entry
      val targetSegments = validateAndroidChapterStorageRelativeDir(entry.targetRelativeDir)
      val targetName = targetSegments.last()
      val parentPath = targetSegments.dropLast(1).joinToString("/")
      val parent = lookup.at(rootUri, parentPath)
      if (prepared.outcome == "copiedSource" || prepared.outcome == "movedSource") {
        val target = parent?.let { lookup.child(it, targetName) }
          ?: throw IllegalStateException(
            "Cannot finalize Android chapter storage transfer without its target.",
          )
        require(
          inspectChapterStorageTransferArtifacts(target, entry.targetRelativeDir, lookup) != null,
        ) {
          "Cannot finalize Android chapter storage transfer without final target content."
        }
        val markerName = androidChapterStorageTransferMarkerName(preparation.token)
        val sourceSegments = validateAndroidChapterStorageRelativeDir(entry.sourceRelativeDir)
        val source = lookup.at(rootUri, sourceSegments.dropLast(1).joinToString("/"))?.let { lookup.child(it, sourceSegments.last()) }
        if (prepared.outcome == "copiedSource" && source != null) {
          require(source.isDirectory) {
            "Android chapter storage transfer source is not a folder."
          }
          val marker = lookup.child(target, markerName)
          require(marker?.isFile == true) {
            "Cannot finalize an unmarked Android chapter storage transfer target."
          }
          deleteChapterStorageDocument(
            source,
            "Cannot remove finalized Android chapter storage transfer source.",
          )
          lookup.changed()
        }
        lookup.child(target, markerName)?.let { marker ->
          require(marker.isFile) {
            "Android chapter storage transfer marker is not a file."
          }
          deleteChapterStorageDocument(
            marker,
            "Cannot remove finalized Android chapter storage transfer marker.",
          )
          lookup.changed()
        }
      }
      parent?.let { lookup.child(it, androidChapterStorageTransferSiblingName(targetName, preparation.token, "stage")) }?.let { stage ->
        deleteChapterStorageDocument(stage, "Cannot remove finalized Android chapter storage transfer stage.")
        lookup.changed()
      }
      parent?.let { lookup.child(it, androidChapterStorageTransferSiblingName(targetName, preparation.token, "backup")) }?.let { backup ->
        deleteChapterStorageDocument(
          backup,
          "Cannot remove finalized Android chapter storage transfer backup.",
        )
        lookup.changed()
      }
    }
    clearTransferProgress(preparation.token)
  }

  fun rollbackChapterStorageTransfer(rootUri: String, preparationJson: String) {
    rollbackChapterStorageTransfer(
      rootUri,
      parseChapterStorageTransferPreparation(preparationJson),
    )
  }

  private fun rollbackChapterStorageTransfer(
    rootUri: String,
    preparation: ChapterStorageTransferPreparation,
  ) {
    validateAndroidChapterStorageTransferToken(preparation.token)
    val touched = recordedTransferProgress(preparation.token)
    val lookup = ChildLookup()
    for (prepared in preparation.entries.asReversed()) {
      if (touched != null && prepared.entry.entryId !in touched) continue
      if (prepared.outcome == "copiedSource" || prepared.outcome == "movedSource") {
        rollbackChapterStorageEntry(rootUri, prepared.entry, preparation.token, lookup)
      }
    }
    clearTransferProgress(preparation.token)
  }

  /**
   * Deletes a work folder's downloads with one provider request instead of one per chapter. The work
   * metadata and cover are copied to an app-private backup, the folder is deleted, and both files are
   * written back into a new folder. A complete backup left by an interrupted reset is restored first.
   */
  fun resetWorkStorageDirectory(rootUri: String, relativeDir: String, backupRoot: File) {
    val segments = validateAndroidContentStorageRelativeDir(relativeDir, setOf(3))
    val normalized = segments.joinToString("/")
    val backupName = MessageDigest.getInstance("SHA-256").digest(normalized.toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it) }
    val backupDir = File(backupRoot, backupName)
    val complete = File(backupDir, WORK_RESET_COMPLETE)
    if (complete.isFile) restoreWorkStorageFiles(rootUri, segments, backupDir)
    backupDir.deleteRecursively()
    val directory = storage.storageDocumentAt(rootUri, normalized) ?: return
    require(directory.isDirectory) { "Android work storage path is not a folder: $normalized" }
    check(backupDir.mkdirs()) { "Cannot create the work folder backup." }
    for (child in storage.listStorageChildren(directory)) {
      if (child.isDirectory || (child.name != "novel.json" && !isAndroidWorkCoverFile(child.name))) continue
      val part = File(backupDir, "${child.name}.part")
      contentResolver.openInputStream(child.uri)?.use { input -> part.outputStream().use { input.copyTo(it) } }
        ?: throw IllegalStateException("Cannot read work file for backup: ${child.name}")
      check(part.renameTo(File(backupDir, child.name))) { "Cannot keep the work file backup: ${child.name}" }
    }
    check(complete.createNewFile()) { "Cannot mark the work folder backup complete." }
    deleteChapterStorageDocument(directory, "Cannot remove Android work storage directory: $normalized")
    restoreWorkStorageFiles(rootUri, segments, backupDir)
    backupDir.deleteRecursively()
  }

  private fun restoreWorkStorageFiles(rootUri: String, segments: List<String>, backupDir: File) {
    val files = backupDir.listFiles { file -> file.isFile && file.name != WORK_RESET_COMPLETE && !file.name.endsWith(".part") }
      ?: return
    if (files.isEmpty()) return
    val directory = storage.ensureStorageDirectory(ensureChapterStorageTransferParent(rootUri, segments), segments.last())
    for (file in files) {
      if (storage.findStorageChildWithoutRecovery(directory, file.name) != null) continue
      val created = storage.requireExactCreatedStorageName(
        storage.createStorageFile(directory, storage.mimeTypeForPath(file.name, "application/octet-stream"), file.name)
          ?: throw IllegalStateException("Cannot restore work file: ${file.name}"),
        file.name,
        "file",
        "Cannot restore work file: ${file.name}",
      )
      contentResolver.openOutputStream(created.uri, "wt")?.use { output -> file.inputStream().use { it.copyTo(output) } }
        ?: throw IllegalStateException("Cannot write restored work file: ${file.name}")
    }
  }

  fun removeChapterStorageDirectory(rootUri: String, relativeDir: String) {
    val normalized = validateAndroidChapterStorageRemovalRelativeDir(relativeDir)
      .joinToString("/")
    storage.storageDocumentAt(rootUri, normalized)?.let { directory ->
      require(directory.isDirectory) {
        "Android chapter storage cleanup path is not a folder: $normalized"
      }
      deleteChapterStorageDocument(
        directory,
        "Cannot remove Android chapter storage directory: $normalized",
      )
    }
  }

}
