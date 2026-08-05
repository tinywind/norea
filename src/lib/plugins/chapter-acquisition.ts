import type { ChapterContentType } from "../chapter-content";
import type { ScraperExecutorId } from "../tasks/scraper-queue";
import { captureChapterWebView } from "./shims";
import type {
  ChapterAcquisitionPlan,
  ChapterCaptureLoadStrategy,
  ChapterPageAcquisitionPlan,
  TextChapterContentType,
} from "./types";

const MIN_CAPTURE_TIMEOUT_MS = 1_000;
const MAX_CAPTURE_TIMEOUT_MS = 120_000;
const MAX_DOCUMENT_START_SCRIPT_BYTES = 64 * 1024;
const MAX_EXCLUDE_SELECTORS = 64;

export interface CapturedChapterPage {
  baseUrl: string;
  content: string;
}

export interface CaptureChapterPageOptions {
  contentType: TextChapterContentType;
  executor: ScraperExecutorId;
  signal?: AbortSignal;
  sourceId: string;
}

function validSelector(selector: unknown, field: string): string {
  if (typeof selector !== "string" || selector.trim() === "") {
    throw new Error(`Chapter acquisition ${field} must be a non-empty selector.`);
  }
  const normalized = selector.trim();
  if (typeof document !== "undefined") {
    try {
      document.createDocumentFragment().querySelector(normalized);
    } catch {
      throw new Error(`Chapter acquisition ${field} is not a valid selector.`);
    }
  }
  return normalized;
}

function captureTimeoutMs(value: unknown): number {
  if (value === undefined) return 30_000;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Chapter acquisition timeoutMs must be a finite number.");
  }
  return Math.min(
    MAX_CAPTURE_TIMEOUT_MS,
    Math.max(MIN_CAPTURE_TIMEOUT_MS, Math.round(value)),
  );
}

function captureLoadStrategy(value: unknown): ChapterCaptureLoadStrategy {
  if (value === undefined) return "network-idle";
  if (
    value !== "selector" &&
    value !== "network-idle" &&
    value !== "scroll-to-end"
  ) {
    throw new Error("Chapter acquisition loadStrategy is invalid.");
  }
  return value;
}

function absoluteHttpUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Chapter acquisition page URL must be a string.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Chapter acquisition page URL must be absolute.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Chapter acquisition page URL must use HTTP or HTTPS.");
  }
  return url.href;
}

function validatePagePlan(
  value: Record<string, unknown>,
): ChapterPageAcquisitionPlan {
  const documentStartScript = value.documentStartScript;
  if (
    documentStartScript !== undefined &&
    typeof documentStartScript !== "string"
  ) {
    throw new Error("Chapter acquisition documentStartScript must be a string.");
  }
  if (
    typeof documentStartScript === "string" &&
    new TextEncoder().encode(documentStartScript).byteLength >
      MAX_DOCUMENT_START_SCRIPT_BYTES
  ) {
    throw new Error("Chapter acquisition documentStartScript is too large.");
  }

  const excludeSelectors = value.excludeSelectors;
  if (excludeSelectors !== undefined && !Array.isArray(excludeSelectors)) {
    throw new Error("Chapter acquisition excludeSelectors must be an array.");
  }
  if (
    Array.isArray(excludeSelectors) &&
    excludeSelectors.length > MAX_EXCLUDE_SELECTORS
  ) {
    throw new Error("Chapter acquisition has too many excludeSelectors.");
  }

  return {
    type: "page",
    url: absoluteHttpUrl(value.url),
    contentSelector: validSelector(value.contentSelector, "contentSelector"),
    ...(value.readySelector !== undefined
      ? { readySelector: validSelector(value.readySelector, "readySelector") }
      : {}),
    ...(Array.isArray(excludeSelectors)
      ? {
          excludeSelectors: excludeSelectors.map((selector, index) =>
            validSelector(selector, `excludeSelectors[${index}]`),
          ),
        }
      : {}),
    ...(documentStartScript ? { documentStartScript } : {}),
    loadStrategy: captureLoadStrategy(value.loadStrategy),
    cacheBust: value.cacheBust === true,
    timeoutMs: captureTimeoutMs(value.timeoutMs),
  };
}

