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
sessions, library rows, or download folders. HTTP 404 skips the missing resource;
all other download errors require a hold and explicit user recovery.

## Recovery During Background Work

1. Record the original settings and confirm Wi-Fi is working.
2. Select notification mode Off, connect the plugin VPN, and start fixture media
   downloads through the regular task scheduler.
3. Press HOME. Confirm the quiet task foreground service remains active.
4. Disable Wi-Fi and mobile data on the test device for 50 seconds, then restore
   them in a cleanup path even if the test fails. Do not disrupt the development
   host's network.
5. Observe the VPN and task states without returning the app to the foreground.
6. Confirm an active acquisition interrupted by the outage stops its source
   queue or VPN range and preserves pending work. The VPN may reconnect when
   Android permits background execution, but media requests must remain held
   after connectivity returns and after reopening the app. Record the task
   foreground-service state while the downloads are held.
7. Explicitly resume the affected queue or VPN range and manually retry failed
   chapters. Inspect the fixture's final content, media manifest, and database
   flags. Previously uncached images must be stored before the chapter is marked
   complete.

## Failure and Cancellation

- With system internet available, keep the VPN unavailable past a 120-second
  readiness deadline. The acquisition must release its executor and hold the
  affected source queue or VPN range without automatic retry. Partial files,
  pending queue records, and failed-chapter records remain available for manual
  recovery; incomplete content must not be marked downloaded.
- Cancel a waiting task. It must stop promptly without creating a completed
  content file or leaving readiness timers and listeners attached.
- Restore connectivity without pressing Resume or Retry. Confirm failed
  downloads stay held after foreground return and app restart. Explicit queue
  resume must restore preserved backend jobs before clearing the hold; a failed
  restoration must retain the hold. Manual chapter retry must reuse valid partial
  media and complete normally after the cause is fixed.
- Cancel both running and paused tasks while hidden. Confirm their backend queue
  entries are removed and do not reappear after an app restart.
- Test HTTP 401, 403, 429, 5xx, timeouts, and parser failures. Each must hold its
  source queue or VPN range without another automatic request or profile change.
  A separate unaffected source may continue. Test HTTP 404 separately: later
  resources and chapters may proceed, but missing media remains incomplete.
- Inject a local storage or database failure. Confirm all source queues and VPN
  ranges hold, new downloads cannot start, and the hold survives app restart.
  Preserve existing files, pending jobs, and VPN checkpoints throughout recovery.
- On Android 15+, shorten data_sync_fgs_timeout_duration only for a controlled
  test, saving and restoring the original setting in a cleanup path. Confirm quota
  expiry stops the service without a crash or restart loop, preserves queued work,
  and resumes after a user foreground visit without clearing a user queue pause
  or download failure hold.
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

## Effective Connectivity and Catalog Cases

- Repeat an outage with Norea VPN Off and On, including a cold offline start.
  New source, catalog, repository, and update HTTP must not start. Existing source
  requests and catalog transports must cancel; queued chapters remain queued.
- Disable Wi-Fi while cellular internet remains available. Work must continue
  over the effective default network. Norea must never enable either radio.
- Connect to Wi-Fi without internet or with a captive portal. Confirm a waiting
  state rather than a connected VPN indication or recurring connection attempts.
- Test an external VPN alone and together with Norea VPN, including external VPN
  reconnection, lockdown, and an app-blocked route. Catalog retrieval follows the
  system route; an inner tunnel failure must not become a catalog failure.
- During downloads, switch between usable networks. Confirm obsolete requests
  stop and only one VPN recovery runs. Downloads interrupted during acquisition
  must retain their failure hold until explicit resume.
- Pause or cancel work, or select VPN Off during an outage. Restoring connectivity
  must preserve those decisions. Explicit Off must clear the previous tunnel error.
- Exercise authentication/profile failures separately from connection timeouts.
  Download failures require user action in both cases. Independent foreground VPN
  connection recovery must not release a source or VPN-range failure hold.
- Repeat the applicable cases in the Windows app, including an external VPN and
  a system proxy. Observe actual catalog cancellation and downloads, not only an
  independent HTTP request to the API. Close and reopen the finder after cancelling.
- Fail one endpoint while the OS still reports internet. Keep that failure scoped
  to the endpoint; it must not set the shared network state to Offline.

## Cleanup

Restore Wi-Fi and the original notification, logging, and VPN settings. Remove
only fixture rows/files created by this test. Stop local capture processes and
ADB forwarding bridges. Replace temporary diagnostic builds with a build that
does not enable WebView debugging or expose a diagnostic JavaScript object.
Retain the relevant test summaries and build identity with the verification
report; do not retain credentials, private keys, or unrelated app data in it.
