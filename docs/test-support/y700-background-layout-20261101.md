# Y700 background chapter extraction investigation

## Scope

Observed on 2026-11-01 on a Lenovo Y700 fourth generation (TB322FC),
Android 16, with Android WebView 156.0.8078.47. Norea ran on the built-in
display (logical display 0); Moonlight remained on extended display 25.
The Newtoki Novel download queue and the configured in-app VPN were preserved.
No WebView debugger was attached, and no source request bypassed the plugin
fetch path.

The original application's scraper bridge matches commit `0caa73c` and the
pre-fix bridge in this checkout. The reproduction used that installed application.
The fixed APK was subsequently installed over it without clearing application data.

## Reproduction

Times below are device-local time (UTC+07:00).

| Time | Observation |
| --- | --- |
| 16:41:45.593 | Foreground extraction `21553` completed successfully. |
| 16:41:51.101 | The main activity window became invisible after Home on display 0. |
| 16:41:56.018 | Extraction `21554` started with a 35-second deadline. No navigation-start event followed. |
| 16:41:59 and 16:42:09 | Norea remained in foreground-service process state. Android netpolicy reported effective network blocking `NONE`. |
| 16:42:31.019 | Extraction `21554` failed with `webview_extract: timeout after 35000ms`. |
| 16:42:41.093 | The next extraction, `21555`, started while the activity was hidden. Navigation again waited. |
| 16:42:45.368 | Bringing Norea back to display 0 immediately released the pending navigation. |
| 16:42:47.001 | Extraction `21555` completed successfully, about 1.6 seconds after navigation began. |
| 16:43–16:44 | Further foreground extractions succeeded repeatedly. Settings showed the in-app VPN connected. |

The task foreground service stayed active during the reproduction. This failure
occurred before page navigation and does not demonstrate a VPN transport failure.

## Cause and change

`showBackgroundScraperSurface` requests a viewport-sized layout and waits for an
`OnLayoutChangeListener` before navigating. An invisible activity window did not
perform that layout. A previously collapsed or newly created scraper WebView
therefore waited until the extraction deadline, even with an active task service.
Returning the activity to the foreground allowed layout and navigation to proceed.

The change measures and lays out the offscreen scraper explicitly when its
container window is hidden. It also releases a pending layout wait when the
activity becomes hidden after that wait was registered. Visible activity windows
continue to use normal layout callbacks.

## Automated validation

The pre-fix failure and foreground recovery above were observed on the physical
device. Android JVM regression tests cover the existing scraper policies; they
do not exercise hidden Android window traversal. The final change passed
`:app:testUniversalDebugUnitTest`: 111 tests, zero failures, errors, or skips.
`git diff --check` also passed. Static code review and the plugin fetch contract,
Tauri architecture, and English-only project verifiers found no violations in
the changed scope.

The targeted release build used:

```sh
pnpm exec tauri android build --apk --target aarch64
```

It returned exit code 0 and produced an APK containing only `arm64-v8a` native
libraries. APK ZIP integrity and signature verification passed. The shrinker
emitted Kotlin metadata diagnostics; the build completed and the device checks
below exercised the resulting APK.

| APK property | Value |
| --- | --- |
| Size | 19,804,131 bytes |
| SHA-256 | `afe7f8365546fa714c1a96a581e19b7862b445f2f950810a5e2c69e3173419a0` |
| Signing certificate SHA-256 | `d6792257d0d2aba0f7c75941d3c7ab971172752dc677a4951fc52ebb7d16c89f` |

The signing certificate matches the original installed APK. `adb install -r`
succeeded, and pulling the installed APK back from the device produced the same
SHA-256 as the fixed build. Existing library data, storage access, and queued
downloads survived the update.

## Fixed APK device checks

After installation, the original public VPN endpoint rejected authentication.
Queued work was paused while reconnecting. The user replaced that profile with
their home VPN and connected it. The checks below used the connected home VPN;
no source traffic was switched to a direct route.

| Scenario | Result |
| --- | --- |
| Background from 17:03:50.850 to 17:06:32 | 14 successful extractions, including 13 navigations started while hidden; zero extraction timeouts or failed tasks. Extraction `23`, started immediately before Home, also finished while hidden. |
| Background again from 17:07:35 to 17:09:21 | 10 further navigations and extractions succeeded while hidden; zero extraction timeouts or failed tasks. The two background intervals completed 24 extractions in total. |
| Android execution and network policy | The task service remained foreground, the process state was `FGS`, and effective Android network blocking was `NONE`. |
| Return to Norea on display 0 | Downloads continued. The failed-task count remained four, matching the count before the connected-VPN test. VPN settings still showed connected. |
| Extended display | Moonlight remained the resumed activity on display 25. All input and activity launches targeted display 0. |

After both intervals, the same Norea process remained alive, the home VPN still
showed connected, and Norea was returned to display 0. The app's original install
time remained 2026-10-12 02:33:57; only its update time changed.

Three chapter bodies were read back from the selected storage folder after their
background extractions. Each had a new modification time inside the background
interval and nonempty text. These chapters contain no images, so they require no
media manifest or ZIP.

| Relative chapter path | Bytes | Text characters | Device modification time |
| --- | --- | --- | --- |
| `newtoki-novel/3824/471/content.html` | 14,243 | 5,552 | 17:04:04.350 |
| `newtoki-novel/3824/1022/content.html` | 15,155 | 5,907 | 17:04:16.858 |
| `newtoki-novel/58011/237/content.html` | 16,244 | 6,198 | 17:04:28.562 |

This verifies background continuation for the observed source, device, and VPN
session. It does not claim coverage of Android foreground-service quota expiry,
screen-off power management, or every possible layout-transition timing.
