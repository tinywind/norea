package io.github.tinywind.norea

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class AndroidUpdateApkPathTest {
  @get:Rule
  val temporary = TemporaryFolder()

  @Test
  fun acceptsApksInsideInternalUpdateDirectories() {
    val cacheDir = temporary.newFolder("internal-cache")
    val filesDir = temporary.newFolder("internal-files")
    val roots = allowedInternalUpdateRoots(cacheDir, filesDir)

    val cacheApk = File(File(cacheDir, "Norea Updates"), "norea-arm64.apk").apply {
      parentFile!!.mkdirs()
      writeBytes(byteArrayOf(1, 2, 3))
    }
    val streamApk = File(File(File(cacheDir, "native-stream"), "update"), "update.apk").apply {
      parentFile!!.mkdirs()
      writeBytes(byteArrayOf(1, 2, 3))
    }
    val filesApk = File(File(filesDir, "Norea Updates"), "norea-x86_64.apk").apply {
      parentFile!!.mkdirs()
      writeBytes(byteArrayOf(1, 2, 3))
    }

    assertEquals(cacheApk.canonicalFile, requireAllowedUpdateApk(cacheApk.path, roots))
    assertEquals(streamApk.canonicalFile, requireAllowedUpdateApk(streamApk.path, roots))
    assertEquals(filesApk.canonicalFile, requireAllowedUpdateApk(filesApk.path, roots))
  }

  @Test
  fun rejectsExternalSiblingAndTraversalPaths() {
    val cacheDir = temporary.newFolder("internal-cache")
    val filesDir = temporary.newFolder("internal-files")
    val externalDir = temporary.newFolder("external-cache")
    val roots = allowedInternalUpdateRoots(cacheDir, filesDir)

    val externalApk = File(File(externalDir, "Norea Updates"), "tampered.apk").apply {
      parentFile!!.mkdirs()
      writeBytes(byteArrayOf(1, 2, 3))
    }
    val siblingPrefixApk = File(File(cacheDir, "Norea Updates-evil"), "tampered.apk").apply {
      parentFile!!.mkdirs()
      writeBytes(byteArrayOf(1, 2, 3))
    }
    val traversalPath = File(File(cacheDir, "Norea Updates"), "../../external-cache/Norea Updates/tampered.apk").path
    val nonApk = File(File(cacheDir, "Norea Updates"), "not-an-apk.zip").apply {
      parentFile!!.mkdirs()
      writeBytes(byteArrayOf(1, 2, 3))
    }

    assertThrows(IllegalArgumentException::class.java) {
      requireAllowedUpdateApk(externalApk.path, roots)
    }
    assertThrows(IllegalArgumentException::class.java) {
      requireAllowedUpdateApk(siblingPrefixApk.path, roots)
    }
    assertThrows(IllegalArgumentException::class.java) {
      requireAllowedUpdateApk(traversalPath, roots)
    }
    assertThrows(IllegalArgumentException::class.java) {
      requireAllowedUpdateApk(nonApk.path, roots)
    }
  }
}
