# Android Background Download Verification — 2026-09-26

## Scope

Device: Lenovo Y700 (TB320FC), Android 15/API 35, arm64.
Build target: minSdk 24, targetSdk 36. Existing user data was preserved.
The source under test includes durable download retries, explicit cancellation
classification, strict offline-media completion and Android FGS quota handling.

## Automated regression coverage

- TypeScript check and Vitest: 1,066 passing tests in 92 files, Node 24.
- Rust library tests on Linux: 198 passing tests.
- Android Kotlin JVM tests: 73 passing tests in 10 suites.
- Android arm64 release APK compilation and signed installation passed.

The test suite covers retained task promises and deduplication, executor release
between attempts, capped backoff, cancellation timer cleanup, independent user
pauses, Retry-After, permanent HTTP errors, native captured-stream cleanup, VPN
fail-closed routing and foreground-service suspension.

## Non-debuggable APK device test

The test used the normal release-mode APK with SHA-256
`8ad0ae07186a1e1167ab0ebe4d720be92b4dac82bcd80523423b6932e9680608`. It did not expose the diagnostic JavaScript object or
an app WebView debugging socket. The APK was signed with the existing local
test key, not a production release key.

Two isolated fixture sources each provided 50 chapters, with five public
Pepper&Carrot images per chapter. Each source/chapter/image request used a unique
URL query key. The fixture chapter HTML was deterministic; the images traversed
the actual source WebView, plugin VPN proxy and Android storage path.
This tests the download infrastructure, not every site's parser or authentication.

The 100 jobs were persisted before the app was stopped and replaced with the
normal APK. On launch, the existing native queue restored them. Notification
mode was Off and the VPN was On. The device was switched away from the app and
locked; no foreground visit or Retry action was used during the run.

Three Wi-Fi outages were injected: 50 seconds, 195 seconds, and 45 seconds.
Both source queues resumed without interaction after every outage. The
195-second outage exceeds the per-acquisition VPN-readiness deadline, so the
result also covers recovery beyond the former terminal timeout behavior.

The observer recorded completion of all 100 chapters and 500 images over
1317.69 seconds. The app process remained alive, the task foreground
service remained active while work was pending, and the screen stayed locked
(Dozing or Asleep). A simulated RUNNING_LOW/RUNNING_CRITICAL memory-trim callback
was also delivered; it is not evidence of surviving an actual process kill.

A first observer check incorrectly required Asleep and rejected the valid Dozing
screen state. The observer was corrected without modifying or restarting the
app; the resumed observation began after the first six chapters had completed.
An in-progress manifest read occasionally encountered incomplete JSON and was
retried. Final integrity validation used settled files after the run ended.

## Final data integrity

Every completed chapter was copied from the device and checked:

- 100 complete manifests, 500 stored images, no remote-only images.
- All 100 media archives passed ZIP CRC checks.
- Archive names and image byte lengths matched the manifests.
- All 500 entries had JPEG signatures.
- All completed HTML image references were local, not HTTP fallbacks.
- Total media archive bytes: 120,648,800.

A post-run database check found 100 downloaded chapters with no media-repair
flag and an empty persistent queue. The explicitly cancelled fixture chapter
IDs remained undownloaded across the app restart. Original chapter metadata
was unchanged from the saved baseline.

## Targeted diagnostic tests

A separate diagnostic APK was used to inspect cancellation and quota events.
Cancelling queued retry work and a running hidden VPN wait removed their native
queue entries, without timer-driven resurrection. A permanent 404 produced an
explicit incomplete/failed task with manual retry available, not a successful
offline archive.

The Android dataSync foreground-service quota was temporarily shortened to
30 seconds. Expiry stopped the service without killing the app, retained the
same pending job and queue entry, and suspended source execution. Foreground
return cleared platform suspension without clearing a user's independent pause.
The original device_config value was restored after the test.

## Platform boundaries

No application can retrieve permanently missing server content. Those failures
remain explicit rather than being mislabeled as complete offline downloads.

This is not an always-on idle VPN service. Android may deny background network
access after all task work ends. The task foreground service protects active
and retry-waiting downloads; idle VPN continuity is a separate behavior.

Android-enforced service quotas and explicit OS force-stop are not bypassed.
When Android revokes execution, the service stops safely and queued work remains
for the next permitted foreground execution. The six-hour dataSync quota is not
a promise of unlimited background execution on every device.

The results are for this physical device and these scenarios; they are not a
claim that every OEM policy, source website, credential flow or OS version has
been exhaustively tested. No Windows build was performed in this Linux session.

## Evidence location

Device JSONL timelines, archive-check output, source fingerprints, build logs
and test results are retained under the ignored local directory
`.tmp/stabilize-20260926/`. No device data, APK, credentials or signing keys are
committed with this record.
