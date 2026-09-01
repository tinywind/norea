package io.github.tinywind.norea

import android.content.Context

object RustlsPlatformVerifierBridge {
  init {
    System.loadLibrary("app_lib")
  }

  @JvmStatic
  external fun init(context: Context)
}
