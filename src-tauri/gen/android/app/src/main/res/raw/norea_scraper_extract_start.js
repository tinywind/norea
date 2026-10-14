(function () {
  if (window.top !== window || !/^https?:$/.test(window.location.protocol)) return;
  window.ReactNativeWebView = window.ReactNativeWebView || {};
  window.ReactNativeWebView.postMessage = function (payload) {
    try {
      AndroidScraper.postExtractResultWithNonce(
        __NOREA_REQUEST_ID_JSON__,
        __NOREA_REQUEST_NONCE_JSON__,
        String(payload)
      );
    } catch (e) {}
  };
  try {
    __NOREA_BEFORE_SCRIPT__
  } catch (e) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        ok: false,
        error: "before-script error: " + ((e && e.message) || String(e))
      }));
    } catch (e2) {}
  }
})();
