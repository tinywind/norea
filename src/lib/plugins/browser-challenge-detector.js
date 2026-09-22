/*
 * Browser-challenge heuristic shared by the WebView snapshot script
 * (src/lib/plugins/shims.ts) and the desktop scraper host
 * (src-tauri/src/scraper/desktop.rs, via include_str!). Both embed this file
 * verbatim, so it must stay a single ES5 function expression with no imports.
 */
(function () {
  var BODY_TEXT_LIMIT = 12000;
  var CLOUDFLARE_EVIDENCE_SELECTOR =
    "script[src*='/cdn-cgi/challenge-platform/'], " +
    "link[href*='/cdn-cgi/challenge-platform/'], [data-ray], #cf-error-details";
  var CLOUDFLARE_SELECTORS = [
    "#challenge-running",
    "#cf-challenge-running",
    "#challenge-stage",
    "form#challenge-form",
    ".cf-browser-verification",
    ".cf-turnstile",
    "iframe[src*='challenges.cloudflare.com']",
  ];
  var CAPTCHA_SELECTORS = [
    "iframe[src*='recaptcha']",
    "iframe[src*='hcaptcha']",
    "iframe[src*='captcha']",
    ".g-recaptcha",
    ".h-captcha",
    ".geetest_panel",
    ".geetest_holder",
    "[class*='captcha-slider']",
    "[class*='slider-captcha']",
    "[class*='puzzle-captcha']",
    "#tcaptcha_iframe_dy",
    ".tcaptcha-transform",
    ".secsdk-captcha-drag-icon",
  ];

  function isVisible(element) {
    if (!element || typeof element.getClientRects !== "function") return false;
    if (element.hidden || element.getAttribute("aria-hidden") === "true")
      return false;
    try {
      var style = window.getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
    } catch (error) {}
    var rects = element.getClientRects();
    for (var rectIndex = 0; rectIndex < rects.length; rectIndex += 1) {
      if (
        Number(rects[rectIndex].width) > 0 &&
        Number(rects[rectIndex].height) > 0
      ) {
        return true;
      }
    }
    return false;
  }

  function hasVisibleSelector(selectors) {
    for (var index = 0; index < selectors.length; index += 1) {
      var elements = document.querySelectorAll(selectors[index]);
      for (
        var elementIndex = 0;
        elementIndex < elements.length;
        elementIndex += 1
      ) {
        if (isVisible(elements[elementIndex])) return true;
      }
    }
    return false;
  }

  var title = (document.title || "").toLowerCase();
  var body = ((document.body && document.body.innerText) || "").toLowerCase();
  if (body.length > BODY_TEXT_LIMIT) body = body.slice(0, BODY_TEXT_LIMIT);
  var hasCloudflareEvidence =
    document.querySelector(CLOUDFLARE_EVIDENCE_SELECTOR) !== null ||
    /cloudflare ray id|cf-ray|cf-chl/.test(body);
  var hasChallengeText =
    /just a moment|attention required/.test(title) ||
    /checking if the site connection is secure|verify you are human|enable javascript and cookies to continue|sorry, you have been blocked/.test(
      body,
    );
  if (
    hasVisibleSelector(CLOUDFLARE_SELECTORS) ||
    (hasCloudflareEvidence && hasChallengeText)
  ) {
    return "cloudflare";
  }
  if (hasVisibleSelector(CAPTCHA_SELECTORS)) {
    return "captcha";
  }
  return null;
});
