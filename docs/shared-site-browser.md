# Shared site browser and download recovery

This document records the Android browser policy approved on 2026-11-07. It
supersedes the separate browser storage and parallel browser execution parts
of the earlier VPN download designs. It does not change plugin permissions,
source access ownership, or the requirement to keep VPN traffic blocked when
its requested tunnel is unavailable.

## One persistent site profile

All Android site WebViews use the main process and the same AndroidX WebKit
Profile: source browsing, page extraction, resource fetches, manual
authentication, VPN download workers, and VPN URL tests. The app UI keeps its
own profile, so resetting site data cannot erase task settings or the app's
database.

Migration adopts the existing main-process Newtoki Webtoon profile. It does not
merge cookie databases, delete legacy profile directories, or create a fresh
profile every time a source is opened. This preserves the working site session
that motivated the migration.

A single browser owner controls the process-wide WebView proxy. Independent
tunnels may remain available, but browser requests use only one route at a time.
The VPN download setting therefore exposes one worker. A visible manual
browser holds its route until the user closes it. Queued native browser
operations support cancellation before dispatch.

Source ids remain part of bridge validation, capability checks, task leases,
and response routing. Sharing browser data is not permission for a plugin to
invoke another plugin's privileged host functions.

## Route transitions

The committed route identity is the VPN profile content hash, or an explicit
direct connection. An absent identity means connection preparation or recovery;
it must never be interpreted as permission to use a direct connection.

Releasing a worker closes the network gate and drains its route without committing
an intermediate foreground or direct route. The next foreground source command
or an explicit foreground route change prepares that route. An unchanged status
poll does not count as a foreground visit. This preserves the committed identity
when a new worker generation reconnects the same VPN profile.

Before changing routes, the owner blocks page and service-worker networking,
retires the previous documents, and drains accepted proxy sockets. It then
expires all cookies when the committed profile hash changes, waits for the
CookieManager callback, flushes the cookie store, configures the shared
environment, and applies the next proxy before reopening the gate.

The pending cookie reset and committed identity are persisted. A failed or
interrupted transition leaves network access blocked. Reconnecting the same
profile does not expire cookies or generate another environment. Explicit
transitions between VPN and direct connections count as route changes. A deletion
timeout cannot cancel WebView's pending mutation: the gate stays closed until the
actual completion callback arrives, and that late callback does not reopen it
automatically.

Cookie expiry intentionally includes login cookies. It does not clear
localStorage, IndexedDB, cache storage, or other origin data. Those can still
hold a site-issued identity, so cookie expiry alone is not a general remedy for
an HTTP 403.

## Optional environment rotation

Settings > Downloads contains an opt-in environment rotation setting, disabled
by default. While enabled, a real route change generates one persisted
environment. Every site WebView uses that environment until the next transition;
reloading a page, opening another source, or restarting the app does not
independently rotate it. Setting changes normally apply at the next real route
change, rather than changing the active session immediately.

The implementation uses the installed WebView engine version for a common
User-Agent and native User-Agent Client Hints. Android source-specific and manual
User-Agent values do not override this shared environment. When rotation is
enabled, an Android device preset supplies the model and WebGL vendor/renderer,
with selected hardware properties and reported screen dimensions. Individual
values may repeat between generations. A persisted random seed changes small
canvas readbacks and offline audio measurements consistently.

Canvas drawing data and large reader/chapter images are not rewritten. Live
audio playback and ordinary writable AudioBuffer semantics are preserved.
Language, timezone, locale formatting, engine version, and actual supported
APIs remain real so related signals do not contradict each other. This is not
complete fingerprint concealment: TLS behavior, fonts, supported APIs,
unmodified execution contexts, network address, and account/server history can
still identify an environment.

Document-start scripts and native UA metadata must both be supported by the
installed WebView provider. The UI prevents enabling an unsupported feature and
still lets the user turn off a previously saved enabled setting. If that setting
blocks startup, the error screen offers an explicit turn-off-and-retry action.
It changes only the fingerprint setting and reruns network preparation; the app
and automatic VPN recovery stay gated until preparation succeeds. If support was
lost, explicitly turning rotation off also discards the unsupported saved
environment without requiring a different VPN profile first.

## Download failure policy

The Downloads settings page owns recovery behavior and Android battery
optimization guidance. The Tasks page links to these settings, and a failure
notice links directly to the recovery controls.

| Failure | Available actions | Default |
| --- | --- | --- |
| HTTP 403 / access forbidden | Pause; retry current route; reset the affected site's browser data and retry | Pause |
| Transient network or server failure | Pause; retry; use the next unused VPN profile when this is a VPN job | Pause |
| HTTP 429 | Pause; retry after the configured delay or the longer server Retry-After | Pause |
| HTTP 404 | Skip; pause | Skip |

Retry budgets are bounded to 0–5 attempts, delays to 5–3600 seconds, and VPN
profile replacements to 0–3. The default is two retries, thirty seconds, and one
profile replacement when the corresponding automatic action is selected.

A site reset uses the shared profile's native site-scoped browsing-data deletion
API. It clears the browser data covered by that operation and can sign the user
out. Because the profile is shared, the reset affects every source using that
site; it does not guarantee removal of every possible identifying signal. It
does not run merely because a 403 exists: the selected
policy must authorize it, the provider must support it, and the episode may
consume at most one reset. No VPN is required.

Existing failure holds are not released merely by changing a setting. New jobs
snapshot the current policy; explicit resume adopts changed settings and starts
a new bounded episode. Recovery saves its next retry time, consumed attempts,
used VPN profiles, and reset state before retrying. A storage failure pauses
rather than losing the budget and starting an unlimited loop. User pause,
cancellation, and storage holds take priority over automatic recovery.

A server-side account restriction or a remaining site identity can still return
403 after these steps. Exhausted or unsupported recovery pauses with its reason
instead of cycling through profiles indefinitely.

## Validation responsibilities

- Verify sharing through actual cookies and origin storage, not equal profile
  labels or copied cookie values.
- Verify same-profile reconnect, VPN-to-VPN, VPN-to-direct, interrupted reset,
  late network responses, and explicit user cancellation.
- Check both direct and VPN download failures, retry exhaustion, one site reset,
  process restart, and preservation of pre-existing queue and failure rows.
- Inspect the installed app on Y700: both source entry points, settings links,
  battery optimization location, and environment behavior.
- Use the isolated debug package for destructive fixture and instrumentation
  tests. Do not reset the production package or its database for a test.

Windows retains its existing native profile and custom User-Agent behavior.
Site data reset and environment rotation are reported as unavailable there;
the general pause, retry, and skip policies remain available.
