(function (message) {
  const controllers = window.__noreaFetchControllers || {};
  const results = window.__noreaFetchResults || (window.__noreaFetchResults = {});
  let cancelled = 0;
  try { window.stop(); } catch (error) {}
  for (const requestId of Object.keys(controllers)) {
    try {
      controllers[requestId].abort();
    } catch (error) {}
    results[requestId] = { done: true, ok: false, error: message };
    try {
      delete controllers[requestId];
    } catch (error) {}
    cancelled += 1;
  }
  return cancelled;
})
