# Norea patches to `wry` 0.57.1

Base crate archive: `wry-0.57.1.crate` from crates.io
SHA-256: `759c50ddad0ef9913bb5496cb9d509a50433a3b78cb0238d61105526589cf0e9`

## Summary

1. **Fix Android `EVAL_CALLBACKS` permanent memory leak and callback lock scope**:
   - Upstream `MainPipe::handle_message` (`WebViewMessage::Eval`) inserted a boxed closure into `EVAL_CALLBACKS` on every `eval()` even when `callback` was `None`, and `binding::onEval` looked up the callback with `.get(&id)` instead of `.remove(&id)`, leaking every `eval()` entry for the lifetime of the process.
   - Fire-and-forget evaluations (`callback.is_none()` without the `tracing` feature) now pass `NO_EVAL_CALLBACK_ID` (`-1`), skip `EVAL_CALLBACKS` insertion, and invoke `WebView.evaluateJavascript(script, null)` without allocating a Kotlin result callback or round-tripping through JNI `onEval`.
   - When a callback (or `tracing` span) is present, `onEval` removes the entry from `EVAL_CALLBACKS` and releases the mutex guard before running the callback, avoiding both leaks on null/unreadable JNI strings and re-entrant `eval()` deadlocks; failed `evalScript` JNI calls also clean up their registered callback immediately.
2. **Guard destroyed activity lookup in `get_webview`**:
   - Replace `.get(&activity_id).unwrap()` with `.get(&activity_id)?` so messages drained after an Android activity teardown do not panic inside the looper callback.
