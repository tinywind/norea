# Android VPN Recovery Smoke Test

Use a physical device and an arm64 build containing the VPN traffic-readiness
changes. Keep the device's existing app data and user downloads. Record the
installed build identity and signing certificate before replacing a build;
install a compatible signed APK with data preservation rather than uninstalling.

## Evidence to Collect

Record the notification preference, VPN On/Off intent, native VPN phase, task
status, foreground-service state, final chapter database flags, and media
manifest entries. A successful chapter task count alone is not evidence that all
images are stored offline. Distinguish `stored` media from `remote` entries and
check the completed content file or archive.

Use an isolated fixture work and previously unused image URLs to prevent a warm
browser cache from hiding a network outage. Do not clear unrelated browser
sessions, library rows, or download folders. Keep terminal HTTP errors such as
404 separate from transient transport failures.

## Recovery During Background Work

1. Record the original settings and confirm Wi-Fi is working.
2. Select notification mode Off, connect the plugin VPN, and start fixture media
   downloads through the regular task scheduler.
3. Press HOME. Confirm the quiet task foreground service remains active.
4. Disable Wi-Fi on the test device for 50 seconds, then restore it in a cleanup
   path even if the test fails. Do not disrupt the development host's network.
5. Observe the VPN and task states without returning the app to the foreground.
6. Confirm the VPN reconnects and media requests resume. The ordinary 1-second
   and 3-second network retries must not be exhausted by the VPN recovery wait.
7. Inspect the fixture's final content, media manifest, and database flags.
   Previously uncached images must be stored, not merely retained as remote URLs.

## Failure and Cancellation

- Keep the VPN unavailable past the shared 120-second media-readiness deadline.
  The current acquisition run must release its executor and return to the same
  queued task with automatic backoff, without publishing a completed remote-fallback
  download or settling the batch. Partial files and the backend queue entry remain;
  the task foreground service must stay active while recovery is pending.
- Cancel a waiting task. It must stop promptly without creating a completed
  content file or leaving readiness timers and listeners attached.
- Restore connectivity without opening the app or pressing Retry. Confirm the
  same task resumes automatically, reuses partial media, and completes normally.
- Cancel both running and retry-waiting tasks while hidden. Confirm their backend
  queue entries are removed and do not reappear after an app restart.
- Test temporary HTTP failures separately from permanent 404 responses. Temporary
  failures must back off; missing content must remain explicitly incomplete.
- On Android 15+, shorten data_sync_fgs_timeout_duration only for a controlled
  test, saving and restoring the original setting in a cleanup path. Confirm quota
  expiry stops the service without a crash or restart loop, preserves queued work,
  and resumes after a user foreground visit without clearing a user queue pause.
- Run the final non-debuggable APK with at least two independent source queues,
  a large uncached batch, screen lock, and repeated outages including one exceeding
  three minutes. Inspect every completed manifest and ZIP entry, not only counts.
- Cause a connection attempt to fail while VPN intent remains On. Confirm source
  traffic stays blocked, including during backoff. Only explicit Off (or an
  explicit profile action that turns VPN use off) may restore direct routing.
- Verify ordinary app-owned requests, such as repository and update checks,
  retain their direct app HTTP path; do not reroute them through the source VPN.

## Idle Lifecycle Investigation

After tasks finish, confirm the task foreground service stops. Disconnect any
WebView debugging client before observing idle behavior: an attached debugger
can change the behavior being measured. Record the native VPN error and Android
process/freezer/network events at matching timestamps. Include the app UID's
`dumpsys netpolicy` blocked/allowed/effective reasons and firewall transition log:
an app can lose network access while `isFrozen=false`. On the Y700 Android 15
verification device, the background firewall became effective about five seconds
after foreground-service activity ended. Record the actual device policy rather
than treating that delay as a universal Android constant. Do not infer a specific
cause merely because a VPN disconnect followed the end of a task.

After bringing the app back or starting new source work, verify that recovery
runs and source requests wait for a confirmed tunnel instead of using direct
routing. Continuous VPN execution while Android suspends an idle application is
not a guarantee of the task foreground service.

## Cleanup

Restore Wi-Fi and the original notification, logging, and VPN settings. Remove
only fixture rows/files created by this test. Stop local capture processes and
ADB forwarding bridges. Replace temporary diagnostic builds with a build that
does not enable WebView debugging or expose a diagnostic JavaScript object.
Retain the relevant test summaries and build identity with the verification
report; do not retain credentials, private keys, or unrelated app data in it.
