package io.github.tinywind.norea

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidVpnWorkerPolicyTest {
  private fun configuration(generation: Long = 1, source: String = "source", profile: String = "profile") =
    AndroidVpnWorkerConfiguration(0, generation, source, profile, 18080, "a".repeat(64))

  @Test
  fun everyWorkerSlotUsesTheSharedMainProcessForItsPrivateServiceAndManualActivity() {
    val root = generateSequence(File(".").canonicalFile) { it.parentFile }
      .first { File(it, "src-tauri/gen/android/app/src/main/AndroidManifest.xml").isFile }
    val document = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder()
      .parse(File(root, "src-tauri/gen/android/app/src/main/AndroidManifest.xml"))
    val android = "http://schemas.android.com/apk/res/android"
    val processes = mutableSetOf<String>()
    for (slot in 0..9) {
      for (kind in listOf("service", "activity")) {
        val name = ".AndroidVpnDownloadWorker$slot" + if (kind == "service") "Service" else "Activity"
        val nodes = document.getElementsByTagName(kind)
        val element = (0 until nodes.length).map { nodes.item(it) as org.w3c.dom.Element }
          .single { it.getAttributeNS(android, "name") == name }
        assertEquals("false", element.getAttributeNS(android, "exported"))
        assertEquals("", element.getAttributeNS(android, "process"))
        val component = if (kind == "service") androidVpnDownloadWorkerServiceClass(slot) else androidVpnDownloadWorkerActivityClass(slot)
        assertEquals("io.github.tinywind.norea$name", component.name)
        processes.add(element.getAttributeNS(android, "process"))
      }
    }
    assertEquals(setOf(""), processes)
  }

  @Test
  fun acceptsTenCanonicalWorkerSlotsAndSafePositiveGenerations() {
    assertEquals(AndroidVpnWorkerQueue(0, 1), parseAndroidVpnWorkerQueue("vpn:0:1"))
    assertEquals(AndroidVpnWorkerQueue(1, 9_007_199_254_740_991), parseAndroidVpnWorkerQueue("vpn:1:9007199254740991"))
    assertEquals(AndroidVpnWorkerQueue(2, 1), parseAndroidVpnWorkerQueue("vpn:2:1"))
    assertEquals(AndroidVpnWorkerQueue(9, 5), parseAndroidVpnWorkerQueue("vpn:9:5"))
    for (queue in listOf("pool:0", "vpn:10:1", "vpn:-1:1", "vpn:0:0", "vpn:0:01", "vpn:0:1.0", "vpn:0:9007199254740992", " vpn:0:1", "vpn:0:1\n")) {
      assertThrows(queue, IllegalArgumentException::class.java) { parseAndroidVpnWorkerQueue(queue) }
    }
  }

  @Test
  fun validatesConfigurationWithoutCoercingStringsFloatsOrIdentityWhitespace() {
    assertEquals(configuration(), androidVpnWorkerConfiguration(0, 1L, "source", "profile", 18080, "a".repeat(64)))
    assertEquals(" profile ", androidVpnWorkerConfiguration(0, 1L, " source ", " profile ", 1, "a".repeat(64)).profileId)
    assertEquals(9, androidVpnWorkerConfiguration(9, 1L, "source", "profile", 1, "a".repeat(64)).slot)
    for (slot in listOf<Any?>(10, -1, "0", 0.0, null)) {
      assertThrows(IllegalArgumentException::class.java) { androidVpnWorkerConfiguration(slot, 1L, "source", "profile", 1, "a".repeat(64)) }
    }
    for (generation in listOf<Any?>(0, -1, "1", 1.0, 9_007_199_254_740_992L)) {
      assertThrows(IllegalArgumentException::class.java) { androidVpnWorkerConfiguration(0, generation, "source", "profile", 1, "a".repeat(64)) }
    }
    for (identity in listOf("", " ", "a".repeat(513), "\u00e9".repeat(257))) {
      assertThrows(IllegalArgumentException::class.java) { androidVpnWorkerConfiguration(0, 1, identity, "profile", 1, "a".repeat(64)) }
      assertThrows(IllegalArgumentException::class.java) { androidVpnWorkerConfiguration(0, 1, "source", identity, 1, "a".repeat(64)) }
    }
    for (port in listOf<Any?>(0, 65536, "80", 80.0, null)) {
      assertThrows(IllegalArgumentException::class.java) { androidVpnWorkerConfiguration(0, 1, "source", "profile", port, "a".repeat(64)) }
    }
  }

  @Test
  fun legacyProfileKeysRemainStableForTheOneTimeSharedProfileAdoption() {
    assertEquals("norea-source-41cf6794ba4200b839c53531555f0f3998df4cbb01a4d5cb0b94e3ca5e23947d", androidScraperProfileName("source"))
    assertNotEquals(androidScraperProfileName("source"), androidScraperProfileName("source", "profile"))
    assertNotEquals(androidScraperProfileName("source", "profile"), androidScraperProfileName("source", "profile "))
    assertNotEquals(androidScraperProfileName("source", "profile"), androidScraperProfileName("other", "profile"))
    assertNotEquals(androidScraperProfileName("c", "a:b"), androidScraperProfileName("b:c", "a"))
    assertEquals(androidScraperProfileName("source", "profile"), androidScraperProfileName("source", "profile"))
  }

  @Test
  fun rejectsRequestsUntilConfiguredAndAfterCloseOrDeathWithoutReconnection() {
    val lease = AndroidVpnWorkerLease(0)
    val queue = AndroidVpnWorkerQueue(0, 1)
    assertThrows(IllegalStateException::class.java) { lease.requireRequest(queue, "source") }
    lease.beginConfigure(configuration())
    assertThrows(IllegalStateException::class.java) { lease.requireRequest(queue, "source") }
    lease.markReady(1)
    lease.requireRequest(queue, "source")
    assertThrows(IllegalArgumentException::class.java) { lease.requireRequest(AndroidVpnWorkerQueue(1, 1), "source") }
    assertThrows(IllegalArgumentException::class.java) { lease.requireRequest(queue, "other") }
    lease.close()
    assertThrows(IllegalStateException::class.java) { lease.requireRequest(queue, "source") }
    assertThrows(IllegalArgumentException::class.java) { lease.beginConfigure(configuration()) }
    lease.beginConfigure(configuration(2))
    lease.markReady(2)
    lease.died()
    assertThrows(IllegalStateException::class.java) { lease.requireRequest(AndroidVpnWorkerQueue(0, 2), "source") }
    lease.beginConfigure(configuration(3))
    lease.markReady(3)
    lease.requireRequest(AndroidVpnWorkerQueue(0, 3), "source")
    assertThrows(IllegalArgumentException::class.java) { lease.requireRequest(queue, "source") }
  }

  @Test
  fun manualOwnershipPreventsIpReplacementAndStaleActivityAttachmentOrDetach() {
    val lease = AndroidVpnWorkerLease(0)
    lease.beginConfigure(configuration())
    lease.markReady(1)
    lease.reserveManual(AndroidVpnWorkerQueue(0, 1), "source", "ticket")
    assertThrows(IllegalStateException::class.java) { lease.beginConfigure(configuration(2)) }
    val oldActivity = Any()
    assertFalse(lease.attachManual(1, "wrong", oldActivity))
    assertTrue(lease.attachManual(1, "ticket", oldActivity))
    assertFalse(lease.detachManual(1, Any()))
    assertTrue(lease.detachManual(1, oldActivity))
    lease.beginConfigure(configuration(2))
    lease.markReady(2)
    lease.reserveManual(AndroidVpnWorkerQueue(0, 2), "source", "next")
    val newActivity = Any()
    assertFalse(lease.attachManual(1, "ticket", oldActivity))
    assertTrue(lease.attachManual(2, "next", newActivity))
    assertFalse(lease.detachManual(1, oldActivity))
    assertTrue(lease.manualOpen)
    lease.close()
    assertFalse(lease.attachManual(2, "next", newActivity))
  }

  @Test
  fun configuringWorkersCanBeClosedWithoutAllowingSourceWorkOrLateReadiness() {
    val lease = AndroidVpnWorkerLease(0)
    lease.beginConfigure(configuration())
    assertEquals(configuration(), lease.requireConfiguration(AndroidVpnWorkerQueue(0, 1), "source"))
    assertThrows(IllegalStateException::class.java) { lease.requireRequest(AndroidVpnWorkerQueue(0, 1), "source") }
    lease.close()
    assertThrows(IllegalStateException::class.java) { lease.markReady(1) }
    assertThrows(IllegalStateException::class.java) { lease.requireConfiguration(AndroidVpnWorkerQueue(0, 1), "source") }
    lease.beginConfigure(configuration(2))
    assertThrows(IllegalArgumentException::class.java) { lease.requireConfiguration(AndroidVpnWorkerQueue(0, 1), "source") }
  }

  @Test
  fun abandonedManualReservationsCannotUnlockANewerActivity() {
    val lease = AndroidVpnWorkerLease(0)
    lease.beginConfigure(configuration())
    lease.markReady(1)
    lease.reserveManual(AndroidVpnWorkerQueue(0, 1), "source", "old")
    assertTrue(lease.cancelManualReservation(1, "old"))
    lease.reserveManual(AndroidVpnWorkerQueue(0, 1), "source", "new")
    assertFalse(lease.cancelManualReservation(1, "old"))
    assertTrue(lease.attachManual(1, "new", Any()))
    assertFalse(lease.cancelManualReservation(1, "new"))
  }

  @Test
  fun commandWhitelistDoesNotExposeCacheBoundsOrArbitraryJavaMethods() {
    assertEquals("scraper.fetch", androidVpnWorkerCapability("fetch"))
    assertEquals("scraper.cancel", androidVpnWorkerCapability("cancelBackground"))
    for (method in listOf("destroy", "getClass", "clearCache", "setBounds", "hide", "request")) {
      assertThrows(IllegalArgumentException::class.java) { androidVpnWorkerCapability(method) }
    }
  }

  @Test
  fun boundedPayloadCopyRejectsOversizedStreamsWithoutWritingExcessBytes() {
    val output = ByteArrayOutputStream()
    assertEquals(3L, copyAndroidVpnWorkerPayload(ByteArrayInputStream(byteArrayOf(1, 2, 3)), output, 3))
    assertEquals(listOf<Byte>(1, 2, 3), output.toByteArray().toList())
    val excess = ByteArrayOutputStream()
    assertThrows(IllegalArgumentException::class.java) {
      copyAndroidVpnWorkerPayload(ByteArrayInputStream(ByteArray(4)), excess, 3)
    }
    assertTrue(excess.size() <= 3)
  }

  @Test
  fun backgroundDownloadsRequireTheExistingExecutionAnchorEvenWithAManualBrowserOpen() {
    assertFalse(androidVpnWorkerMayExecute("extract", executionActive = false, manualOpen = false))
    assertFalse(androidVpnWorkerMayExecute("fetch", executionActive = false, manualOpen = true))
    assertTrue(androidVpnWorkerMayExecute("extract", executionActive = true, manualOpen = false))
    assertTrue(androidVpnWorkerMayExecute("navigate", executionActive = false, manualOpen = true))
    assertFalse(androidVpnWorkerMayExecute("navigate", executionActive = false, manualOpen = false))
    assertTrue(androidVpnWorkerMayExecute("cancelBackground", executionActive = false, manualOpen = false))
  }

  @Test
  fun payloadTransferCanCarryMoreThanABinderTransaction() {
    val bytes = ByteArray(2 * 1024 * 1024) { (it % 251).toByte() }
    val output = ByteArrayOutputStream()
    assertEquals(bytes.size.toLong(), copyAndroidVpnWorkerPayload(ByteArrayInputStream(bytes), output, bytes.size.toLong()))
    assertTrue(bytes.contentEquals(output.toByteArray()))
  }

  @Test
  fun hiddenManualActivitiesDoNotAuthorizeSourceTrafficWithoutTheExecutionAnchor() {
    assertFalse(androidVpnWorkerMayExecute("navigate", executionActive = false, manualOpen = true, manualVisible = false))
    assertFalse(androidVpnWorkerMayExecute("clearCookies", executionActive = false, manualOpen = true, manualVisible = false))
    assertTrue(androidVpnWorkerMayExecute("navigate", executionActive = false, manualOpen = true, manualVisible = true))
    assertTrue(androidVpnWorkerMayExecute("currentUrl", executionActive = false, manualOpen = true, manualVisible = false))
  }

  @Test
  fun unloadedDummyHostsUseTheTrustedMainAppOriginForExistingScriptGuards() {
    assertEquals("https://tauri.localhost", androidVpnWorkerAppOrigin("https://tauri.localhost/tasks?x=1#top"))
    assertEquals("http://localhost:1420", androidVpnWorkerAppOrigin("http://localhost:1420/tasks"))
    for (url in listOf(null, "", "about:blank", "file:///data/app", "https://user:secret@host.test/", "not a URL")) {
      assertThrows(IllegalArgumentException::class.java) { androidVpnWorkerAppOrigin(url) }
    }
  }

  @Test
  fun delayedManualOpenRepliesCannotRelockAClosedOrReconfiguredWorker() {
    val state = AndroidVpnWorkerManualState(1)
    state.expectOpen()
    assertTrue(state.open)
    assertTrue(state.apply(1, 2, false))
    assertFalse(state.apply(1, 1, true))
    assertFalse(state.open)
    state.beginGeneration(2)
    state.expectOpen()
    assertFalse(state.apply(1, 10, false))
    assertTrue(state.open)
    assertTrue(state.apply(2, 0, false))
    assertFalse(state.open)
  }

  @Test
  fun browserHiddenEventIdentifiesTheExactWorkerAndSourceWithoutProfileData() {
    assertEquals(
      mapOf("queue" to "vpn:1:42", "sourceId" to " source "),
      androidVpnWorkerBrowserHiddenDetail(AndroidVpnWorkerConfiguration(1, 42, " source ", "private-profile-id", 18081, "a".repeat(64))),
    )
  }

  @Test
  fun cancellationAndCloseCanReachAWorkerWhoseProxyIsStillConfiguring() {
    assertFalse(androidVpnWorkerRequiresReady("cancel"))
    assertFalse(androidVpnWorkerRequiresReady("cancelBackground"))
    assertFalse(androidVpnWorkerRequiresReady("closeWorker"))
    assertTrue(androidVpnWorkerRequiresReady("fetch"))
    assertTrue(androidVpnWorkerRequiresReady("extract"))
    assertTrue(androidVpnWorkerRequiresReady("showWorker"))
  }

  @Test
  fun closingAnAbsentOrOlderWorkerAcknowledgesSettlementWithoutClosingItsReplacement() {
    assertTrue(androidVpnWorkerCloseAlreadySettled(7, null))
    assertTrue(androidVpnWorkerCloseAlreadySettled(7, 8))
    assertFalse(androidVpnWorkerCloseAlreadySettled(8, 8))
    assertFalse(androidVpnWorkerCloseAlreadySettled(9, 8))
  }

  @Test
  fun capabilityResultRequiresApi28AndBothWebViewFeatures() {
    val unsupported = mapOf("supported" to false, "parallelSupported" to false, "maxWorkers" to 0)
    val supported = mapOf("supported" to true, "parallelSupported" to false, "maxWorkers" to 1)
    assertEquals(unsupported, androidVpnWorkerCapabilities(27, true, true))
    assertEquals(unsupported, androidVpnWorkerCapabilities(28, false, true))
    assertEquals(unsupported, androidVpnWorkerCapabilities(28, true, false))
    assertEquals(unsupported, androidVpnWorkerCapabilities(36, false, false))
    assertEquals(supported, androidVpnWorkerCapabilities(28, true, true))
    assertEquals(supported, androidVpnWorkerCapabilities(36, true, true))
  }

  @Test
  fun firstForegroundSourceRequestWaitsForPublishedAnchorWithoutExecutingEarly() {
    val bootstrap = AndroidVpnWorkerExecutionBootstrap()
    assertEquals(AndroidVpnWorkerBootstrapDecision.WAIT, bootstrap.decision(0, false, true, false, false))
    assertEquals(AndroidVpnWorkerBootstrapDecision.WAIT, bootstrap.decision(250, false, true, false, false))
    assertEquals(AndroidVpnWorkerBootstrapDecision.READY, bootstrap.decision(275, true, true, false, false))
    assertEquals(AndroidVpnWorkerBootstrapDecision.REJECT, bootstrap.decision(300, false, true, false, false))
  }

  @Test
  fun bootstrapNeverAuthorizesHiddenSuspendedManualOrExplicitlyStoppedWork() {
    assertEquals(AndroidVpnWorkerBootstrapDecision.REJECT, AndroidVpnWorkerExecutionBootstrap().decision(0, false, false, false, false))
    assertEquals(AndroidVpnWorkerBootstrapDecision.REJECT, AndroidVpnWorkerExecutionBootstrap().decision(0, true, true, true, false))
    assertEquals(AndroidVpnWorkerBootstrapDecision.REJECT, AndroidVpnWorkerExecutionBootstrap().decision(0, false, true, false, true))
    val bootstrap = AndroidVpnWorkerExecutionBootstrap()
    assertEquals(AndroidVpnWorkerBootstrapDecision.WAIT, bootstrap.decision(0, false, true, false, false))
    bootstrap.revoke()
    assertEquals(AndroidVpnWorkerBootstrapDecision.REJECT, bootstrap.decision(250, false, true, false, false))
    assertEquals(AndroidVpnWorkerBootstrapDecision.READY, bootstrap.decision(500, true, false, false, false))
  }

  @Test
  fun bootstrapWaitIsBoundedAndDoesNotRestartItsGracePeriod() {
    val bootstrap = AndroidVpnWorkerExecutionBootstrap()
    assertEquals(AndroidVpnWorkerBootstrapDecision.WAIT, bootstrap.decision(100, false, true, false, false))
    assertEquals(AndroidVpnWorkerBootstrapDecision.WAIT, bootstrap.decision(2_099, false, true, false, false))
    assertEquals(AndroidVpnWorkerBootstrapDecision.REJECT, bootstrap.decision(2_100, false, true, false, false))
    assertEquals(AndroidVpnWorkerBootstrapDecision.REJECT, bootstrap.decision(5_000, false, true, false, false))
  }
}
