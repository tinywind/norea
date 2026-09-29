# Android VPN browser-error regression verification

Verified on 2026-09-29 with a Lenovo Y700 (TB320FC), Android 15, and the
user-supplied certificate-authenticated UDP OpenVPN profile. The profile was
transferred byte-for-byte and its SHA-256 matched before import. No profile,
endpoint, certificate, or private key is included in this report or commit.
Testing used `io.github.tinywind.norea.debug`; the production installation was
not replaced. Baseline revision: `bea7883`.

## Reproduction

The supplied profile connected successfully. On the unmodified application,
opening the actual source from Browse > Sources displayed the foreground
site-browser dialog and then removed it 932 ms later. The app process remained
alive and the native VPN status remained connected. The browser returned
`net::ERR_CONNECTION_CLOSED` during TLS negotiation, before an HTTP response.

The native error was passed to `SiteBrowserOverlay`, whose navigation error
handler cancelled the owning scheduler task and hid the entire browser.
There was no persistent error message or way to retry in that window. The
previous native error-reporting fix did not cover this frontend failure path.

Source catalog and keyword requests were also exercised with the real plugin.
They remained on the source screen with a visible source error rather than
terminating the app process. The specific keyword request used the source's
normal Search control, not a replacement HTTP implementation.

## Change

The browser now has an explicit navigation-error phase. Failures retain the
source profile, requested address, scheduler task, and any access-challenge
context. The native surface is collapsed while an accessible error panel
provides a redacted error detail and Retry. The address bar also remains usable.
Only an explicit close or task cancellation releases the browser.

Late failures from old navigation sequences cannot overwrite newer requests.
Bounds-resync timers do not reveal a failed native surface over the error
panel. Failed pages cannot request access verification; closing a failed
challenge browser keeps its source paused. English and Korean copy is provided.

No tunnel routing, certificate verification, authentication, cookie isolation,
or fail-closed behavior was changed. No source-specific workaround was added.

## Verification

- The new navigation-effect tests fail against the baseline overlay and pass
  with the fix.
- TypeScript checking and the targeted arm64 debug APK build passed.
- Frontend test suite: 1,108 tests across 94 files passed, including 16 added
  regression cases for error recovery, ownership, closing, and stale events.
- The built APK was installed on the Y700. Its new frontend asset was verified.
  The supplied profile was reconnected using the actual Settings Connect button.
- Device checks passed: the failed foreground browser remains open; Retry
  preserves the window and VPN; changing its address loads a healthy HTTPS
  page in the real native WebView; a subsequent failed address retains the
  browser; explicit Close works; closing during navigation does not reopen
  later; a catalog failure remains visible on the source route; the app PID
  and VPN connection survive these cases. A separate keyword-search check
  also retained the app and displayed its source error.

## Remaining network failure

With the supplied VPN, control HTTPS requests succeeded through the same local
tunnel proxy. Both Android WebView and a separate HTTPS client through that
proxy failed the source TLS handshake. This narrows the failure below the
source HTML parser, but does not identify whether its cause is the destination,
network path, or tunnel implementation. The exact cause remains unproven.

This change fixes silent browser dismissal and permits recovery without
restarting the app. It does not make the source TLS handshake succeed, and
successful live source search or chapter retrieval is not claimed.

## Follow-up

The pre-HTTP connection failure was subsequently isolated and corrected; see
[Android VPN TLS connection recovery](android-vpn-tls-framing-20260929.md).
The earlier observations above describe the baseline before that transport fix.
