package io.github.tinywind.norea

import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.ParcelFileDescriptor
import android.system.Os
import android.system.OsConstants
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.Executors

internal const val VPN_WORKER_REQUEST = 1
internal const val VPN_WORKER_RESPONSE = 2
internal const val VPN_WORKER_EXECUTION = 3
internal const val VPN_WORKER_MANUAL_CLOSED = 4
internal const val VPN_WORKER_TRANSFER_FAILED = 5
internal const val VPN_WORKER_REQUEST_LIMIT = 16L * 1024L * 1024L
internal const val VPN_WORKER_RESPONSE_LIMIT = ANDROID_CHAPTER_MEDIA_MAX_ENTRY_BYTES
internal const val VPN_WORKER_MAX_PENDING = 32

internal class AndroidVpnWorkerTransport(context: Context) {
  private val directory = File(context.cacheDir, "vpn-worker-ipc")
  private val handler = Handler(Looper.getMainLooper())
  private val writer = Executors.newSingleThreadExecutor()
  private val reader = Executors.newSingleThreadExecutor()
  private val descriptors = mutableSetOf<ParcelFileDescriptor>()
  @Volatile private var closed = false

  fun send(
    destination: Messenger,
    what: Int,
    ticket: Long,
    payload: String,
    limit: Long,
    replyTo: Messenger? = null,
    onError: (Throwable) -> Unit,
  ) {
    runCatching {
      check(!closed) { "VPN worker transport is closed." }
      writer.execute {
        runCatching {
          check(!closed) { "VPN worker transport is closed." }
          require(payload.length.toLong() <= limit) { "VPN worker payload exceeds its byte limit." }
          val bytes = payload.toByteArray(Charsets.UTF_8)
          require(bytes.size.toLong() <= limit) { "VPN worker payload exceeds its byte limit." }
          check(directory.isDirectory || directory.mkdirs()) { "VPN worker transfer directory is unavailable." }
          val file = File.createTempFile("payload-", ".json", directory)
          try {
            file.outputStream().use { it.write(bytes) }
            val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
            var transferredLocally = false
            try {
              // Only an already-open descriptor crosses Binder; no caller-controlled path is accepted.
              check(file.delete()) { "VPN worker transfer could not be unlinked." }
              synchronized(descriptors) {
                check(!closed) { "VPN worker transport is closed." }
                descriptors.add(descriptor)
              }
              val message = Message.obtain(null, what).apply {
                this.replyTo = replyTo
                data = Bundle().apply {
                  putLong("ticket", ticket)
                  putParcelable("payload", descriptor)
                }
              }
              val local = destination.binder.interfaceDescriptor
                ?.let { destination.binder.queryLocalInterface(it) != null } ?: false
              synchronized(descriptors) {
                check(!closed) { "VPN worker transport is closed." }
                destination.send(message)
                if (local) {
                  // A local Messenger does not marshal/duplicate the descriptor.
                  // Its receiver owns this exact object after enqueueing succeeds.
                  descriptors.remove(descriptor)
                  transferredLocally = true
                }
              }
            } finally {
              synchronized(descriptors) { descriptors.remove(descriptor) }
              if (!transferredLocally) descriptor.close()
            }
          } finally {
            file.delete()
          }
        }.onFailure { error -> handler.post { if (!closed) onError(error) } }
      }
    }.onFailure { error -> handler.post { if (!closed) onError(error) } }
  }

  fun receive(message: Message, limit: Long, onResult: (Long, Result<String>) -> Unit) {
    val ticket = message.data.getLong("ticket")
    @Suppress("DEPRECATION") // The app supports Android versions before typed getParcelable.
    val descriptor = message.data.getParcelable<ParcelFileDescriptor>("payload")
    if (descriptor == null) {
      onResult(ticket, Result.failure(IllegalArgumentException("VPN worker payload descriptor is missing.")))
      return
    }
    synchronized(descriptors) {
      if (closed) { descriptor.close(); return }
      descriptors.add(descriptor)
    }
    runCatching {
      reader.execute {
        val result = runCatching {
          val stat = Os.fstat(descriptor.fileDescriptor)
          require(OsConstants.S_ISREG(stat.st_mode) && stat.st_size in 0L..limit) {
            "VPN worker payload must be a bounded regular file."
          }
          ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { input ->
            val output = ByteArrayOutputStream()
            copyAndroidVpnWorkerPayload(input, output, limit)
            output.toString(Charsets.UTF_8.name())
          }
        }
        synchronized(descriptors) { descriptors.remove(descriptor) }
        runCatching { descriptor.close() }
        handler.post { if (!closed) onResult(ticket, result) }
      }
    }.onFailure { error ->
      synchronized(descriptors) { descriptors.remove(descriptor) }
      descriptor.close()
      onResult(ticket, Result.failure(error))
    }
  }

  fun close() {
    closed = true
    writer.shutdownNow()
    reader.shutdownNow()
    synchronized(descriptors) {
      descriptors.forEach { runCatching { it.close() } }
      descriptors.clear()
    }
  }
}
