# Reader keyboard focus during source downloads

Background source WebViews must not take keyboard focus from the main app.
Moving a native WebView offscreen or hiding it after creation does not enforce
this rule: Windows WebView creation focuses it by default, and a new Android
WebView remains a native keyboard focus candidate until explicitly disabled.

The Windows scraper and temporary cache-clear WebViews must be created with
`focused(false)`. Android must disable click and keyboard focus before attaching
a new scraper WebView. The existing visible site-browser path enables input
when the user opens it.

## Regression checks

Use separate Debug app data and the local source fixture described in
[the fixture smoke guide](fixture-plugin-smoke.md). Keep test scripts, logs,
screenshots, and build output under the project-root `.tmp/` directory.

1. Open a readable chapter and verify that native `PageDown` input pages or
   scrolls the reader without first selecting a toolbar control.
2. Start source fetches and rendered chapter captures on unused pool executors.
   Also switch a reused executor to another source, which recreates its WebView.
   Continue sending native keyboard events while each request is running.
3. Verify that requests succeed and that the main WebView continues receiving
   paging keys. Include a source page with an autofocus input and scripted
   `element.focus()` and `window.focus()` calls.
4. On Android, use Tab traversal after creating a fetch-only WebView, then send
   `PageDown`. Offscreen source views must not consume the paging key. A Tab
   destination that is an app button, link, or input retains its normal keyboard
   behavior; do not force paging while an interactive control owns the event.
5. Open the source's site browser through Browse, select a page input, and type
   with the keyboard. Close it, return to the reader, and repeat the background
   request checks.
6. On Windows, also clear a source profile cache while reading and confirm that
   creating the temporary cleanup WebView does not take focus.

Observe real key delivery as well as focus state. Android's
`document.hasFocus()` alone is not a reliable assertion for native keyboard
ownership during Tab traversal. Synthetic DOM `KeyboardEvent` dispatch and CDP
key injection into a chosen page bypass native focus routing and cannot prove
this regression is fixed. Use hardware keys, Android input injection, or the
Windows native focused-window key path.

When observing a desktop Debug app through CDP, select the main app page
explicitly. Newly created scraper pages briefly use the app-origin
`scraper.html` URL and must not be mistaken for the reader.
