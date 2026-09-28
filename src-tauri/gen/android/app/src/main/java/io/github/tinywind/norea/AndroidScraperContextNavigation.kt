package io.github.tinywind.norea

internal sealed interface AndroidScraperContextAction {
  data object Wait : AndroidScraperContextAction
  data class Navigate(val url: String) : AndroidScraperContextAction
  data class Ready(val fetchUrl: String?) : AndroidScraperContextAction
}

internal class AndroidScraperContextNavigation(
  private val contextUrl: String,
  private val requestUrl: String?,
) {
  private var navigationStarted = false
  private var fallbackAttempted = false
  var finished = false
    private set

  fun onStarted() {
    navigationStarted = true
  }

  fun cancel() {
    finished = true
  }

  fun onDocumentReady(
    documentUrl: String,
    sameOriginAsContext: Boolean,
    httpDocument: Boolean,
  ): AndroidScraperContextAction {
    if (finished || !navigationStarted) return AndroidScraperContextAction.Wait
    if (sameOriginAsContext) {
      finished = true
      return AndroidScraperContextAction.Ready(null)
    }
    if (!httpDocument) return AndroidScraperContextAction.Wait

    val fallbackUrl = requestUrl?.takeIf { it != contextUrl }
    if (!fallbackAttempted && fallbackUrl != null) {
      fallbackAttempted = true
      // The old document may still emit onPageFinished after loadUrl is requested.
      // It must not start a fetch that the upcoming navigation will discard.
      navigationStarted = false
      return AndroidScraperContextAction.Navigate(fallbackUrl)
    }
    if (fallbackAttempted || requestUrl == contextUrl) {
      finished = true
      return AndroidScraperContextAction.Ready(documentUrl)
    }
    return AndroidScraperContextAction.Wait
  }
}
