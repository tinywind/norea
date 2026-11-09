(function () {
  if (window.top !== window) return;
  var appOrigin = __NOREA_APP_ORIGIN_JSON__;
  var targetOrigin = __NOREA_TARGET_ORIGIN_JSON__;
  if (!/^https?:$/.test(location.protocol) || !appOrigin || !targetOrigin ||
      location.origin !== targetOrigin ||
      /^(?:tauri|asset|norea-media)\.localhost$/i.test(location.hostname) ||
      location.origin === appOrigin) return;

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
