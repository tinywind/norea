# Norea patches to `tauri` 2.12.5

Base crate archive: `tauri-2.12.5.crate` from crates.io
SHA-256: `5fb0244332cfb9cee7e2a568bf5da29a36ed8fdbd717f6f47a66b6b7b358c072`

## Summary

1. **Fix Android/mobile IPC response `Channel` leak (`ALooper` `RefBase` strong-refcount overflow)**:
   - On Android, `canUseCustomProtocol` is always `false`, so every `invoke()` returning a JSON object, JSON array, or `Raw` byte buffer calls `Channel::from_callback_fn(webview, callback).send(...)`.
   - Upstream `Channel::from_callback_fn` delegated to `Channel::new_with_id`, which under `#[cfg(mobile)]` unconditionally inserted a strong `Channel` clone (capturing `Webview<Wry>` and two `ForeignLooper` handles) into `plugin::mobile::CHANNELS` with no removal path.
   - After ~524,288 `invoke()` calls, Android `libutils.so` `RefBase::decStrong()` hit the 20-bit `MAX_COUNT` (`0xfffff`) limit on `ALooper` and aborted the process (`decStrong() called on <ALooper*> too many times`).
   - `Channel::from_callback_fn` now constructs a one-shot response `Channel` without registering in `MOBILE_CHANNELS`.
   - `JavaScriptChannelId::channel_on` likewise avoids unconditional `MOBILE_CHANNELS` registration so pure-Rust `Channel` command arguments drop cleanly and fire `{ end: true }`; channels serialized for native mobile plugins (`Serialize for Channel`) or loaded by `webview::on_message` for mobile plugin commands still register in `MOBILE_CHANNELS`, `Channel::new` retains registration for Rust-created mobile plugin listeners (such as `tauri-plugin-deep-link` and `tauri-plugin-notification`), and `removeListener` unregisters removed mobile listener channels outside the registry mutex.
2. **Gradle build hygiene**:
   - Ignore `/.kotlin` under `mobile/android/.gitignore` so local Android builds do not leave untracked Kotlin compiler session directories inside the vendored crate.
