/** Clicks an available chapter link only when its destination matches the request. */
export function chapterNavigationScript(url: string, selector: string): string {
  return `(function (prepareCapture) {
    if (document.readyState === "loading") return false;
    function destination(value) {
      var parsed = new URL(value, location.href);
      parsed.searchParams.delete("_norea_capture");
      return parsed;
    }
    var target = destination(${JSON.stringify(url)});
    var current = destination(location.href);
    if (target.origin !== current.origin || target.href === current.href) return false;
    var links;
    try { links = document.querySelectorAll(${JSON.stringify(selector)}); }
    catch (_) { return false; }
    for (var index = 0; index < links.length; index += 1) {
      var link = links[index];
      if (link.tagName !== "A" || link.hidden || link.hasAttribute("download") ||
          link.getAttribute("aria-disabled") === "true" ||
          (link.getAttribute("target") && link.getAttribute("target") !== "_self")) continue;
      var href = link.getAttribute("href");
      if (!href || destination(href).href !== target.href) continue;
      var style = window.getComputedStyle(link);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      var visible = Array.from(link.getClientRects()).some(function (rect) { return rect.width > 0 && rect.height > 0; });
      if (!visible) continue;
      window.__noreaChapterLinkTargetUrl = target.href;
      prepareCapture();
      setTimeout(function () { link.click(); }, 0);
      return true;
    }
    return false;
  })`;
}
