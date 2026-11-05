package io.github.tinywind.norea

/**
 * Fetch context documents one executor keeps besides its primary WebView. With
 * the primary document this covers a chapter page plus three media mirrors, and
 * it matches the four-request chapter media window.
 */
internal const val ANDROID_SCRAPER_FETCH_CONTEXT_LIMIT = 3

internal sealed interface AndroidScraperFetchRoute<out T> {
  /** The executor's primary WebView runs the request. */
  data object Primary : AndroidScraperFetchRoute<Nothing>

  /** Every document is busy with another origin; route again when one settles. */
  data object Wait : AndroidScraperFetchRoute<Nothing>

  sealed interface Context<out T> : AndroidScraperFetchRoute<T>

  /** The context document that already holds the request origin runs it. */
  data class Reuse<T>(val context: T) : Context<T>

  /** A new context document for [origin] runs it, after [evicted] closes to stay within the limit. */
  data class Open<T>(val origin: String, val evicted: T?) : Context<T>
}

/**
 * Per-origin fetch context documents of one scraper executor, least recently
 * used first.
 *
 * Requests that load the plugin's own context page, and requests for the origin
 * of the primary document, keep using the primary WebView. A request that only
 * needs an empty document on another origin, such as chapter media spread over
 * mirrors, runs in that origin's own context document instead of waiting until
 * the primary document drains and switches origins.
 */
internal class AndroidScraperFetchContexts<T : Any>(private val limit: Int) {
  private val contexts = LinkedHashMap<String, T>()

  val all: List<T>
    get() = contexts.values.toList()

  /**
   * @param origin origin of the empty context document the request needs, or
   *   null when it runs against the plugin's own context page.
   * @param primaryOrigin origin the primary document holds or is switching to.
   * @param primaryIdle whether the primary WebView could start the request now.
   */
  fun route(
    origin: String?,
    primaryOrigin: String?,
    primaryIdle: Boolean,
    busy: (T) -> Boolean,
  ): AndroidScraperFetchRoute<T> {
    if (origin == null || origin == primaryOrigin) return AndroidScraperFetchRoute.Primary
    contexts[origin]?.let { return AndroidScraperFetchRoute.Reuse(it) }
    if (contexts.size < limit) return AndroidScraperFetchRoute.Open(origin, null)
    contexts.values.firstOrNull { !busy(it) }?.let { return AndroidScraperFetchRoute.Open(origin, it) }
    return if (primaryIdle) AndroidScraperFetchRoute.Primary else AndroidScraperFetchRoute.Wait
  }

  fun open(origin: String, context: T) {
    contexts[origin] = context
  }

  fun touch(context: T) {
    val origin = contexts.entries.firstOrNull { it.value === context }?.key ?: return
    contexts.remove(origin)
    contexts[origin] = context
  }

  fun remove(context: T): Boolean = contexts.values.remove(context)

  fun clear(): List<T> = all.also { contexts.clear() }
}
