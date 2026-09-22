package io.github.tinywind.norea

import androidx.documentfile.provider.DocumentFile
import org.json.JSONObject

internal const val NOVEL_COVER_MANIFEST_FILE = "cover.json"

internal data class AndroidNovelCoverInspection(
  val manifest: String,
  val relativePath: String,
  val sourceId: String?,
  val novelPath: String?,
  val sourceUrl: String,
  val updatedAt: Long,
)

internal data class AndroidNovelCoverIdentity(
  val sourceId: String?,
  val novelPath: String?,
)

internal fun parseAndroidNovelCoverIdentity(
  sourceIdValue: Any?,
  novelPathValue: Any?,
): AndroidNovelCoverIdentity? {
  if (sourceIdValue != null && sourceIdValue !is String) return null
  if (novelPathValue != null && novelPathValue !is String) return null
  return AndroidNovelCoverIdentity(
    sourceId = (sourceIdValue as? String)?.takeIf { it.isNotBlank() },
    novelPath = novelPathValue as? String,
  )
}

internal fun nonEmptyAndroidNovelCoverInspection(
  inspection: AndroidNovelCoverInspection,
  bytes: Long,
): AndroidNovelCoverInspection? =
  if (bytes > 0L) {
    inspection
  } else {
    null
  }

internal fun selectAndroidNovelCoverInspection(
  preferred: AndroidNovelCoverInspection?,
  matches: List<AndroidNovelCoverInspection>,
  sourceId: String,
  novelPath: String,
  expectedSourceUrl: String,
): AndroidNovelCoverInspection? {
  fun AndroidNovelCoverInspection.hasIdentity(): Boolean =
    this.sourceId != null || this.novelPath != null

  fun AndroidNovelCoverInspection.matchesIdentity(): Boolean =
    this.sourceId == sourceId && this.novelPath == novelPath

  if (preferred != null && (!preferred.hasIdentity() || preferred.matchesIdentity())) {
    return preferred
  }

  return matches
    .asSequence()
    .filter { candidate ->
      candidate.matchesIdentity() ||
        (!candidate.hasIdentity() &&
          expectedSourceUrl.isNotBlank() &&
          candidate.sourceUrl == expectedSourceUrl)
    }
    .sortedWith(
      compareByDescending<AndroidNovelCoverInspection> { it.updatedAt }
        .thenBy { it.relativePath },
    )
    .firstOrNull()
}

internal class AndroidNovelCoverInspector(private val storage: AndroidStorageDocuments) {
  fun inspectNovelCover(
    rootUri: String,
    preferredNovelDir: String,
    sourceDir: String,
    novelIdentitySuffix: String,
    sourceId: String,
    novelPath: String,
    expectedSourceUrl: String,
  ): JSONObject {
    val root = storage.storageRoot(rootUri)
    require(root.canRead()) { "Android storage folder is not readable." }
    require(sourceId.isNotBlank()) { "Android storage novel source id is required." }

    fun inspectDirectory(
      directory: DocumentFile,
      relativeDir: String,
    ): AndroidNovelCoverInspection? {
      require(directory.isDirectory) {
        "Android storage novel path is not a folder: $relativeDir"
      }
      require(directory.canRead()) {
        "Android storage novel path is not readable: $relativeDir"
      }
      val manifestDocument = directory.findFile(NOVEL_COVER_MANIFEST_FILE)
        ?: return null
      require(manifestDocument.isFile && manifestDocument.canRead()) {
        "Android storage novel cover manifest is not a readable file: $relativeDir"
      }
      val manifestRelativePath = "$relativeDir/$NOVEL_COVER_MANIFEST_FILE"
      val manifest = storage.openStorageInputStream(
        rootUri,
        manifestRelativePath,
        manifestDocument,
      )?.use { input ->
        input.readBytes().toString(Charsets.UTF_8)
      } ?: throw IllegalStateException(
        "Cannot read Android storage novel cover manifest: $manifestRelativePath",
      )
      val manifestJson = runCatching { JSONObject(manifest) }.getOrNull() ?: return null
      val version = manifestJson.opt("version") as? Number ?: return null
      if (version.toDouble() != 1.0) return null
      val fileName = (manifestJson.opt("fileName") as? String)
        ?.trim()
        ?.takeIf { candidate ->
          runCatching { storage.safeStorageSegments(candidate) }.getOrNull() == listOf(candidate)
        } ?: return null
      val storedSourceIdValue = manifestJson.opt("sourceId")
      val storedNovelPathValue = manifestJson.opt("novelPath")
      val identity = parseAndroidNovelCoverIdentity(
        storedSourceIdValue.takeUnless { it == JSONObject.NULL },
        storedNovelPathValue.takeUnless { it == JSONObject.NULL },
      ) ?: return null
      val sourceUrl = manifestJson.opt("sourceUrl") as? String ?: return null
      val updatedAt = (manifestJson.opt("updatedAt") as? Number)?.toLong() ?: 0L
      val cover = directory.findFile(fileName) ?: return null
      if (!cover.isFile) return null
      require(cover.canRead()) {
        "Android storage novel cover is not readable: $relativeDir/$fileName"
      }
      val relativePath = "$relativeDir/$fileName"
      return nonEmptyAndroidNovelCoverInspection(
        inspection = AndroidNovelCoverInspection(
          manifest = manifest,
          relativePath = relativePath,
          sourceId = identity.sourceId,
          novelPath = identity.novelPath,
          sourceUrl = sourceUrl,
          updatedAt = updatedAt,
        ),
        bytes = storage.storageDocumentSize(rootUri, relativePath, cover),
      )
    }

    val preferred = storage.storageDocumentAt(rootUri, preferredNovelDir)?.let { directory ->
      inspectDirectory(directory, preferredNovelDir)
    }
    val selectedPreferred = selectAndroidNovelCoverInspection(
      preferred = preferred,
      matches = emptyList(),
      sourceId = sourceId,
      novelPath = novelPath,
      expectedSourceUrl = expectedSourceUrl,
    )
    val selected = selectedPreferred ?: run {
      val matches = mutableListOf<AndroidNovelCoverInspection>()
      val source = storage.storageDocumentAt(rootUri, sourceDir)
      if (source != null) {
        require(source.isDirectory) {
          "Android storage source path is not a folder: $sourceDir"
        }
        require(source.canRead()) {
          "Android storage source path is not readable: $sourceDir"
        }
        for (novel in source.listFiles()) {
          val novelName = novel.name ?: continue
          if (!novelName.endsWith(novelIdentitySuffix)) continue
          inspectDirectory(novel, "$sourceDir/$novelName")?.let(matches::add)
        }
      }
      selectAndroidNovelCoverInspection(
        preferred = null,
        matches = matches,
        sourceId = sourceId,
        novelPath = novelPath,
        expectedSourceUrl = expectedSourceUrl,
      )
    }

    return if (selected == null) {
      JSONObject()
        .put("ok", true)
        .put("status", "missing")
    } else {
      JSONObject()
        .put("ok", true)
        .put("status", "present")
        .put("manifest", selected.manifest)
        .put("relativePath", selected.relativePath)
    }
  }
}
