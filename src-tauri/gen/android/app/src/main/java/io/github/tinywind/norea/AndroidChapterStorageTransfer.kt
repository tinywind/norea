package io.github.tinywind.norea

import android.content.ContentResolver
import androidx.documentfile.provider.DocumentFile
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
  ): ChapterStorageTransferArtifacts? {
    if (!directory.isDirectory) return null
    require(directory.canRead()) {
      "Android chapter storage path is not readable: $relativeDir"
    }
    val content = listOf("content.html", "content.pdf")
      .firstNotNullOfOrNull { name ->
        directory.findFile(name)?.also { candidate ->
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
    val mediaDirectoryBytes = directory.findFile("media")?.let { media ->
      require(media.isDirectory) {
        "Android chapter storage media path is not a folder: $relativeDir/media"
      }
      storage.storageDocumentSize(media)
    } ?: 0L
    val mediaArchiveBytes = directory.findFile("media.zip")?.let { archive ->
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
    require(targetParent.findFile(targetName) == null) {
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
    require(parent.findFile(newName) == null) {
      "Android chapter storage transfer target already exists: $newName"
    }
    if (!document.renameTo(newName)) {
      throw IllegalStateException(context)
    }
    return parent.findFile(newName)
      ?: throw IllegalStateException("Android chapter storage renamed path is inaccessible: $newName")
  }

  private fun prepareChapterStorageTransferEntry(
    rootUri: String,
    entry: ChapterStorageTransferEntry,
    token: String,
  ): JSONObject {
    val targetSegments = validateAndroidChapterStorageRelativeDir(entry.targetRelativeDir)
    val targetName = targetSegments.last()
    storage.storageDocumentAt(rootUri, entry.targetRelativeDir)?.let { target ->
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
    ) ?: return preparedChapterStorageTransferEntryJson(
      entry,
      "sourceNotDownloaded",
      false,
      null,
    )

    val targetParent = ensureChapterStorageTransferParent(rootUri, targetSegments)
    val stageName = androidChapterStorageTransferSiblingName(targetName, token, "stage")
    val backupName = androidChapterStorageTransferSiblingName(targetName, token, "backup")
    require(targetParent.findFile(stageName) == null && targetParent.findFile(backupName) == null) {
      "Android chapter storage transfer workspace already exists."
    }

    var replacedTarget = false
    var publishedTarget = false
    try {
      val stage = copyChapterStorageDirectory(
        source,
        targetParent,
        stageName,
        entry.targetRelativeDir,
      )
      val markerName = androidChapterStorageTransferMarkerName(token)
      require(stage.findFile(markerName) == null) {
        "Android chapter storage transfer marker already exists in copied source."
      }
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

      targetParent.findFile(targetName)?.let { racedTarget ->
        inspectChapterStorageTransferArtifacts(
          racedTarget,
          entry.targetRelativeDir,
        )?.let { targetArtifacts ->
          deleteChapterStorageDocument(
            stage,
            "Cannot remove superseded Android chapter storage transfer stage.",
          )
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
      publishedTarget = true
      val published = targetParent.findFile(targetName)
        ?: throw IllegalStateException("Published Android chapter storage transfer is missing.")
      val publishedArtifacts = inspectChapterStorageTransferArtifacts(
        published,
        entry.targetRelativeDir,
      ) ?: throw IllegalStateException(
        "Published Android chapter storage transfer has no final content.",
      )
      return preparedChapterStorageTransferEntryJson(
        entry,
        "copiedSource",
        replacedTarget,
        publishedArtifacts,
      )
    } catch (error: Throwable) {
      if (publishedTarget) {
        targetParent.findFile(targetName)?.let { target ->
          runCatching {
            deleteChapterStorageDocument(
              target,
              "Cannot remove failed Android chapter storage transfer target.",
            )
          }.exceptionOrNull()?.let(error::addSuppressed)
        }
      }
      if (replacedTarget) {
        targetParent.findFile(backupName)?.let { backup ->
          runCatching {
            if (targetParent.findFile(targetName) == null) {
              renameChapterStorageDocument(
                targetParent,
                backup,
                targetName,
                "Cannot restore failed Android chapter storage transfer target.",
              )
            }
          }.exceptionOrNull()?.let(error::addSuppressed)
        }
      }
      targetParent.findFile(stageName)?.let { stage ->
        runCatching {
          deleteChapterStorageDocument(
            stage,
            "Cannot remove failed Android chapter storage transfer stage.",
          )
        }.exceptionOrNull()?.let(error::addSuppressed)
      }
      throw error
    }
  }

  fun prepareChapterStorageTransfer(rootUri: String, entriesJson: String): JSONObject {
    val entries = parseChapterStorageTransferEntries(JSONArray(entriesJson))
    val token = validateAndroidChapterStorageTransferToken(chapterStorageTransferToken())
    storage.ensureContentsNoMedia(rootUri)
    val prepared = JSONArray()
    try {
      for (entry in entries) {
        prepared.put(prepareChapterStorageTransferEntry(rootUri, entry, token))
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
    for (prepared in preparation.entries) {
      val entry = prepared.entry
      val targetSegments = validateAndroidChapterStorageRelativeDir(entry.targetRelativeDir)
      val targetName = targetSegments.last()
      val parentPath = targetSegments.dropLast(1).joinToString("/")
      val parent = storage.storageDocumentAt(rootUri, parentPath)
      parent?.findFile(
        androidChapterStorageTransferSiblingName(targetName, preparation.token, "stage"),
      )?.let { stage ->
        deleteChapterStorageDocument(
          stage,
          "Cannot remove finalized Android chapter storage transfer stage.",
        )
      }
      if (prepared.outcome == "copiedSource") {
        val target = parent?.findFile(targetName)
          ?: throw IllegalStateException(
            "Cannot finalize Android chapter storage transfer without its target.",
          )
        require(
          inspectChapterStorageTransferArtifacts(target, entry.targetRelativeDir) != null,
        ) {
          "Cannot finalize Android chapter storage transfer without final target content."
        }
        val markerName = androidChapterStorageTransferMarkerName(preparation.token)
        val source = storage.storageDocumentAt(rootUri, entry.sourceRelativeDir)
        if (source != null) {
          require(source.isDirectory) {
            "Android chapter storage transfer source is not a folder."
          }
          val marker = target.findFile(markerName)
          require(marker?.isFile == true) {
            "Cannot finalize an unmarked Android chapter storage transfer target."
          }
          deleteChapterStorageDocument(
            source,
            "Cannot remove finalized Android chapter storage transfer source.",
          )
        }
        target.findFile(markerName)?.let { marker ->
          require(marker.isFile) {
            "Android chapter storage transfer marker is not a file."
          }
          deleteChapterStorageDocument(
            marker,
            "Cannot remove finalized Android chapter storage transfer marker.",
          )
        }
      }
      parent?.findFile(
        androidChapterStorageTransferSiblingName(targetName, preparation.token, "backup"),
      )?.let { backup ->
        deleteChapterStorageDocument(
          backup,
          "Cannot remove finalized Android chapter storage transfer backup.",
        )
      }
    }
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
    for (prepared in preparation.entries.asReversed()) {
      val entry = prepared.entry
      val targetSegments = validateAndroidChapterStorageRelativeDir(entry.targetRelativeDir)
      val targetName = targetSegments.last()
      val parentPath = targetSegments.dropLast(1).joinToString("/")
      val parent = storage.storageDocumentAt(rootUri, parentPath) ?: continue
      val stageName = androidChapterStorageTransferSiblingName(
        targetName,
        preparation.token,
        "stage",
      )
      parent.findFile(stageName)?.let { stage ->
        deleteChapterStorageDocument(
          stage,
          "Cannot remove rolled back Android chapter storage transfer stage.",
        )
      }
      if (prepared.outcome != "copiedSource") continue
      val backupName = androidChapterStorageTransferSiblingName(
        targetName,
        preparation.token,
        "backup",
      )
      val markerName = androidChapterStorageTransferMarkerName(preparation.token)
      if (prepared.replacedTarget) {
        parent.findFile(backupName)?.let { backup ->
          parent.findFile(targetName)?.let { target ->
            val marker = target.findFile(markerName)
            if (marker?.isFile == true) {
              deleteChapterStorageDocument(
                target,
                "Cannot remove rolled back Android chapter storage transfer target.",
              )
            }
          }
          require(parent.findFile(targetName) == null) {
            "Cannot restore an Android chapter storage transfer backup over an unmarked target."
          }
          renameChapterStorageDocument(
            parent,
            backup,
            targetName,
            "Cannot restore rolled back Android chapter storage transfer target.",
          )
        }
      } else {
        parent.findFile(targetName)?.let { target ->
          if (target.findFile(markerName)?.isFile == true) {
            deleteChapterStorageDocument(
              target,
              "Cannot remove rolled back Android chapter storage transfer target.",
            )
          }
        }
      }
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
