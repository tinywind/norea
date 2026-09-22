package io.github.tinywind.norea

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.JavascriptInterface
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

private const val APK_MIME_TYPE = "application/vnd.android.package-archive"
private const val MAX_UPDATE_BYTES = 512L * BYTES_PER_MIB
private const val UPDATE_DOWNLOAD_DIR = "Norea Updates"
private val SHA256_HEX_PATTERN = Regex("^[a-f0-9]{64}$")

internal class AndroidUpdateInstallBridge(
  private val context: Context,
  private val bridgeSession: BridgeSession,
) {
  private data class UpdateOpenRequest(
    val path: String,
    val authority: BridgeAuthorityFields,
    val integrity: UpdateApkIntegrity?,
  )

  private data class UpdateApkIntegrity(
    val size: Long,
    val sha256: String,
  )

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
        context,
        "${context.packageName}.fileprovider",
        apk,
      )
      context.startActivity(apkInstallIntent(uri))
    }.fold(
      onSuccess = { JSONObject().put("ok", true).toString() },
      onFailure = { error ->
        JSONObject()
          .put("ok", false)
          .put("error", error.message ?: error.toString())
          .toString()
      },
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

    addUpdateRoots(context.cacheDir)
    addUpdateRoots(context.externalCacheDir)
    addUpdateRoots(context.filesDir)
    addUpdateRoots(context.getExternalFilesDir(null))
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
      clipData = ClipData.newUri(context.contentResolver, "Norea update", uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
