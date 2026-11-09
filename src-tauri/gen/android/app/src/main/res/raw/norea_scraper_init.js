(function () {
  try {
    var appOrigin = __NOREA_APP_ORIGIN_JSON__;
    var protectedHost = /^(?:tauri|asset|norea-media)\.localhost$/i.test(location.hostname);
    var websiteContext = /^https?:$/.test(location.protocol) && !protectedHost;
    if (!appOrigin || location.origin === appOrigin) websiteContext = false;
    if (!websiteContext) return;

    // This static bridge contains no request-provided executable code. Extracts
    // with a beforeScript install a native document-start script separately.
    window.ReactNativeWebView = window.ReactNativeWebView || {};
    window.ReactNativeWebView.postMessage = function (payload) {
      try { AndroidScraper.postExtractResult(String(payload)); } catch (e) {}
    };
    if (window.top === window && typeof AndroidScraper.postDocumentReady === "function") {
      var notifyDocumentReady = function () {
        try { AndroidScraper.postDocumentReady(String(location.href)); } catch (e) {}
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", notifyDocumentReady, { once: true });
      } else {
        notifyDocumentReady();
      }
    }
  } catch (e) {}
})();
