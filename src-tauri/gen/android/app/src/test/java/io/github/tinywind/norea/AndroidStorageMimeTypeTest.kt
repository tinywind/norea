package io.github.tinywind.norea

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class AndroidStorageMimeTypeTest {
  @get:Rule
  val temporaryFolder = TemporaryFolder()

  private val mimeTypes = mapOf(
    "html" to "text/html",
    "jpg" to "image/jpeg",
    "jpeg" to "image/jpeg",
    "gif" to "image/gif",
    "zip" to "application/zip",
  )

  @Test
  fun keepsGenericMimeTypeForInternalStorageSuffixes() {
    assertEquals(
      "application/octet-stream",
      inferAndroidStorageMimeType("contents/chapter/content.html.tmp", mimeTypes::get),
    )
    assertEquals(
      "application/octet-stream",
      inferAndroidStorageMimeType("contents/chapter/.chapter-content.partial", mimeTypes::get),
    )
    assertEquals(
      "application/octet-stream",
      inferAndroidStorageMimeType("contents/chapter/manifest.json.tmp", mimeTypes::get),
    )
  }

  @Test
  fun preservesKnownStorageMimeTypes() {
    assertEquals(
      "text/html",
      inferAndroidStorageMimeType("contents/chapter/content.html", mimeTypes::get),
    )
  }

  @Test
  fun createsMediaUsingTheExactFileNamesMimeType() {
    assertEquals(
      "image/jpeg",
      androidStorageCreationMimeType("0001-p001.jpg", "image/gif", mimeTypes::get),
    )
    assertEquals(
      "image/gif",
      androidStorageCreationMimeType("0001-p001.gif", "image/jpeg", mimeTypes::get),
    )
    assertEquals(
      "image/jpeg",
      androidStorageCreationMimeType(
        "0001-p001.JPEG",
        "image/jpeg; charset=binary",
        mimeTypes::get,
      ),
    )
  }

  @Test
  fun avoidsProviderExtensionsForUnknownOrInternalSuffixes() {
    val fileNames = listOf(
      "content.html.tmp",
      "archive.zip.tmp",
      ".chapter-content.partial",
      "image",
      "image.custom",
    )
    for (name in fileNames) {
      assertEquals(
        name,
        "application/octet-stream",
        androidStorageCreationMimeType(name, "image/gif", mimeTypes::get),
      )
    }
  }

  @Test
  fun preservesGenericDocumentCreationAndMatchingMimeTypes() {
    for (mimeType in listOf("application/octet-stream", "Application/Octet-Stream; charset=binary")) {
      assertEquals(
        "application/octet-stream",
        androidStorageCreationMimeType("content.html", mimeType, mimeTypes::get),
      )
    }
    assertEquals(
      "text/html",
      androidStorageCreationMimeType("content.html", "text/html", mimeTypes::get),
    )
    assertEquals(
      "application/zip",
      androidStorageCreationMimeType("media.zip", "application/zip", mimeTypes::get),
    )
  }

  @Test
  fun keepsExactFileNameForRawDocumentStorage() {
    val directory = temporaryFolder.newFolder("raw-storage")
    val created = createRawAndroidStorageFile(directory, "content.html")

    assertEquals("content.html", created?.name)
    assertTrue(created?.isFile == true)
    assertNull(createRawAndroidStorageFile(directory, "content.html"))
  }
}
