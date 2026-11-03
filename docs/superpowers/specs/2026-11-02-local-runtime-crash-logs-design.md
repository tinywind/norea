# Local runtime and crash logs

Status: approved for implementation planning on 2026-11-02.

## Intent and accepted choices

Make operational and crash diagnostics available as local files without ADB.
Prefer the user's Norea storage folder and continue recording elsewhere when
that folder cannot be written. Reuse the existing logging-level setting.

The user selected platform-native storage: Kotlin on Android and Rust on
Windows. Runtime logs and crash reports have independent retention budgets:
each file is at most 1 MiB (1,048,576 bytes), with at most ten retained files
per category, including the active runtime file. Oldest files are removed
first. The ordinary retained budget is approximately 20 MiB.

This feature targets the existing Windows and Android applications. Validation
for this task uses Waydroid, not the physical Y700. It does not introduce a
remote telemetry service, a new Tauri plugin, a log viewer or a manual crash
button in production.

## Storage selection and ownership

Interpret the Norea folder as the media-storage root already selected in the
app. Write beneath its `logs/` child, never inside `contents/` or chapter
directories. Do not change the selected storage root or request a new folder
permission merely to record diagnostics.

Try writable destinations in this order:

1. `logs/` beneath the selected media-storage root.
2. A public Downloads fallback when the platform permits it: Android's
   `Download/Norea/logs/`, or `Norea/logs/` in the Windows Downloads directory.
3. An app-specific temporary logs directory as the last available destination.

Android must honor persisted SAF grants. A `content://` root must not be
treated as an ordinary filesystem path. Use app-owned `MediaStore.Downloads`
files on Android 10 and later when the selected root is unavailable and raw
shared-storage access is not granted. Earlier Android versions may use a
writable public filesystem directory; without such permission, they fall back
to app-specific temporary storage. Never bypass storage permissions.

Windows uses the configured filesystem root, its public/user Downloads
directory when available, and the OS temporary directory. Early startup may
use the temporary destination until configured storage can be resolved.

Probe by opening or creating the app's own log file, not just with an
existence or `canWrite` check. Retry the same record in the next destination
after an open, append, flush or rotation failure. Do not truncate an existing
file merely to test access. A missing public writable destination is recorded
as a fallback condition; an app cannot promise public files when the OS grants
no public write access.

Use an application- and category-specific filename namespace. Retention may
delete only regular files created in that namespace, never unrelated `.log`
files, links, content files, another application variant's logs or directories.
Keep runtime and crash ownership separate. Serialize Android writers across
the main process and VPN worker processes with an app-private coordination
lock. Preserve the current process identity in every record.

Opening a log must not follow a linked managed log file or `logs/` directory.
Resolve trusted OS or selected root aliases before adding managed children,
without weakening checks on the children themselves.

Apply retention across known, accessible destinations and reconcile when a
previously unavailable destination becomes writable again. Files stranded on
inaccessible storage cannot be deleted immediately, so the physical total
across unavailable volumes is not a hard 20 MiB guarantee. Do not sacrifice
new crash capture or delete unrelated data to claim that guarantee.

## Runtime logging

Preserve the existing `trace`, `debug`, `info`, `warn`, `error` and `off`
setting and Rust/frontend logging entry points. Route app-owned Kotlin logs
through the Android file sink as well. Keep stdout/logcat diagnostics and
existing dependency-specific noise limits. Disable redundant default file
targets so the new managed files are the active file-log output.

Persist a native copy of the selected level for startup and Android worker
processes, without changing the frontend settings format. Use `info` when no
native setting exists yet; the frontend synchronizes its saved level as it
does today. A later restart must honor the last synchronized native setting
before ordinary application initialization. Runtime `off` creates no runtime
log records; crash reports remain enabled independently.

Include UTC time, severity, source/target, process and thread identity, build
version/platform and the message where available. Do not invent missing build
or crashed-process metadata. Keep records bounded and mark truncation
explicitly. Redact recognizable authorization headers, cookies, passwords,
tokens, secret-bearing URL fields and private-key/profile blocks before file
output. Do not add logging of request bodies or backup contents.

