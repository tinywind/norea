package io.github.tinywind.norea

import android.content.Context
import androidx.annotation.Keep
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.HttpsURLConnection

@Keep
object RustlsPlatformVerifierBridge {
  init {
    System.loadLibrary("app_lib")
  }

  @JvmStatic
  external fun init(context: Context)

  @Keep
  @JvmStatic
  fun httpsGet(
    url: String,
    connectTimeoutMs: Int,
    requestTimeoutMs: Int,
    maxBytes: Int,
  ): ByteArray {
    require(connectTimeoutMs > 0) { "HTTPS connect timeout must be positive." }
    require(requestTimeoutMs > 0) { "HTTPS request timeout must be positive." }
    require(maxBytes > 0) { "HTTPS response limit must be positive." }

    val connection = URL(url).openConnection() as? HttpsURLConnection
      ?: throw IOException("VPN Gate server list URL must use HTTPS.")
    val timedOut = AtomicBoolean(false)
    val timeoutExecutor = Executors.newSingleThreadScheduledExecutor()
    val timeoutTask = timeoutExecutor.schedule({
      timedOut.set(true)
      connection.disconnect()
    }, requestTimeoutMs.toLong(), TimeUnit.MILLISECONDS)
    return try {
      connection.requestMethod = "GET"
      connection.instanceFollowRedirects = false
      connection.connectTimeout = connectTimeoutMs
      connection.readTimeout = requestTimeoutMs
      connection.useCaches = false
      connection.setRequestProperty("User-Agent", "Norea")

      val status = connection.responseCode
      if (status !in 200..299) {
        throw IOException("VPN Gate server list returned HTTP $status.")
      }
      val contentLength = connection.contentLengthLong
      if (contentLength > maxBytes.toLong()) {
        throw IOException("VPN Gate server list exceeds the $maxBytes-byte limit.")
      }

      val initialCapacity = if (contentLength in 1..maxBytes.toLong()) {
        contentLength.toInt()
      } else {
        minOf(8192, maxBytes)
      }
      val output = ByteArrayOutputStream(initialCapacity)
      connection.inputStream.use { input ->
        val buffer = ByteArray(8192)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          if (read > maxBytes - output.size()) {
            throw IOException("VPN Gate server list exceeds the $maxBytes-byte limit.")
          }
          output.write(buffer, 0, read)
        }
      }
      if (timedOut.get()) {
        throw SocketTimeoutException("VPN Gate server list request timed out.")
      }
      output.toByteArray()
    } catch (error: IOException) {
      if (timedOut.get() && error !is SocketTimeoutException) {
        throw SocketTimeoutException("VPN Gate server list request timed out.").apply {
          initCause(error)
        }
      }
      throw error
    } finally {
      timeoutTask.cancel(false)
      timeoutExecutor.shutdownNow()
      connection.disconnect()
    }
  }
}
