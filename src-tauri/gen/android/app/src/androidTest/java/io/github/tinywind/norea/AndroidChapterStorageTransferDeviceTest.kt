package io.github.tinywind.norea

import android.provider.DocumentsContract
import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidChapterStorageTransferDeviceTest {
  private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

  private fun fixture(noMove: Boolean = false, run: (AndroidStorageDocuments, AndroidChapterStorageTransfer, String, JSONObject) -> Unit) {
    check(context.packageName == "io.github.tinywind.norea.debug") { "Storage transfer tests require the isolated debug application." }
    val resolver = context.contentResolver
    val tree = DocumentsContract.buildTreeDocumentUri(StorageTransferDocumentsProvider.AUTHORITY, "root")
    val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
    context.grantUriPermission(context.packageName, tree, flags)
    val rootDocument = DocumentsContract.buildDocumentUriUsingTree(tree, "root")
    val testRoot = checkNotNull(DocumentsContract.createDocument(resolver, rootDocument, DocumentsContract.Document.MIME_TYPE_DIR,
      (if (noMove) "no-move-" else "move-") + UUID.randomUUID()))
    val rootUri = DocumentsContract.buildTreeDocumentUri(StorageTransferDocumentsProvider.AUTHORITY, DocumentsContract.getDocumentId(testRoot))
    context.grantUriPermission(context.packageName, rootUri, flags)
    val root = rootUri.toString()
    val storage = AndroidStorageDocuments(context)
    val entry = JSONObject().put("entryId", "1").put("sourceRelativeDir", "contents/source-a/a/1").put("targetRelativeDir", "contents/source-b/b/2")
    try {
      val body = checkNotNull(storage.ensureStorageFile(root, "contents/source-a/a/1/content.html", "text/html"))
      checkNotNull(resolver.openOutputStream(body.uri, "wt")).use { it.write("stored body".toByteArray()) }
      run(storage, AndroidChapterStorageTransfer(resolver, storage), root, entry)
    } finally {
      DocumentsContract.deleteDocument(resolver, testRoot)
      context.revokeUriPermission(rootUri, flags)
    }
  }

  @Test
  fun movesSafFoldersWithoutKeepingASecondBodyAndRestoresThemOnRollback() = fixture { storage, transfer, root, entry ->
    val prepared = transfer.prepareChapterStorageTransfer(root, JSONArray().put(entry).toString(), "{\"token\":\"move-test\",\"moveSource\":true}")
    assertEquals("movedSource", prepared.getJSONArray("entries").getJSONObject(0).getString("outcome"))
    assertNull(storage.storageDocumentAt(root, entry.getString("sourceRelativeDir")))
    assertNotNull(storage.storageDocumentAt(root, entry.getString("targetRelativeDir") + "/content.html"))
    transfer.rollbackChapterStorageTransfer(root, prepared.toString())
    transfer.rollbackChapterStorageTransfer(root, prepared.toString())
    assertNotNull(storage.storageDocumentAt(root, entry.getString("sourceRelativeDir") + "/content.html"))
    assertNull(storage.storageDocumentAt(root, entry.getString("targetRelativeDir")))
  }

  @Test
  fun restoresAMoveUsingOnlyThePersistedPlanAfterItsReceiptWasLost() = fixture { storage, transfer, root, entry ->
    transfer.prepareChapterStorageTransfer(root, JSONArray().put(entry).toString(), "{\"token\":\"lost-receipt\",\"moveSource\":true}")
    val pending = JSONObject().put("token", "lost-receipt").put("entries", JSONArray().put(JSONObject(entry.toString())
      .put("outcome", "movedSource").put("replacedTarget", true)))
    transfer.rollbackChapterStorageTransfer(root, pending.toString())
    assertNotNull(storage.storageDocumentAt(root, entry.getString("sourceRelativeDir") + "/content.html"))
    assertNull(storage.storageDocumentAt(root, entry.getString("targetRelativeDir")))
  }

  @Test
  fun finalizesAMovedChapterIdempotently() = fixture { storage, transfer, root, entry ->
    val prepared = transfer.prepareChapterStorageTransfer(root, JSONArray().put(entry).toString(), "{\"token\":\"final-move\",\"moveSource\":true}")
    transfer.finalizeChapterStorageTransfer(root, prepared.toString())
    transfer.finalizeChapterStorageTransfer(root, prepared.toString())
    assertNull(storage.storageDocumentAt(root, entry.getString("sourceRelativeDir")))
    assertNotNull(storage.storageDocumentAt(root, entry.getString("targetRelativeDir") + "/content.html"))
  }

  @Test
  fun retainsCopyFallbackForAProviderWithoutMoveSupport() = fixture(true) { storage, transfer, root, entry ->
    val prepared = transfer.prepareChapterStorageTransfer(root, JSONArray().put(entry).toString(), "{\"token\":\"copy-fallback\",\"moveSource\":true}")
    assertEquals("copiedSource", prepared.getJSONArray("entries").getJSONObject(0).getString("outcome"))
    assertNotNull(storage.storageDocumentAt(root, entry.getString("sourceRelativeDir") + "/content.html"))
    transfer.rollbackChapterStorageTransfer(root, prepared.toString())
    assertNotNull(storage.storageDocumentAt(root, entry.getString("sourceRelativeDir") + "/content.html"))
  }
}
