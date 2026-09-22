(function (requestId) {
  const store = window.__noreaFetchResults || {};
  const result = store[requestId];
  if (!result || !result.done) return null;
  delete store[requestId];
  return result;
})
