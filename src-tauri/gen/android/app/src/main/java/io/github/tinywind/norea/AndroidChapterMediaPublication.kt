package io.github.tinywind.norea

internal interface AndroidChapterMediaManifestArtifactStore {
  fun delete(fileName: String): Boolean

  fun exists(fileName: String): Boolean

  fun isFile(fileName: String): Boolean

  fun rename(sourceFileName: String, targetFileName: String): Boolean
}

private fun androidChapterMediaManifestArtifactsAreFiles(
  store: AndroidChapterMediaManifestArtifactStore,
): Boolean = listOf(
  CHAPTER_MEDIA_MANIFEST_FILE,
  CHAPTER_MEDIA_MANIFEST_TEMP_FILE,
  CHAPTER_MEDIA_MANIFEST_BACKUP_FILE,
).all { fileName -> !store.exists(fileName) || store.isFile(fileName) }

private fun requireAndroidChapterMediaManifestArtifactsAreFiles(
  store: AndroidChapterMediaManifestArtifactStore,
) {
  check(androidChapterMediaManifestArtifactsAreFiles(store)) {
    "Android chapter media manifest artifact path is not a file."
  }
}

private fun deleteAndroidChapterMediaManifestArtifact(
  store: AndroidChapterMediaManifestArtifactStore,
  fileName: String,
  errorMessage: String,
) {
  if (store.exists(fileName) && !store.delete(fileName)) {
    throw IllegalStateException(errorMessage)
  }
}

internal fun publishAndroidChapterMediaArtifactWithRollback(
  publicationErrorMessage: String,
  restorationErrorMessage: String,
  publish: () -> Boolean,
  restore: (() -> Boolean)?,
) {
  if (publish()) return

  val publicationError = IllegalStateException(publicationErrorMessage)
  if (restore != null) {
    val restorationError = try {
      if (restore()) null else IllegalStateException(restorationErrorMessage)
    } catch (restorationCause: Exception) {
      IllegalStateException(restorationErrorMessage, restorationCause)
    }
    if (restorationError != null) {
      throw IllegalStateException(
        "$publicationErrorMessage $restorationErrorMessage",
        publicationError,
      ).apply {
        addSuppressed(restorationError)
      }
    }
  }
  throw publicationError
}

internal fun runAndroidChapterMediaRecoveryPreservingPrimaryFailure(
  primaryFailure: IllegalStateException,
  recovery: () -> Unit,
) {
  try {
    recovery()
  } catch (recoveryFailure: Exception) {
    throw IllegalStateException(
      "${primaryFailure.message} ${recoveryFailure.message}",
      primaryFailure,
    ).apply {
      addSuppressed(recoveryFailure)
    }
  }
}

internal fun recoverInvalidPublishedAndroidChapterMediaArchive(
  deletePublished: () -> Boolean,
  restorePrevious: (() -> Boolean)?,
) {
  val validationFailure = IllegalStateException(
    "Published Android chapter media archive failed validation.",
  )
  runAndroidChapterMediaRecoveryPreservingPrimaryFailure(validationFailure) {
    if (!deletePublished()) {
      throw IllegalStateException("Cannot remove invalid published chapter media archive.")
    }
    if (restorePrevious != null && !restorePrevious()) {
      throw IllegalStateException("Cannot restore previous Android chapter media archive.")
    }
  }
}

