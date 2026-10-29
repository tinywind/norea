# Security maintenance checks

## Dependency compatibility

- OpenVPN uses `openvpn-connect` and the local `openvpn-connect-sys` 0.1.2 patch. The local TLS, resolver, and Core-frame changes remain; `src-tauri/vendor/openvpn-connect-sys/PATCHES.md` records the upstream port.
- DES and triple-DES data ciphers are rejected before connection and have no backend cipher handles. AES, authenticated ciphers, and the existing profile format remain supported.
- Android's verifier Java artifact follows the Cargo-resolved support version from the upstream Maven archive.
- The legacy Drizzle loader resolves a patched esbuild through a scoped pnpm override. Drizzle generation was compared with the baseline in isolated copies; generated SQL was identical and no database was opened.
- GLib retains upstream version 0.18.5 with documented source backports. See `src-tauri/vendor/glib/SECURITY_BACKPORT.md` for the Variant and StrV production fixes and the separate upstream test-only repair. Version-only advisory tools may still report the original version.

## Browser and Android boundaries

- Website before-scripts run outside bundled application protocols and the actual application or development origin. The initial scraper bootstrap keeps its result bridge. Protected documents discard stored before-script handoffs.
- Script templates receive only a canonical application origin. They do not receive URL credentials, paths, queries, or fragments. Android fills both document-start and fallback templates in one pass.
- The main WebView permits bundled routes and its active development origin. Separate scraper WebViews retain website navigation and their existing source profiles. Tauri's Rust IPC checks and Android's Java interfaces are distinct boundaries.
- Native media responses apply a CSP sandbox, block executable and external document resources, and preserve inline SVG styling and data images. SVG bytes, MIME types, and cover cache headers remain unchanged. Browser regression fixtures verify that scripts and event handlers stop, framed documents lose parent access, and SVG pixels still render. This check does not replace Windows WebView2 or real-device Android acceptance.
- Android WebViews disable direct `content://` and `file://` access. Selected-document and reader-media access still uses the existing native SAF and custom-media handlers.
- Android explicitly disables automatic OS backup because private app storage can contain VPN private keys, repository credentials, and browser sessions. Existing data and manual export/import remain. Existing backup archives are not deleted, and OEM device-transfer behavior has not been verified.
- The affected Android log messages escape CR/LF, including exception stack text, so a filename, URI, or remote message cannot create another log line. This preserves diagnostic content; it does not promise that every diagnostic field is public information.

## Static-analysis contexts

| Context | Evidence required for disposition |
| --- | --- |
| Reader text tag removal | Text is decoded and then escaped again before a virtual segment becomes HTML. Tag-shaped text remains text. |
| Large-reader style extraction | This moves existing styles into the static portion of a prepared document. HTML, Markdown, and EPUB have separate import/download sanitizers; this regex is not the sanitizer. EPUB CSS is parsed and scoped before preparation. |
| Reader worker messages | A private DedicatedWorker is created by the application. Real browser messages have an empty origin, and its runtime has no DOM globals. A Window origin check would reject valid work. |
| Android parameter names | The parser assigns strings, reads fixed protocol keys, and does not merge objects. Adversarial `__proto__`, constructor, and malformed keys did not modify prototypes. |
| Native test keys and nonces | Fixed values are inside `cfg(test)` regression fixtures; they are not production credentials. |
| Rust URL diagnostics | Inspect each sink: URL helpers remove user information, paths, queries, and fragments; fetch summaries use header names and body lengths. Cookie values are not emitted by the desktop cookie diagnostic helper. |
| Android Java interfaces and JavaScript | The main application and the separate scraper have different interfaces and navigation policies. The scraper exposes result/document notifications, not storage or application-command interfaces. Their intentional presence is not evidence that a remote page may invoke the main application's interfaces. |
| GLib pointer operations | Review each upstream ownership and transfer contract. A pointer-operation report alone does not prove that the app calls an unsafe API with an invalid pointer. No vendor-wide exclusion is used. |

The advanced CodeQL workflow analyzes Actions, JavaScript/TypeScript, Rust, and an actual Android Java/Kotlin build. Its verification phase keeps uploads disabled until the reviewed setup transition. A successful dependency audit does not replace source analysis or platform checks.
