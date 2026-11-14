package io.github.tinywind.norea

import android.app.Activity
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.annotation.Keep
import androidx.core.content.FileProvider
import io.github.tinywind.norea.AppLog as Log
import java.io.File
import java.lang.ref.WeakReference
import java.security.MessageDigest
import org.json.JSONObject

private const val REQUEST_MEDIA_STORAGE_ROOT = 1001
private const val APK_MIME_TYPE = "application/vnd.android.package-archive"
private const val BYTES_PER_MIB = 1024L * 1024L
private const val MAX_UPDATE_BYTES = 512L * BYTES_PER_MIB
private const val UPDATE_DOWNLOAD_DIR = "Norea Updates"
private const val COPY_BUFFER_BYTES = 64 * 1024
private val SHA256_HEX_PATTERN = Regex("^[a-f0-9]{64}$")

@Keep
object AndroidNativeIo {
  init {
    System.loadLibrary("app_lib")
  }

  @JvmStatic
  private external fun register()

  @JvmStatic
  private external fun completeStorageRootPick(requestId: Long, resultJson: String)

  private val lock = Any()
  @Volatile
  private var appContext: Context? = null
  private var currentActivity: WeakReference<Activity>? = null
  private var registered = false
  private var pendingStorageRootPickId: Long? = null

  fun attachActivity(activity: Activity) {
    synchronized(lock) {
      if (appContext == null) {
        appContext = activity.applicationContext
      }
      currentActivity = WeakReference(activity)
      if (!registered) {
        registered = true
        register()
      }
    }
  }

  fun detachActivity(activity: Activity) {
    val cancelledId = synchronized(lock) {
      if (currentActivity?.get() === activity) {
        currentActivity = null
      }
      if (activity.isFinishing) {
        pendingStorageRootPickId.also { pendingStorageRootPickId = null }
      } else {
        null
      }
    }
    if (cancelledId != null) {
      completeStorageRootPick(
        cancelledId,
        JSONObject().put("status", "cancelled").toString(),
      )
    }
  }

  fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != REQUEST_MEDIA_STORAGE_ROOT) return

    val requestId = synchronized(lock) {
      pendingStorageRootPickId.also { pendingStorageRootPickId = null }
    } ?: return

    if (resultCode != Activity.RESULT_OK) {
      completeStorageRootPick(
        requestId,
        JSONObject().put("status", "cancelled").toString(),
      )
      return
    }

    val uri = data?.data
    if (uri == null) {
      completeStorageRootPick(
        requestId,
        JSONObject()
          .put("status", "error")
          .put("error", "No storage folder was selected.")
          .toString(),
      )
      return
    }

    val flags = data.flags and (
      Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
    )
    runCatching {
      activity.contentResolver.takePersistableUriPermission(uri, flags)
      uri.toString()
    }.fold(
      onSuccess = { root ->
        completeStorageRootPick(
          requestId,
          JSONObject()
            .put("status", "picked")
            .put("root", root)
            .toString(),
        )
      },
      onFailure = { error ->
        Log.w(
          "NoreaStorage",
          singleLineLogMessage("Storage folder permission failed. " + error.stackTraceToString()),
        )
        completeStorageRootPick(
          requestId,
          JSONObject()
            .put("status", "error")
            .put("error", "Storage folder permission could not be retained.")
            .toString(),
        )
      },
    )
  }

  @Keep
  @JvmStatic
  fun isAllFilesAccessGranted(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()

  @Keep
  @JvmStatic
  fun externalStorageRootPath(): String =
    Environment.getExternalStorageDirectory().absolutePath

  @Keep
  @JvmStatic
  fun startStorageRootPick(requestId: Long): String? {
    val activity = synchronized(lock) {
      if (pendingStorageRootPickId != null) {
        return "A storage folder picker is already open."
      }
      val active = currentActivity?.get()?.takeIf { !it.isFinishing && !it.isDestroyed }
        ?: return "Storage folder picker requires an active window."
      pendingStorageRootPickId = requestId
      active
    }

    activity.runOnUiThread {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
        putExtra("android.content.extra.SHOW_ADVANCED", true)
      }
      runCatching {
        activity.startActivityForResult(intent, REQUEST_MEDIA_STORAGE_ROOT)
      }.onFailure { error ->
        val stillPending = synchronized(lock) {
          if (pendingStorageRootPickId == requestId) {
            pendingStorageRootPickId = null
            true
          } else {
            false
          }
        }
        Log.w(
          "NoreaStorage",
          singleLineLogMessage("Storage folder picker failed. " + error.stackTraceToString()),
        )
        if (stillPending) {
          completeStorageRootPick(
            requestId,
            JSONObject()
              .put("status", "error")
              .put("error", "Storage folder picker could not be opened.")
              .toString(),
          )
        }
      }
    }
    return null
  }

  @Keep
  @JvmStatic
  fun scanFile(path: String) {
    val context = appContext ?: return
    MediaScannerConnection.scanFile(context, arrayOf(path), null, null)
  }

  @Keep
  @JvmStatic
  fun describeContentUri(uri: String): String {
    val context = requireContext()
    val contentUri = Uri.parse(uri)
    val resolver = context.contentResolver
    var displayName: String? = null
    var size: Long? = null
    runCatching {
      resolver.query(
        contentUri,
        arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
        null,
        null,
        null,
      )?.use { cursor ->
        if (!cursor.moveToFirst()) return@use
        val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (nameIndex >= 0 && !cursor.isNull(nameIndex)) {
          displayName = cursor.getString(nameIndex)
        }
        val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
        if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
          size = cursor.getLong(sizeIndex).takeIf { it >= 0L }
        }
      }
    }.onFailure { error ->
      Log.w(
        "NoreaStorage",
        singleLineLogMessage("Android content URI metadata query failed. uri=$contentUri ${error.stackTraceToString()}"),
      )
    }

    val mimeType = resolver.getType(contentUri)
      ?.takeIf { it.isNotBlank() }
      ?: inferMimeTypeFromPath(contentUri.toString())
    val fileName = resolveContentUriFileName(contentUri, mimeType, displayName)
    return JSONObject()
      .put("fileName", fileName)
      .put("mimeType", mimeType)
      .put("size", size ?: JSONObject.NULL)
      .toString()
  }

  @Keep
  @JvmStatic
  fun openContentUriFd(uri: String, mode: String): Int {
    val context = requireContext()
    val descriptor = context.contentResolver.openFileDescriptor(Uri.parse(uri), mode)
      ?: throw IllegalStateException("Cannot open selected file ($mode).")
    return descriptor.detachFd()
  }

  @Keep
  @JvmStatic
  fun installUpdateApk(path: String, expectedSize: Long, expectedSha256: String) {
    val context = requireContext()
    require(expectedSize in 0L..MAX_UPDATE_BYTES) {
      "Update size metadata exceeds the $MAX_UPDATE_BYTES byte limit."
    }
    val normalizedSha = expectedSha256.trim().lowercase()
    require(SHA256_HEX_PATTERN.matches(normalizedSha)) {
      "Update SHA-256 metadata is invalid."
    }

    val apk = allowedUpdateApk(context, path)
    verifyUpdateApkIntegrity(apk, expectedSize, normalizedSha)
    verifyUpdateApkIdentity(context, apk)

    val uri = FileProvider.getUriForFile(
      context,
      "${context.packageName}.fileprovider",
      apk,
    )
    val intent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, APK_MIME_TYPE)
      clipData = ClipData.newUri(context.contentResolver, "Norea update", uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.startActivity(intent)
  }

  private fun requireContext(): Context =
    checkNotNull(appContext) { "Android native I/O is not initialized." }

  private fun inferMimeTypeFromPath(path: String): String {
    val extension = path.substringBefore('?')
      .substringAfterLast('.', "")
      .lowercase()
      .takeIf { it.isNotBlank() }
    return extension
      ?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }
      ?: "application/octet-stream"
  }

  private fun resolveContentUriFileName(
    uri: Uri,
    mimeType: String,
    displayName: String?,
  ): String {
    displayName?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
    uri.lastPathSegment
      ?.substringAfterLast('/')
      ?.substringAfterLast(':')
      ?.takeIf { it.isNotBlank() }
      ?.let { return it }
    val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType)
    return if (extension.isNullOrBlank()) "opened-file" else "opened-file.$extension"
  }

  private fun allowedUpdateApk(context: Context, path: String): File {
    val apk = File(path).canonicalFile
    require(apk.isFile) { "APK file does not exist." }
    require(apk.extension.equals("apk", ignoreCase = true)) {
      "Update file is not an APK."
    }
    require(allowedUpdateRoots(context).any { root -> isContainedBy(apk, root) }) {
      "APK file is outside the Android update folder."
    }
    return apk
  }

  private fun allowedUpdateRoots(context: Context): List<File> {
    val roots = mutableListOf<File>()
    fun addUpdateRoots(base: File?) {
      if (base == null) return
      roots.add(File(base, UPDATE_DOWNLOAD_DIR))
      roots.add(File(File(base, "native-stream"), "update"))
    }
    addUpdateRoots(context.cacheDir)
    addUpdateRoots(context.externalCacheDir)
    addUpdateRoots(context.filesDir)
    addUpdateRoots(context.getExternalFilesDir(null))
    return roots.map { it.canonicalFile }
  }

  private fun verifyUpdateApkIntegrity(apk: File, expectedSize: Long, expectedSha256: String) {
    val fileSize = apk.length().coerceAtLeast(0L)
    require(fileSize <= MAX_UPDATE_BYTES) {
      "Update file exceeds the $MAX_UPDATE_BYTES byte limit."
    }
    require(fileSize == expectedSize) {
      "Update file size does not match metadata."
    }
    val actualSha256 = sha256Hex(apk)
    require(actualSha256 == expectedSha256) {
      "Update file SHA-256 does not match metadata."
    }
  }

  private fun verifyUpdateApkIdentity(context: Context, apk: File) {
    val packageManager = context.packageManager
    val archive = packageInfo(packageManager, apk.absolutePath)
      ?: throw IllegalArgumentException("Update APK package information is unavailable.")
    require(archive.packageName == context.packageName) {
      "Update APK package name does not match this app."
    }
    val installed = installedPackageInfo(context, packageManager)
    val installedCurrent = currentSignerDigests(installed)
    val archiveCurrent = currentSignerDigests(archive)
    val archiveHistory = signerHistoryDigests(archive)
    require(installedCurrent.isNotEmpty() && archiveCurrent.isNotEmpty()) {
      "Update APK signing information is unavailable."
    }
    val signerMatches = if (installedCurrent.size > 1) {
      archiveCurrent == installedCurrent
    } else {
      archiveHistory.containsAll(installedCurrent)
    }
    require(signerMatches) {
      "Update APK signing certificate does not match this app."
    }
  }

  @Suppress("DEPRECATION")
  private fun packageInfo(packageManager: PackageManager, path: String): PackageInfo? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      packageManager.getPackageArchiveInfo(path, PackageManager.GET_SIGNING_CERTIFICATES)
    } else {
      packageManager.getPackageArchiveInfo(path, PackageManager.GET_SIGNATURES)
    }

  @Suppress("DEPRECATION")
  private fun installedPackageInfo(context: Context, packageManager: PackageManager): PackageInfo =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
    } else {
      packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES)
    }

  @Suppress("DEPRECATION")
  private fun currentSigners(info: PackageInfo): List<Signature> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      info.signingInfo?.apkContentsSigners?.toList().orEmpty()
    } else {
      info.signatures?.toList().orEmpty()
    }

  @Suppress("DEPRECATION")
  private fun signerHistory(info: PackageInfo): List<Signature> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      info.signingInfo?.signingCertificateHistory?.toList().orEmpty()
    } else {
      info.signatures?.toList().orEmpty()
    }

  private fun signatureDigest(signature: Signature): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())
    return digest.joinToString(separator = "") { byte ->
      (byte.toInt() and 0xff).toString(16).padStart(2, '0')
    }
  }

  private fun currentSignerDigests(info: PackageInfo): Set<String> =
    currentSigners(info).mapTo(linkedSetOf(), ::signatureDigest)

  private fun signerHistoryDigests(info: PackageInfo): Set<String> =
    signerHistory(info).mapTo(linkedSetOf(), ::signatureDigest)

  private fun sha256Hex(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    var total = 0L
    val buffer = ByteArray(COPY_BUFFER_BYTES)
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
}
