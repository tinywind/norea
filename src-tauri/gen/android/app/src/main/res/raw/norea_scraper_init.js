(function () {
  var scriptPrefix = "__norea_script__=";
  function parseParams(raw) {
    var params = {};
    if (!raw) return params;
    var parts = raw.split("&");
    for (var index = 0; index < parts.length; index += 1) {
      var part = parts[index];
      var equals = part.indexOf("=");
      var key = equals === -1 ? part : part.substring(0, equals);
      var value = equals === -1 ? "" : part.substring(equals + 1);
      try {
        params[decodeURIComponent(key)] = decodeURIComponent(value);
      } catch (e) {
        params[key] = value;
      }
    }
    return params;
  }
  function hashParams() {
    var hash = location.hash || "";
    if (hash.charAt(0) === "#") {
      hash = hash.substring(1);
    }
    return parseParams(hash);
  }
  function nameParams() {
    var name = "";
    try {
      name = window.name || "";
    } catch (e) {}
    if (name.indexOf(scriptPrefix) !== 0) return {};
    var params = parseParams(name);
    if (params.__norea_origin__ !== location.origin) {
      try {
        window.name = "";
      } catch (e) {}
      return {};
    }
    return params;
  }
  var params = hashParams();
  var fromHash = !!params.__norea_script__;
  if (!fromHash) {
    params = nameParams();
  }
  var bridgeRequestId = params.__norea_request_id__ || "";
  var bridgeNonce = params.__norea_nonce__ || "";
  window.ReactNativeWebView = window.ReactNativeWebView || {};
  window.ReactNativeWebView.postMessage = function (payload) {
    try {
      if (bridgeRequestId && bridgeNonce && AndroidScraper.postExtractResultWithNonce) {
        AndroidScraper.postExtractResultWithNonce(
          bridgeRequestId,
          bridgeNonce,
          String(payload)
        );
      } else {
        AndroidScraper.postExtractResult(String(payload));
      }
    } catch (e) {}
  };
  try {
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
  try {
    if (params.__norea_script__) {
      var script = params.__norea_script__;
      if (fromHash) {
        try {
          history.replaceState(null, "", location.pathname + location.search);
        } catch (e) {}
        try {
          window.name = scriptPrefix + encodeURIComponent(script) +
            "&__norea_request_id__=" + encodeURIComponent(bridgeRequestId) +
            "&__norea_nonce__=" + encodeURIComponent(bridgeNonce) +
            "&__norea_origin__=" + encodeURIComponent(location.origin);
        } catch (e) {}
      }
      try {
        (0, eval)(script);
      } catch (e) {
        var msg = (e && e.message) || String(e);
        try {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            ok: false,
            error: "before-script error: " + msg
          }));
        } catch (e2) {}
      }
    }
  } catch (e) {}
})();
