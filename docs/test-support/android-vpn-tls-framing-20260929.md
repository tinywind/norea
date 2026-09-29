# Android VPN TLS connection recovery

Verified on 2026-09-29 with the Y700 (TB320FC), Android 15, and the same
user-supplied certificate-authenticated UDP OpenVPN profile used in the earlier
browser-error investigation. Baseline revision: `5717f63`.

The profile was transferred unchanged and its SHA-256 matched the attachment.
No VPN endpoint, certificate, private key, cookie, or profile is included here.
Only the development app (`io.github.tinywind.norea.debug`) was updated.

## Connection failure isolated

An ordinary TLS client through the installed application's local proxy could
reach a control site, but the source connection ended before ServerHello.
The WebView reported `ERR_CONNECTION_CLOSED`; independent clients reported an
unexpected TLS EOF. The embedded VPN remained connected.

The following comparisons separated this from DNS and the source parser:

- DNS answers obtained through HTTPS inside the VPN matched the system answers.
  Connecting to each resolved IP directly, while retaining the real source SNI,
  still failed.
- TLS 1.2 and TLS 1.3 both failed with the ordinary ClientHello framing.
- On the same destination IP, a control hostname in SNI completed TLS while the
  source hostname caused EOF.
- Generic small TCP writes did not reliably help. A write boundary inside the
  SNI hostname helped TLS 1.3 but not TLS 1.2.
- Splitting the initial ClientHello across two TLS records, with a boundary
  inside its server_name field, completed both TLS 1.2 and TLS 1.3. The hostname,
  complete handshake payload, destination, profile, and certificate checks
  remained unchanged.

These observations demonstrate a hostname/framing-sensitive connection failure
on this path. They are consistent with SNI-sensitive middlebox interference,
but do not establish which network operator or device performs it. They do not
prove that every relay, network, or destination has the same behavior.

## Implementation

The existing local CONNECT proxy now calls `tls_client_hello::copy_connect`.
It recognizes a complete initial plaintext ClientHello and walks its bounded
extension structure to locate server_name. It emits two nonempty TLS records
with unchanged handshake payload bytes. There are no sleeps, hostname rewrites,
TLS termination, replacement certificates, or raw source HTTP fallbacks.

Handshake fragmentation is allowed by
[RFC 8446 section 5.1](https://www.rfc-editor.org/rfc/rfc8446.html#section-5.1).
The record headers are not part of the handshake transcript. The implementation
changes only the initial record boundaries, not authenticated handshake data.

The parser buffers at most one 16 KiB plaintext record plus its header. It
passes through non-TLS protocols, unsupported or malformed messages, preexisting
handshake fragmentation, missing SNI, and incomplete records without rewriting.
A partial-read deadline forwards consumed bytes unchanged rather than dropping
them. Bytes coalesced with CONNECT headers and later TLS records are preserved.

Upload and download run concurrently, preserving server-first protocols and
half-close responses. Route-generation cancellation and VPN fail-closed checks
stay outside this helper and are unchanged. The common path also supports
ordinary direct routing, including traffic subject to an external system VPN;
an external OpenVPN application was not separately exercised in this run.

## Installed APK verification

The targeted command was:

```text
pnpm exec tauri android build --apk --debug --target aarch64
```

The resulting APK was installed on the Y700 and the profile was connected using
the actual Settings UI. The subsequent diagnostic client performed no framing
changes of its own; all changes came from the installed application's proxy.
Certificate verification remained enabled and reported successful authorization.

| Probe | Before | Installed fix, supplied VPN |
| --- | --- | --- |
| Control hostname, TLS 1.3 | HTTP 200 | HTTP 200, 796 ms |
| Original source hostname, TLS 1.3 | TLS EOF, 435 ms | HTTP 302, 864 ms |
| First resolved source IP with original SNI, TLS 1.3 | TLS EOF, 331 ms | HTTP 302, 636 ms |
| Second resolved source IP with original SNI, TLS 1.3 | TLS EOF, 386 ms | HTTP 302, 661 ms |
| Redirected source host, TLS 1.3 | TLS EOF, 329 ms | HTTP 403 challenge, 756 ms |
| Original source hostname, TLS 1.2 | TLS EOF, 463 ms | HTTP 302, 925 ms |

The six probes were repeated with VPN disabled and after reconnecting the
supplied profile. All 18 installed-proxy TLS checks completed with certificate
validation and HTTP responses. Timings are individual observations, not a
performance guarantee. HTTP 403 is not counted as successful content access.

The unchanged private source plugin was imported through the app's local
JavaScript-file control. Actual foreground browsing followed the old source
address to the current host and displayed its Cloudflare verification page.
Actual catalog loading and keyword search entered the existing source-access
verification workflow instead of failing TLS or dismissing the browser. The
application process and VPN connection stayed alive.

**Content-access limit:** no successful Cloudflare clearance, populated search
results, or chapter retrieval is claimed. The site still requested verification
in the tested WebView. This is distinct from the reproduced pre-HTTP connection
termination, which the framing change resolved. External browser cookies were
not imported and no challenge response was fabricated.

## Automated regression verification

The production proxy and framing modules passed 21 tests: nine existing proxy
tests and twelve new framing/stream tests. Coverage includes transcript-byte
preservation, alternate record versions, every truncated input prefix,
malformed lengths, byte mutations, a large ClientHello, later records, partial
read timeouts, one-byte input/output buffers, CONNECT trailing bytes,
server-first protocols, half-close delivery, and blocked-route behavior.

The Windows whole-application Rust test binary compiled, but its loader exited
with `STATUS_ENTRYPOINT_NOT_FOUND` before any tests ran. It is not reported as
passing. To exercise the affected code despite that local runtime problem, a
separate offline Cargo runner referenced the exact production `.rs` files by
path. Its only Tauri adapter delegated `async_runtime::spawn` to Tokio; neither
the transport implementation nor the committed test bodies were copied or
replaced. The 21 tests passed again after formatting.

The Android native build and installed-device checks exercised the actual
application integration, not this isolated runner. Rust formatting and
`git diff --check` also passed. Standard commit/push hooks additionally check
TypeScript, the frontend suite, and the Windows Rust build.