internal fun <T> recoverAndroidChapterMediaManifestArtifacts(
  store: AndroidChapterMediaManifestArtifactStore,
  readValid: (String) -> T?,
): T? {
  if (!androidChapterMediaManifestArtifactsAreFiles(store)) return null

  val temp = if (store.exists(CHAPTER_MEDIA_MANIFEST_TEMP_FILE)) {
    readValid(CHAPTER_MEDIA_MANIFEST_TEMP_FILE)
  } else {
    null
  }
  val publishedBeforeRecovery = if (store.exists(CHAPTER_MEDIA_MANIFEST_FILE)) {
    readValid(CHAPTER_MEDIA_MANIFEST_FILE)
  } else {
    null
  }
  if (temp != null) {
    val hadPublishedManifest = publishedBeforeRecovery != null
    if (hadPublishedManifest) {
      deleteAndroidChapterMediaManifestArtifact(
        store,
        CHAPTER_MEDIA_MANIFEST_BACKUP_FILE,
        "Cannot remove stale Android chapter media manifest backup.",
      )
      if (!store.rename(CHAPTER_MEDIA_MANIFEST_FILE, CHAPTER_MEDIA_MANIFEST_BACKUP_FILE)) {
        throw IllegalStateException("Cannot backup Android chapter media manifest.")
      }
    } else {
      deleteAndroidChapterMediaManifestArtifact(
        store,
        CHAPTER_MEDIA_MANIFEST_FILE,
        "Cannot remove invalid Android chapter media manifest.",
      )
    }
    publishAndroidChapterMediaArtifactWithRollback(
      publicationErrorMessage = "Cannot publish Android chapter media manifest temp file.",
      restorationErrorMessage = "Cannot restore Android chapter media manifest backup.",
      publish = {
        store.rename(CHAPTER_MEDIA_MANIFEST_TEMP_FILE, CHAPTER_MEDIA_MANIFEST_FILE)
      },
      restore = if (hadPublishedManifest) {
        {
          store.rename(CHAPTER_MEDIA_MANIFEST_BACKUP_FILE, CHAPTER_MEDIA_MANIFEST_FILE)
        }
      } else {
        null
      },
    )
    val published = readValid(CHAPTER_MEDIA_MANIFEST_FILE)
    if (published == null) {
      val validationFailure = IllegalStateException(
        "Published Android chapter media manifest failed validation.",
      )
      runAndroidChapterMediaRecoveryPreservingPrimaryFailure(validationFailure) {
        if (!store.rename(CHAPTER_MEDIA_MANIFEST_FILE, CHAPTER_MEDIA_MANIFEST_TEMP_FILE)) {
          throw IllegalStateException("Cannot preserve invalid Android chapter media manifest.")
        }
        if (
          hadPublishedManifest &&
          !store.rename(CHAPTER_MEDIA_MANIFEST_BACKUP_FILE, CHAPTER_MEDIA_MANIFEST_FILE)
        ) {
          throw IllegalStateException("Cannot restore Android chapter media manifest backup.")
        }
      }
      throw validationFailure
    }
    deleteAndroidChapterMediaManifestArtifact(
      store,
      CHAPTER_MEDIA_MANIFEST_BACKUP_FILE,
      "Cannot remove Android chapter media manifest backup.",
    )
    return published
  }
  if (publishedBeforeRecovery != null) return publishedBeforeRecovery

  val backup = if (store.exists(CHAPTER_MEDIA_MANIFEST_BACKUP_FILE)) {
    readValid(CHAPTER_MEDIA_MANIFEST_BACKUP_FILE)
  } else {
    null
  }
  if (backup != null) {
    deleteAndroidChapterMediaManifestArtifact(
      store,
      CHAPTER_MEDIA_MANIFEST_FILE,
      "Cannot remove invalid Android chapter media manifest.",
    )
    if (!store.rename(CHAPTER_MEDIA_MANIFEST_BACKUP_FILE, CHAPTER_MEDIA_MANIFEST_FILE)) {
      throw IllegalStateException("Cannot restore Android chapter media manifest backup.")
    }
    val published = readValid(CHAPTER_MEDIA_MANIFEST_FILE)
    if (published == null) {
      val validationFailure = IllegalStateException(
        "Restored Android chapter media manifest failed validation.",
      )
      runAndroidChapterMediaRecoveryPreservingPrimaryFailure(validationFailure) {
        if (!store.rename(CHAPTER_MEDIA_MANIFEST_FILE, CHAPTER_MEDIA_MANIFEST_BACKUP_FILE)) {
          throw IllegalStateException("Cannot preserve invalid Android chapter media manifest.")
        }
      }
      throw validationFailure
    }
    deleteAndroidChapterMediaManifestArtifact(
      store,
      CHAPTER_MEDIA_MANIFEST_TEMP_FILE,
      "Cannot remove invalid Android chapter media manifest temp file.",
    )
    return published
  }

  return null
}