File I/O must not block the Android UI thread. Bound queued runtime data and
record any dropped-record count after saturation. A failing storage backend
must not recursively log through itself or terminate the app. Crash capture
uses a synchronous, independently flushed path rather than relying on the
runtime queue draining during termination.

## Rotation and retention

Append runtime records until the next bounded record would exceed 1 MiB;
then create the next file and prune the oldest owned files. Include existing
active-file bytes after restart. Keep no more than ten retained runtime files
when their destinations are accessible.

Create a separate report for each captured crash. Limit each report to 1 MiB
and retain the newest ten reports independently of runtime traffic. Preserve
the most useful exception and stack information before optional context. Add
an explicit truncation marker rather than silently claiming a complete trace.

Use collision-resistant filenames with time/process/sequence information and
exclusive creation. Do not rely on mutable filesystem modification times as
the sole ordering key; preserve creation order across restarts rather than
sorting solely by wall-clock time. Concurrent threads, process restarts and
Android worker processes must not overwrite each other's files or reset the
retention count.

## Crash coverage and limits

Install Android's application-level uncaught-exception capture before activity
startup, covering the main and app-owned worker processes. Preserve the
previous/default exception handler so recording does not swallow fatal
exceptions or leave a broken process running.

Install the Rust panic hook before proxy binding, Tauri setup and the restore
guard. Capture the panic reason, source location, forced backtrace and known
build/process context. Chain the previous panic hook. Keep the interrupted
restore guard before SQL preload; logging must not hydrate app state, open the
database, delete a checkpoint or alter restore recovery policy.

Capture browser `error` and `unhandledrejection` events before the normal app
module loads, including WebView-only reloads. The early capture module must
not import persisted settings stores or bypass the existing bootstrap fence.
Handled operational errors remain ordinary level-filtered logs, not crashes.

On Android 11 and later, recover relevant previous crash/ANR exit information
on the next start. Native tombstone traces are available through
`ApplicationExitInfo` from Android 12 when the OS still retains them. Deduplicate
recovered records. Render bounded diagnostic fields such as the signal, abort
reason and crashing thread's frames. Do not publish raw memory segments or an
opaque, potentially secret-bearing native tombstone into a public file.
Unavailable, malformed or truncated OS evidence must be labeled, not presented
as a recovered complete stack.

SIGKILL, power loss, out-of-memory aborts and fatal failures before the capture
code runs cannot guarantee an immediate report. Windows native access
violations are not made equivalent to Rust panic capture by this change.
Do not install unsafe native-signal handlers or add a crash SDK to imply full
native-dump coverage. Report these limits accurately.

## Verification and delivery

Use TDD and real filesystem tests for size boundaries, active-plus-archive
counting, oldest-first pruning, restart append, filename collisions, independent
categories, linked/unrelated-file preservation, fallback retries and total
write failure. Test level filtering, persisted native levels, early frontend
capture, bounded records and redaction separately.

On Waydroid, build only the required x86_64 APK and use an isolated test app or
explicitly isolated test state. Verify actual public/SAF output, a revoked or
unwritable primary destination, public Downloads fallback, and last-resort
temporary output. Generate enough real log traffic to rotate beyond ten
files. Verify that `off` suppresses runtime records but not a real controlled
Java exception or Rust startup panic. Reopen after a controlled native crash
and inspect OS recovery evidence or its explicit unavailability reason.
Exercise worker-process ownership and repeated startup without touching Y700.

Run the frontend/type checks and the relevant Android JVM/native suites. Report
all failures, including the known Android fixture/mock failures, by name in
the verification report. Do not label a partially failing full suite green.
Review the change, retain evidence under project-root `.tmp/`, and commit/push
the tested feature separately from startup repair commit `3848a40`.

This approved design is not an implementation or completed verification
report. Product implementation begins after review of the implementation plan
and selection of the execution method.

## Platform references

- [ApplicationExitInfo trace availability](https://developer.android.com/reference/android/app/ApplicationExitInfo#getTraceInputStream())
- [App access to native tombstones](https://developer.android.com/ndk/guides/debug)
- [App-owned MediaStore Downloads access](https://developer.android.com/training/data-storage/shared/media)
