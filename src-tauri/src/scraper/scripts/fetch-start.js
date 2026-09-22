(function (request, requestId) {
  const blockedHeaders = new Set([
    "accept-charset", "accept-encoding", "access-control-request-headers",
    "access-control-request-method", "connection", "content-length", "cookie",
    "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin",
    "referer", "te", "trailer", "transfer-encoding", "upgrade", "via",
    "user-agent"
  ]);
  const init = request.init || {};
  const controllers = window.__noreaFetchControllers || (window.__noreaFetchControllers = {});
  const controller = new AbortController();
  controllers[requestId] = controller;
  const headers = new Headers();
  for (const key of Object.keys(init.headers || {})) {
    if (!blockedHeaders.has(key.toLowerCase())) {
      headers.set(key, String(init.headers[key]));
    }
  }
  window.__noreaFetchResults = window.__noreaFetchResults || {};
  window.__noreaFetchResults[requestId] = { done: false };
  (async function () {
    try {
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
      const chunkSize = 0x8000;
      for (let offset = 0; offset < responseBytes.length; offset += chunkSize) {
        const chunk = responseBytes.subarray(offset, offset + chunkSize);
        responseChunks.push(String.fromCharCode.apply(null, Array.from(chunk)));
      }
      const bodyBase64 = btoa(responseChunks.join(""));
      window.__noreaFetchResults[requestId] = {
        done: true,
        ok: true,
        status: response.status,
        statusText: response.statusText || "",
        bodyBase64,
        headers: responseHeaders,
        finalUrl: response.url || request.url
      };
    } catch (error) {
      window.__noreaFetchResults[requestId] = {
        done: true,
        ok: false,
        error: (error && (error.message || error.toString())) || String(error)
      };
    } finally {
      try {
        delete window.__noreaFetchControllers[requestId];
      } catch (error) {}
      try {
        location.href = "https://norea.localhost/__norea_scraper_result__/" +
          encodeURIComponent(requestId);
      } catch (error) {}
    }
  })();
})
