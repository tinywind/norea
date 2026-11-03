package io.github.tinywind.norea

import android.app.Application

class NoreaApplication : Application() {
  override fun onCreate() {
    AndroidAppLogging.install(this)
    super.onCreate()
  }
}
