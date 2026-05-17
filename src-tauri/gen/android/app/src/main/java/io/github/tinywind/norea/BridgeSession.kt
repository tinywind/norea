package io.github.tinywind.norea

import java.security.SecureRandom

data class BridgeAuthorityFields(
  val token: String? = null,
  val capability: String? = null,
  val nonce: String? = null,
) {
  fun isEmpty(): Boolean =
    token.isNullOrBlank() && capability.isNullOrBlank() && nonce.isNullOrBlank()
}

data class BridgeAuthority(
  val capability: String,
  val legacy: Boolean,
  val nonce: String?,
)

object BridgeCapabilities {
  const val SCRAPER_CANCEL = "scraper.cancel"
  const val SCRAPER_FETCH = "scraper.fetch"
  const val SCRAPER_EXTRACT = "scraper.extract"
  const val SCRAPER_NAVIGATE = "scraper.navigate"
  const val SCRAPER_BOUNDS = "scraper.bounds"
  const val UPDATE_OPEN_APK = "update.openApk"

  val ALL = listOf(
    SCRAPER_CANCEL,
    SCRAPER_FETCH,
    SCRAPER_EXTRACT,
    SCRAPER_NAVIGATE,
    SCRAPER_BOUNDS,
    UPDATE_OPEN_APK,
  )
}

class BridgeSession(
  private val random: SecureRandom = SecureRandom(),
  private val nonceCapacity: Int = DEFAULT_NONCE_CAPACITY,
) {
  val sessionToken: String = randomToken(TOKEN_BYTES)
  private val seenNonces = LinkedHashMap<String, Unit>(nonceCapacity, 0.75f, true)

  fun newNonce(): String = randomToken(NONCE_BYTES)

  @Synchronized
  fun validate(
    requiredCapability: String,
    fields: BridgeAuthorityFields,
  ): BridgeAuthority {
    if (fields.isEmpty()) {
      return BridgeAuthority(
        capability = requiredCapability,
        legacy = true,
        nonce = null,
      )
    }

    val token = fields.token?.trim().orEmpty()
    val capability = fields.capability?.trim().orEmpty()
    val nonce = fields.nonce?.trim().orEmpty()

    require(token == sessionToken) { "Android bridge session is invalid." }
    require(capability == requiredCapability) {
      "Android bridge capability is invalid."
    }
    require(isNonceShapeValid(nonce)) { "Android bridge nonce is invalid." }

    require(!seenNonces.containsKey(nonce)) {
      "Android bridge nonce has already been used."
    }
    seenNonces[nonce] = Unit
    trimSeenNonces()

    return BridgeAuthority(
      capability = requiredCapability,
      legacy = false,
      nonce = nonce,
    )
  }

  private fun trimSeenNonces() {
    while (seenNonces.size > nonceCapacity) {
      val firstKey = seenNonces.keys.firstOrNull() ?: return
      seenNonces.remove(firstKey)
    }
  }

  private fun randomToken(byteLength: Int): String {
    val bytes = ByteArray(byteLength)
    random.nextBytes(bytes)
    return bytes.joinToString(separator = "") { byte ->
      "%02x".format(byte.toInt() and 0xff)
    }
  }

  companion object {
    private const val DEFAULT_NONCE_CAPACITY = 1024
    private const val TOKEN_BYTES = 32
    private const val NONCE_BYTES = 16
    private val NONCE_PATTERN = Regex("^[A-Za-z0-9._:-]{8,128}$")

    private fun isNonceShapeValid(value: String): Boolean = NONCE_PATTERN.matches(value)
  }
}