internal fun <T> replaceAndroidChapterMediaManifestAtomically(
  store: AndroidChapterMediaManifestArtifactStore,
  writeTemp: () -> Unit,
  readValid: (String) -> T?,
): T {
  recoverAndroidChapterMediaManifestArtifacts(store, readValid)
  requireAndroidChapterMediaManifestArtifactsAreFiles(store)
  deleteAndroidChapterMediaManifestArtifact(
    store,
    CHAPTER_MEDIA_MANIFEST_TEMP_FILE,
    "Cannot remove stale Android chapter media manifest temp file.",
  )

  writeTemp()
  requireAndroidChapterMediaManifestArtifactsAreFiles(store)
  if (
    !store.exists(CHAPTER_MEDIA_MANIFEST_TEMP_FILE) ||
    readValid(CHAPTER_MEDIA_MANIFEST_TEMP_FILE) == null
  ) {
    throw IllegalStateException("Android chapter media manifest temp file failed validation.")
  }

  val hadPublishedManifest = store.exists(CHAPTER_MEDIA_MANIFEST_FILE)
  if (hadPublishedManifest) {
    deleteAndroidChapterMediaManifestArtifact(
      store,
      CHAPTER_MEDIA_MANIFEST_BACKUP_FILE,
      "Cannot remove stale Android chapter media manifest backup.",
    )
    if (!store.rename(CHAPTER_MEDIA_MANIFEST_FILE, CHAPTER_MEDIA_MANIFEST_BACKUP_FILE)) {
      throw IllegalStateException("Cannot backup Android chapter media manifest.")
    }
  }

  publishAndroidChapterMediaArtifactWithRollback(
    publicationErrorMessage = "Cannot publish Android chapter media manifest.",
    restorationErrorMessage = "Cannot restore Android chapter media manifest backup.",
    publish = {
      store.rename(CHAPTER_MEDIA_MANIFEST_TEMP_FILE, CHAPTER_MEDIA_MANIFEST_FILE)
    },
    restore = if (hadPublishedManifest) {
      {
        store.rename(CHAPTER_MEDIA_MANIFEST_BACKUP_FILE, CHAPTER_MEDIA_MANIFEST_FILE)
      }
    } else {
      null
    },
  )

  val published = readValid(CHAPTER_MEDIA_MANIFEST_FILE)
  if (published == null) {
    val validationFailure = IllegalStateException(
      "Published Android chapter media manifest failed validation.",
    )
    runAndroidChapterMediaRecoveryPreservingPrimaryFailure(validationFailure) {
      if (!store.rename(CHAPTER_MEDIA_MANIFEST_FILE, CHAPTER_MEDIA_MANIFEST_TEMP_FILE)) {
        throw IllegalStateException("Cannot preserve invalid Android chapter media manifest.")
      }
      if (hadPublishedManifest) {
        if (!store.rename(CHAPTER_MEDIA_MANIFEST_BACKUP_FILE, CHAPTER_MEDIA_MANIFEST_FILE)) {
          throw IllegalStateException("Cannot restore Android chapter media manifest backup.")
        }
      }
    }
    throw validationFailure
  }

  deleteAndroidChapterMediaManifestArtifact(
    store,
    CHAPTER_MEDIA_MANIFEST_BACKUP_FILE,
    "Cannot remove Android chapter media manifest backup.",
  )
  return published
}
