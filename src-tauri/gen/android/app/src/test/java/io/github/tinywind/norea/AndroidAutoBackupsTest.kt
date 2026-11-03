package io.github.tinywind.norea

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidAutoBackupsTest {
  @Test
  fun prunesOnlyTheOldestAutomaticBackupsBeyondTheKeepCount() {
    val names = listOf(
      "norea-auto-backup-20261101000000.zip",
      "norea-auto-backup-20261103000000.zip",
      "norea-backup-20261001000000.zip",
      ".norea-auto-backup-20261104000000.zip.partial",
      "norea-auto-backup-20261102000000.zip",
      "notes.txt",
    )

    assertEquals(
      listOf("norea-auto-backup-20261101000000.zip"),
      autoBackupNamesToPrune(names, 2),
    )
    assertEquals(emptyList<String>(), autoBackupNamesToPrune(names, 5))
  }

  @Test
  fun acceptsOnlyTimestampedAutomaticBackupNames() {
    assertTrue(isAutoBackupName("norea-auto-backup-20261103000000.zip"))
    for (name in listOf("../norea-auto-backup-20261103000000.zip", "norea-auto-backup-2026.zip", "norea-backup-20261103000000.zip")) {
      assertFalse(name, isAutoBackupName(name))
    }
  }
}
