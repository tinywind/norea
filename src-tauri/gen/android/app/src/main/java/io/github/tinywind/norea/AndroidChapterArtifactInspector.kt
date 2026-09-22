package io.github.tinywind.norea

import androidx.documentfile.provider.DocumentFile
import org.json.JSONObject

internal class AndroidChapterArtifactInspector(
  private val storage: AndroidStorageDocuments,
  private val mediaStore: AndroidChapterMediaStore,
) {
  fun inspectChapterArtifacts(
    rootUri: String,
    preferredChapterDir: String,
    sourceDir: String,
    novelIdentitySuffix: String,
    chapterIdentityPrefix: String,
    preferredContentFileName: String,
  ): JSONObject = run {
    val root = storage.storageRoot(rootUri)
    require(root.canRead()) { "Android storage folder is not readable." }
    val preferredName = storage.safeStorageSegments(preferredContentFileName).singleOrNull()
      ?: throw IllegalArgumentException("Android storage content file name is invalid.")
    val contentNames = linkedSetOf(preferredName, "content.html", "content.pdf")

    fun inspectDirectory(directory: DocumentFile, relativeDir: String): JSONObject? {
      require(directory.isDirectory) { "Android storage chapter path is not a folder: $relativeDir" }
      require(directory.canRead()) { "Android storage chapter path is not readable: $relativeDir" }
      val content = contentNames.firstNotNullOfOrNull { name ->
        storage.findStorageChild(directory, name)?.also { candidate ->
          require(candidate.isFile) {
            "Android storage content path is not a file: $relativeDir/$name"
          }
        }
      } ?: return null
      require(content.canRead()) { "Android storage content file is not readable: $relativeDir" }
      val contentName = content.name ?: preferredName
      val finalizedMediaBytes = mediaStore.finalizeChapterMediaArtifacts(
        rootUri,
        directory,
        relativeDir,
        allowLegacyWithoutManifest = true,
      )
      val existingArchiveBytes = storage.findStorageChild(directory, CHAPTER_MEDIA_ARCHIVE_FILE)
        ?.takeIf { it.isFile }
        ?.length()
      val archiveBytes = resolvedAndroidFinalChapterMediaBytes(
        finalizedMediaBytes,
        existingArchiveBytes,
      )
      return JSONObject()
        .put("ok", true)
        .put("status", "present")
        .put("contentFile", "$relativeDir/$contentName")
        .put("contentBytes", content.length().coerceAtLeast(0L))
        .put("mediaBytes", archiveBytes)
    }

    storage.storageDocumentAt(rootUri, preferredChapterDir)?.let { preferred ->
      inspectDirectory(preferred, preferredChapterDir)?.let { return@run it }
    }

    val matches = mutableListOf<JSONObject>()
    val source = storage.storageDocumentAt(rootUri, sourceDir)
    if (source != null) {
      require(source.isDirectory) { "Android storage source path is not a folder: $sourceDir" }
      require(source.canRead()) { "Android storage source path is not readable: $sourceDir" }
      for (novel in storage.listStorageChildren(source)) {
        val novelName = novel.name
        if (!novelName.endsWith(novelIdentitySuffix)) continue
        require(novel.isDirectory) { "Android storage novel path is not a folder: $novelName" }
        val novelDirectory = storage.storageChildDocumentFile(novel) ?: continue
        require(novelDirectory.canRead()) {
          "Android storage novel path is not readable: $novelName"
        }
        for (chapter in storage.listStorageChildren(novelDirectory)) {
          val chapterName = chapter.name
          if (!chapterName.startsWith(chapterIdentityPrefix)) continue
          require(chapter.isDirectory) {
            "Android storage chapter path is not a folder: $chapterName"
          }
          val chapterDirectory = storage.storageChildDocumentFile(chapter) ?: continue
          require(chapterDirectory.canRead()) {
            "Android storage chapter path is not readable: $chapterName"
          }
          inspectDirectory(chapterDirectory, "$sourceDir/$novelName/$chapterName")
            ?.let(matches::add)
        }
      }
    }

    when (matches.size) {
      0 -> JSONObject()
        .put("ok", true)
        .put("status", "missing")
        .put("contentBytes", 0)
        .put("mediaBytes", 0)
      1 -> matches.single()
      else -> throw IllegalStateException(
        "Multiple stored chapter folders match source identity $chapterIdentityPrefix",
      )
    }
  }

}
