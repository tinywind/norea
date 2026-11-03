package io.github.tinywind.norea

import android.os.Bundle
import android.view.MenuItem
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback

class AndroidVpnDownloadWorker0Activity : AndroidVpnDownloadWorkerActivity(0)
class AndroidVpnDownloadWorker1Activity : AndroidVpnDownloadWorkerActivity(1)
class AndroidVpnDownloadWorker2Activity : AndroidVpnDownloadWorkerActivity(2)
class AndroidVpnDownloadWorker3Activity : AndroidVpnDownloadWorkerActivity(3)
class AndroidVpnDownloadWorker4Activity : AndroidVpnDownloadWorkerActivity(4)
class AndroidVpnDownloadWorker5Activity : AndroidVpnDownloadWorkerActivity(5)
class AndroidVpnDownloadWorker6Activity : AndroidVpnDownloadWorkerActivity(6)
class AndroidVpnDownloadWorker7Activity : AndroidVpnDownloadWorkerActivity(7)
class AndroidVpnDownloadWorker8Activity : AndroidVpnDownloadWorkerActivity(8)
class AndroidVpnDownloadWorker9Activity : AndroidVpnDownloadWorkerActivity(9)

internal fun androidVpnDownloadWorkerActivityClass(slot: Int): Class<out AndroidVpnDownloadWorkerActivity> = when (slot) {
  0 -> AndroidVpnDownloadWorker0Activity::class.java
  1 -> AndroidVpnDownloadWorker1Activity::class.java
  2 -> AndroidVpnDownloadWorker2Activity::class.java
  3 -> AndroidVpnDownloadWorker3Activity::class.java
  4 -> AndroidVpnDownloadWorker4Activity::class.java
  5 -> AndroidVpnDownloadWorker5Activity::class.java
  6 -> AndroidVpnDownloadWorker6Activity::class.java
  7 -> AndroidVpnDownloadWorker7Activity::class.java
  8 -> AndroidVpnDownloadWorker8Activity::class.java
  9 -> AndroidVpnDownloadWorker9Activity::class.java
  else -> throw IllegalArgumentException("VPN worker slot is invalid.")
}

abstract class AndroidVpnDownloadWorkerActivity(private val slot: Int) : ComponentActivity() {
  private var worker: AndroidVpnDownloadWorkerService? = null
  private var generation = 0L

  override fun onCreate(savedInstanceState: Bundle?) {
    AndroidVpnWorkerProcess.initialize(slot)
    super.onCreate(savedInstanceState)
    generation = intent.getLongExtra("generation", 0)
    val token = intent.getStringExtra("manualToken")
    val service = AndroidVpnWorkerProcess.service
    if (token == null || service?.attachManual(this, generation, token) != true) {
      finish()
      return
    }
    worker = service
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (worker?.handleManualBack(this@AndroidVpnDownloadWorkerActivity, generation) != true) finish()
      }
    })
  }

  override fun onOptionsItemSelected(item: MenuItem): Boolean {
    if (item.itemId == android.R.id.home) { finish(); return true }
    return super.onOptionsItemSelected(item)
  }

  override fun onResume() {
    super.onResume()
    worker?.setManualVisible(this, generation, true)
  }

  override fun onPause() {
    worker?.setManualVisible(this, generation, false)
    super.onPause()
  }

  override fun onDestroy() {
    worker?.detachManual(this, generation)
    worker = null
    super.onDestroy()
  }
}
