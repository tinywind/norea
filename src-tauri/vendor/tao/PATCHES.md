# Norea patches to `tao` 0.37.2

Base crate archive: `tao-0.37.2.crate` from crates.io
SHA-256: `d5777b06fe6435126ae8d816eba269e050e1e10d302cf5461e9c49eccabc3548`

## Summary

1. **Share `Arc<ForeignLooper>` across Android `EventLoopProxy` instances**:
   - Upstream Android `EventLoopProxy` held `ndk::looper::ForeignLooper` by value, causing every `EventLoop::create_proxy()` and `EventLoopProxy::clone()` (and therefore every `AppHandle` and `Webview` clone in Tauri) to call `ALooper_acquire()`, incrementing Android `libutils.so` `RefBase`'s 20-bit strong refcount (`MAX_COUNT = 0xfffff`).
   - `EventLoop` now acquires a single shared `Arc<ForeignLooper>` at initialization and clones that `Arc` into every `EventLoopProxy`, bounding native `ALooper` strong references to a constant regardless of how many handles coexist.
