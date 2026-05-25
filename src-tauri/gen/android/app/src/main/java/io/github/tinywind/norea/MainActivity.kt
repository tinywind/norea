package io.github.tinywind.norea

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.documentfile.provider.DocumentFile
import androidx.core.graphics.Insets
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

class MainActivity : TauriActivity() {
  private val bridgeSession = BridgeSession()
  private var androidScraperBridge: AndroidScraperBridge? = null
  private var scraperBackPressedCallback: OnBackPressedCallback? = null
  private var mainWebView: WebView? = null
  private var notificationPermissionRequested = false
  private var pendingStorageRootRequestId: String? = null
  @Volatile
  private var safeAreaInsetsJson = insetsJson(Insets.NONE)

  override fun onCreate(savedInstanceState: Bundle?) {
    RustlsPlatformVerifierBridge.init(applicationContext)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    mainWebView = webView
    val bridge = AndroidScraperBridge(webView, bridgeSession)
    androidScraperBridge = bridge
    webView.addJavascriptInterface(BridgeInfoBridge(), "__NoreaAndroidBridge")
    webView.addJavascriptInterface(bridge, "__NoreaAndroidScraper")
    webView.addJavascriptInterface(SafeAreaBridge(), "__NoreaAndroidSafeArea")
    webView.addJavascriptInterface(TaskNotificationBridge(), "__NoreaAndroidTasks")
    webView.addJavascriptInterface(UpdateInstallBridge(), "__NoreaAndroidUpdater")
    webView.addJavascriptInterface(StorageBridge(), "__NoreaAndroidStorage")
    webView.addJavascriptInterface(WindowMetricsBridge(webView), "__NoreaAndroidWindow")
    webView.settings.apply {
      setSupportZoom(false)
      builtInZoomControls = false
      displayZoomControls = false
      loadWithOverviewMode = false
      useWideViewPort = true
      textZoom = 100
    }
    webView.setInitialScale(100)
    installScraperBackHandler()

    ViewCompat.setOnApplyWindowInsetsListener(webView) { _, windowInsets ->
      val types = WindowInsetsCompat.Type.systemBars() or
        WindowInsetsCompat.Type.displayCutout()
      val insets = windowInsets.getInsets(types)
      safeAreaInsetsJson = insetsJson(insets)
      val script =
        "window.__lnrApplyAndroidSafeAreaInsets && window.__lnrApplyAndroidSafeAreaInsets($safeAreaInsetsJson);"
      webView.evaluateJavascript(
        script,
        null,
      )

      windowInsets
    }
    ViewCompat.requestApplyInsets(webView)
  }

  override fun onDestroy() {
    scraperBackPressedCallback?.remove()
    scraperBackPressedCallback = null
    androidScraperBridge?.destroy()
    androidScraperBridge = null
    super.onDestroy()
  }

