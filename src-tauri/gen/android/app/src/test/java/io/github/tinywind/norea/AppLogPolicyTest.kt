package io.github.tinywind.norea

import org.junit.Assert.*
import org.junit.Test

class AppLogPolicyTest {
  @Test(timeout = 2_000)
  fun largePlainCrashTextDoesNotCauseQuadraticUrlScanning() {
    val text = "x".repeat(262_144)
    assertEquals(text, AppLogPolicy.redact(text))
  }

  @Test
  fun jsonHeadersAndBareBearerCredentialsAreRedacted() {
    val text = "{\"Authorization\":\"Bearer json-auth-secret\",\"Cookie\":\"session=json-cookie-secret\"}\n" +
      "request failed with Bearer standalone-bearer-secret"
    val redacted = AppLogPolicy.redact(text)
    listOf("json-auth-secret", "json-cookie-secret", "standalone-bearer-secret").forEach {
      assertFalse("Credential remained: $it", redacted.contains(it))
    }
  }

  @Test
  fun nonHttpPageUrlsDoNotPublishUserInfoQueriesOrFragments() {
    val redacted = AppLogPolicy.redact("tauri://user:tauri-user-secret@localhost/main?session=tauri-query-secret#fragment-secret " +
      "content://documents/tree/root?document=content-query-secret")
    listOf("tauri-user-secret", "tauri-query-secret", "fragment-secret", "content-query-secret").forEach {
      assertFalse("URL credential remained: $it", redacted.contains(it))
    }
    assertTrue(redacted.contains("localhost/main"))
  }

  private val identity = AppLogIdentity("io.test.logs", "0.2.0", "Android", 42, "main")

  @Test
  fun runtimeIncludesMetadataWithoutAllowingForgedRecords() {
    val line = AppLogPolicy.runtime(identity,
      AppRuntimeRecord(AppLogLevel.WARN, "storage", "worker", "read\nFORGED", 0)).toString(Charsets.UTF_8)
    assertTrue(line.startsWith("1970-01-01T00:00:00Z WARN "))
    assertTrue(line.contains("pid=42 process=main thread=worker target=storage read\\nFORGED"))
    assertEquals(1, line.count { it == '\n' })
  }

  @Test
  fun offRejectsEveryRuntimeLevelAndThresholdsKeepErrors() {
    AppLogLevel.entries.forEach { assertFalse(AppLogLevel.OFF.accepts(it)) }
    assertTrue(AppLogLevel.WARN.accepts(AppLogLevel.ERROR))
    assertTrue(AppLogLevel.DEBUG.accepts(AppLogLevel.DEBUG))
    assertFalse(AppLogLevel.INFO.accepts(AppLogLevel.DEBUG))
    assertFalse(AppLogLevel.TRACE.accepts(AppLogLevel.OFF))
  }

  @Test
  fun crashBoundsUtf8AndRemovesPrivateBlocksIncludingUnclosedOnes() {
    val detail = "<key>synthetic-key-secret</key>\n" +
      "-----BEGIN PRIVATE KEY-----\nsynthetic-pem-secret\n-----END PRIVATE KEY-----\n" +
      "\uD83D\uDE00".repeat(400_000)
    val bytes = AppLogPolicy.crash(identity, "java", "failure", detail)
    val text = bytes.toString(Charsets.UTF_8)
    assertTrue(bytes.size <= 1_048_576)
    assertTrue(text.contains("[truncated]"))
    assertFalse(text.contains("synthetic-key-secret"))
    assertFalse(text.contains("synthetic-pem-secret"))
    assertFalse(AppLogPolicy.redact("<key>unfinished-secret").contains("unfinished-secret"))
    assertFalse(text.contains('\uFFFD'))
  }
}
