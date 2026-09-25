package io.github.tinywind.norea

import android.content.Context
import android.view.View
import android.webkit.WebView

// Android WebView reports a page as hidden while its window is not visible, and
// Blink freezes hidden pages about a minute later, stopping every queued task.
// While background work runs, WebViews report a visible window so work continues.
internal fun backgroundWorkWindowVisibility(
  backgroundWorkActive: Boolean,
  windowVisibility: Int,
): Int = if (backgroundWorkActive) View.VISIBLE else windowVisibility

internal fun syncBackgroundWorkWindowVisibility(webView: WebView, backgroundWorkActive: Boolean) {
  webView.dispatchWindowVisibilityChanged(
    backgroundWorkWindowVisibility(backgroundWorkActive, webView.windowVisibility),
  )
}

internal class WindowVisibilityProbe(
  context: Context,
  private val onWindowHidden: () -> Unit,
) : View(context) {
  init {
    visibility = GONE
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  override fun onWindowVisibilityChanged(visibility: Int) {
    super.onWindowVisibilityChanged(visibility)
    // Posting lets sibling WebViews receive the hidden window state first.
    if (visibility != VISIBLE) post { onWindowHidden() }
  }
}
