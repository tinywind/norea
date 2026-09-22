(function () {
  __NOREA_SNAPSHOT_INTERACTION_RUNTIME__;
  var beforeContentScript = __NOREA_SNAPSHOT_BEFORE_CONTENT_SCRIPT__;
  var afterContentScript = __NOREA_SNAPSHOT_AFTER_CONTENT_SCRIPT__;
  var contentSelector = __NOREA_SNAPSHOT_CONTENT_SELECTOR__;
  var interactions = __NOREA_SNAPSHOT_INTERACTIONS__;
  var interactionRunId = __NOREA_SNAPSHOT_INTERACTION_RUN_ID__;
  var contentDeadline = Date.now() + __NOREA_SNAPSHOT_CONTENT_WAIT_MS__;
  var finished = false;
  function post(payload) {
    if (finished) return;
    finished = true;
    window.ReactNativeWebView.postMessage(JSON.stringify(payload));
  }
  function errorMessage(error) {
    return (error && (error.message || error.toString())) || String(error);
  }
  function runBeforeContentScript() {
    if (!beforeContentScript) return;
    (0, eval)(beforeContentScript);
  }
  var manualActionKind = __NOREA_SNAPSHOT_CHALLENGE_DETECTOR__;
  function postChallenge() {
    var challengeKind = manualActionKind();
    if (!challengeKind) return false;
    post({
      ok: false,
      code: "manual-action-required",
      error:
        challengeKind === "captcha"
          ? "Complete the CAPTCHA in the source browser."
          : "Complete the Cloudflare verification in the source browser.",
      challenge: { kind: challengeKind, url: location.href },
    });
    return true;
  }
  function readPage() {
    if (postChallenge()) return;
    var root = contentSelector ? document.querySelector(contentSelector) : null;
    var payload = {
      url: location.href,
      title: document.title || "",
    };
    if (__NOREA_SNAPSHOT_INCLUDE_CONTENT__) {
      if (root) {
        payload.html = root.outerHTML || "";
        payload.text = root.innerText || root.textContent || "";
      } else {
        payload.html = document.documentElement
          ? document.documentElement.outerHTML
          : "";
        payload.text = document.body ? document.body.innerText || "" : "";
      }
    }
    post({ ok: true, result: payload });
  }
  function readWhenContentReady() {
    if (!contentSelector || document.querySelector(contentSelector)) {
      readPage();
      return;
    }
    if (Date.now() >= contentDeadline) {
      post({
        ok: false,
        code: "content-not-found",
        error:
          "contentSelector " +
          JSON.stringify(contentSelector) +
          " did not match before the timeout.",
      });
      return;
    }
    setTimeout(readWhenContentReady, 100);
  }
  function runAfterContentScript(callback) {
    if (!afterContentScript) {
      callback();
      return;
    }
    var result;
    try {
      result = (0, eval)(afterContentScript);
    } catch (error) {
      post({ ok: false, error: "after-script error: " + errorMessage(error) });
      return;
    }
    if (result && typeof result.then === "function") {
      result.then(
        function () {
          callback();
        },
        function (error) {
          post({
            ok: false,
            error: "after-script error: " + errorMessage(error),
          });
        },
      );
      return;
    }
    callback();
  }
  var lastChallengeCheckAt = 0;
  var challengeDetected = false;
  function shouldAbortForChallenge() {
    if (challengeDetected) return true;
    if (
      Date.now() - lastChallengeCheckAt <
      __NOREA_SNAPSHOT_CHALLENGE_CHECK_INTERVAL_MS__
    )
      return false;
    lastChallengeCheckAt = Date.now();
    challengeDetected = manualActionKind() !== null;
    return challengeDetected;
  }
  function start() {
    if (postChallenge()) return;
    runWebViewInteractions(
      interactions,
      {
        runId: interactionRunId,
        shouldAbort: shouldAbortForChallenge,
      },
      function (error, aborted) {
        if (aborted) {
          readPage();
          return;
        }
        if (error) {
          post({
            ok: false,
            code: "interaction-failed",
            error: errorMessage(error),
          });
          return;
        }
        runAfterContentScript(function () {
          try {
            readWhenContentReady();
          } catch (readError) {
            post({
              ok: false,
              error: "webView snapshot error: " + errorMessage(readError),
            });
          }
        });
      },
    );
  }
  function readWhenReady() {
    setTimeout(function () {
      try {
        start();
      } catch (error) {
        post({
          ok: false,
          error: "webView snapshot error: " + errorMessage(error),
        });
      }
    }, 0);
  }
  try {
    runBeforeContentScript();
  } catch (error) {
    post({ ok: false, error: "before-script error: " + errorMessage(error) });
    return;
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", readWhenReady, {
      once: true,
    });
  } else {
    readWhenReady();
  }
})();
true;
