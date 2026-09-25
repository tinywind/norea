package io.github.tinywind.norea

import android.view.View
import org.junit.Assert.assertEquals
import org.junit.Test

class AndroidBackgroundWorkWebViewsTest {
  @Test
  fun reportsVisibleWindowWhileBackgroundWorkRuns() {
    assertEquals(View.VISIBLE, backgroundWorkWindowVisibility(true, View.GONE))
    assertEquals(View.VISIBLE, backgroundWorkWindowVisibility(true, View.INVISIBLE))
    assertEquals(View.VISIBLE, backgroundWorkWindowVisibility(true, View.VISIBLE))
  }

  @Test
  fun restoresActualWindowVisibilityWhenBackgroundWorkStops() {
    assertEquals(View.GONE, backgroundWorkWindowVisibility(false, View.GONE))
    assertEquals(View.INVISIBLE, backgroundWorkWindowVisibility(false, View.INVISIBLE))
    assertEquals(View.VISIBLE, backgroundWorkWindowVisibility(false, View.VISIBLE))
  }
}