  private fun installScraperBackHandler() {
    scraperBackPressedCallback?.remove()
    scraperBackPressedCallback = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (androidScraperBridge?.handleBackPressed() == true) return
        if (handleMainWebViewBackPressed()) return
        isEnabled = false
        try {
          onBackPressedDispatcher.onBackPressed()
        } finally {
          isEnabled = true
        }
      }
    }.also { callback ->
      // Register after Tauri creates its WebView so source-browser back wins.
      onBackPressedDispatcher.addCallback(this, callback)
    }
  }

  private fun handleMainWebViewBackPressed(): Boolean {
    val webView = mainWebView ?: return false
    val path = mainAppPath(webView.url) ?: return false
    if (path == "/reader" || path == "/source") {
      webView.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('norea:android-back'));",
        null,
      )
      return true
    }

    if (!webView.canGoBack()) return false
    webView.goBack()
    return true
  }

  private fun mainAppPath(url: String?): String? {
    if (url.isNullOrBlank()) return null
    return runCatching {
      val parsed = Uri.parse(url)
      parsed.path?.takeIf { parsed.host == "tauri.localhost" }
    }.getOrNull()
  }

  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode != REQUEST_MEDIA_STORAGE_ROOT) return

    val requestId = pendingStorageRootRequestId ?: return
    pendingStorageRootRequestId = null
    if (resultCode != Activity.RESULT_OK) {
      resolveStorageRootPick(
        requestId,
        JSONObject()
          .put("ok", false)
          .put("cancelled", true),
      )
      return
    }

    val uri = data?.data
    if (uri == null) {
      resolveStorageRootPick(
        requestId,
        JSONObject()
          .put("ok", false)
          .put("error", "No storage folder was selected."),
      )
      return
    }

    val flags = data.flags and (
      Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
      )
    runCatching {
      contentResolver.takePersistableUriPermission(uri, flags)
      uri.toString()
    }.fold(
      onSuccess = { root ->
        resolveStorageRootPick(
          requestId,
          JSONObject()
            .put("ok", true)
            .put("root", root),
        )
      },
      onFailure = { error ->
        resolveStorageRootPick(
          requestId,
          JSONObject()
            .put("ok", false)
            .put("error", error.message ?: error.toString()),
        )
      },
    )
  }

  private inner class BridgeInfoBridge {
    @JavascriptInterface
    fun session(): String =
      JSONObject()
        .put("version", 2)
        .put("sessionToken", bridgeSession.sessionToken)
        .put("capabilities", JSONArray(BridgeCapabilities.ALL))
        .put("legacyCallsAccepted", true)
        .toString()

    @JavascriptInterface
    fun nonce(): String = bridgeSession.newNonce()
  }

  private inner class SafeAreaBridge {
    @JavascriptInterface
    fun getInsets(): String = safeAreaInsetsJson
  }

  private inner class TaskNotificationBridge {
    @JavascriptInterface
    fun update(payload: String) {
      runOnUiThread {
        try {
          try {
            requestNotificationPermissionIfNeeded()
          } catch (_: Throwable) {
            // Permission prompts are best-effort; task execution must continue.
          }
          val json = JSONObject(payload)
          val progress = json.optJSONObject("progress")
          val current = progress?.takeIf { it.has("current") }?.optInt("current")
          val total = progress?.takeIf { it.has("total") }?.optInt("total")
          TaskForegroundService.update(
            this@MainActivity,
            json.optString("title", "Norea tasks"),
            json.optString("body", ""),
            current,
            total,
          )
        } catch (_: Throwable) {
          // Ignore malformed bridge payloads so task execution is not affected.
        }
      }
    }

    @JavascriptInterface
    fun stop() {
      runOnUiThread {
        try {
          TaskForegroundService.stop(this@MainActivity)
        } catch (_: Throwable) {
          // The service may already be stopped by Android.
        }
      }
    }
  }

  private inner class UpdateInstallBridge {
    @JavascriptInterface
    fun openApk(path: String): String =
      runCatching {
        val request = parseUpdateOpenRequest(path)
        val authority = bridgeSession.validate(
          BridgeCapabilities.UPDATE_OPEN_APK,
          request.authority,
        )
        require(authority.legacy || request.integrity != null) {
          "Update integrity metadata is missing."
        }
        val apk = allowedUpdateApk(request.path)
        request.integrity?.let { integrity ->
          verifyUpdateApkIntegrity(apk, integrity)
        }

        val uri = FileProvider.getUriForFile(
          this@MainActivity,
          "$packageName.fileprovider",
          apk,
        )
        startActivity(apkInstallIntent(uri))
      }.fold(
        onSuccess = { JSONObject().put("ok", true).toString() },
        onFailure = { error ->
          JSONObject()
            .put("ok", false)
            .put("error", error.message ?: error.toString())
            .toString()
        },
      )
  }

  private inner class StorageBridge {
    @JavascriptInterface
    fun pickMediaStorageRoot(requestId: String) {
      runOnUiThread {
        if (pendingStorageRootRequestId != null) {
          resolveStorageRootPick(
            requestId,
            JSONObject()
              .put("ok", false)
              .put("error", "A storage folder picker is already open."),
          )
          return@runOnUiThread
        }

        pendingStorageRootRequestId = requestId
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
          addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
          addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
          putExtra("android.content.extra.SHOW_ADVANCED", true)
        }
        runCatching {
          startActivityForResult(intent, REQUEST_MEDIA_STORAGE_ROOT)
        }.onFailure { error ->
          pendingStorageRootRequestId = null
          resolveStorageRootPick(
            requestId,
            JSONObject()
              .put("ok", false)
              .put("error", error.message ?: error.toString()),
          )
        }
      }
    }

    @JavascriptInterface
    fun writeBytes(
      rootUri: String,
      relativePath: String,
      base64: String,
      mimeType: String,
    ): String = storageResponse {
      val bytes = Base64.decode(base64, Base64.DEFAULT)
      val file = ensureStorageFile(rootUri, relativePath, mimeTypeForPath(relativePath, mimeType))
      contentResolver.openOutputStream(file.uri, "wt")?.use { output ->
        output.write(bytes)
      } ?: throw IllegalStateException("Cannot open storage file for writing.")
      JSONObject()
        .put("ok", true)
        .put("bytes", bytes.size)
    }

    @JavascriptInterface
    fun writeContentUriBytes(uri: String, base64: String, mimeType: String): String =
      storageResponse {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        contentResolver.openOutputStream(Uri.parse(uri), "wt")?.use { output ->
          output.write(bytes)
        } ?: throw IllegalStateException("Cannot open selected file for writing.")
        JSONObject()
          .put("ok", true)
          .put("bytes", bytes.size)
          .put("mimeType", mimeType)
      }

    @JavascriptInterface
    fun writeContentUriFile(uri: String, inputPath: String, mimeType: String): String =
      storageResponse {
        val inputFile = File(inputPath)
        require(inputFile.isFile) { "Selected backup temp file is unavailable." }
        val bytes = inputFile.inputStream().use { input ->
          contentResolver.openOutputStream(Uri.parse(uri), "wt")?.use { output ->
            input.copyTo(output)
          } ?: throw IllegalStateException("Cannot open selected file for writing.")
        }
        JSONObject()
          .put("ok", true)
          .put("bytes", bytes)
          .put("mimeType", mimeType)
      }

    @JavascriptInterface
    fun writeContentUriFileCapped(
      uri: String,
      inputPath: String,
      mimeType: String,
      maxBytes: String,
    ): String = storageResponse {
      val limit = parseStorageByteLimit(maxBytes)
      val inputFile = containedAppCacheFile(inputPath)
      require(inputFile.isFile) { "Selected backup temp file is unavailable." }
      val fileLength = inputFile.length().coerceAtLeast(0L)
      require(fileLength <= limit) {
        "Selected backup temp file exceeds the $limit byte limit."
      }
      val bytes = inputFile.inputStream().use { input ->
        contentResolver.openOutputStream(Uri.parse(uri), "wt")?.use { output ->
          copyToWithLimit(input, output, limit)
        } ?: throw IllegalStateException("Cannot open selected file for writing.")
      }
      JSONObject()
        .put("ok", true)
        .put("bytes", bytes)
        .put("mimeType", mimeType)
    }

    @JavascriptInterface
    fun readContentUriFile(uri: String, maxBytes: String): String = storageResponse {
      val limit = parseStorageByteLimit(maxBytes)
      val contentUri = Uri.parse(uri)
      val tempFile = createStorageTempFile()
      var bytes = 0L
      try {
        contentResolver.openInputStream(contentUri)?.use { input ->
          tempFile.outputStream().use { output ->
            bytes = copyToWithLimit(input, output, limit)
          }
        } ?: throw IllegalStateException("Cannot open selected file for reading.")
      } catch (error: Throwable) {
        tempFile.delete()
        throw error
      }
      JSONObject()
        .put("ok", true)
        .put("bytes", bytes)
        .put("path", tempFile.absolutePath)
        .put(
          "mimeType",
          contentResolver.getType(contentUri)
            ?: mimeTypeForPath(uri, "application/octet-stream"),
        )
    }

    @JavascriptInterface
    fun deleteTempFile(path: String): String = storageResponse {
      val tempFile = containedStorageTempFile(path)
      val existed = tempFile.exists()
      if (existed && !tempFile.delete()) {
        throw IllegalStateException("Cannot remove Android storage temp file.")
      }
      JSONObject()
        .put("ok", true)
        .put("deleted", existed)
    }

    @JavascriptInterface
    fun readContentUriBase64(uri: String): String = storageResponse {
      val bytes = contentResolver.openInputStream(Uri.parse(uri))?.use { input ->
        input.readBytes()
      } ?: throw IllegalStateException("Cannot open selected file for reading.")
      JSONObject()
        .put("ok", true)
        .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        .put("mimeType", mimeTypeForPath(uri, "application/octet-stream"))
    }

    @JavascriptInterface
    fun writeText(rootUri: String, relativePath: String, text: String): String =
      storageResponse {
        val bytes = text.toByteArray(Charsets.UTF_8)
        val file = ensureStorageFile(
          rootUri,
          relativePath,
          textMimeTypeForPath(relativePath),
        )
        contentResolver.openOutputStream(file.uri, "wt")?.use { output ->
          output.write(bytes)
        } ?: throw IllegalStateException("Cannot open storage file for writing.")
        JSONObject()
          .put("ok", true)
          .put("bytes", bytes.size)
      }

    @JavascriptInterface
    fun archiveDirectory(
      rootUri: String,
      sourceRelativePath: String,
      archiveRelativePath: String,
    ): String = storageResponse {
      val sourceDir = storageDocumentAt(rootUri, sourceRelativePath)
      val existingArchive = storageDocumentAt(rootUri, archiveRelativePath)
        ?.takeIf { it.isFile }
      if (sourceDir == null || !sourceDir.isDirectory) {
        return@storageResponse JSONObject()
          .put("ok", true)
          .put("bytes", existingArchive?.length()?.coerceAtLeast(0L) ?: 0L)
      }

      val archiveSegments = safeStorageSegments(archiveRelativePath)
      val archiveName = archiveSegments.last()
      val tempArchiveRelativePath = (archiveSegments.dropLast(1) + "$archiveName.tmp")
        .joinToString("/")
      val tempArchive = ensureStorageFile(
        rootUri,
        tempArchiveRelativePath,
        "application/zip",
      )
      val newFiles = sourceDir.listFiles()
        .filter {
          val entryName = safeZipEntryName(it.name)
          it.isFile && entryName != null && !entryName.endsWith(".part")
        }
        .sortedBy { it.name ?: "" }
      val newEntryNames = newFiles.mapNotNull { safeZipEntryName(it.name) }.toSet()
      val writtenEntryNames = mutableSetOf<String>()
      var writtenZipEntryCount = 0
      var writtenZipBytes = 0L

      contentResolver.openOutputStream(tempArchive.uri, "wt")?.use { output ->
        ZipOutputStream(output.buffered()).use { zip ->
          if (existingArchive != null) {
            contentResolver.openInputStream(existingArchive.uri)?.use { input ->
              ZipInputStream(input.buffered()).use { previousZip ->
                var entry = previousZip.nextEntry
                while (entry != null) {
                  writtenZipEntryCount = nextZipEntryCount(
                    writtenZipEntryCount,
                    "Media archive",
                  )
                  val entryName = safeZipEntryName(entry.name)
                  if (
                    !entry.isDirectory &&
                    entryName != null &&
                    !entryName.endsWith(".part") &&
                    entryName !in newEntryNames &&
                    writtenEntryNames.add(entryName)
                  ) {
                    requireZipEntrySize(entry, "Media archive entry")
                    zip.putNextEntry(ZipEntry(entryName))
                    val copied = copyToWithLimit(
                      previousZip,
                      zip,
                      MAX_ZIP_ENTRY_BYTES,
                    )
                    writtenZipBytes = addZipTotalBytes(
                      writtenZipBytes,
                      copied,
                      "Media archive",
                    )
                    zip.closeEntry()
                  }
                  previousZip.closeEntry()
                  entry = previousZip.nextEntry
                }
              }
            }
          }

          newFiles.forEach { file ->
            val entryName = safeZipEntryName(file.name) ?: return@forEach
            if (!writtenEntryNames.add(entryName)) return@forEach
            requireStorageFileZipEntrySize(file, "Media archive entry")
            writtenZipEntryCount = nextZipEntryCount(
              writtenZipEntryCount,
              "Media archive",
            )
            zip.putNextEntry(ZipEntry(entryName))
            val copied = contentResolver.openInputStream(file.uri)?.use { input ->
              copyToWithLimit(input, zip, MAX_ZIP_ENTRY_BYTES)
            } ?: throw IllegalStateException("Cannot open media file for archiving.")
            writtenZipBytes = addZipTotalBytes(
              writtenZipBytes,
              copied,
              "Media archive",
            )
            zip.closeEntry()
          }
        }
      } ?: throw IllegalStateException("Cannot open media archive for writing.")

      val backupArchiveName = "$archiveName.bak"
      val backupArchiveRelativePath = (archiveSegments.dropLast(1) + backupArchiveName)
        .joinToString("/")
      storageDocumentAt(rootUri, backupArchiveRelativePath)?.let { staleBackup ->
        if (!staleBackup.delete()) {
          throw IllegalStateException(
            "Cannot remove stale media archive backup: $backupArchiveRelativePath",
          )
        }
      }
      if (existingArchive != null && !existingArchive.renameTo(backupArchiveName)) {
        throw IllegalStateException("Cannot backup media archive: $archiveRelativePath")
      }
      if (!tempArchive.renameTo(archiveName)) {
        storageDocumentAt(rootUri, backupArchiveRelativePath)?.renameTo(archiveName)
        throw IllegalStateException("Cannot finalize media archive: $archiveRelativePath")
      }
      storageDocumentAt(rootUri, backupArchiveRelativePath)?.let { backup ->
        if (!backup.delete()) {
          throw IllegalStateException(
            "Cannot remove media archive backup: $backupArchiveRelativePath",
          )
        }
      }
      sourceDir.listFiles().forEach { child ->
        if (!child.delete()) {
          throw IllegalStateException("Cannot remove staged media file: ${child.name}")
        }
      }
      if (!sourceDir.delete()) {
        throw IllegalStateException("Cannot remove media staging directory: $sourceRelativePath")
      }
      val archive = storageDocumentAt(rootUri, archiveRelativePath)
        ?: throw IllegalStateException("Media archive was not created: $archiveRelativePath")
      JSONObject()
        .put("ok", true)
        .put("bytes", archive.length().coerceAtLeast(0L))
    }

    @JavascriptInterface
    fun readText(rootUri: String, relativePath: String): String = storageResponse {
      val file = storageDocumentAt(rootUri, relativePath)
        ?: throw IllegalArgumentException("Android storage path not found: $relativePath")
      val text = contentResolver.openInputStream(file.uri)?.use { input ->
        input.readBytes().toString(Charsets.UTF_8)
      } ?: throw IllegalStateException("Cannot open storage file for reading.")
      JSONObject()
        .put("ok", true)
        .put("text", text)
    }

    @JavascriptInterface
    fun readBase64(rootUri: String, relativePath: String): String = storageResponse {
      val file = storageDocumentAt(rootUri, relativePath)
        ?: throw IllegalArgumentException("Android storage path not found: $relativePath")
      val bytes = contentResolver.openInputStream(file.uri)?.use { input ->
        input.readBytes()
      } ?: throw IllegalStateException("Cannot open storage file for reading.")
      JSONObject()
        .put("ok", true)
        .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        .put("mimeType", mimeTypeForPath(relativePath, ""))
    }

    @JavascriptInterface
    fun readZipEntryBase64(
      rootUri: String,
      archiveRelativePath: String,
      entryName: String,
    ): String = storageResponse {
      val safeEntryName = safeZipEntryName(entryName)
        ?: throw IllegalArgumentException("Android storage zip entry is invalid: $entryName")
      val bytes = readZipEntryBytes(rootUri, archiveRelativePath, safeEntryName)
        ?: throw IllegalArgumentException("Android storage zip entry not found: $entryName")
      JSONObject()
        .put("ok", true)
        .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        .put("mimeType", mimeTypeForPath(safeEntryName, ""))
    }

    @JavascriptInterface
    fun readZipEntriesBase64(
      rootUri: String,
      archiveRelativePath: String,
      entryNamesJson: String,
    ): String = storageResponse {
      val requested = JSONArray(entryNamesJson)
      val requestedNames = linkedSetOf<String>()
      for (index in 0 until requested.length()) {
        val entryName = safeZipEntryName(requested.optString(index))
        if (entryName != null) requestedNames.add(entryName)
      }
      val entries = JSONObject()
      if (requestedNames.isEmpty()) {
        return@storageResponse JSONObject()
          .put("ok", true)
          .put("entries", entries)
      }
      val archive = storageDocumentAt(rootUri, archiveRelativePath)
        ?: return@storageResponse JSONObject()
          .put("ok", true)
          .put("entries", entries)
      require(archive.isFile) {
        "Android storage archive is not a file: $archiveRelativePath"
      }

      contentResolver.openInputStream(archive.uri)?.use { input ->
        ZipInputStream(input.buffered()).use { zip ->
          val remaining = requestedNames.toMutableSet()
          var entry = zip.nextEntry
          var entryCount = 0
          var totalBytes = 0L
          while (entry != null && remaining.isNotEmpty()) {
            entryCount = nextZipEntryCount(entryCount, "Media archive")
            val currentName = safeZipEntryName(entry.name)
            if (
              !entry.isDirectory &&
              currentName != null &&
              remaining.contains(currentName)
            ) {
              requireZipEntrySize(entry, "Media archive entry")
              val bytes = readBytesWithLimit(zip, MAX_ZIP_ENTRY_BYTES)
              totalBytes = addZipTotalBytes(
                totalBytes,
                bytes.size.toLong(),
                "Media archive read",
              )
              entries.put(
                currentName,
                JSONObject()
                  .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                  .put("mimeType", mimeTypeForPath(currentName, "")),
              )
              remaining.remove(currentName)
            }
            zip.closeEntry()
            entry = zip.nextEntry
          }
        }
      }
      JSONObject()
        .put("ok", true)
        .put("entries", entries)
    }

    @JavascriptInterface
    fun zipEntryExists(rootUri: String, archiveRelativePath: String, entryName: String): String =
      storageResponse {
        val safeEntryName = safeZipEntryName(entryName)
          ?: throw IllegalArgumentException("Android storage zip entry is invalid: $entryName")
        val archive = storageDocumentAt(rootUri, archiveRelativePath)
          ?: return@storageResponse JSONObject()
            .put("ok", true)
            .put("exists", false)
        if (!archive.isFile) {
          return@storageResponse JSONObject()
            .put("ok", true)
            .put("exists", false)
        }
        val exists = contentResolver.openInputStream(archive.uri)?.use { input ->
          var found = false
          ZipInputStream(input.buffered()).use { zip ->
            var entry = zip.nextEntry
            var entryCount = 0
            while (entry != null) {
              entryCount = nextZipEntryCount(entryCount, "Media archive")
              val currentName = safeZipEntryName(entry.name)
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

    @JavascriptInterface
    fun extractZip(
      rootUri: String,
      archiveRelativePath: String,
      targetRelativePath: String,
    ): String = storageResponse {
      val archive = storageDocumentAt(rootUri, archiveRelativePath)
        ?: return@storageResponse JSONObject()
          .put("ok", true)
          .put("bytes", 0L)
      require(archive.isFile) { "Android storage archive is not a file: $archiveRelativePath" }
      var bytes = 0L
      contentResolver.openInputStream(archive.uri)?.use { input ->
        ZipInputStream(input.buffered()).use { zip ->
          var entry = zip.nextEntry
          var entryCount = 0
          while (entry != null) {
            entryCount = nextZipEntryCount(entryCount, "Media archive extraction")
            val entryName = safeZipEntryName(entry.name)
            if (!entry.isDirectory && entryName != null) {
              requireZipEntrySize(entry, "Media archive extraction entry")
              val targetPath = "$targetRelativePath/$entryName"
              if (storageDocumentAt(rootUri, targetPath) == null) {
                val file = ensureStorageFile(
                  rootUri,
                  targetPath,
                  mimeTypeForPath(entryName, "application/octet-stream"),
                )
                contentResolver.openOutputStream(file.uri, "wt")?.use { output ->
                  val copied = copyToWithLimit(zip, output, MAX_ZIP_ENTRY_BYTES)
                  bytes = addZipTotalBytes(
                    bytes,
                    copied,
                    "Media archive extraction",
                  )
                } ?: throw IllegalStateException("Cannot open extracted media file.")
              }
            }
            zip.closeEntry()
            entry = zip.nextEntry
          }
        }
      } ?: throw IllegalStateException("Cannot open media archive for extraction.")
      JSONObject()
        .put("ok", true)
        .put("bytes", bytes)
    }

    @JavascriptInterface
    fun pathSize(rootUri: String, relativePath: String): String = storageResponse {
      val document = storageDocumentAt(rootUri, relativePath)
      JSONObject()
        .put("ok", true)
        .put("bytes", document?.let(::storageDocumentSize) ?: 0L)
    }

    @JavascriptInterface
    fun deletePath(rootUri: String, relativePath: String): String = storageResponse {
      storageDocumentAt(rootUri, relativePath)?.delete()
      JSONObject().put("ok", true)
    }

    @JavascriptInterface
    fun beginRestore(rootUri: String, token: String): String = storageResponse {
      val root = storageRoot(rootUri)
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
      val nomedia = ensureStorageFile(
        rootUri,
        "contents/.nomedia",
        "application/octet-stream",
      )
      contentResolver.openOutputStream(nomedia.uri, "wt")?.use {
        // Truncate/create the marker file inside the fresh restore root.
      } ?: throw IllegalStateException("Cannot create Android media marker.")
      JSONObject().put("ok", true)
    }

    @JavascriptInterface
    fun commitRestore(rootUri: String, token: String): String = storageResponse {
      val backupName = restoreBackupDirectoryName(token)
      storageRoot(rootUri).findFile(backupName)?.let { backup ->
        if (!backup.delete()) {
          throw IllegalStateException("Cannot remove Android restore backup.")
        }
      }
      JSONObject().put("ok", true)
    }

    @JavascriptInterface
    fun rollbackRestore(rootUri: String, token: String): String = storageResponse {
      val root = storageRoot(rootUri)
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
    fun renamePath(rootUri: String, relativePath: String, newName: String): String =
      storageResponse {
        val safeNewName = safeZipEntryName(newName)
          ?: throw IllegalArgumentException("Android storage target name is invalid: $newName")
        val document = storageDocumentAt(rootUri, relativePath)
          ?: throw IllegalArgumentException("Android storage path not found: $relativePath")
        val parentPath = safeStorageSegments(relativePath).dropLast(1).joinToString("/")
        if (parentPath.isNotEmpty()) {
          storageDocumentAt(rootUri, "$parentPath/$safeNewName")?.delete()
        }
        if (!document.renameTo(safeNewName)) {
          throw IllegalStateException("Cannot rename Android storage path: $relativePath")
        }
        JSONObject().put("ok", true)
      }

    @JavascriptInterface
    fun deleteChildrenExcept(rootUri: String, relativePath: String, keepName: String): String =
      storageResponse {
        storageDocumentAt(rootUri, relativePath)?.listFiles()?.forEach { child ->
          if (child.name != keepName) {
            child.delete()
          }
        }
        JSONObject().put("ok", true)
      }

    @JavascriptInterface
    fun deleteRootChildren(rootUri: String): String = storageResponse {
      storageRoot(rootUri).listFiles().forEach { child ->
        child.delete()
      }
      JSONObject().put("ok", true)
    }
  }

  private inner class WindowMetricsBridge(private val webView: WebView) {
    @JavascriptInterface
    fun getMetrics(): String = windowMetricsJson(webView)
  }

  private data class UpdateOpenRequest(
    val path: String,
    val authority: BridgeAuthorityFields,
    val integrity: UpdateApkIntegrity?,
  )

  private data class UpdateApkIntegrity(
    val size: Long,
    val sha256: String,
  )

  private fun parseUpdateOpenRequest(raw: String): UpdateOpenRequest {
    val trimmed = raw.trim()
    if (!trimmed.startsWith("{")) {
      return UpdateOpenRequest(trimmed, BridgeAuthorityFields(), null)
    }

    val json = JSONObject(trimmed)
    val requestPath = json.optString("path")
      .ifBlank { json.optString("apkPath") }
      .trim()
    require(requestPath.isNotEmpty()) { "APK path is missing." }
    return UpdateOpenRequest(
      requestPath,
      bridgeAuthorityFields(json),
      updateApkIntegrity(json.optJSONObject("metadata") ?: json.optJSONObject("integrity")),
    )
  }

  private fun bridgeAuthorityFields(payload: JSONObject): BridgeAuthorityFields {
    val wrapper = payload.optJSONObject("_bridge") ?: payload.optJSONObject("bridge")
    fun field(name: String): String? =
      wrapper?.optString(name)?.trim()?.takeIf { it.isNotEmpty() }

    return BridgeAuthorityFields(
      token = field("sessionToken") ?: field("token")
        ?: payload.optString("bridgeToken").trim().takeIf { it.isNotEmpty() },
      capability = field("capability")
        ?: payload.optString("capability").trim().takeIf { it.isNotEmpty() },
      nonce = field("nonce")
        ?: payload.optString("nonce").trim().takeIf { it.isNotEmpty() },
    )
  }

  private fun updateApkIntegrity(json: JSONObject?): UpdateApkIntegrity? {
    if (json == null) return null
    val size = when (val raw = json.opt("size")) {
      is Number -> raw.toLong()
      is String -> raw.trim().toLongOrNull()
      else -> null
    } ?: throw IllegalArgumentException("Update size metadata is invalid.")
    require(size >= 0L && size <= MAX_UPDATE_BYTES) {
      "Update size metadata exceeds the $MAX_UPDATE_BYTES byte limit."
    }
    val sha256 = json.optString("sha256").trim().lowercase()
    require(SHA256_HEX_PATTERN.matches(sha256)) {
      "Update SHA-256 metadata is invalid."
    }
    return UpdateApkIntegrity(size = size, sha256 = sha256)
  }

  private fun allowedUpdateApk(path: String): File {
    val apk = File(path).canonicalFile
    require(apk.isFile) { "APK file does not exist." }
    require(apk.extension.equals("apk", ignoreCase = true)) {
      "Update file is not an APK."
    }
    require(allowedUpdateRoots().any { root -> isContainedBy(apk, root) }) {
      "APK file is outside the Android update folder."
    }
    return apk
  }

  private fun allowedUpdateRoots(): List<File> {
    val roots = mutableListOf<File>()
    fun addUpdateRoots(base: File?) {
      if (base == null) return
      roots.add(File(base, UPDATE_DOWNLOAD_DIR))
      roots.add(File(File(base, "native-stream"), "update"))
    }

    addUpdateRoots(cacheDir)
    addUpdateRoots(externalCacheDir)
    addUpdateRoots(filesDir)
    addUpdateRoots(getExternalFilesDir(null))
    return roots.map { it.canonicalFile }
  }

  private fun verifyUpdateApkIntegrity(apk: File, integrity: UpdateApkIntegrity) {
    val fileSize = apk.length().coerceAtLeast(0L)
    require(fileSize <= MAX_UPDATE_BYTES) {
      "Update file exceeds the $MAX_UPDATE_BYTES byte limit."
    }
    require(fileSize == integrity.size) {
      "Update file size does not match metadata."
    }
    val actualSha256 = sha256Hex(apk)
    require(actualSha256 == integrity.sha256) {
      "Update file SHA-256 does not match metadata."
    }
  }

  private fun sha256Hex(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    var total = 0L
    val buffer = ByteArray(DEFAULT_STORAGE_COPY_BUFFER_BYTES)
    file.inputStream().use { input ->
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        total += read.toLong()
        require(total <= MAX_UPDATE_BYTES) {
          "Update file exceeds the $MAX_UPDATE_BYTES byte limit."
        }
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString(separator = "") { byte ->
      (byte.toInt() and 0xff).toString(16).padStart(2, '0')
    }
  }

  private fun isContainedBy(file: File, root: File): Boolean {
    val filePath = file.path
    val rootPath = root.path
    return filePath == rootPath || filePath.startsWith(rootPath + File.separator)
  }

  private fun apkInstallIntent(uri: Uri): Intent =
    Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, APK_MIME_TYPE)
      clipData = ClipData.newUri(contentResolver, "Norea update", uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

  private fun requestNotificationPermissionIfNeeded() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    if (notificationPermissionRequested) return
    if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
      PackageManager.PERMISSION_GRANTED
    ) {
      return
    }
    notificationPermissionRequested = true
    requestPermissions(
      arrayOf(Manifest.permission.POST_NOTIFICATIONS),
      REQUEST_POST_NOTIFICATIONS,
    )
  }

  private fun resolveStorageRootPick(requestId: String, payload: JSONObject) {
    val script =
      "window.__lnrResolveAndroidStoragePick && window.__lnrResolveAndroidStoragePick(" +
        "${JSONObject.quote(requestId)}, $payload);"
    mainWebView?.post {
      mainWebView?.evaluateJavascript(script, null)
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

  private fun storageRoot(rootUri: String): DocumentFile =
    DocumentFile.fromTreeUri(this, Uri.parse(rootUri))
      ?: throw IllegalArgumentException("Android storage folder is unavailable.")

  private fun safeStorageSegments(relativePath: String): List<String> {
    val segments = relativePath
      .replace('\\', '/')
      .split('/')
      .map { it.trim() }
      .filter { it.isNotEmpty() }
    require(segments.isNotEmpty()) { "Android storage path is empty." }
    for (segment in segments) {
      require(segment != "." && segment != ".." && !segment.contains('\u0000')) {
        "Android storage path contains an invalid segment."
      }
    }
    return segments
  }

  private fun storageDocumentAt(rootUri: String, relativePath: String): DocumentFile? {
    var current = storageRoot(rootUri)
    for (segment in safeStorageSegments(relativePath)) {
      current = current.findFile(segment) ?: return null
    }
    return current
  }

  private fun restoreBackupDirectoryName(token: String): String {
    val safeToken = safeZipEntryName(token)
      ?: throw IllegalArgumentException("Android restore token is invalid.")
    return "contents.restore-$safeToken"
  }

  private fun ensureStorageDirectory(parent: DocumentFile, name: String): DocumentFile {
    val existing = parent.findFile(name)
    if (existing != null) {
      require(existing.isDirectory) { "Android storage path segment is not a folder: $name" }
      return existing
    }
    return parent.createDirectory(name)
      ?: throw IllegalStateException("Cannot create Android storage folder: $name")
  }

  private fun ensureStorageFile(
    rootUri: String,
    relativePath: String,
    mimeType: String,
  ): DocumentFile {
    val segments = safeStorageSegments(relativePath)
    var current = storageRoot(rootUri)
    for (segment in segments.dropLast(1)) {
      current = ensureStorageDirectory(current, segment)
    }
    val fileName = segments.last()
    val existing = current.findFile(fileName)
    if (existing != null) {
      require(existing.isFile) { "Android storage path is not a file: $relativePath" }
      return existing
    }
    val created = current.createFile(mimeType, fileName)
    if (created != null) return created
    val raced = current.findFile(fileName)
    if (raced != null) {
      require(raced.isFile) { "Android storage path is not a file: $relativePath" }
      return raced
    }
    throw IllegalStateException("Cannot create Android storage file: $relativePath")
  }

  private fun safeZipEntryName(name: String?): String? {
    val entryName = name
      ?.replace('\\', '/')
      ?.substringAfterLast('/')
      ?.trim()
      ?: return null
    if (entryName.isEmpty() || entryName == "." || entryName == "..") return null
    if (entryName.contains('\u0000')) return null
    return entryName
  }

  private fun parseStorageByteLimit(raw: String): Long {
    val limit = raw.trim().toLongOrNull()
      ?: throw IllegalArgumentException("Android storage byte limit is invalid.")
    require(limit > 0L) { "Android storage byte limit must be positive." }
    require(limit <= MAX_ANDROID_TEMP_BYTES) {
      "Android storage byte limit exceeds the $MAX_ANDROID_TEMP_BYTES byte limit."
    }
    return limit
  }

  private fun storageTempRoot(): File {
    val root = File(cacheDir, STORAGE_TEMP_DIR)
    if (!root.exists() && !root.mkdirs()) {
      throw IllegalStateException("Cannot create Android storage temp folder.")
    }
    require(root.isDirectory) { "Android storage temp path is not a folder." }
    return root.canonicalFile
  }

  private fun createStorageTempFile(): File =
    File.createTempFile("content-", ".tmp", storageTempRoot()).canonicalFile

  private fun containedStorageTempFile(path: String): File {
    val root = storageTempRoot()
    val file = File(path).canonicalFile
    require(file.path.startsWith(root.path + File.separator)) {
      "Android storage temp file is outside the bridge temp folder."
    }
    return file
  }

  private fun containedAppCacheFile(path: String): File {
    val root = cacheDir.canonicalFile
    val file = File(path).canonicalFile
    require(file.path == root.path || file.path.startsWith(root.path + File.separator)) {
      "Selected backup temp file is outside the app cache folder."
    }
    return file
  }

  private fun nextZipEntryCount(count: Int, context: String): Int {
    val next = count + 1
    require(next <= MAX_ZIP_ENTRIES) {
      "$context has more than $MAX_ZIP_ENTRIES entries."
    }
    return next
  }

  private fun requireZipEntrySize(entry: ZipEntry, context: String) {
    val size = entry.size
    require(size < 0L || size <= MAX_ZIP_ENTRY_BYTES) {
      "$context exceeds the $MAX_ZIP_ENTRY_BYTES byte entry limit."
    }
  }

  private fun requireStorageFileZipEntrySize(file: DocumentFile, context: String) {
    val size = file.length()
    require(size <= 0L || size <= MAX_ZIP_ENTRY_BYTES) {
      "$context exceeds the $MAX_ZIP_ENTRY_BYTES byte entry limit."
    }
  }

  private fun addZipTotalBytes(total: Long, copied: Long, context: String): Long {
    val next = total + copied
    require(next >= total && next <= MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
      "$context exceeds the $MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES byte total limit."
    }
    return next
  }

  private fun readZipEntryBytes(
    rootUri: String,
    archiveRelativePath: String,
    entryName: String,
  ): ByteArray? {
    val archive = storageDocumentAt(rootUri, archiveRelativePath) ?: return null
    if (!archive.isFile) return null
    return contentResolver.openInputStream(archive.uri)?.use { input ->
      var body: ByteArray? = null
      ZipInputStream(input.buffered()).use { zip ->
        var entry = zip.nextEntry
        var entryCount = 0
        while (entry != null) {
          entryCount = nextZipEntryCount(entryCount, "Media archive")
          val currentName = safeZipEntryName(entry.name)
          if (!entry.isDirectory && currentName == entryName) {
            requireZipEntrySize(entry, "Media archive entry")
            body = readBytesWithLimit(zip, MAX_ZIP_ENTRY_BYTES)
            break
          }
          zip.closeEntry()
          entry = zip.nextEntry
        }
      }
      body
    }
  }

  private fun readBytesWithLimit(input: InputStream, maxBytes: Long): ByteArray {
    val output = ByteArrayOutputStream()
    copyToWithLimit(input, output, maxBytes)
    return output.toByteArray()
  }

  private fun copyToWithLimit(
    input: InputStream,
    output: OutputStream,
    maxBytes: Long,
  ): Long {
    val buffer = ByteArray(DEFAULT_STORAGE_COPY_BUFFER_BYTES)
    var total = 0L
    while (true) {
      val read = input.read(buffer)
      if (read < 0) break
      val next = total + read
      if (next < total || next > maxBytes) {
        throw IllegalArgumentException(
          "Android storage stream exceeds the $maxBytes byte limit.",
        )
      }
      output.write(buffer, 0, read)
      total = next
    }
    return total
  }

  private fun textMimeTypeForPath(relativePath: String): String {
    val mimeType = mimeTypeForPath(relativePath, "")
    return if (mimeType == "application/octet-stream") "text/plain" else mimeType
  }

  private fun mimeTypeForPath(relativePath: String, fallback: String): String {
    if (fallback.isNotBlank()) return fallback
    val extension = relativePath.substringAfterLast('.', "")
      .lowercase()
      .takeIf { it.isNotBlank() }
    return extension
      ?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }
      ?: "application/octet-stream"
  }

  private fun storageDocumentSize(document: DocumentFile): Long =
    if (document.isDirectory) {
      document.listFiles().sumOf(::storageDocumentSize)
    } else {
      document.length().coerceAtLeast(0L)
    }

  private fun windowMetricsJson(webView: WebView): String {
    val metrics = resources.displayMetrics
    val density = if (metrics.density > 0f) metrics.density else 1f
    val widthPx = if (webView.width > 0) webView.width else metrics.widthPixels
    val heightPx = if (webView.height > 0) webView.height else metrics.heightPixels

    return JSONObject()
      .put("widthPx", widthPx)
      .put("heightPx", heightPx)
      .put("density", density.toDouble())
      .put("widthDp", widthPx / density)
      .put("heightDp", heightPx / density)
      .toString()
  }

  companion object {
    private const val APK_MIME_TYPE = "application/vnd.android.package-archive"
    private const val BYTES_PER_MIB = 1024L * 1024L
    private const val DEFAULT_STORAGE_COPY_BUFFER_BYTES = 64 * 1024
    private const val MAX_ANDROID_TEMP_BYTES = 2L * 1024L * BYTES_PER_MIB
    private const val MAX_UPDATE_BYTES = 512L * BYTES_PER_MIB
    private const val MAX_ZIP_ENTRY_BYTES = 256L * BYTES_PER_MIB
    private const val MAX_ZIP_ENTRIES = 100_000
    private const val MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 2L * 1024L * BYTES_PER_MIB
    private const val REQUEST_MEDIA_STORAGE_ROOT = 1001
    private const val REQUEST_POST_NOTIFICATIONS = 1002
    private const val STORAGE_TEMP_DIR = "android-storage-bridge"
    private const val UPDATE_DOWNLOAD_DIR = "Norea Updates"
    private val SHA256_HEX_PATTERN = Regex("^[a-f0-9]{64}$")

    private fun insetsJson(insets: Insets): String {
      return JSONObject()
        .put("top", insets.top)
        .put("right", insets.right)
        .put("bottom", insets.bottom)
        .put("left", insets.left)
        .toString()
    }
  }
}
