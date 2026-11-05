package io.github.tinywind.norea

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.FileNotFoundException
import java.io.IOException

class AndroidStorageDirectReadPolicyTest {
  private val rootA = "content://com.android.externalstorage.documents/tree/primary%3ANorea"
  private val rootB = "content://com.android.externalstorage.documents/tree/primary%3AOther"
  private val denied = FileNotFoundException(
    "/storage/emulated/0/Norea/contents/source/1/2/media.zip: open failed: EACCES (Permission denied)",
  )
  private val missing = FileNotFoundException(
    "/storage/emulated/0/Norea/contents/source/1/2/.chapter-content.partial: open failed: ENOENT (No such file or directory)",
  )

  @Test
  fun classifiesPermissionFailuresButNotMissingFiles() {
    assertTrue(isAndroidStorageAccessDenied(denied))
    assertTrue(isAndroidStorageAccessDenied(IOException("open failed: EPERM (Operation not permitted)")))
    assertTrue(isAndroidStorageAccessDenied(SecurityException("Permission Denial")))
    assertTrue(isAndroidStorageAccessDenied(IOException("zip open failed", denied)))
    assertFalse(isAndroidStorageAccessDenied(missing))
    assertFalse(
      isAndroidStorageAccessDenied(
        FileNotFoundException("/storage/emulated/0/Norea/contents/source/SLEEPERM/novel.json: open failed: ENOENT (No such file or directory)"),
      ),
    )
    assertFalse(isAndroidStorageAccessDenied(IOException("zip END header not found")))
    assertFalse(isAndroidStorageAccessDenied(IOException(null as String?)))
  }

  @Test
  fun deniedRootSkipsDirectReadsAndReportsOnce() {
    val reports = mutableListOf<String>()
    val policy = AndroidStorageDirectReadPolicy { rootUri, _ -> reports.add(rootUri) }

    assertTrue(policy.allows(rootA))
    assertTrue(policy.recordFailure(rootA, denied))
    assertTrue(policy.recordFailure(rootA, denied))

    assertFalse(policy.allows(rootA))
    assertTrue(policy.allows(rootB))
    assertEquals(listOf(rootA), reports)

    assertTrue(policy.recordFailure(rootB, SecurityException("Permission Denial")))
    assertEquals(listOf(rootA, rootB), reports)
  }

  @Test
  fun missingFilesAndOtherFailuresKeepDirectReads() {
    val reports = mutableListOf<String>()
    val policy = AndroidStorageDirectReadPolicy { rootUri, _ -> reports.add(rootUri) }

    assertFalse(policy.recordFailure(rootA, missing))
    assertFalse(policy.recordFailure(rootA, IOException("zip END header not found")))

    assertTrue(policy.allows(rootA))
    assertTrue(reports.isEmpty())
  }
}
