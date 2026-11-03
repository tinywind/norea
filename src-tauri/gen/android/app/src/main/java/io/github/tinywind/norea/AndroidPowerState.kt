package io.github.tinywind.norea

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.PowerManager
import androidx.annotation.Keep
import androidx.core.content.ContextCompat

/** Publishes battery saver state so automatic goal downloads can pause while it is on. */
@Keep
object AndroidPowerState {
  private var started = false

  @JvmStatic
  private external fun publish(powerSave: Boolean)

  @Synchronized
  fun start(context: Context) {
    if (started) return
    val manager = context.getSystemService(PowerManager::class.java) ?: return
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        publish(manager.isPowerSaveMode)
      }
    }
    ContextCompat.registerReceiver(
      context, receiver, IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED,
    )
    publish(manager.isPowerSaveMode)
    started = true
  }
}
