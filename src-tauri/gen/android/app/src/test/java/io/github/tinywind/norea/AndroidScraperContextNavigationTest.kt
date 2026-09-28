package io.github.tinywind.norea

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidScraperContextNavigationTest {
  private val context = "https://old.example/"
  private val request = "https://old.example/novel?page=2&sort=hot"
  private val finalRequest = "https://new.example/novel?page=2&sort=hot"

  @Test
  fun waitsUntilTheInitialNavigationStarts() {
    val navigation = AndroidScraperContextNavigation(context, request)
    assertEquals(AndroidScraperContextAction.Wait, navigation.onDocumentReady(context, true, true))
    assertFalse(navigation.finished)
  }

  @Test
  fun preservesTheOriginalRequestWhenTheContextStaysOnItsOrigin() {
    val navigation = AndroidScraperContextNavigation(context, request)
    navigation.onStarted()
    assertEquals(AndroidScraperContextAction.Ready(null), navigation.onDocumentReady(context, true, true))
    assertTrue(navigation.finished)
  }

  @Test
  fun acceptsTheRedirectWhenTheContextIsAlreadyTheRequestedPage() {
    val navigation = AndroidScraperContextNavigation(context, context)
    navigation.onStarted()
    assertEquals(
      AndroidScraperContextAction.Ready("https://new.example/"),
      navigation.onDocumentReady("https://new.example/", false, true),
    )
    assertTrue(navigation.finished)
  }

  @Test
  fun ignoresTheOldPageFinishUntilTheFallbackNavigationStarts() {
    val navigation = AndroidScraperContextNavigation(context, request)
    navigation.onStarted()
    assertEquals(
      AndroidScraperContextAction.Navigate(request),
      navigation.onDocumentReady("https://new.example/", false, true),
    )
    // DOMContentLoaded triggered the fallback; this is the OLD onPageFinished.
    assertEquals(
      AndroidScraperContextAction.Wait,
      navigation.onDocumentReady("https://new.example/", false, true),
    )
    assertFalse(navigation.finished)
    navigation.onStarted()
    assertEquals(
      AndroidScraperContextAction.Ready(finalRequest),
      navigation.onDocumentReady(finalRequest, false, true),
    )
    assertTrue(navigation.finished)
  }

  @Test
  fun ignoresEvenASameOriginFinishWhileTheFallbackIsPending() {
    val navigation = AndroidScraperContextNavigation(context, request)
    navigation.onStarted()
    navigation.onDocumentReady("https://new.example/", false, true)
    assertEquals(AndroidScraperContextAction.Wait, navigation.onDocumentReady(context, true, true))
  }

  @Test
  fun acceptsAFallbackReturningToTheOriginalOrigin() {
    val navigation = AndroidScraperContextNavigation(context, request)
    navigation.onStarted()
    navigation.onDocumentReady("https://new.example/", false, true)
    navigation.onStarted()
    assertEquals(AndroidScraperContextAction.Ready(null), navigation.onDocumentReady(request, true, true))
  }

  @Test
  fun doesNotStartAnotherFetchForDuplicateCompletionEvents() {
    val navigation = AndroidScraperContextNavigation(context, context)
    navigation.onStarted()
    navigation.onDocumentReady("https://new.example/", false, true)
    navigation.onStarted()
    assertEquals(
      AndroidScraperContextAction.Wait,
      navigation.onDocumentReady("https://new.example/", false, true),
    )
  }

  @Test
  fun doesNotAcceptAnErrorDocumentAsARedirectedSource() {
    val navigation = AndroidScraperContextNavigation(context, context)
    navigation.onStarted()
    assertEquals(
      AndroidScraperContextAction.Wait,
      navigation.onDocumentReady("chrome-error://chromewebdata/", false, false),
    )
    assertFalse(navigation.finished)
  }

  @Test
  fun cancellationRejectsLateDocumentEvents() {
    val navigation = AndroidScraperContextNavigation(context, request)
    navigation.onStarted()
    navigation.cancel()
    assertEquals(AndroidScraperContextAction.Wait, navigation.onDocumentReady(context, true, true))
    assertTrue(navigation.finished)
  }
}
