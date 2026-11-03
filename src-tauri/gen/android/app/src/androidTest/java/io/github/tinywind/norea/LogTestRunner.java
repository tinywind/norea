package io.github.tinywind.norea;

import android.app.Application;
import android.os.StrictMode;
import androidx.test.runner.AndroidJUnitRunner;

public class LogTestRunner extends AndroidJUnitRunner {
  @Override public void callApplicationOnCreate(Application application) {
    if (!"io.github.tinywind.norea.qalogs20261102.debug".equals(application.getPackageName())) {
      super.callApplicationOnCreate(application);
      return;
    }
    StrictMode.ThreadPolicy previous = StrictMode.getThreadPolicy();
    StrictMode.setThreadPolicy(new StrictMode.ThreadPolicy.Builder()
      .detectDiskReads().detectDiskWrites().penaltyDeath().build());
    try { super.callApplicationOnCreate(application); }
    finally { StrictMode.setThreadPolicy(previous); }
  }
}
