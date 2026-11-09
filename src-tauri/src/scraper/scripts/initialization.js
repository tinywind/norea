(function () {
  try {
    var appOrigin = __NOREA_APP_ORIGIN_JSON__;
    var protectedHost = /^(?:tauri|asset|norea-media)\.localhost$/i.test(location.hostname);
    var websiteContext = /^https?:$/.test(location.protocol) && !protectedHost;
    if (appOrigin && location.origin === appOrigin) websiteContext = false;
    if (!websiteContext) return;

    // Non-Windows desktop builds can transport only an opaque request id via
    // window.name. Executable code is never read from page-controlled state.
    var requestPrefix = "__norea_request__=";
    try {
      var name = window.name || "";
      if (name.indexOf(requestPrefix) === 0) {
        window.__noreaExtractRequestId = decodeURIComponent(name.substring(requestPrefix.length));
        window.name = "";
      }
    } catch (e) {}

    window.ReactNativeWebView = window.ReactNativeWebView || {};
    window.ReactNativeWebView.postMessage = function (payload) {
      try {
        window.__noreaExtractResult = String(payload);
        var encoded = encodeURIComponent(String(payload));
        var marker = "#__norea_result__=" + encoded;
        try {
          history.replaceState(null, "", location.pathname + location.search + marker);
        } catch (e) {
          location.hash = marker;
        }
        try {
          var rid = window.__noreaExtractRequestId;
          if (rid) {
            location.href = "https://norea.localhost/__norea_scraper_result__/" + encodeURIComponent(rid);
          }
        } catch (e) {}
      } catch (e) {}
    };
  } catch (e) {}
})();
