(function () {
  window.__noreaChapterCaptureRunId = null;
  window.__noreaChapterLinkTargetUrl = null;
  if (window.__noreaChapterCaptureObserver) window.__noreaChapterCaptureObserver.disconnect();
  window.__noreaChapterCaptureObserver = null;
  try {
    if ((window.name || "").indexOf("__norea_script__=") === 0) {
      window.name = "";
    }
  } catch (e) {}
})();
