(function (requestId) {
  if (window.__noreaFetchResults) {
    delete window.__noreaFetchResults[requestId];
  }
  if (window.__noreaFetchControllers && window.__noreaFetchControllers[requestId]) {
    try {
      window.__noreaFetchControllers[requestId].abort();
    } catch (error) {}
    delete window.__noreaFetchControllers[requestId];
  }
})
