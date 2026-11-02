package io.github.tinywind.norea

import android.os.Bundle
import android.view.MenuItem
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback

class AndroidVpnDownloadWorker0Activity : AndroidVpnDownloadWorkerActivity(0)
class AndroidVpnDownloadWorker1Activity : AndroidVpnDownloadWorkerActivity(1)

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
