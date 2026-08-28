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
  fun keepsExactFileNameForRawDocumentStorage() {
    val directory = temporaryFolder.newFolder("raw-storage")
    val created = createRawAndroidStorageFile(directory, "content.html")

    assertEquals("content.html", created?.name)
    assertTrue(created?.isFile == true)
    assertNull(createRawAndroidStorageFile(directory, "content.html"))
  }
}
