package io.github.tinywind.norea

import android.content.Context
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.zip.ZipInputStream

private const val TAG = "NoreaStorage"

internal class AndroidStorageBridge(
  private val context: Context,
  private val mainWebView: () -> WebView?,
  private val rootPicker: AndroidStorageRootPicker,
  private val storage: AndroidStorageDocuments,
  private val readerMediaCache: AndroidReaderMediaCache,
) {
  private val contentFiles = AndroidContentUriFiles(context, storage)
  private val contentResolver = context.contentResolver
  private val zipFiles = AndroidStorageZipFiles(contentResolver, storage)
  private val mediaStore = AndroidChapterMediaStore(contentResolver, storage)
  private val chapterTransfer = AndroidChapterStorageTransfer(contentResolver, storage)
  private val coverInspector = AndroidNovelCoverInspector(storage)
  private val chapterInspector = AndroidChapterArtifactInspector(storage, mediaStore)
  private val storageExecutor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "NoreaStorageBridge").apply { isDaemon = true }
  }

  fun destroy() = storageExecutor.shutdownNow()

  private fun submitStorageOperation(
    requestId: String,
    operation: () -> JSONObject,
  ) {
    runCatching {
      storageExecutor.execute {
        resolveStorageOperation(requestId, storageResponse(operation))
      }
    }.onFailure { error ->
      resolveStorageOperation(
        requestId,
        storageResponse { throw error },
      )
    }
  }

  @JavascriptInterface
  fun pickMediaStorageRoot(requestId: String) = rootPicker.pick(requestId)

  @JavascriptInterface
  fun ensureNoMedia(rootUri: String): String = storageResponse {
    val created = storage.ensureContentsNoMedia(rootUri)
    JSONObject()
      .put("ok", true)
      .put("created", created)
  }

  @JavascriptInterface
  fun ensureNoMediaAsync(requestId: String, rootUri: String) {
    submitStorageOperation(requestId) {
      val created = storage.ensureContentsNoMedia(rootUri)
      JSONObject()
        .put("ok", true)
        .put("created", created)
    }
  }

  @JavascriptInterface
  fun writeBytes(
    requestId: String,
    rootUri: String,
    relativePath: String,
    base64: String,
    mimeType: String,
  ) {
    submitStorageOperation(requestId) {
      val bytes = Base64.decode(base64, Base64.DEFAULT)
      val file = storage.ensureStorageFile(
        rootUri,
        relativePath,
        storage.mimeTypeForPath(relativePath, mimeType),
      )
      contentResolver.openOutputStream(file.uri, "wt")?.use { output ->
        output.write(bytes)
      } ?: throw IllegalStateException("Cannot open storage file for writing.")
      JSONObject()
        .put("ok", true)
        .put("bytes", bytes.size)
    }
  }

  @JavascriptInterface
  fun writeContentUriBytes(uri: String, base64: String, mimeType: String): String =
    storageResponse {
    contentFiles.writeContentUriBytes(uri, base64, mimeType)
  }

  @JavascriptInterface
  fun writeContentUriFile(uri: String, inputPath: String, mimeType: String): String =
    storageResponse {
    contentFiles.writeContentUriFile(uri, inputPath, mimeType)
  }

  @JavascriptInterface
  fun writeContentUriFileCapped(
    uri: String,
    inputPath: String,
    mimeType: String,
    maxBytes: String,
  ): String = storageResponse {
    contentFiles.writeContentUriFileCapped(uri, inputPath, mimeType, maxBytes)
  }

  @JavascriptInterface
  fun describeContentUri(uri: String): String = storageResponse {
    contentFiles.describeContentUri(uri)
  }

  @JavascriptInterface
  fun readContentUriFile(uri: String, maxBytes: String): String = storageResponse {
    contentFiles.readContentUriFile(uri, maxBytes)
  }

  @JavascriptInterface
  fun deleteTempFile(path: String): String = storageResponse {
    contentFiles.deleteTempFile(path)
  }

  @JavascriptInterface
  fun readContentUriBase64(uri: String): String = storageResponse {
    contentFiles.readContentUriBase64(uri)
  }

  @JavascriptInterface
  fun writeText(
    requestId: String,
    rootUri: String,
    relativePath: String,
    text: String,
  ) {
    submitStorageOperation(requestId) {
      val bytes = text.toByteArray(Charsets.UTF_8)
      val segments = storage.safeStorageSegments(relativePath)
      if (segments.last() == CHAPTER_MEDIA_MANIFEST_FILE) {
        var directory = storage.storageRoot(rootUri)
        for (segment in segments.dropLast(1)) {
          directory = storage.ensureStorageDirectory(directory, segment)
        }
        mediaStore.writeChapterMediaManifestAtomically(
          rootUri,
          directory,
          segments.dropLast(1).joinToString("/"),
          bytes,
        )
      } else {
        val file = storage.ensureStorageFile(
          rootUri,
          relativePath,
          textMimeTypeForPath(relativePath),
        )
        contentResolver.openOutputStream(file.uri, "wt")?.use { output ->
          output.write(bytes)
        } ?: throw IllegalStateException("Cannot open storage file for writing.")
      }
      JSONObject()
        .put("ok", true)
        .put("bytes", bytes.size)
    }
  }

  @JavascriptInterface
  fun archiveDirectory(
    requestId: String,
    rootUri: String,
    sourceRelativePath: String,
    archiveRelativePath: String,
  ) {
    submitStorageOperation(requestId) {
      val sourceSegments = storage.safeStorageSegments(sourceRelativePath)
      val archiveSegments = storage.safeStorageSegments(archiveRelativePath)
      require(
        sourceSegments.lastOrNull() == "media" &&
          archiveSegments.lastOrNull() == "media.zip" &&
          sourceSegments.dropLast(1) == archiveSegments.dropLast(1),
      ) {
        "Android chapter media archive paths do not share a chapter directory."
      }
      val chapterRelativeDir = sourceSegments.dropLast(1).joinToString("/")
      val chapterDirectory = storage.storageDocumentAt(rootUri, chapterRelativeDir)
        ?: throw IllegalStateException("Android chapter media directory is unavailable.")
      require(chapterDirectory.isDirectory && chapterDirectory.canRead()) {
        "Android chapter media path is not a readable folder."
      }
      val mediaBytes = mediaStore.finalizeChapterMediaArtifacts(
        rootUri,
        chapterDirectory,
        chapterRelativeDir,
        allowLegacyWithoutManifest = false,
      ) ?: throw IllegalStateException(
        "Android chapter media files do not match the manifest.",
      )
      JSONObject()
        .put("ok", true)
        .put("bytes", mediaBytes)
    }
  }

  @JavascriptInterface
  fun readText(requestId: String, rootUri: String, relativePath: String) {
    submitStorageOperation(requestId) {
      Log.d(TAG, "Android storage readText path=$relativePath root=$rootUri")
      val text = storage.openStorageInputStream(rootUri, relativePath)?.use { input ->
        input.readBytes().toString(Charsets.UTF_8)
      } ?: throw IllegalStateException(storage.storageReadFailureMessage(rootUri, relativePath))
      JSONObject()
        .put("ok", true)
        .put("text", text)
    }
  }

  @JavascriptInterface
  fun inspectNovelCover(
    requestId: String,
    rootUri: String,
    preferredNovelDir: String,
    sourceDir: String,
    novelIdentitySuffix: String,
    sourceId: String,
    novelPath: String,
    expectedSourceUrl: String,
  ) {
    storageExecutor.execute {
      resolveNovelCoverInspection(
        requestId,
        inspectNovelCoverResponse(
          rootUri,
          preferredNovelDir,
          sourceDir,
          novelIdentitySuffix,
          sourceId,
          novelPath,
          expectedSourceUrl,
        ),
      )
    }
  }

  private fun inspectNovelCoverResponse(
    rootUri: String,
    preferredNovelDir: String,
    sourceDir: String,
    novelIdentitySuffix: String,
    sourceId: String,
    novelPath: String,
    expectedSourceUrl: String,
  ): String = storageResponse {
    coverInspector.inspectNovelCover(
      rootUri,
      preferredNovelDir,
      sourceDir,
      novelIdentitySuffix,
      sourceId,
      novelPath,
      expectedSourceUrl,
    )
  }

  @JavascriptInterface
  fun inspectChapterArtifacts(
    requestId: String,
    rootUri: String,
    preferredChapterDir: String,
    sourceDir: String,
    novelIdentitySuffix: String,
    chapterIdentityPrefix: String,
    preferredContentFileName: String,
  ) {
    storageExecutor.execute {
      resolveChapterArtifactInspection(
        requestId,
        inspectChapterArtifactsResponse(
          rootUri,
          preferredChapterDir,
          sourceDir,
          novelIdentitySuffix,
          chapterIdentityPrefix,
          preferredContentFileName,
        ),
      )
    }
  }

  private fun inspectChapterArtifactsResponse(
    rootUri: String,
    preferredChapterDir: String,
    sourceDir: String,
    novelIdentitySuffix: String,
    chapterIdentityPrefix: String,
    preferredContentFileName: String,
  ): String = storageResponse {
    chapterInspector.inspectChapterArtifacts(
      rootUri,
      preferredChapterDir,
      sourceDir,
      novelIdentitySuffix,
      chapterIdentityPrefix,
      preferredContentFileName,
    )
  }

  @JavascriptInterface
  fun prepareChapterStorageTransfer(
    requestId: String,
    rootUri: String,
    entriesJson: String,
  ) {
    storageExecutor.execute {
      val response = storageResponse {
        JSONObject()
          .put("ok", true)
          .put(
            "preparation",
            chapterTransfer.prepareChapterStorageTransfer(rootUri, entriesJson),
          )
      }
      resolveChapterStorageTransfer(requestId, response)
    }
  }

  @JavascriptInterface
  fun finalizeChapterStorageTransfer(
    requestId: String,
    rootUri: String,
    preparationJson: String,
  ) {
    storageExecutor.execute {
      val response = storageResponse {
        chapterTransfer.finalizeChapterStorageTransfer(rootUri, preparationJson)
        JSONObject().put("ok", true)
      }
      resolveChapterStorageTransfer(requestId, response)
    }
  }

  @JavascriptInterface
  fun rollbackChapterStorageTransfer(
    requestId: String,
    rootUri: String,
    preparationJson: String,
  ) {
    storageExecutor.execute {
      val response = storageResponse {
        chapterTransfer.rollbackChapterStorageTransfer(rootUri, preparationJson)
        JSONObject().put("ok", true)
      }
      resolveChapterStorageTransfer(requestId, response)
    }
  }

  @JavascriptInterface
  fun removeChapterStorageDirectory(
    requestId: String,
    rootUri: String,
    relativeDir: String,
  ) {
    storageExecutor.execute {
      val response = storageResponse {
        chapterTransfer.removeChapterStorageDirectory(rootUri, relativeDir)
        JSONObject().put("ok", true)
      }
      resolveChapterStorageTransfer(requestId, response)
    }
  }

  @JavascriptInterface
  fun listChapterStorageDirs(
    rootUri: String,
    preferredChapterDir: String,
    sourceDir: String,
    novelIdentitySuffix: String,
    chapterIdentityPrefix: String,
  ): String = storageResponse {
    val root = storage.storageRoot(rootUri)
    require(root.canRead()) { "Android storage folder is not readable." }
    val chapterDirs = linkedSetOf<String>()

    storage.storageDocumentAt(rootUri, preferredChapterDir)?.let { preferred ->
      require(preferred.isDirectory) {
        "Android storage chapter path is not a folder: $preferredChapterDir"
      }
      require(preferred.canRead()) {
        "Android storage chapter path is not readable: $preferredChapterDir"
      }
      chapterDirs.add(preferredChapterDir)
    }

    val source = storage.storageDocumentAt(rootUri, sourceDir)
    if (source != null) {
      require(source.isDirectory) { "Android storage source path is not a folder: $sourceDir" }
      require(source.canRead()) { "Android storage source path is not readable: $sourceDir" }
      for (novel in source.listFiles()) {
        val novelName = novel.name ?: continue
        if (!novelName.endsWith(novelIdentitySuffix)) continue
        require(novel.isDirectory) { "Android storage novel path is not a folder: $novelName" }
        require(novel.canRead()) { "Android storage novel path is not readable: $novelName" }
        for (chapter in novel.listFiles()) {
          val chapterName = chapter.name ?: continue
          if (!chapterName.startsWith(chapterIdentityPrefix)) continue
          require(chapter.isDirectory) {
            "Android storage chapter path is not a folder: $chapterName"
          }
          require(chapter.canRead()) {
            "Android storage chapter path is not readable: $chapterName"
          }
          chapterDirs.add("$sourceDir/$novelName/$chapterName")
        }
      }
    }

    JSONObject()
      .put("ok", true)
      .put("chapterDirs", JSONArray(chapterDirs.toList()))
  }

  @JavascriptInterface
  fun readBase64(rootUri: String, relativePath: String): String = storageResponse {
    Log.d(TAG, "Android storage readBase64 path=$relativePath root=$rootUri")
    val bytes = storage.openStorageInputStream(rootUri, relativePath)?.use { input ->
      input.readBytes()
    } ?: throw IllegalStateException(storage.storageReadFailureMessage(rootUri, relativePath))
    JSONObject()
      .put("ok", true)
      .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
      .put("mimeType", storage.mimeTypeForPath(relativePath, ""))
  }

  @JavascriptInterface
  fun readZipEntryBase64(
    rootUri: String,
    archiveRelativePath: String,
    entryName: String,
  ): String = storageResponse {
    zipFiles.readZipEntryBase64(rootUri, archiveRelativePath, entryName)
  }

  @JavascriptInterface
  fun readZipEntriesBase64(
    rootUri: String,
    archiveRelativePath: String,
    entryNamesJson: String,
  ): String = storageResponse {
    zipFiles.readZipEntriesBase64(rootUri, archiveRelativePath, entryNamesJson)
  }

  @JavascriptInterface
  fun zipEntrySizes(
    requestId: String,
    rootUri: String,
    archiveRelativePath: String,
    entryNamesJson: String,
  ) {
    submitStorageOperation(requestId) {
      val requested = JSONArray(entryNamesJson)
      val requestedNames = linkedSetOf<String>()
      for (index in 0 until requested.length()) {
        val entryName = storage.safeZipEntryName(requested.optString(index))
        if (entryName != null) requestedNames.add(entryName)
      }
      val sizes = JSONObject()
      storage.openStorageInputStream(rootUri, archiveRelativePath)?.use { input ->
        readAndroidChapterMediaArchiveEntrySizes(input, requestedNames)
          .forEach { (entryName, bytes) -> sizes.put(entryName, bytes) }
      }
      JSONObject()
        .put("ok", true)
        .put("sizes", sizes)
    }
  }

  @JavascriptInterface
  fun zipEntryExists(
    requestId: String,
    rootUri: String,
    archiveRelativePath: String,
    entryName: String,
  ) {
    submitStorageOperation(requestId) {
      val safeEntryName = storage.safeZipEntryName(entryName)
        ?: throw IllegalArgumentException("Android storage zip entry is invalid: $entryName")
      val exists = storage.openStorageInputStream(rootUri, archiveRelativePath)?.use { input ->
        var found = false
        ZipInputStream(input.buffered()).use { zip ->
          var entry = zip.nextEntry
          var entryCount = 0
          while (entry != null) {
            entryCount = storage.nextZipEntryCount(entryCount, "Media archive")
            val currentName = storage.safeZipEntryName(entry.name)
            if (!entry.isDirectory && currentName == safeEntryName) {
              found = true
              break
            }
            zip.closeEntry()
            entry = zip.nextEntry
          }
        }
        found
      } ?: false
      JSONObject()
        .put("ok", true)
        .put("exists", exists)
    }
  }

  @JavascriptInterface
  fun extractZip(
    rootUri: String,
    archiveRelativePath: String,
    targetRelativePath: String,
  ): String = storageResponse {
    zipFiles.extractZip(rootUri, archiveRelativePath, targetRelativePath)
  }

  @JavascriptInterface
  fun pathSize(requestId: String, rootUri: String, relativePath: String) {
    submitStorageOperation(requestId) {
      val document = storage.storageDocumentAt(rootUri, relativePath)
      JSONObject()
        .put("ok", true)
        .put(
          "bytes",
          document?.let { storage.storageDocumentSize(rootUri, relativePath, it) }
            ?: storage.externalStorageFile(rootUri, relativePath)
              ?.takeIf { it.isFile }
              ?.length()
              ?.coerceAtLeast(0L)
            ?: 0L,
        )
    }
  }

  @JavascriptInterface
  fun prepareReaderMediaCache(
    rootUri: String,
    mediaRelativePath: String,
    archiveRelativePath: String,
    cacheToken: String,
  ): String =
    storageResponse {
    readerMediaCache.prepareReaderMediaCache(rootUri, mediaRelativePath, archiveRelativePath, cacheToken)
  }

  @JavascriptInterface
  fun deletePath(requestId: String, rootUri: String, relativePath: String) {
    submitStorageOperation(requestId) {
      storage.storageDocumentAt(rootUri, relativePath)?.let { document ->
        if (!document.delete()) {
          throw IllegalStateException("Cannot delete Android storage path: $relativePath")
        }
      }
      JSONObject().put("ok", true)
    }
  }

  @JavascriptInterface
  fun deletePaths(requestId: String, rootUri: String, relativePathsJson: String) {
    submitStorageOperation(requestId) {
      val relativePaths = JSONArray(relativePathsJson)
      for (index in 0 until relativePaths.length()) {
        val relativePath = relativePaths.getString(index)
        storage.storageDocumentAt(rootUri, relativePath)?.let { document ->
          if (!document.delete()) {
            throw IllegalStateException("Cannot delete Android storage path: $relativePath")
          }
        }
      }
      JSONObject().put("ok", true)
    }
  }

  @JavascriptInterface
  fun beginRestore(rootUri: String, token: String): String = storageResponse {
    val root = storage.storageRoot(rootUri)
    val backupName = restoreBackupDirectoryName(token)
    root.findFile(backupName)?.let { staleBackup ->
      if (!staleBackup.delete()) {
        throw IllegalStateException("Cannot remove stale Android restore backup.")
      }
    }
    root.findFile("contents")?.let { contents ->
      if (!contents.renameTo(backupName)) {
        throw IllegalStateException("Cannot backup Android media contents.")
      }
    }
    storage.ensureContentsNoMedia(rootUri)
    JSONObject().put("ok", true)
  }

  @JavascriptInterface
  fun commitRestore(rootUri: String, token: String): String = storageResponse {
    val backupName = restoreBackupDirectoryName(token)
    storage.storageRoot(rootUri).findFile(backupName)?.let { backup ->
      if (!backup.delete()) {
        throw IllegalStateException("Cannot remove Android restore backup.")
      }
    }
    JSONObject().put("ok", true)
  }

  @JavascriptInterface
  fun rollbackRestore(rootUri: String, token: String): String = storageResponse {
    val root = storage.storageRoot(rootUri)
    val backupName = restoreBackupDirectoryName(token)
    root.findFile("contents")?.let { contents ->
      if (!contents.delete()) {
        throw IllegalStateException("Cannot remove failed Android restore contents.")
      }
    }
    root.findFile(backupName)?.let { backup ->
      if (!backup.renameTo("contents")) {
        throw IllegalStateException("Cannot rollback Android restore backup.")
      }
    }
    JSONObject().put("ok", true)
  }

  @JavascriptInterface
  fun renamePath(
    requestId: String,
    rootUri: String,
    relativePath: String,
    newName: String,
  ) {
    submitStorageOperation(requestId) {
      val safeNewName = storage.safeStorageSegments(newName).singleOrNull()
        ?: throw IllegalArgumentException("Android storage target name is invalid: $newName")
      val document = storage.storageDocumentAt(rootUri, relativePath)
        ?: throw IllegalArgumentException("Android storage path not found: $relativePath")
      val parentPath = storage.safeStorageSegments(relativePath).dropLast(1).joinToString("/")
      val parent = if (parentPath.isEmpty()) {
        storage.storageRoot(rootUri)
      } else {
        storage.storageDocumentAt(rootUri, parentPath)
          ?: throw IllegalStateException("Android storage parent path not found: $parentPath")
      }
      if (document.name == safeNewName) {
        return@submitStorageOperation JSONObject().put("ok", true)
      }
      val backupName = "$safeNewName.bak"
      val existing = storage.findStorageChild(parent, safeNewName)
      var backup = storage.findStorageChild(parent, backupName)
      if (existing != null) {
        if (backup != null && !backup.delete()) {
          throw IllegalStateException("Cannot remove Android storage backup: $backupName")
        }
        if (!existing.renameTo(backupName)) {
          throw IllegalStateException("Cannot backup Android storage path: $safeNewName")
        }
        backup = existing
      }
      if (!document.renameTo(safeNewName)) {
        val rollbackBackup = backup
        if (rollbackBackup != null) {
          if (!rollbackBackup.renameTo(safeNewName)) {
            throw IllegalStateException(
              "Cannot restore Android storage path after rename failure: $safeNewName",
            )
          }
        }
        throw IllegalStateException("Cannot rename Android storage path: $relativePath")
      }
      storage.findStorageChild(parent, backupName)?.let { publishedBackup ->
        if (!publishedBackup.delete()) {
          throw IllegalStateException("Cannot remove Android storage backup: $backupName")
        }
      }
      JSONObject().put("ok", true)
    }
  }

  @JavascriptInterface
  fun deleteChildrenExcept(rootUri: String, relativePath: String, keepName: String): String =
    storageResponse {
      storage.storageDocumentAt(rootUri, relativePath)?.listFiles()?.forEach { child ->
        if (child.name != keepName) {
          child.delete()
        }
      }
      JSONObject().put("ok", true)
    }

  @JavascriptInterface
  fun deleteRootChildren(rootUri: String): String = storageResponse {
    storage.storageRoot(rootUri).listFiles().forEach { child ->
      child.delete()
    }
    JSONObject().put("ok", true)
  }

  private fun resolveStorageOperation(requestId: String, response: String) {
    val script =
      "window.__noreaResolveAndroidStorageOperation && " +
        "window.__noreaResolveAndroidStorageOperation(" +
        "${JSONObject.quote(requestId)}, ${JSONObject.quote(response)});"
    mainWebView()?.post {
      mainWebView()?.evaluateJavascript(script, null)
    }
  }

  private fun resolveChapterArtifactInspection(requestId: String, response: String) {
    val script =
      "window.__noreaResolveAndroidChapterArtifacts && window.__noreaResolveAndroidChapterArtifacts(" +
        "${JSONObject.quote(requestId)}, ${JSONObject.quote(response)});"
    mainWebView()?.post {
      mainWebView()?.evaluateJavascript(script, null)
    }
  }

  private fun resolveNovelCoverInspection(requestId: String, response: String) {
    val script =
      "window.__noreaResolveAndroidNovelCover && window.__noreaResolveAndroidNovelCover(" +
        "${JSONObject.quote(requestId)}, ${JSONObject.quote(response)});"
    mainWebView()?.post {
      mainWebView()?.evaluateJavascript(script, null)
    }
  }

  private fun resolveChapterStorageTransfer(requestId: String, response: String) {
    val script =
      "window.__noreaResolveAndroidChapterStorageTransfer && " +
        "window.__noreaResolveAndroidChapterStorageTransfer(" +
        "${JSONObject.quote(requestId)}, ${JSONObject.quote(response)});"
    mainWebView()?.post {
      mainWebView()?.evaluateJavascript(script, null)
    }
  }

  private fun storageResponse(block: () -> JSONObject): String =
    runCatching(block).fold(
      onSuccess = { it.toString() },
      onFailure = { error ->
        JSONObject()
          .put("ok", false)
          .put("error", error.message ?: error.toString())
          .toString()
      },
    )

  private fun restoreBackupDirectoryName(token: String): String {
    val safeToken = storage.safeZipEntryName(token)
      ?: throw IllegalArgumentException("Android restore token is invalid.")
    return "contents.restore-$safeToken"
  }

  private fun textMimeTypeForPath(relativePath: String): String =
    storage.mimeTypeForPath(relativePath, "")

}
