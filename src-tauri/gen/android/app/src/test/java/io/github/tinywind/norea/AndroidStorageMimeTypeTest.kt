package io.github.tinywind.norea

import org.junit.Assert.assertEquals
import org.junit.Test

class AndroidStorageMimeTypeTest {
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
  }

  @Test
  fun preservesKnownStorageMimeTypes() {
    assertEquals(
      "text/html",
      inferAndroidStorageMimeType("contents/chapter/content.html", mimeTypes::get),
    )
  }
}
