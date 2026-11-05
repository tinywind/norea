package io.github.tinywind.norea

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidScraperFetchContextsTest {
  private class Document(val origin: String) {
    var busy = false
  }

  private val chapter = "https://toki.example"
  private val mirrorA = "https://booktoki8.example"
  private val mirrorB = "https://booktoki9.example"
  private val mirrorC = "https://mana.example"
  private val mirrorD = "https://cdn.example"

  private fun AndroidScraperFetchContexts<Document>.routeFor(
    origin: String?,
    primaryOrigin: String? = chapter,
    primaryIdle: Boolean = false,
  ): AndroidScraperFetchRoute<Document> = route(origin, primaryOrigin, primaryIdle) { it.busy }

  /** Applies a route the way the bridge does and returns the context that runs the request. */
  private fun AndroidScraperFetchContexts<Document>.dispatch(
    origin: String,
    primaryOrigin: String? = chapter,
  ): Document = when (val route = routeFor(origin, primaryOrigin)) {
    is AndroidScraperFetchRoute.Reuse -> route.context.also(this::touch)
    is AndroidScraperFetchRoute.Open -> {
      route.evicted?.let(this::remove)
      Document(route.origin).also { open(route.origin, it) }
    }
    else -> throw AssertionError("expected a context route for $origin, got $route")
  }

  @Test
  fun interleavedMirrorsRunInTheirOwnContextsWhileAnotherMirrorStalls() {
    val contexts = AndroidScraperFetchContexts<Document>(3)
    val a = contexts.dispatch(mirrorA).apply { busy = true }
    val b = contexts.dispatch(mirrorB).apply { busy = true }
    assertEquals(AndroidScraperFetchRoute.Open<Document>(mirrorC, null), contexts.routeFor(mirrorC))
    val c = contexts.dispatch(mirrorC)

    assertEquals(listOf(mirrorA, mirrorB, mirrorC), listOf(a, b, c).map { it.origin })
    // A stalled mirror only holds requests for its own origin.
    assertEquals(AndroidScraperFetchRoute.Reuse(b), contexts.routeFor(mirrorB))
    assertEquals(AndroidScraperFetchRoute.Reuse(c), contexts.routeFor(mirrorC))
    assertEquals(AndroidScraperFetchRoute.Reuse(a), contexts.routeFor(mirrorA))
  }

  @Test
  fun sameOriginRequestsReuseTheirContext() {
    val contexts = AndroidScraperFetchContexts<Document>(3)
    val first = contexts.dispatch(mirrorA)
    first.busy = true
    repeat(5) { assertSame(first, contexts.dispatch(mirrorA)) }
    first.busy = false
    assertSame(first, contexts.dispatch(mirrorA))
    assertEquals(listOf(first), contexts.all)
  }

  @Test
  fun thePluginContextPageAndThePrimaryDocumentOriginStayOnThePrimaryWebView() {
    val contexts = AndroidScraperFetchContexts<Document>(3)
    assertEquals(AndroidScraperFetchRoute.Primary, contexts.routeFor(null))
    assertEquals(AndroidScraperFetchRoute.Primary, contexts.routeFor(chapter))
    contexts.dispatch(mirrorA)
    assertEquals(AndroidScraperFetchRoute.Primary, contexts.routeFor(mirrorA, primaryOrigin = mirrorA))
    assertEquals(1, contexts.all.size)
  }

  @Test
  fun aPrimaryWithoutADocumentStillLeavesMirrorsToTheirContexts() {
    val contexts = AndroidScraperFetchContexts<Document>(3)
    assertEquals(AndroidScraperFetchRoute.Open<Document>(mirrorA, null), contexts.routeFor(mirrorA, primaryOrigin = null))
  }

  @Test
  fun theLimitEvictsTheLeastRecentlyUsedIdleContext() {
    val contexts = AndroidScraperFetchContexts<Document>(3)
    val a = contexts.dispatch(mirrorA)
    val b = contexts.dispatch(mirrorB)
    val c = contexts.dispatch(mirrorC)
    contexts.dispatch(mirrorA)

    assertEquals(AndroidScraperFetchRoute.Open(mirrorD, b), contexts.routeFor(mirrorD))
    b.busy = true
    assertEquals(AndroidScraperFetchRoute.Open(mirrorD, c), contexts.routeFor(mirrorD))

    val d = contexts.dispatch(mirrorD)
    assertEquals(listOf(b, a, d), contexts.all)
    assertTrue(c !in contexts.all)
  }

  @Test
  fun aLimitOfBusyContextsFallsBackToAnIdlePrimaryOrWaits() {
    val contexts = AndroidScraperFetchContexts<Document>(3)
    listOf(mirrorA, mirrorB, mirrorC).forEach { contexts.dispatch(it).busy = true }

    assertEquals(AndroidScraperFetchRoute.Wait, contexts.routeFor(mirrorD, primaryIdle = false))
    assertEquals(AndroidScraperFetchRoute.Primary, contexts.routeFor(mirrorD, primaryIdle = true))
    assertEquals(3, contexts.all.size)
  }

  @Test
  fun clearingReturnsAndForgetsEveryContext() {
    val contexts = AndroidScraperFetchContexts<Document>(3)
    val opened = listOf(mirrorA, mirrorB, mirrorC).map { contexts.dispatch(it) }
    opened[1].busy = true

    assertEquals(opened, contexts.clear())
    assertTrue(contexts.all.isEmpty())
    assertEquals(AndroidScraperFetchRoute.Open<Document>(mirrorB, null), contexts.routeFor(mirrorB))
  }
}