export function validateChapterAcquisitionPlan(
  value: unknown,
): ChapterAcquisitionPlan {
  if (value === null || typeof value !== "object") {
    throw new Error("Chapter acquisition plan must be an object.");
  }
  const plan = value as Record<string, unknown>;
  if (plan.type === "resource") return { type: "resource" };
  if (plan.type === "page") return validatePagePlan(plan);
  throw new Error("Chapter acquisition plan type must be 'page' or 'resource'.");
}

function navigationUrl(plan: ChapterPageAcquisitionPlan): string {
  if (!plan.cacheBust) return plan.url;
  const url = new URL(plan.url);
  url.searchParams.set("_norea_capture", Date.now().toString(36));
  return url.href;
}

function chapterCaptureScript(
  plan: ChapterPageAcquisitionPlan,
  contentType: ChapterContentType,
): string {
  const serializedPlan = JSON.stringify(plan);
  const serializedContentType = JSON.stringify(contentType);
  return `(function () {
  var plan = ${serializedPlan};
  var contentType = ${serializedContentType};
  var finished = false;
  var lastActivityAt = Date.now();
  var lastHeight = -1;
  var stableHeightRounds = 0;
  var lastScrollAt = 0;
  function post(payload) {
    if (finished) return;
    finished = true;
    window.ReactNativeWebView.postMessage(JSON.stringify(payload));
  }
  function message(error) {
    return (error && (error.message || error.toString())) || String(error);
  }
  function fail(code, error) {
    post({ ok: false, code: code, error: message(error) });
  }
  function absolute(value) {
    if (!value || /^data:|^blob:/i.test(value)) return value || "";
    try { return new URL(value, location.href).href; } catch (_) { return value; }
  }
  function markActivity() {
    lastActivityAt = Date.now();
  }
  function lazyImageSource(image) {
    var attributes = ["data-src", "data-original", "data-lazy-src", "data-orig-src"];
    for (var index = 0; index < attributes.length; index += 1) {
      var value = image.getAttribute(attributes[index]);
      if (value) return value;
    }
    return "";
  }
  function materializeImageRequests(root) {
    var elements = [root].concat(Array.from(root.querySelectorAll("*")));
    elements.forEach(function (element) {
      var tag = element.tagName ? element.tagName.toLowerCase() : "";
      if (tag !== "img") return;
      var lazySource = lazyImageSource(element);
      var source = absolute(lazySource || element.getAttribute("src"));
      if (!source.startsWith("https://") && !source.startsWith("http://")) return;
      element.setAttribute("loading", "eager");
      if (lazySource || !element.currentSrc) element.setAttribute("src", source);
    });
  }
  try {
    if (typeof PerformanceObserver === "function") {
      new PerformanceObserver(markActivity).observe({ type: "resource", buffered: true });
    }
  } catch (_) {}
  try {
    if (plan.documentStartScript) (0, eval)(plan.documentStartScript);
  } catch (error) {
    fail("capture-failed", "documentStartScript failed: " + message(error));
    return;
  }
  function normalizeClone(sourceRoot, cloneRoot) {
    var sources = [sourceRoot].concat(Array.from(sourceRoot.querySelectorAll("*")));
    var clones = [cloneRoot].concat(Array.from(cloneRoot.querySelectorAll("*")));
    sources.forEach(function (source, index) {
      var clone = clones[index];
      if (!clone) return;
      var tag = source.tagName ? source.tagName.toLowerCase() : "";
      if (tag === "img") {
        var src = source.currentSrc || source.getAttribute("src");
        if (src) clone.setAttribute("src", absolute(src));
        ["data-src", "data-original", "data-lazy-src", "data-orig-src"].forEach(
          function (attribute) {
            var lazySrc = source.getAttribute(attribute);
            if (lazySrc) clone.setAttribute(attribute, absolute(lazySrc));
          }
        );
        clone.removeAttribute("srcset");
      } else if (tag === "source") {
        var sourceSrc = source.getAttribute("src");
        if (sourceSrc) clone.setAttribute("src", absolute(sourceSrc));
      } else if (tag === "video") {
        var poster = source.getAttribute("poster");
        if (poster) clone.setAttribute("poster", absolute(poster));
      } else if (tag === "a") {
        var href = source.getAttribute("href");
        if (href) clone.setAttribute("href", absolute(href));
      }
    });
  }
  function capture() {
    var root = document.querySelector(plan.contentSelector);
    if (!root) {
      fail("content-not-found", "Chapter content selector did not match.");
      return;
    }
    if (contentType === "html") materializeImageRequests(root);
    var clone = root.cloneNode(true);
    normalizeClone(root, clone);
    clone.querySelectorAll("#__norea_scraper_controls").forEach(function (element) {
      element.remove();
    });
    (plan.excludeSelectors || []).forEach(function (selector) {
      clone.querySelectorAll(selector).forEach(function (element) { element.remove(); });
    });
    clone.querySelectorAll("script,noscript").forEach(function (element) { element.remove(); });
    var content = contentType === "html"
      ? clone.innerHTML
      : (clone.textContent || "");
    if (!content.trim()) {
      fail("content-not-found", "Captured chapter content is empty.");
      return;
    }
    post({ ok: true, result: { content: content, url: location.href } });
  }
  function poll() {
    if (finished) return;
    if (document.querySelector("[data-norea-manual-action]")) {
      fail("manual-action-required", "The source page requires manual action.");
      return;
    }
    var readySelector = plan.readySelector || plan.contentSelector;
    var ready = document.readyState !== "loading" && document.querySelector(readySelector);
    if (!ready) {
      setTimeout(poll, 100);
      return;
    }
    if (plan.loadStrategy === "scroll-to-end") {
      var height = Math.max(document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0);
      if (height === lastHeight) stableHeightRounds += 1;
      else stableHeightRounds = 0;
      lastHeight = height;
      if (Date.now() - lastScrollAt >= 200) {
        window.scrollTo(0, height);
        lastScrollAt = Date.now();
      }
      if (stableHeightRounds < 3 || Date.now() - lastActivityAt < 500) {
        setTimeout(poll, 100);
        return;
      }
    } else if (plan.loadStrategy === "network-idle") {
      if (Date.now() - lastActivityAt < 700) {
        setTimeout(poll, 100);
        return;
      }
    }
    try { capture(); } catch (error) { fail("capture-failed", error); }
  }
  poll();
})(); true;`;
}

