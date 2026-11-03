package io.github.tinywind.norea

import android.app.Service
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process
import android.os.SystemClock
import java.io.File

class LogTestWriterService : Service() {
  private val endpoint = Messenger(object : Handler(Looper.getMainLooper()) {
    override fun handleMessage(message: Message) {
      check(packageName == "io.github.tinywind.norea.qalogs20261102.debug") { "Refuse non-QA application" }
      val command = message.what
      val arguments = message.data
      val receiver = message.replyTo ?: return
      Thread({
        val result = Bundle()
        try {
          when (command) {
            1 -> {
              val marker = arguments.getString("marker") ?: error("Missing QA marker")
              val count = arguments.getInt("count", 1)
              require(count in 1..2_000 && marker.matches(Regex("[a-z0-9-]{1,64}")))
              repeat(count) { index ->
                val text = "$marker-$index " + "x".repeat(12_200)
                val deadline = SystemClock.elapsedRealtime() + 30_000
                while (!AndroidAppLogging.enqueueRuntime("info", "qa", Thread.currentThread().name, text)) {
                  check(SystemClock.elapsedRealtime() < deadline) { "QA runtime enqueue timed out" }
                  SystemClock.sleep(10)
                }
              }
              result.putInt("accepted", count)
            }
            2 -> result.putString("level", AndroidAppLogging.currentLevel())
            3 -> Handler(Looper.getMainLooper()).postDelayed({ Process.sendSignal(Process.myPid(), 6) }, 500)
            4 -> {
              val marker = File(File(applicationInfo.dataDir).canonicalFile, "plugin-vpn/.device-restore/restore.json")
              val proof = "local-logs-owned-startup-panic-fixture"
              if (arguments.getBoolean("enabled")) {
                check(!marker.exists()) { "Refuse an existing restore checkpoint" }
                check(marker.parentFile!!.mkdirs()) { "QA checkpoint directory already exists" }
                marker.writeText(proof)
              } else if (marker.exists()) {
                check(marker.readText() == proof) { "Refuse an unowned restore checkpoint" }
                check(marker.delete() && marker.parentFile!!.delete())
              }
              result.putBoolean("enabled", marker.exists())
            }
            else -> error("Unknown QA command")
          }
          result.putInt("pid", Process.myPid())
        } catch (error: Exception) { result.putString("error", error.toString()) }
        receiver.send(Message.obtain(null, command).apply { data = result })
      }, "norea-qa-producer").start()
    }
  })

  override fun onBind(intent: Intent): IBinder = endpoint.binder
}
