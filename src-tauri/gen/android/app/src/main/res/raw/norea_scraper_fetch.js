(function () {
  const request = __NOREA_REQUEST_JSON__;
  const requestId = __NOREA_REQUEST_ID_JSON__;
  const requestNonce = __NOREA_REQUEST_NONCE_JSON__;
  const blockedHeaders = new Set([
    "accept-charset", "accept-encoding", "access-control-request-headers",
    "access-control-request-method", "connection", "content-length", "cookie",
    "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin",
    "referer", "te", "trailer", "transfer-encoding", "upgrade", "via",
    "user-agent"
  ]);
  (async function () {
    try {
      const init = request.init || {};
      const controllers = window.__noreaAndroidFetchControllers || (window.__noreaAndroidFetchControllers = {});
      const controller = new AbortController();
      controllers[requestId] = controller;
      const headers = new Headers();
      for (const key of Object.keys(init.headers || {})) {
        if (!blockedHeaders.has(key.toLowerCase())) {
          headers.set(key, String(init.headers[key]));
        }
      }
      const fetchInit = {
        method: init.method || "GET",
        headers,
        credentials: "include",
        redirect: "follow",
        signal: controller.signal
      };
      if (init.body !== undefined && init.body !== null) {
        fetchInit.body = init.body;
      }
      const response = await fetch(request.url, fetchInit);
      const responseHeaders = {};
      response.headers.forEach(function (value, key) {
        responseHeaders[key] = value;
      });
      const responseBytes = new Uint8Array(await response.arrayBuffer());
      const responseChunks = [];
      const chunkSize = 0x6000;
      for (let offset = 0; offset < responseBytes.length; offset += chunkSize) {
        const chunk = responseBytes.subarray(offset, offset + chunkSize);
        responseChunks.push(btoa(String.fromCharCode.apply(null, Array.from(chunk))));
        if (responseChunks.length % 16 === 0 && offset + chunkSize < responseBytes.length) {
          await new Promise(function (resolve) {
            setTimeout(resolve, 0);
          });
        }
      }
      const bodyBase64 = responseChunks.join("");
      AndroidScraper.postFetchResultWithNonce(requestId, requestNonce, JSON.stringify({
        success: true,
        status: response.status,
        statusText: response.statusText || "",
        bodyBase64,
        headers: responseHeaders,
        finalUrl: response.url || request.url
      }));
    } catch (error) {
      const message = (error && (error.message || error.toString())) || String(error);
      AndroidScraper.postFetchResultWithNonce(requestId, requestNonce, JSON.stringify({
        success: false,
        error: "scraper: browser fetch failed: " + message
      }));
    } finally {
      try {
        delete window.__noreaAndroidFetchControllers[requestId];
      } catch (e) {}
    }
  })();
})();