function parseCaptureResult(raw: string): CapturedChapterPage {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Chapter page capture returned invalid JSON.");
  }
  if (value === null || typeof value !== "object") {
    throw new Error("Chapter page capture returned an invalid envelope.");
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.ok !== true) {
    const code = typeof envelope.code === "string" ? envelope.code : "capture-failed";
    const error = typeof envelope.error === "string" ? envelope.error : "Chapter page capture failed.";
    throw new Error(`${code}: ${error}`);
  }
  if (envelope.result === null || typeof envelope.result !== "object") {
    throw new Error("Chapter page capture returned an invalid result.");
  }
  const result = envelope.result as Record<string, unknown>;
  if (typeof result.content !== "string" || result.content.trim() === "") {
    throw new Error("Chapter page capture returned empty content.");
  }
  return {
    content: result.content,
    baseUrl: absoluteHttpUrl(result.url),
  };
}

export async function captureChapterPage(
  plan: ChapterPageAcquisitionPlan,
  options: CaptureChapterPageOptions,
): Promise<CapturedChapterPage> {
  const raw = await captureChapterWebView(navigationUrl(plan), {
    beforeContentScript: chapterCaptureScript(plan, options.contentType),
    scraperExecutor: options.executor,
    signal: options.signal,
    sourceId: options.sourceId,
    timeoutMs: plan.timeoutMs,
  });
  return parseCaptureResult(raw);
}
