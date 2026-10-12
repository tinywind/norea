package io.github.tinywind.norea

internal class AndroidContentSnapshotGuard {
  private class ChapterState {
    var generation = 0L
    var snapshots = 0
    var installations = 0
  }

  private val chapters = mutableMapOf<Pair<String, String>, ChapterState>()

  fun <T> snapshot(rootUri: String, storageDir: String, read: () -> T): T {
    val key = rootUri to storageDir
    val (state, generation) = synchronized(chapters) {
      val state = chapters.getOrPut(key) { ChapterState() }
      check(state.installations == 0) { "Chapter changed during content snapshot." }
      state.snapshots++
      state to state.generation
    }
    try {
      val result = read()
      synchronized(chapters) {
        check(state.installations == 0 && state.generation == generation) {
          "Chapter changed during content snapshot."
        }
      }
      return result
    } finally {
      synchronized(chapters) {
        state.snapshots--
        if (state.snapshots == 0 && state.installations == 0) chapters.remove(key)
      }
    }
  }

  fun <T> install(rootUri: String, storageDir: String, write: () -> T): T {
    val key = rootUri to storageDir
    val state = synchronized(chapters) {
      chapters.getOrPut(key) { ChapterState() }.apply {
        installations++
        generation++
      }
    }
    try {
      return write()
    } finally {
      synchronized(chapters) {
        state.installations--
        state.generation++
        if (state.snapshots == 0 && state.installations == 0) chapters.remove(key)
      }
    }
  }
}
