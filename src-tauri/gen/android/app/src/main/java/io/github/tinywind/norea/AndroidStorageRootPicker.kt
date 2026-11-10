package io.github.tinywind.norea

import android.app.Activity
import android.content.Intent
import android.webkit.WebView
import io.github.tinywind.norea.AppLog as Log
import org.json.JSONObject

private const val REQUEST_MEDIA_STORAGE_ROOT = 1001

internal class AndroidStorageRootPicker(
  private val activity: Activity,
  private val mainWebView: () -> WebView?,
) {
  private var pendingStorageRootRequestId: String? = null

  fun pick(requestId: String) {
    activity.runOnUiThread {
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
        activity.startActivityForResult(intent, REQUEST_MEDIA_STORAGE_ROOT)
      }.onFailure { error ->
        pendingStorageRootRequestId = null
        Log.w("NoreaStorage", singleLineLogMessage("Storage folder picker failed. " + error.stackTraceToString()))
        resolveStorageRootPick(
          requestId,
          JSONObject()
            .put("ok", false)
            .put("error", "Storage folder picker could not be opened."),
        )
      }
    }
  }

  fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
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
      activity.contentResolver.takePersistableUriPermission(uri, flags)
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
        Log.w("NoreaStorage", singleLineLogMessage("Storage folder permission failed. " + error.stackTraceToString()))
        resolveStorageRootPick(
          requestId,
          JSONObject()
            .put("ok", false)
            .put("error", "Storage folder permission could not be retained."),
        )
      },
    )
  }

  private fun resolveStorageRootPick(requestId: String, payload: JSONObject) {
    val encodedPayload = JSONObject.quote(payload.toString())
    val script =
      "window.__noreaResolveAndroidStoragePick && window.__noreaResolveAndroidStoragePick(" +
        "${JSONObject.quote(requestId)}, JSON.parse($encodedPayload));"
    mainWebView()?.post {
      mainWebView()?.evaluateJavascript(script, null)
    }
  }
}
