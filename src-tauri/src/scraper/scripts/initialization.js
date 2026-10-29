(function () {
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
          location.href = "https://norea.localhost/__norea_scraper_result__/" +
            encodeURIComponent(rid);
        }
      } catch (e) {}
    } catch (e) {}
  };
  try {
    var appOrigin = __NOREA_APP_ORIGIN_JSON__;
    var protectedHost = /^(?:tauri|asset|norea-media)\.localhost$/i.test(location.hostname);
    var websiteContext = /^https?:$/.test(location.protocol) && !protectedHost;
    if (appOrigin && location.origin === appOrigin) websiteContext = false;
    if (!websiteContext) {
      if ((window.name || "").indexOf("__norea_script__=") === 0) window.name = "";
      return;
    }
    var hash = location.hash || "";
    var name = window.name || "";
    var prefix = "__norea_script__=";
    var hashPrefix = "#" + prefix;
    var idx = hash.indexOf(hashPrefix);
    var encoded = "";
    var fromHash = false;
    if (idx !== -1) {
      encoded = hash.substring(idx + hashPrefix.length);
      fromHash = true;
    } else if (name.indexOf(prefix) === 0) {
      encoded = name.substring(prefix.length);
    }
    if (encoded) {
      var script = decodeURIComponent(encoded);
      if (fromHash) {
        try {
          history.replaceState(null, "", location.pathname + location.search);
        } catch (e) {}
      }
      try {
        (0, eval)(script);
      } catch (e) {
        var msg = (e && e.message) || String(e);
        try {
          window.ReactNativeWebView.postMessage(JSON.stringify({ ok: false, error: "before-script error: " + msg }));
        } catch (e2) {}
      }
    }
  } catch (e) {}
})();
