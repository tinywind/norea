import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type Ref,
  type WheelEvent,
} from "react";
import { Box } from "@mantine/core";
import {
  resolveLocalChapterMediaPatches,
  type ChapterMediaElementPatch,
  type ChapterMediaStorageContext,
} from "../lib/chapter-media";
import { formatTimeForLocale, useTranslation, type AppLocale } from "../i18n";
import {
  useReaderStore,
  type ReaderAppearanceSettings,
  type ReaderGeneralSettings,
  type ReaderTapAction,
  type ReaderTapZone,
} from "../store/reader";
import { ReaderSeekbars } from "./ReaderSeekbars";
import {
  prefixSegmentHeights,
  virtualRangeForScroll,
} from "./reader-virtualization";

export interface ReaderContentHandle {
  completeIfAtEnd: () => boolean;
  patchMediaElements: (patches: ChapterMediaElementPatch[]) => void;
  scrollByPage: (direction: 1 | -1, source?: string) => void;
  scrollToStart: () => void;
}

interface ReaderContentProps {
  appearanceSettings?: ReaderAppearanceSettings;
  bottomOverlayOffset?: number | string;
  contentKey?: number | string;
  generalSettings?: ReaderGeneralSettings;
  html: string;
  initialProgress?: number;
  interactionBlocked?: boolean;
  localMediaContext?: ChapterMediaStorageContext;
  onProgressChange?: (progress: number) => void;
  onPageIndexChange?: (pageIndex: number) => void;
  onMediaError?: (source: string | null) => void;
  onSeekbarActivity?: () => void;
  onSeekbarActiveChange?: (active: boolean) => void;
  onToggleChrome?: () => void;
  onBoundaryPage?: (direction: 1 | -1) => void;
  viewportHeight?: string;
}

interface BatteryManagerLike {
  level: number;
  charging: boolean;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

interface PageInfo {
  current: number;
  total: number;
}

interface ReaderVirtualSegment {
  estimatedHeight: number;
  html: string;
  index: number;
}

interface ReaderVirtualDocument {
  contentClassName: string;
  contentDirection?: "ltr" | "rtl" | "auto";
  contentLanguage?: string;
  segments: ReaderVirtualSegment[];
  staticHtml: string;
}

interface ReaderViewportSize {
  width: number;
  height: number;
}

interface ReaderInitialProgressRestore {
  contentKey: number | string | undefined;
  progress: number;
}

interface ReaderMediaPatchTargetIndex {
  byIndex: Map<number, HTMLElement[]>;
  bySource: Map<string, HTMLElement[]>;
  elements: HTMLElement[];
}

const SCROLL_PAGE_FRACTION = 0.9;
const TWO_PAGE_MIN_COLUMN_WIDTH = 320;
const PAGED_SCROLL_ANIMATION_MS = 500;
const PROGRESS_SAVE_DELAY_MS = 350;
const WHEEL_PAGE_COOLDOWN_MS = 220;
const WHEEL_PAGE_DELTA_THRESHOLD = 20;
const NATIVE_WHEEL_ACTION_LOCK_MS = 240;
const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;
const PAGED_SCROLL_POSITION_TOLERANCE_PX = 2;
const PAGED_TRAILING_PAGE_TOLERANCE_MAX_PX = 32;
const PAGED_TRAILING_PAGE_TOLERANCE_FRACTION = 0.03;
const READER_MEDIA_EVENT_SELECTOR =
  "img,picture,svg,video,audio,canvas,iframe,figure";
const READER_MEDIA_PATCH_SELECTOR = [
  "img[src]",
  "video[src]",
  "audio[src]",
  "source[src]",
  "embed[src]",
  "track[src]",
  "img[data-src]",
  "img[data-original]",
  "img[data-lazy-src]",
  "img[data-orig-src]",
  "video[data-src]",
  "video[data-original]",
  "video[data-lazy-src]",
  "video[data-orig-src]",
  "audio[data-src]",
  "audio[data-original]",
  "audio[data-lazy-src]",
  "audio[data-orig-src]",
  "source[data-src]",
  "source[data-original]",
  "source[data-lazy-src]",
  "source[data-orig-src]",
  "video[poster]",
  "object[data]",
  'link[href][rel~="preload"][as="image"]',
  'link[href][rel~="preload"][as="video"]',
  'link[href][rel~="preload"][as="audio"]',
  "image[href]",
  "image[xlink\\:href]",
  "use[href]",
  "use[xlink\\:href]",
  "img[srcset]",
  "source[srcset]",
  "[style]",
].join(",");
const READER_MEDIA_PATCH_ATTRIBUTES = [
  "src",
  "srcset",
  "poster",
  "data",
  "href",
  "xlink:href",
  "data-src",
  "data-original",
  "data-lazy-src",
  "data-orig-src",
  "style",
] as const;
const READER_PROTECTED_LOCAL_MEDIA_ATTRIBUTES = {
  src: "data-norea-reader-local-media-src",
  srcset: "data-norea-reader-local-media-srcset",
  poster: "data-norea-reader-local-media-poster",
  data: "data-norea-reader-local-media-data",
  href: "data-norea-reader-local-media-href",
  "xlink:href": "data-norea-reader-local-media-xlink-href",
  "data-src": "data-norea-reader-local-media-data-src",
  "data-original": "data-norea-reader-local-media-data-original",
  "data-lazy-src": "data-norea-reader-local-media-data-lazy-src",
  "data-orig-src": "data-norea-reader-local-media-data-orig-src",
  style: "data-norea-reader-local-media-style",
} as const satisfies Record<
  (typeof READER_MEDIA_PATCH_ATTRIBUTES)[number],
  string
>;
const READER_MEDIA_SOURCE_URL_ATTRIBUTE = "data-norea-media-source-url";
const READER_PENDING_MEDIA_ATTRIBUTE = "data-norea-reader-media-pending";
const READER_PENDING_BACKGROUND_ATTRIBUTE = "data-norea-reader-media-bg";
const READER_PENDING_DISPLAY_ATTRIBUTE = "data-norea-reader-media-display";
const READER_PENDING_HEIGHT_ATTRIBUTE = "data-norea-reader-media-height";
const READER_MEDIA_INDEX_ATTRIBUTE = "data-norea-reader-media-index";
const READER_SEGMENT_INDEX_ATTRIBUTE = "data-norea-reader-segment-index";
const READER_PENDING_PLACEHOLDER_SRC =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%221000%22%20height%3D%221400%22%20viewBox%3D%220%200%201000%201400%22%2F%3E";
const READER_EMPTY_MEDIA_PLACEHOLDER_SRC =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%221%22%20height%3D%221%22%2F%3E";
const READER_PENDING_PLACEHOLDER_HEIGHT = "min(72vh, 56rem)";
const READER_LOCAL_MEDIA_SRC_PREFIX = "norea-media://chapter/";
const READER_STYLE_URL_PATTERN =
  /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*?))\s*\)/gi;
const READER_SCROLL_OVERSCAN_PX = 1800;
const READER_SEGMENT_DEFAULT_HEIGHT = 96;
const READER_SEGMENT_MEDIA_HEIGHT = 520;
const READER_DOM_PREPROCESS_MAX_HTML_LENGTH = 350_000;
const READER_LARGE_SEGMENT_TARGET_LENGTH = 24_000;
const READER_LARGE_SEGMENT_MAX_LENGTH = 80_000;
const READER_TEXT_SEGMENT_TARGET_LENGTH = 2_000;
const READER_TEXT_SEGMENT_MIN_SPLIT_LENGTH = 1_000;
const READER_TEXT_CONTENT_CLASS_PATTERN = /\breader-text-content\b/;
const READER_TEXT_BLOCK_PATTERN =
  /<p\b[^>]*>([\s\S]*?)<\/p>|<div\b(?=[^>]*\breader-text-break\b)[^>]*\bdata-blank-lines=(?:"(\d+)"|'(\d+)'|(\d+))[^>]*>\s*<\/div>/gi;
const READER_TEXT_LINE_PATTERN =
  /<span\b(?=[^>]*\breader-text-line\b)[^>]*>([\s\S]*?)<\/span>/gi;
const READER_PAGE_MEDIA_ELEMENTS = [
  "img",
  "svg",
  "video",
  "canvas",
  "iframe",
] as const;
const READER_PAGE_SINGLE_MEDIA_ELEMENTS = [
  "img",
  "picture",
  "svg",
  "video",
  "canvas",
  "iframe",
] as const;
const READER_PAGE_SINGLE_FLOW_ELEMENTS = ["p", "div", "figure", "a"] as const;
const READER_PREPROCESSED_HTML_CACHE_LIMIT = 8;
const READER_PROTECTED_HTML_CACHE_LIMIT = 12;
const READER_VIRTUAL_DOCUMENT_CACHE_LIMIT = 8;
const readerPreprocessedHtmlCache = new Map<string, string>();
const readerProtectedHtmlCache = new Map<string, string>();
const readerVirtualDocumentCache = new Map<string, ReaderVirtualDocument>();

function cssSelectorList(
  prefix: string,
  elements: readonly string[],
  suffix = "",
): string {
  return elements.map((element) => `${prefix}${element}${suffix}`).join(",\n");
}

function rememberReaderCacheValue<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
  limit: number,
): T {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);
  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  return value;
}

function readerStringFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${hash >>> 0}`;
}

function readerLocalMediaMapFingerprint(
  resolvedLocalMedia?: ReadonlyMap<string, string>,
): string {
  if (!resolvedLocalMedia || resolvedLocalMedia.size === 0) return "0";
  let hash = 2166136261;
  for (const [source, resolved] of [...resolvedLocalMedia.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const entry = `${source}\u0000${resolved}`;
    for (let index = 0; index < entry.length; index += 1) {
      hash ^= entry.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${resolvedLocalMedia.size}:${hash >>> 0}`;
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, progress));
}

function getReaderDebugSnapshot(node: HTMLElement | null) {
  if (!node) return null;
  const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
  return {
    scrollTop: Math.round(node.scrollTop),
    maxTop: Math.round(maxTop),
    scrollLeft: Math.round(node.scrollLeft),
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  };
}

function logReaderInput(
  event: string,
  details: Record<string, unknown> | (() => Record<string, unknown>),
): void {
  if (!import.meta.env.DEV) return;
  console.warn(
    "[reader-input:html]",
    event,
    typeof details === "function" ? details() : details,
  );
}

function logReaderMediaPipeline(
  event: string,
  details: Record<string, unknown>,
): void {
  if (!import.meta.env.DEV) return;
  console.warn("[reader-media:content]", event, details);
}

function dispatchReaderScrollEvent(node: HTMLElement): void {
  node.dispatchEvent(new Event("scroll", { bubbles: true }));
}

function easeOutCubic(progress: number): number {
  return 1 - Math.pow(1 - progress, 3);
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (isReaderMediaEventTarget(target)) return true;
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest(
    "button,a,input,select,textarea,[role='button'],[role='slider']",
  );
}

function getReaderEventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function isReaderMediaEventTarget(target: EventTarget | null): boolean {
  const element = getReaderEventElement(target);
  if (!element) return false;
  if (element.closest(READER_MEDIA_EVENT_SELECTOR)) return true;
  const link = element.closest("a");
  return !!link?.querySelector(READER_MEDIA_EVENT_SELECTOR);
}

function stopReaderMediaClick(event: MouseEvent<HTMLDivElement>): void {
  if (!isReaderMediaEventTarget(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
}

function mediaPatchValueKind(value: string): string {
  if (value === "") return "blank";
  if (value.startsWith("data:")) return "data-url";
  if (value.startsWith("norea-media://")) return "local-media";
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return "remote";
  }
  return "other";
}

function isRemoteMediaUrl(value: string): boolean {
  try {
    const parsed = new URL(value, window.location.href);
    if (parsed.host === "asset.localhost") return false;
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return value.startsWith("//");
  }
}

function mediaErrorSource(target: EventTarget | null): string | null {
  if (target instanceof HTMLImageElement) {
    return target.currentSrc || target.src || target.getAttribute("src");
  }
  if (target instanceof HTMLVideoElement || target instanceof HTMLAudioElement) {
    return target.currentSrc || target.src || target.getAttribute("src");
  }
  if (target instanceof HTMLSourceElement) {
    return target.src || target.getAttribute("src");
  }
  if (target instanceof HTMLEmbedElement) {
    return target.src || target.getAttribute("src");
  }
  if (target instanceof HTMLIFrameElement) {
    return target.src || target.getAttribute("src");
  }
  if (target instanceof HTMLObjectElement) {
    return target.data || target.getAttribute("data");
  }
  return target instanceof HTMLElement ? target.getAttribute("src") : null;
}

function mediaLogHost(value: string): string {
  try {
    return new URL(value, window.location.href).host;
  } catch {
    return "invalid";
  }
}

function hasLocalChapterMediaValue(value: string | null): value is string {
  return !!value?.includes(READER_LOCAL_MEDIA_SRC_PREFIX);
}

function hasReaderMediaPatchCandidate(html: string): boolean {
  return /<(?:img|video|audio|source|embed|track|object|link|image|use)\b|\b(?:style|srcset|poster|data-src|data-original|data-lazy-src|data-orig-src)\s*=/i.test(
    html,
  );
}

function protectedLocalMediaAttribute(
  attribute: string,
): string | undefined {
  return READER_PROTECTED_LOCAL_MEDIA_ATTRIBUTES[
    attribute as keyof typeof READER_PROTECTED_LOCAL_MEDIA_ATTRIBUTES
  ];
}

function setReaderLocalMediaPlaceholder(
  element: Element,
  attribute: string,
  value: string,
  resolvedLocalMedia?: ReadonlyMap<string, string>,
): void {
  const resolvedValue = resolvedLocalMedia?.get(value);
  if (resolvedValue) {
    element.setAttribute(attribute, resolvedValue);
    return;
  }
  const protectedAttribute = protectedLocalMediaAttribute(attribute);
  if (!protectedAttribute) return;
  element.setAttribute(protectedAttribute, value);
  if (attribute === "style") {
    element.setAttribute(
      "style",
      value.replace(
        READER_STYLE_URL_PATTERN,
        (match, doubleQuoted, singleQuoted, unquoted) => {
          const source = String(
            doubleQuoted ?? singleQuoted ?? unquoted ?? "",
          ).trim();
          if (!source.includes(READER_LOCAL_MEDIA_SRC_PREFIX)) return match;
          const resolvedStyleUrl = resolvedLocalMedia?.get(source);
          return `url("${resolvedStyleUrl ?? READER_EMPTY_MEDIA_PLACEHOLDER_SRC}")`;
        },
      ),
    );
    return;
  }
  if (attribute === "src" && element instanceof HTMLImageElement) {
    setReaderPendingImagePlaceholder(element);
    return;
  }
  element.setAttribute(attribute, READER_EMPTY_MEDIA_PLACEHOLDER_SRC);
}

function protectLocalReaderMedia(
  html: string,
  resolvedLocalMedia?: ReadonlyMap<string, string>,
): string {
  if (
    typeof document === "undefined" ||
    !html.includes(READER_LOCAL_MEDIA_SRC_PREFIX)
  ) {
    return html;
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  let protectedCount = 0;
  let changed = false;

  for (const element of template.content.querySelectorAll<Element>(
    READER_MEDIA_PATCH_SELECTOR,
  )) {
    for (const attribute of READER_MEDIA_PATCH_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (!hasLocalChapterMediaValue(value)) continue;
      setReaderLocalMediaPlaceholder(
        element,
        attribute,
        value,
        resolvedLocalMedia,
      );
      changed = true;
      if (!resolvedLocalMedia?.has(value)) {
        protectedCount += 1;
      }
    }
  }

  if (protectedCount > 0) {
    logReaderMediaPipeline("protect-local-media", {
      htmlLength: html.length,
      protectedCount,
    });
  }
  return changed ? template.innerHTML : html;
}

function stripLocalMediaFontFaces(html: string): string {
  if (!html.includes(READER_LOCAL_MEDIA_SRC_PREFIX)) return html;
  return html.replace(
    /@font-face\s*{[^}]*norea-media:\/\/chapter\/[^}]*}/gi,
    "",
  );
}

function prepareReaderHtmlForDisplay(html: string): string {
  if (
    typeof document === "undefined" ||
    !html.includes(READER_MEDIA_SOURCE_URL_ATTRIBUTE)
  ) {
    return html;
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  let changed = false;

  let placeholderCount = 0;
  for (const image of template.content.querySelectorAll<HTMLImageElement>(
    `img[${READER_MEDIA_SOURCE_URL_ATTRIBUTE}]`,
  )) {
    if ((image.getAttribute("src") ?? "").trim() !== "") continue;
    setReaderPendingImagePlaceholder(image);
    placeholderCount += 1;
    changed = true;
  }

  if (changed) {
    logReaderMediaPipeline("placeholder-shell", {
      htmlLength: html.length,
      placeholderCount,
    });
  }
  return changed ? template.innerHTML : html;
}

function annotateReaderMediaElements(html: string): string {
  if (typeof document === "undefined" || !hasReaderMediaPatchCandidate(html)) {
    return html;
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  const elements = [
    ...template.content.querySelectorAll<HTMLElement>(
      READER_MEDIA_PATCH_SELECTOR,
    ),
  ];
  elements.forEach((element, index) => {
    element.setAttribute(READER_MEDIA_INDEX_ATTRIBUTE, String(index));
  });
  return template.innerHTML;
}

function preprocessReaderHtmlShell(html: string, bionicReading: boolean): string {
  if (html.length > READER_DOM_PREPROCESS_MAX_HTML_LENGTH) return html;
  const key = [
    "shell:v1",
    typeof document === "undefined" ? "no-document" : "document",
    bionicReading ? "bionic" : "plain",
    readerStringFingerprint(html),
  ].join("|");
  const cached = readerPreprocessedHtmlCache.get(key);
  if (cached !== undefined) return cached;

  const preparedHtml = prepareReaderHtmlForDisplay(html);
  const displayHtml = bionicReading
    ? applyBionicReading(preparedHtml)
    : preparedHtml;
  return rememberReaderCacheValue(
    readerPreprocessedHtmlCache,
    key,
    annotateReaderMediaElements(displayHtml),
    READER_PREPROCESSED_HTML_CACHE_LIMIT,
  );
}

function protectLocalReaderMediaCached(
  html: string,
  resolvedLocalMedia?: ReadonlyMap<string, string>,
): string {
  if (
    typeof document === "undefined" ||
    !html.includes(READER_LOCAL_MEDIA_SRC_PREFIX)
  ) {
    return html;
  }
  const key = [
    "protect:v1",
    readerStringFingerprint(html),
    readerLocalMediaMapFingerprint(resolvedLocalMedia),
  ].join("|");
  const cached = readerProtectedHtmlCache.get(key);
  if (cached !== undefined) return cached;
  return rememberReaderCacheValue(
    readerProtectedHtmlCache,
    key,
    protectLocalReaderMedia(html, resolvedLocalMedia),
    READER_PROTECTED_HTML_CACHE_LIMIT,
  );
}

function preprocessReaderHtmlForRender(
  html: string,
  bionicReading: boolean,
  resolvedLocalMedia?: ReadonlyMap<string, string>,
): string {
  return protectLocalReaderMediaCached(
    preprocessReaderHtmlShell(html, bionicReading),
    resolvedLocalMedia,
  );
}

function setReaderPendingImagePlaceholder(image: HTMLImageElement): void {
  image.setAttribute("src", READER_PENDING_PLACEHOLDER_SRC);
  image.setAttribute(READER_PENDING_MEDIA_ATTRIBUTE, "true");
  if (image.style.display === "") {
    image.style.display = "block";
    image.setAttribute(READER_PENDING_DISPLAY_ATTRIBUTE, "true");
  }
  if (image.style.minHeight === "") {
    image.style.minHeight = READER_PENDING_PLACEHOLDER_HEIGHT;
    image.setAttribute(READER_PENDING_HEIGHT_ATTRIBUTE, "true");
  }
  if (image.style.backgroundColor === "") {
    image.style.backgroundColor = "rgba(148, 163, 184, 0.12)";
    image.setAttribute(READER_PENDING_BACKGROUND_ATTRIBUTE, "true");
  }
}

function clearReaderPendingMedia(element: HTMLElement): void {
  if (!element.hasAttribute(READER_PENDING_MEDIA_ATTRIBUTE)) return;
  element.removeAttribute(READER_PENDING_MEDIA_ATTRIBUTE);
  if (element.hasAttribute(READER_PENDING_BACKGROUND_ATTRIBUTE)) {
    element.style.removeProperty("background-color");
    element.removeAttribute(READER_PENDING_BACKGROUND_ATTRIBUTE);
  }
  if (element.hasAttribute(READER_PENDING_DISPLAY_ATTRIBUTE)) {
    element.style.removeProperty("display");
    element.removeAttribute(READER_PENDING_DISPLAY_ATTRIBUTE);
  }
  if (element.hasAttribute(READER_PENDING_HEIGHT_ATTRIBUTE)) {
    element.style.removeProperty("min-height");
    element.removeAttribute(READER_PENDING_HEIGHT_ATTRIBUTE);
  }
}

function clearProtectedLocalMediaAttribute(
  element: HTMLElement,
  attribute: string,
): void {
  const protectedAttribute = protectedLocalMediaAttribute(attribute);
  if (protectedAttribute) {
    element.removeAttribute(protectedAttribute);
  }
}

function mergeMediaElementPatches(
  current: Map<number, ChapterMediaElementPatch>,
  patches: ChapterMediaElementPatch[],
): void {
  for (const patch of patches) {
    const existing = current.get(patch.index);
    current.set(patch.index, {
      index: patch.index,
      attributes: {
        ...(existing?.attributes ?? {}),
        ...patch.attributes,
      },
      sourceAttributes: {
        ...(existing?.sourceAttributes ?? {}),
        ...(patch.sourceAttributes ?? {}),
      },
    });
  }
}

function readerMediaPatchSourceKey(attribute: string, source: string): string {
  return `${attribute}\u0000${source}`;
}

function addReaderMediaPatchSourceTarget(
  targets: Map<string, HTMLElement[]>,
  attribute: string,
  source: string | null,
  element: HTMLElement,
): void {
  if (!source) return;
  const key = readerMediaPatchSourceKey(attribute, source);
  const existing = targets.get(key);
  if (existing) {
    existing.push(element);
    return;
  }
  targets.set(key, [element]);
}

function buildReaderMediaPatchTargetIndex(
  container: HTMLElement,
): ReaderMediaPatchTargetIndex {
  const elements = [
    ...container.querySelectorAll<HTMLElement>(READER_MEDIA_PATCH_SELECTOR),
  ];
  const byIndex = new Map<number, HTMLElement[]>();
  const bySource = new Map<string, HTMLElement[]>();

  elements.forEach((element) => {
    const index = Number.parseInt(
      element.getAttribute(READER_MEDIA_INDEX_ATTRIBUTE) ?? "",
      10,
    );
    if (Number.isFinite(index) && index >= 0) {
      const indexed = byIndex.get(index);
      if (indexed) {
        indexed.push(element);
      } else {
        byIndex.set(index, [element]);
      }
    }

    for (const attribute of READER_MEDIA_PATCH_ATTRIBUTES) {
      addReaderMediaPatchSourceTarget(
        bySource,
        attribute,
        element.getAttribute(attribute),
        element,
      );
      const protectedAttribute = protectedLocalMediaAttribute(attribute);
      if (protectedAttribute) {
        addReaderMediaPatchSourceTarget(
          bySource,
          attribute,
          element.getAttribute(protectedAttribute),
          element,
        );
      }
    }
  });

  return { byIndex, bySource, elements };
}

function localMediaPatchTargets(
  targetIndex: ReaderMediaPatchTargetIndex,
  patch: ChapterMediaElementPatch,
): HTMLElement[] | null {
  const sourceAttributes = patch.sourceAttributes;
  if (!sourceAttributes || Object.keys(sourceAttributes).length === 0) {
    return null;
  }
  const targets = new Set<HTMLElement>();
  for (const [attribute, source] of Object.entries(sourceAttributes)) {
    for (const element of targetIndex.bySource.get(
      readerMediaPatchSourceKey(attribute, source),
    ) ?? []) {
      targets.add(element);
    }
  }
  return [...targets];
}

function patchReaderMediaElements(
  container: HTMLElement,
  patches: ChapterMediaElementPatch[],
): void {
  if (patches.length === 0) return;
  const targetIndex = buildReaderMediaPatchTargetIndex(container);
  let changedCount = 0;
  const srcKinds = new Set<string>();

  for (const patch of patches) {
    const localTargets = localMediaPatchTargets(targetIndex, patch);
    const indexedElements = targetIndex.byIndex.get(patch.index) ?? [];
    const targets =
      localTargets
        ? localTargets
        : indexedElements.length > 0
        ? indexedElements
        : targetIndex.elements[patch.index]
          ? [targetIndex.elements[patch.index]]
          : [];
    for (const current of targets) {
      let changed = false;
      for (const [attribute, value] of Object.entries(patch.attributes)) {
        if (
          !(READER_MEDIA_PATCH_ATTRIBUTES as readonly string[]).includes(
            attribute,
          )
        ) {
          continue;
        }
        if (value.trim() === "") continue;
        if (attribute === "src" || attribute === "srcset") {
          srcKinds.add(mediaPatchValueKind(value));
        }
        if ((current.getAttribute(attribute) ?? "") !== value) {
          current.setAttribute(attribute, value);
          changed = true;
        }
        clearProtectedLocalMediaAttribute(current, attribute);
      }
      if (changed) {
        changedCount += 1;
        clearReaderPendingMedia(current);
      }
    }
  }
  if (changedCount > 0) {
    logReaderMediaPipeline("patch-elements", {
      changedCount,
      patchCount: patches.length,
      srcKinds: [...srcKinds],
      firstIndexes: patches.slice(0, 8).map((patch) => patch.index),
      mediaElementCount: targetIndex.elements.length,
    });
  }
}

function collectMountedLocalMediaPatches(
  container: HTMLElement,
): ChapterMediaElementPatch[] {
  const elements = [
    ...container.querySelectorAll<HTMLElement>(READER_MEDIA_PATCH_SELECTOR),
  ];
  const patches: ChapterMediaElementPatch[] = [];
  elements.forEach((element, index) => {
    const attributes: Record<string, string> = {};
    const sourceAttributes: Record<string, string> = {};
    for (const attribute of READER_MEDIA_PATCH_ATTRIBUTES) {
      const protectedAttribute = protectedLocalMediaAttribute(attribute);
      const value =
        (protectedAttribute
          ? element.getAttribute(protectedAttribute)
          : null) ?? element.getAttribute(attribute);
      if (hasLocalChapterMediaValue(value)) {
        attributes[attribute] = value;
        sourceAttributes[attribute] = value;
      }
    }
    if (Object.keys(attributes).length > 0) {
      patches.push({ index, attributes, sourceAttributes });
    }
  });
  return patches;
}

function localMediaPatchSignature(patches: ChapterMediaElementPatch[]): string {
  return patches
    .map((patch) =>
      READER_MEDIA_PATCH_ATTRIBUTES.map((attribute) => {
        const source = patch.sourceAttributes?.[attribute];
        return source ? `${attribute}=${source}` : "";
      })
        .filter(Boolean)
        .join("&"),
    )
    .filter(Boolean)
    .join("|");
}

function hasLocalMediaSourceAttributes(
  patch: ChapterMediaElementPatch,
): boolean {
  return (
    !!patch.sourceAttributes &&
    Object.keys(patch.sourceAttributes).length > 0
  );
}

function resolveMountedLocalMediaPatchesFromMap(
  patches: ChapterMediaElementPatch[],
  resolvedLocalMedia: ReadonlyMap<string, string>,
): ChapterMediaElementPatch[] | null {
  const resolvedPatches: ChapterMediaElementPatch[] = [];
  for (const patch of patches) {
    const attributes: Record<string, string> = {};
    for (const attribute of READER_MEDIA_PATCH_ATTRIBUTES) {
      const source = patch.sourceAttributes?.[attribute];
      if (!source) continue;
      const resolved = resolvedLocalMedia.get(source);
      if (!resolved) return null;
      attributes[attribute] = resolved;
    }
    resolvedPatches.push({
      index: patch.index,
      attributes,
      sourceAttributes: patch.sourceAttributes,
    });
  }
  return resolvedPatches;
}

function countBlankReaderMedia(html: string): number {
  if (html.length > READER_DOM_PREPROCESS_MAX_HTML_LENGTH) {
    return html.match(/<img\b[^>]*\bsrc\s*=\s*["']\s*["'][^>]*>/gi)?.length ?? 0;
  }
  if (typeof document === "undefined") return 0;
  const template = document.createElement("template");
  template.innerHTML = html;
  return [
    ...template.content.querySelectorAll<HTMLImageElement>(
      `img[${READER_MEDIA_SOURCE_URL_ATTRIBUTE}]`,
    ),
  ].filter((image) => (image.getAttribute("src") ?? "").trim() === "").length;
}

function countDataUrlReaderMedia(html: string): number {
  if (html.length > READER_DOM_PREPROCESS_MAX_HTML_LENGTH) {
    return html.match(/\b(?:src|poster|data|href)\s*=\s*["']data:/gi)?.length ?? 0;
  }
  if (typeof document === "undefined") return 0;
  const template = document.createElement("template");
  template.innerHTML = html;
  return [...template.content.querySelectorAll<HTMLImageElement>("img")].filter(
    (image) => (image.getAttribute("src") ?? "").startsWith("data:"),
  ).length;
}

function serializeNode(node: Node): string {
  const container = document.createElement("div");
  container.appendChild(node.cloneNode(true));
  return container.innerHTML;
}

function estimatedSegmentHeight(element: Element): number {
  if (element.querySelector("img,picture,svg,video,canvas,iframe")) {
    return READER_SEGMENT_MEDIA_HEIGHT;
  }
  const textLength = element.textContent?.trim().length ?? 0;
  if (textLength <= 0) return READER_SEGMENT_DEFAULT_HEIGHT;
  return Math.max(
    READER_SEGMENT_DEFAULT_HEIGHT,
    Math.min(1200, Math.ceil(textLength / 4)),
  );
}

function nodeSegmentHtml(node: Node, index: number): string | null {
  if (node instanceof Text) {
    const text = node.textContent ?? "";
    if (text.trim() === "") return null;
    const paragraph = document.createElement("p");
    paragraph.setAttribute(READER_SEGMENT_INDEX_ATTRIBUTE, String(index));
    paragraph.textContent = text;
    return paragraph.outerHTML;
  }
  if (!(node instanceof Element)) return null;
  const element = node.cloneNode(true) as Element;
  element.setAttribute(READER_SEGMENT_INDEX_ATTRIBUTE, String(index));
  return serializeNode(element);
}

function readerContentClassFromRoot(root: Element | null): string {
  const classes = new Set(["reader-content"]);
  for (const className of root?.classList ?? []) {
    classes.add(className);
  }
  return [...classes].join(" ");
}

function htmlAttributeValue(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(
    attributes,
  );
  return match?.[1];
}

function stripSingleReaderContentWrapper(html: string): {
  contentClassName: string;
  contentDirection?: "ltr" | "rtl" | "auto";
  contentHtml: string;
  contentLanguage?: string;
} {
  const trimmed = html.trim();
  const match = /^<([a-z][\w:-]*)([^>]*\bclass\s*=\s*["'][^"']*\breader-content\b[^"']*["'][^>]*)>([\s\S]*)<\/\1>\s*$/i.exec(
    trimmed,
  );
  if (!match) {
    return {
      contentClassName: "reader-content",
      contentHtml: html,
    };
  }
  const attributes = match[2] ?? "";
  const classes = new Set(["reader-content"]);
  for (const className of (htmlAttributeValue(attributes, "class") ?? "").split(
    /\s+/,
  )) {
    if (className) classes.add(className);
  }
  const dir = htmlAttributeValue(attributes, "dir");
  const lang = htmlAttributeValue(attributes, "lang");
  return {
    contentClassName: [...classes].join(" "),
    ...(dir === "ltr" || dir === "rtl" || dir === "auto"
      ? { contentDirection: dir }
      : {}),
    contentHtml: match[3] ?? "",
    ...(lang ? { contentLanguage: lang } : {}),
  };
}

function estimateHtmlSegmentHeight(html: string): number {
  if (/<(?:img|picture|svg|video|canvas|iframe)\b/i.test(html)) {
    return READER_SEGMENT_MEDIA_HEIGHT;
  }
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return READER_SEGMENT_DEFAULT_HEIGHT;
  return Math.max(
    READER_SEGMENT_DEFAULT_HEIGHT,
    Math.min(1200, Math.ceil(text.length / 4)),
  );
}

function escapeReaderHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeReaderHtmlText(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|#39|#x27|#(\d+)|#x([\da-f]+));/gi,
    (entity, decimal, hex) => {
      const normalized = entity.toLowerCase();
      if (normalized === "&amp;") return "&";
      if (normalized === "&lt;") return "<";
      if (normalized === "&gt;") return ">";
      if (normalized === "&quot;") return '"';
      if (normalized === "&#39;" || normalized === "&#x27;") return "'";
      const codePoint = decimal
        ? Number.parseInt(decimal, 10)
        : Number.parseInt(hex, 16);
      return Number.isFinite(codePoint)
        ? String.fromCodePoint(codePoint)
        : entity;
    },
  );
}

function stripReaderTextTags(value: string): string {
  return value.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "");
}

function readerTextParagraphText(html: string): string {
  const lines: string[] = [];
  let match: RegExpExecArray | null;
  READER_TEXT_LINE_PATTERN.lastIndex = 0;
  while ((match = READER_TEXT_LINE_PATTERN.exec(html)) !== null) {
    lines.push(decodeReaderHtmlText(match[1] ?? ""));
  }
  if (lines.length > 0) return lines.join("\n");
  return decodeReaderHtmlText(stripReaderTextTags(html));
}

function estimateTextSegmentHeight(textLength: number): number {
  return Math.max(
    READER_SEGMENT_DEFAULT_HEIGHT,
    Math.min(1600, Math.ceil(textLength / 4)),
  );
}

function splitReaderTextBlock(text: string): string[] {
  if (text.length <= READER_TEXT_SEGMENT_TARGET_LENGTH) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const hardLimit = Math.min(
      text.length,
      start + READER_TEXT_SEGMENT_TARGET_LENGTH,
    );
    if (hardLimit >= text.length) {
      chunks.push(text.slice(start));
      break;
    }
    const minSplit = start + READER_TEXT_SEGMENT_MIN_SPLIT_LENGTH;
    const newlineSplit = text.lastIndexOf("\n", hardLimit);
    const spaceSplit = text.lastIndexOf(" ", hardLimit);
    const splitAt =
      newlineSplit >= minSplit
        ? newlineSplit + 1
        : spaceSplit >= minSplit
          ? spaceSplit + 1
          : hardLimit;
    chunks.push(text.slice(start, splitAt));
    start = splitAt;
  }
  return chunks;
}

function pushReaderTextSegment(
  segments: ReaderVirtualSegment[],
  parts: string[],
  textLength: number,
): void {
  if (parts.length === 0) return;
  const index = segments.length;
  const html = [
    `<section class="reader-text-section" data-section-index="${index}" ${READER_SEGMENT_INDEX_ATTRIBUTE}="${index}">`,
    parts.join(""),
    "</section>",
  ].join("");
  segments.push({
    estimatedHeight: estimateTextSegmentHeight(textLength),
    html,
    index,
  });
}

function buildReaderTextVirtualDocument(
  html: string,
): ReaderVirtualDocument | null {
  if (!READER_TEXT_CONTENT_CLASS_PATTERN.test(html)) return null;
  const segments: ReaderVirtualSegment[] = [];
  const segmentParts: string[] = [];
  let segmentTextLength = 0;
  let matched = false;

  const flush = () => {
    pushReaderTextSegment(segments, segmentParts, segmentTextLength);
    segmentParts.length = 0;
    segmentTextLength = 0;
  };
  const appendPart = (part: string, textLength: number) => {
    if (
      segmentParts.length > 0 &&
      segmentTextLength + textLength > READER_TEXT_SEGMENT_TARGET_LENGTH
    ) {
      flush();
    }
    segmentParts.push(part);
    segmentTextLength += textLength;
    if (segmentTextLength >= READER_TEXT_SEGMENT_TARGET_LENGTH) {
      flush();
    }
  };

  READER_TEXT_BLOCK_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = READER_TEXT_BLOCK_PATTERN.exec(html)) !== null) {
    matched = true;
    const paragraphHtml = match[1];
    if (paragraphHtml !== undefined) {
      for (const chunk of splitReaderTextBlock(
        readerTextParagraphText(paragraphHtml),
      )) {
        appendPart(
          `<p class="reader-text-paragraph">${escapeReaderHtmlText(chunk)}</p>`,
          chunk.length,
        );
      }
      continue;
    }
    const blankLines = Number.parseInt(
      match[2] ?? match[3] ?? match[4] ?? "2",
      10,
    );
    const normalizedBlankLines = Number.isFinite(blankLines) ? blankLines : 2;
    appendPart(
      `<div class="reader-text-break" data-blank-lines="${normalizedBlankLines}" aria-hidden="true"></div>`,
      0,
    );
  }
  flush();
  if (!matched || segments.length === 0) return null;

  return {
    contentClassName: "reader-content reader-text-content",
    segments,
    staticHtml: "",
  };
}

function largeHtmlSplitIndex(html: string): number {
  const limit = Math.min(READER_LARGE_SEGMENT_MAX_LENGTH, html.length - 1);
  if (limit <= READER_LARGE_SEGMENT_TARGET_LENGTH) return 0;
  const boundaryPattern =
    /<\/(?:p|div|section|article|figure|blockquote|pre|ul|ol|li|h[1-6]|table|tr|hr)>/gi;
  let splitIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = boundaryPattern.exec(html)) !== null) {
    const boundaryEnd = match.index + match[0].length;
    if (boundaryEnd > limit) break;
    splitIndex = boundaryEnd;
  }
  return splitIndex >= READER_LARGE_SEGMENT_TARGET_LENGTH ? splitIndex : 0;
}

function pushLargeHtmlSegment(
  segments: ReaderVirtualSegment[],
  html: string,
): void {
  const trimmed = html.trim();
  if (!trimmed) return;
  if (trimmed.length > READER_LARGE_SEGMENT_MAX_LENGTH) {
    const splitIndex = largeHtmlSplitIndex(trimmed);
    if (splitIndex > 0) {
      pushLargeHtmlSegment(segments, trimmed.slice(0, splitIndex));
      pushLargeHtmlSegment(segments, trimmed.slice(splitIndex));
      return;
    }
  }
  const index = segments.length;
  segments.push({
    estimatedHeight: estimateHtmlSegmentHeight(trimmed),
    html: `<div ${READER_SEGMENT_INDEX_ATTRIBUTE}="${index}">${trimmed}</div>`,
    index,
  });
}

function buildLargeReaderVirtualDocument(html: string): ReaderVirtualDocument {
  const staticHtmlParts: string[] = [];
  const withoutStyles = html.replace(
    /<style\b[^>]*>[\s\S]*?<\/style>/gi,
    (style) => {
      staticHtmlParts.push(style);
      return "";
    },
  );
  const stripped = stripSingleReaderContentWrapper(withoutStyles);
  const segments: ReaderVirtualSegment[] = [];
  const boundaryPattern =
    /<\/(?:p|div|section|article|figure|blockquote|pre|ul|ol|li|h[1-6]|table|tr|hr)>/gi;
  let cursor = 0;
  let segmentStart = 0;
  let match: RegExpExecArray | null;

  while ((match = boundaryPattern.exec(stripped.contentHtml)) !== null) {
    const boundaryEnd = match.index + match[0].length;
    if (boundaryEnd - segmentStart < READER_LARGE_SEGMENT_TARGET_LENGTH) {
      cursor = boundaryEnd;
      continue;
    }
    pushLargeHtmlSegment(
      segments,
      stripped.contentHtml.slice(segmentStart, boundaryEnd),
    );
    segmentStart = boundaryEnd;
    cursor = boundaryEnd;
  }

  if (segmentStart < stripped.contentHtml.length) {
    pushLargeHtmlSegment(segments, stripped.contentHtml.slice(segmentStart));
  }
  if (segments.length === 0 && cursor < stripped.contentHtml.length) {
    for (
      let start = 0;
      start < stripped.contentHtml.length;
      start += READER_LARGE_SEGMENT_MAX_LENGTH
    ) {
      pushLargeHtmlSegment(
        segments,
        stripped.contentHtml.slice(start, start + READER_LARGE_SEGMENT_MAX_LENGTH),
      );
    }
  }

  return {
    contentClassName: stripped.contentClassName,
    ...(stripped.contentDirection
      ? { contentDirection: stripped.contentDirection }
      : {}),
    ...(stripped.contentLanguage
      ? { contentLanguage: stripped.contentLanguage }
      : {}),
    segments,
    staticHtml: staticHtmlParts.join(""),
  };
}

function buildReaderVirtualDocument(html: string): ReaderVirtualDocument {
  const textDocument = buildReaderTextVirtualDocument(html);
  if (textDocument) return textDocument;

  if (html.length > READER_DOM_PREPROCESS_MAX_HTML_LENGTH) {
    return buildLargeReaderVirtualDocument(html);
  }

  if (typeof document === "undefined") {
    return {
      contentClassName: "reader-content",
      segments: [{ estimatedHeight: 800, html, index: 0 }],
      staticHtml: "",
    };
  }

  const template = document.createElement("template");
  template.innerHTML = html;

  const staticNodes = [
    ...template.content.querySelectorAll<HTMLStyleElement>("style"),
  ];
  const staticHtml = staticNodes.map((node) => node.outerHTML).join("");
  staticNodes.forEach((node) => node.remove());

  const elementChildren = [...template.content.children];
  const root =
    elementChildren.length === 1 &&
    elementChildren[0] instanceof Element &&
    elementChildren[0].children.length > 0
      ? elementChildren[0]
      : null;
  const sourceNodes = root
    ? [...root.childNodes]
    : [...template.content.childNodes];
  const segments: ReaderVirtualSegment[] = [];

  for (const node of sourceNodes) {
    const htmlSegment = nodeSegmentHtml(node, segments.length);
    if (!htmlSegment) continue;
    const estimatedHeight =
      node instanceof Element
        ? estimatedSegmentHeight(node)
        : READER_SEGMENT_DEFAULT_HEIGHT;
    segments.push({
      estimatedHeight,
      html: htmlSegment,
      index: segments.length,
    });
  }

  return {
    contentClassName: readerContentClassFromRoot(root),
    ...(root?.getAttribute("dir")
      ? { contentDirection: root.getAttribute("dir") as "ltr" | "rtl" | "auto" }
      : {}),
    ...(root?.getAttribute("lang")
      ? { contentLanguage: root.getAttribute("lang") ?? undefined }
      : {}),
    segments,
    staticHtml,
  };
}

function buildReaderVirtualDocumentCached(html: string): ReaderVirtualDocument {
  const key = [
    "virtual:v1",
    typeof document === "undefined" ? "no-document" : "document",
    readerStringFingerprint(html),
  ].join("|");
  const cached = readerVirtualDocumentCache.get(key);
  if (cached) return cached;
  return rememberReaderCacheValue(
    readerVirtualDocumentCache,
    key,
    buildReaderVirtualDocument(html),
    READER_VIRTUAL_DOCUMENT_CACHE_LIMIT,
  );
}

function formatClock(date: Date, locale: AppLocale): string {
  return formatTimeForLocale(locale, date);
}

function emphasizeWord(word: string): string {
  if (word.length < 4) return word;
  const splitAt = Math.ceil(word.length * 0.42);
  return `<strong>${word.slice(0, splitAt)}</strong>${word.slice(splitAt)}`;
}

function applyBionicReading(html: string): string {
  const parser = new DOMParser();
  const document = parser.parseFromString(html, "text/html");
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node instanceof Text && node.textContent?.trim()) {
      nodes.push(node);
    }
  }

  for (const node of nodes) {
    const span = document.createElement("span");
    span.innerHTML = node.textContent!.replace(/[A-Za-z0-9]{4,}/g, emphasizeWord);
    node.replaceWith(span);
  }

  return document.body.innerHTML;
}

function getProgress(node: HTMLElement, pageReader: boolean): number {
  if (pageReader) {
    const total = getPagedPageCount(node);
    if (total <= 1) return 0;
    return ((getPagedPageIndex(node) - 1) / (total - 1)) * 100;
  }
  const maxTop = node.scrollHeight - node.clientHeight;
  return maxTop <= 0 ? 100 : (node.scrollTop / maxTop) * 100;
}

function getPagedStep(node: HTMLElement): number {
  return Math.max(1, node.clientWidth);
}

function getPagedMaxLeft(node: HTMLElement): number {
  return Math.max(0, node.scrollWidth - node.clientWidth);
}

function getPagedTrailingTolerance(step: number): number {
  return Math.max(
    PAGED_SCROLL_POSITION_TOLERANCE_PX,
    Math.min(
      PAGED_TRAILING_PAGE_TOLERANCE_MAX_PX,
      step * PAGED_TRAILING_PAGE_TOLERANCE_FRACTION,
    ),
  );
}

function getPagedPageCount(node: HTMLElement): number {
  const maxLeft = getPagedMaxLeft(node);
  if (maxLeft <= PAGED_SCROLL_POSITION_TOLERANCE_PX) return 1;
  const step = getPagedStep(node);
  const fullSteps = Math.floor(maxLeft / step);
  const remainder = maxLeft - fullSteps * step;
  const hasDistinctTrailingPage =
    remainder > getPagedTrailingTolerance(step);
  return Math.max(1, fullSteps + 1 + (hasDistinctTrailingPage ? 1 : 0));
}

function getPagedPageIndex(node: HTMLElement): number {
  const total = getPagedPageCount(node);
  const maxLeft = getPagedMaxLeft(node);
  if (maxLeft <= PAGED_SCROLL_POSITION_TOLERANCE_PX) return 1;
  if (node.scrollLeft >= maxLeft - PAGED_SCROLL_POSITION_TOLERANCE_PX) {
    return total;
  }
  const current = Math.round(node.scrollLeft / getPagedStep(node)) + 1;
  return Math.max(1, Math.min(total, current));
}

function getPagedLeft(node: HTMLElement, pageIndex: number): number {
  const total = getPagedPageCount(node);
  const maxLeft = getPagedMaxLeft(node);
  if (total <= 1) return 0;
  const clampedPageIndex = Math.max(1, Math.min(total, pageIndex));
  if (clampedPageIndex >= total) return maxLeft;
  return Math.max(
    0,
    Math.min(maxLeft, (clampedPageIndex - 1) * getPagedStep(node)),
  );
}

function getProgressPageIndex(node: HTMLElement, progress: number): number {
  const total = getPagedPageCount(node);
  if (total <= 1) return 1;
  const ratio = clampProgress(progress) / 100;
  if (ratio >= 1) return total;
  return Math.max(1, Math.min(total, Math.round(ratio * (total - 1)) + 1));
}

function isAtReadingEnd(node: HTMLElement, pageReader: boolean): boolean {
  if (pageReader) {
    return getPagedPageIndex(node) >= getPagedPageCount(node);
  }
  const maxTop = node.scrollHeight - node.clientHeight;
  return maxTop <= 2 || node.scrollTop >= maxTop - 2;
}

function getPageIndex(node: HTMLElement, pageReader: boolean): number {
  if (pageReader) {
    return getPagedPageIndex(node);
  }
  return Math.floor(node.scrollTop / Math.max(1, node.clientHeight)) + 1;
}

function getPageInfo(node: HTMLElement, pageReader: boolean): PageInfo {
  if (pageReader) {
    const total = getPagedPageCount(node);
    return {
      current: Math.max(1, Math.min(total, getPagedPageIndex(node))),
      total,
    };
  }
  const total = Math.max(
    1,
    Math.ceil(node.scrollHeight / Math.max(1, node.clientHeight)),
  );
  return {
    current: Math.max(1, Math.min(total, getPageIndex(node, false))),
    total,
  };
}

function scrollToProgress(
  node: HTMLElement,
  progress: number,
  pageReader: boolean,
  behavior: ScrollBehavior,
): void {
  const ratio = clampProgress(progress) / 100;
  if (pageReader) {
    const pageIndex = getProgressPageIndex(node, progress);
    node.scrollTo({ left: getPagedLeft(node, pageIndex), behavior });
    return;
  }
  const maxTop = node.scrollHeight - node.clientHeight;
  node.scrollTo({ top: maxTop * ratio, behavior });
}

function getNormalizedWheelDelta(event: WheelEvent<HTMLElement>): number {
  const primaryDelta =
    Math.abs(event.deltaY) >= Math.abs(event.deltaX)
      ? event.deltaY
      : event.deltaX;
  if (event.deltaMode === WHEEL_DELTA_LINE) return primaryDelta * 16;
  if (event.deltaMode === WHEEL_DELTA_PAGE) {
    return primaryDelta * window.innerHeight;
  }
  return primaryDelta;
}

function getTapZone(
  rect: DOMRect,
  clientX: number,
  clientY: number,
): ReaderTapZone {
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const column =
    x < rect.width / 3 ? "Left" : x > (rect.width * 2) / 3 ? "Right" : "Center";
  const row =
    y < rect.height / 3
      ? "top"
      : y > (rect.height * 2) / 3
        ? "bottom"
        : "middle";
  return `${row}${column}` as ReaderTapZone;
}

function ReaderContentInner(
  props: ReaderContentProps,
  ref: Ref<ReaderContentHandle>,
) {
  const {
    html,
    bottomOverlayOffset,
    contentKey,
    initialProgress = 0,
    interactionBlocked = false,
    localMediaContext,
    onProgressChange,
    onPageIndexChange,
    onMediaError,
    onSeekbarActivity,
    onSeekbarActiveChange,
    onToggleChrome,
    onBoundaryPage,
    viewportHeight: requestedViewportHeight,
    appearanceSettings,
    generalSettings,
  } = props;
  const storedGeneral = useReaderStore((state) => state.general);
  const storedAppearance = useReaderStore((state) => state.appearance);
  const general = generalSettings ?? storedGeneral;
  const appearance = appearanceSettings ?? storedAppearance;
  const { locale, t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const latestProgressRef = useRef(clampProgress(initialProgress));
  const lastSavedProgressRef = useRef(Math.round(clampProgress(initialProgress)));
  const progressTimerRef = useRef<number | null>(null);
  const completedForNavigationRef = useRef(false);
  const latestMediaElementPatchesRef = useRef<
    Map<number, ChapterMediaElementPatch>
  >(new Map());
  const localMediaPatchGenerationRef = useRef(0);
  const latestLocalMediaSignatureRef = useRef<string | null>(null);
  const pendingLocalMediaSignatureRef = useRef<string | null>(null);
  const unresolvedLocalMediaSignatureRef = useRef<string | null>(null);
  const latestRenderedHtmlRef = useRef<string | null>(null);
  const appliedInitialContentKeyRef = useRef<number | string | undefined | null>(
    null,
  );
  const pendingInitialProgressRestoreRef =
    useRef<ReaderInitialProgressRestore | null>(null);
  const restoredLayoutKeyRef = useRef<string | null>(null);
  const scrollActivityVersionRef = useRef(0);
  const pageScrollFrameRef = useRef<number | null>(null);
  const pageScrollAnimatingRef = useRef(false);
  const wheelDeltaRef = useRef(0);
  const wheelCooldownTimerRef = useRef<number | null>(null);
  const wheelPagingLockedRef = useRef(false);
  const nativeWheelActionLockedUntilRef = useRef(0);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const [progress, setProgress] = useState(clampProgress(initialProgress));
  const [pageInfo, setPageInfo] = useState<PageInfo>({
    current: 1,
    total: 1,
  });
  const [now, setNow] = useState(() => new Date());
  const [battery, setBattery] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState<ReaderViewportSize>({
    width: 0,
    height: 0,
  });
  const [segmentHeights, setSegmentHeights] = useState<number[]>([]);
  const [virtualRange, setVirtualRange] = useState({ start: 0, end: -1 });
  const [resolvedLocalMedia, setResolvedLocalMedia] = useState<
    Record<string, string>
  >({});
  const resolvedLocalMediaMap = useMemo(
    () => new Map(Object.entries(resolvedLocalMedia)),
    [resolvedLocalMedia],
  );
  const localMediaContextKey = useMemo(
    () =>
      localMediaContext
        ? [
            localMediaContext.chapterId,
            localMediaContext.chapterName ?? "",
            localMediaContext.chapterNumber ?? "",
            localMediaContext.chapterPosition ?? "",
            localMediaContext.novelId ?? "",
            localMediaContext.novelName ?? "",
            localMediaContext.novelPath ?? "",
            localMediaContext.sourceId ?? "",
          ].join("\u0000")
        : "",
    [
      localMediaContext?.chapterId,
      localMediaContext?.chapterName,
      localMediaContext?.chapterNumber,
      localMediaContext?.chapterPosition,
      localMediaContext?.novelId,
      localMediaContext?.novelName,
      localMediaContext?.novelPath,
      localMediaContext?.sourceId,
    ],
  );
  const stableLocalMediaContext = useMemo(
    () => localMediaContext,
    [localMediaContextKey],
  );

  const renderedHtml = useMemo(
    () =>
      preprocessReaderHtmlForRender(
        html,
        general.bionicReading,
        resolvedLocalMediaMap,
      ),
    [general.bionicReading, html, resolvedLocalMediaMap],
  );
  const virtualDocument = useMemo(
    () => buildReaderVirtualDocumentCached(renderedHtml),
    [renderedHtml],
  );
  const displayStaticHtml = useMemo(
    () => stripLocalMediaFontFaces(virtualDocument.staticHtml),
    [virtualDocument.staticHtml],
  );

  useEffect(() => {
    if (latestRenderedHtmlRef.current === renderedHtml) return;
    latestRenderedHtmlRef.current = renderedHtml;
    logReaderMediaPipeline("html-replace", {
      blankMediaCount: countBlankReaderMedia(renderedHtml),
      dataUrlMediaCount: countDataUrlReaderMedia(renderedHtml),
      htmlLength: renderedHtml.length,
    });
  }, [renderedHtml]);

  const viewportHeight =
    requestedViewportHeight ??
    "calc(var(--lnr-app-content-height) - 3.75rem)";
  const viewportWidth = viewportSize.width;
  const viewportHeightPx =
    viewportSize.height > 0
      ? viewportSize.height
      : typeof window !== "undefined"
        ? window.innerHeight
        : 0;
  const overlayBottom = bottomOverlayOffset ?? "0.5rem";
  const isPagedReader = general.pageReader;
  const requestedPageColumnsPerSpread = general.twoPageReader ? 2 : 1;
  const availablePageColumnsPerSpread = Math.max(
    1,
    Math.floor(viewportWidth / TWO_PAGE_MIN_COLUMN_WIDTH),
  );
  const pageColumnsPerSpread = isPagedReader
    ? Math.max(
        1,
        Math.min(requestedPageColumnsPerSpread, availablePageColumnsPerSpread),
      )
    : 1;
  const isMultiPageReader = isPagedReader && pageColumnsPerSpread > 1;
  const getActiveScrollNode = useCallback(
    () => (isPagedReader ? contentRef.current : viewportRef.current),
    [isPagedReader],
  );
  const effectiveSegmentHeights = useMemo(
    () =>
      virtualDocument.segments.map(
        (segment) => segmentHeights[segment.index] ?? segment.estimatedHeight,
      ),
    [segmentHeights, virtualDocument.segments],
  );
  const segmentOffsets = useMemo(
    () => prefixSegmentHeights(effectiveSegmentHeights),
    [effectiveSegmentHeights],
  );
  const virtualContentHeight =
    segmentOffsets[segmentOffsets.length - 1] ?? 0;

  const cancelPagedScrollAnimation = useCallback(() => {
    if (pageScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(pageScrollFrameRef.current);
      pageScrollFrameRef.current = null;
    }
    pageScrollAnimatingRef.current = false;
  }, []);

  const scrollPagedTo = useCallback((targetLeft: number) => {
    const node = getActiveScrollNode();
    if (!node) return;
    cancelPagedScrollAnimation();
    pageScrollAnimatingRef.current = true;
    const startLeft = node.scrollLeft;
    const distance = targetLeft - startLeft;
    logReaderInput("page-scroll-start", () => ({
      startLeft: Math.round(startLeft),
      targetLeft: Math.round(targetLeft),
      distance: Math.round(distance),
      snapshot: getReaderDebugSnapshot(node),
    }));
    if (Math.abs(distance) <= 1) {
      node.scrollLeft = targetLeft;
      pageScrollAnimatingRef.current = false;
      dispatchReaderScrollEvent(node);
      logReaderInput("page-scroll-complete", () => ({
        targetLeft: Math.round(targetLeft),
        snapshot: getReaderDebugSnapshot(node),
      }));
      return;
    }
    const startedAt = performance.now();
    const step = (now: number) => {
      const progress = Math.min(
        1,
        (now - startedAt) / PAGED_SCROLL_ANIMATION_MS,
      );
      node.scrollLeft = startLeft + distance * easeOutCubic(progress);
      if (progress < 1) {
        pageScrollFrameRef.current = window.requestAnimationFrame(step);
        return;
      }

      node.scrollLeft = targetLeft;
      pageScrollAnimatingRef.current = false;
      dispatchReaderScrollEvent(node);
      logReaderInput("page-scroll-complete", () => ({
        targetLeft: Math.round(targetLeft),
        snapshot: getReaderDebugSnapshot(node),
      }));
      pageScrollFrameRef.current = null;
    };

    pageScrollFrameRef.current = window.requestAnimationFrame(step);
  }, [cancelPagedScrollAnimation, getActiveScrollNode]);

  const scrollByPage = useCallback(
    (direction: 1 | -1, source = "imperative") => {
      const node = getActiveScrollNode();
      if (!node) return;
      if (direction === -1) {
        completedForNavigationRef.current = false;
      }
      if (isPagedReader) {
        const currentPage = getPagedPageIndex(node);
        const targetPage = currentPage + direction;
        logReaderInput("page-step-request", () => ({
          source,
          direction,
          mode: "paged",
          currentPage,
          targetPage,
          snapshot: getReaderDebugSnapshot(node),
        }));
        if (targetPage < 1 || targetPage > getPagedPageCount(node)) {
          logReaderInput("page-step-boundary", () => ({
            source,
            direction,
            snapshot: getReaderDebugSnapshot(node),
          }));
          onBoundaryPage?.(direction);
          return;
        }
        scrollPagedTo(getPagedLeft(node, targetPage));
        return;
      }
      if (performance.now() < nativeWheelActionLockedUntilRef.current) {
        logReaderInput("page-step-suppressed", () => ({
          source,
          direction,
          reason: "native-wheel-active",
          snapshot: getReaderDebugSnapshot(node),
        }));
        return;
      }
      const axisMax = node.scrollHeight - node.clientHeight;
      const current = node.scrollTop;
      logReaderInput("page-step-request", () => ({
        source,
        direction,
        mode: "scroll",
        axisMax: Math.round(axisMax),
        snapshot: getReaderDebugSnapshot(node),
      }));
      if (
        (direction === 1 && current >= axisMax - 2) ||
        (direction === -1 && current <= 2)
      ) {
        logReaderInput("page-step-boundary", () => ({
          source,
          direction,
          snapshot: getReaderDebugSnapshot(node),
        }));
        onBoundaryPage?.(direction);
        return;
      }
      const amount = node.clientHeight * SCROLL_PAGE_FRACTION;
      logReaderInput("page-step-scroll", () => ({
        source,
        direction,
        amount: Math.round(amount),
        snapshot: getReaderDebugSnapshot(node),
      }));
      node.scrollBy({ top: amount * direction, behavior: "auto" });
    },
    [
      isPagedReader,
      onBoundaryPage,
      getActiveScrollNode,
      scrollPagedTo,
    ],
  );

  const flushProgress = useCallback(
    (value: number) => {
      if (!onProgressChange) return;
      const rounded = Math.round(clampProgress(value));
      if (
        rounded >= 97 ||
        Math.abs(rounded - lastSavedProgressRef.current) >= 1
      ) {
        lastSavedProgressRef.current = rounded;
        onProgressChange(rounded);
      }
    },
    [onProgressChange],
  );

  const scheduleProgressSave = useCallback(
    (value: number) => {
      if (progressTimerRef.current !== null) {
        window.clearTimeout(progressTimerRef.current);
      }
      progressTimerRef.current = window.setTimeout(() => {
        flushProgress(value);
        progressTimerRef.current = null;
      }, PROGRESS_SAVE_DELAY_MS);
    },
    [flushProgress],
  );

  const patchMediaElements = useCallback(
    (patches: ChapterMediaElementPatch[]) => {
      if (patches.length === 0) return;
      mergeMediaElementPatches(latestMediaElementPatchesRef.current, patches);
      const content = contentRef.current;
      if (!content) return;
      patchReaderMediaElements(content, patches);
    },
    [],
  );

  useLayoutEffect(() => {
    latestMediaElementPatchesRef.current.clear();
    latestLocalMediaSignatureRef.current = null;
    pendingLocalMediaSignatureRef.current = null;
    unresolvedLocalMediaSignatureRef.current = null;
    localMediaPatchGenerationRef.current += 1;
    setResolvedLocalMedia((current) =>
      Object.keys(current).length === 0 ? current : {},
    );
  }, [contentKey]);

  useEffect(() => {
    unresolvedLocalMediaSignatureRef.current = null;
  }, [localMediaContextKey, renderedHtml]);

  useImperativeHandle(
    ref,
    () => ({
      completeIfAtEnd() {
        const node = getActiveScrollNode();
        if (!node || !isAtReadingEnd(node, isPagedReader)) return false;
        completedForNavigationRef.current = true;
        latestProgressRef.current = 100;
        setProgress(100);
        if (progressTimerRef.current !== null) {
          window.clearTimeout(progressTimerRef.current);
          progressTimerRef.current = null;
        }
        flushProgress(100);
        return true;
      },
      patchMediaElements,
      scrollByPage,
      scrollToStart() {
        const node = getActiveScrollNode();
        if (!node) return;
        cancelPagedScrollAnimation();
        node.scrollTo({ top: 0, left: 0, behavior: "auto" });
        dispatchReaderScrollEvent(node);
      },
    }),
    [
      cancelPagedScrollAnimation,
      flushProgress,
      getActiveScrollNode,
      isPagedReader,
      patchMediaElements,
      scrollByPage,
    ],
  );

  const applyPageInfo = useCallback(
    (nextPageInfo: PageInfo) => {
      setPageInfo((current) =>
        current.current === nextPageInfo.current &&
        current.total === nextPageInfo.total
          ? current
          : nextPageInfo,
      );
      onPageIndexChange?.(nextPageInfo.current);
    },
    [onPageIndexChange],
  );

  const restoreProgressPosition = useCallback(
    (value: number) => {
      const node = getActiveScrollNode();
      if (!node) return;
      if (isPagedReader) {
        scrollToProgress(node, value, true, "auto");
        if (!completedForNavigationRef.current) {
          const restoredProgress = clampProgress(getProgress(node, true));
          latestProgressRef.current = restoredProgress;
          setProgress(restoredProgress);
        }
        applyPageInfo(getPageInfo(node, true));
        return;
      }
      scrollToProgress(node, value, false, "auto");
      if (!completedForNavigationRef.current) {
        const restoredProgress = clampProgress(getProgress(node, false));
        latestProgressRef.current = restoredProgress;
        setProgress(restoredProgress);
      }
      applyPageInfo(getPageInfo(node, false));
    },
    [
      applyPageInfo,
      getActiveScrollNode,
      isPagedReader,
    ],
  );
  const restoreProgressPositionRef = useRef(restoreProgressPosition);

  useEffect(() => {
    restoreProgressPositionRef.current = restoreProgressPosition;
  }, [restoreProgressPosition]);

  const updateProgressFromScroll = useCallback(() => {
    const node = getActiveScrollNode();
    if (!node) return;
    if (completedForNavigationRef.current) return;
    if (isPagedReader && pageScrollAnimatingRef.current) return;
    scrollActivityVersionRef.current += 1;
    if (pendingInitialProgressRestoreRef.current?.contentKey === contentKey) {
      pendingInitialProgressRestoreRef.current = null;
    }
    if (!isPagedReader) {
      setVirtualRange(
        virtualRangeForScroll(
          node.scrollTop,
          node.clientHeight,
          segmentOffsets,
          READER_SCROLL_OVERSCAN_PX,
        ),
      );
    }
    const nextProgress = clampProgress(getProgress(node, isPagedReader));
    latestProgressRef.current = nextProgress;
    setProgress(nextProgress);
    applyPageInfo(getPageInfo(node, isPagedReader));
    scheduleProgressSave(nextProgress);
  }, [
    applyPageInfo,
    contentKey,
    getActiveScrollNode,
    isPagedReader,
    scheduleProgressSave,
    segmentOffsets,
  ]);

  useEffect(() => {
    if (appliedInitialContentKeyRef.current === contentKey) return;
    appliedInitialContentKeyRef.current = contentKey;
    const nextProgress = clampProgress(initialProgress);
    pendingInitialProgressRestoreRef.current = {
      contentKey,
      progress: nextProgress,
    };
    latestProgressRef.current = nextProgress;
    setProgress(nextProgress);
    lastSavedProgressRef.current = Math.round(nextProgress);
    if (nextProgress < 97) {
      completedForNavigationRef.current = false;
    }
  }, [contentKey, initialProgress]);

  const layoutRestoreKey = useMemo(
    () =>
      [
        contentKey ?? "",
        appearance.fontFamily,
        appearance.lineHeight,
        appearance.padding,
        appearance.textSize,
        general.bionicReading,
        general.pageReader,
        general.htmlImagePagingMode,
        viewportSize.width,
        isPagedReader ? viewportSize.height : "",
        pageColumnsPerSpread,
      ].join("|"),
    [
      appearance.fontFamily,
      appearance.lineHeight,
      appearance.padding,
      appearance.textSize,
      contentKey,
      general.bionicReading,
      general.pageReader,
      general.htmlImagePagingMode,
      isPagedReader,
      viewportSize.height,
      viewportSize.width,
      pageColumnsPerSpread,
    ],
  );

  useEffect(() => {
    setSegmentHeights([]);
    setVirtualRange({ start: 0, end: -1 });
  }, [virtualDocument]);

  useEffect(() => {
    const node = getActiveScrollNode();
    if (!node) return;
    if (restoredLayoutKeyRef.current === layoutRestoreKey) return;
    restoredLayoutKeyRef.current = layoutRestoreKey;
    const pendingInitialProgress = pendingInitialProgressRestoreRef.current;
    const progressToRestore =
      pendingInitialProgress &&
      pendingInitialProgress.contentKey === contentKey
        ? pendingInitialProgress.progress
        : latestProgressRef.current;
    const restoreActivityVersion = scrollActivityVersionRef.current;
    let disposed = false;
    const restore = () => {
      if (disposed) return;
      if (scrollActivityVersionRef.current !== restoreActivityVersion) return;
      restoreProgressPositionRef.current(progressToRestore);
      if (pendingInitialProgressRestoreRef.current?.contentKey === contentKey) {
        pendingInitialProgressRestoreRef.current = null;
      }
    };
    const frame = window.requestAnimationFrame(restore);
    const timeout = window.setTimeout(restore, 120);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [contentKey, getActiveScrollNode, layoutRestoreKey]);

  useEffect(() => {
    if (!stableLocalMediaContext || !renderedHtml.includes(READER_LOCAL_MEDIA_SRC_PREFIX)) {
      return;
    }
    const content = contentRef.current;
    if (!content) return;
    const rawPatches = collectMountedLocalMediaPatches(content);
    if (rawPatches.length === 0) return;
    const signature = localMediaPatchSignature(rawPatches);
    const scopedSignature = `${localMediaContextKey}\u0000${signature}`;
    const resolvedPatches = resolveMountedLocalMediaPatchesFromMap(
      rawPatches,
      resolvedLocalMediaMap,
    );
    if (resolvedPatches) {
      latestLocalMediaSignatureRef.current = scopedSignature;
      unresolvedLocalMediaSignatureRef.current = null;
      mergeMediaElementPatches(
        latestMediaElementPatchesRef.current,
        resolvedPatches,
      );
      patchReaderMediaElements(content, resolvedPatches);
      return;
    }
    const cachedLocalPatches = [
      ...latestMediaElementPatchesRef.current.values(),
    ].filter(hasLocalMediaSourceAttributes);
    if (
      scopedSignature === latestLocalMediaSignatureRef.current &&
      cachedLocalPatches.length > 0
    ) {
      patchReaderMediaElements(content, cachedLocalPatches);
      return;
    }
    if (scopedSignature === unresolvedLocalMediaSignatureRef.current) return;
    if (scopedSignature === pendingLocalMediaSignatureRef.current) return;
    latestLocalMediaSignatureRef.current = scopedSignature;
    pendingLocalMediaSignatureRef.current = scopedSignature;
    const generation = ++localMediaPatchGenerationRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const patches = await resolveLocalChapterMediaPatches(
          rawPatches,
          stableLocalMediaContext,
        );
        if (
          cancelled ||
          generation !== localMediaPatchGenerationRef.current ||
          contentRef.current !== content
        ) {
          return;
        }
        if (patches.length > 0) {
          unresolvedLocalMediaSignatureRef.current = null;
          setResolvedLocalMedia((current) => {
            let changed = false;
            const next = { ...current };
            rawPatches.forEach((rawPatch, patchIndex) => {
              const resolvedPatch = patches[patchIndex];
              if (!resolvedPatch) return;
              for (const attribute of READER_MEDIA_PATCH_ATTRIBUTES) {
                const source = rawPatch.sourceAttributes?.[attribute];
                const resolved = resolvedPatch.attributes[attribute];
                if (
                  !source ||
                  !resolved ||
                  resolved.includes(READER_LOCAL_MEDIA_SRC_PREFIX) ||
                  next[source] === resolved
                ) {
                  continue;
                }
                next[source] = resolved;
                changed = true;
              }
            });
            return changed ? next : current;
          });
          for (const [index, patch] of latestMediaElementPatchesRef.current) {
            if (hasLocalMediaSourceAttributes(patch)) {
              latestMediaElementPatchesRef.current.delete(index);
            }
          }
          patchReaderMediaElements(content, patches);
        } else if (!cancelled) {
          unresolvedLocalMediaSignatureRef.current = scopedSignature;
        }
      } finally {
        if (pendingLocalMediaSignatureRef.current === scopedSignature) {
          pendingLocalMediaSignatureRef.current = null;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    isPagedReader,
    localMediaContextKey,
    renderedHtml,
    resolvedLocalMediaMap,
    stableLocalMediaContext,
    virtualRange.end,
    virtualRange.start,
  ]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const syncViewportSize = () => {
      const next = {
        width: node.clientWidth,
        height: node.clientHeight,
      };
      setViewportSize((current) =>
        current.width === next.width && current.height === next.height
          ? current
          : next,
      );
    };
    syncViewportSize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      syncViewportSize();
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [restoreProgressPosition]);

  useEffect(() => {
    if (isPagedReader) return;
    const content = contentRef.current;
    if (!content) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const measurements = [...content.querySelectorAll<HTMLElement>(
        `[${READER_SEGMENT_INDEX_ATTRIBUTE}]`,
      )].map((element) => {
        const index = Number.parseInt(
          element.getAttribute(READER_SEGMENT_INDEX_ATTRIBUTE) ?? "",
          10,
        );
        if (!Number.isFinite(index) || index < 0) return null;
        const style = window.getComputedStyle(element);
        const marginTop = Number.parseFloat(style.marginTop) || 0;
        const marginBottom = Number.parseFloat(style.marginBottom) || 0;
        const height = Math.ceil(
          element.getBoundingClientRect().height + marginTop + marginBottom,
        );
        return height > 0 ? { height, index } : null;
      });
      setSegmentHeights((current) => {
        const next = [...current];
        let changed = false;
        for (const measurement of measurements) {
          if (!measurement || next[measurement.index] === measurement.height) {
            continue;
          }
          next[measurement.index] = measurement.height;
          changed = true;
        }
        return changed ? next : current;
      });
    };
    const scheduleMeasure = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(measure);
    };

    scheduleMeasure();
    if (typeof ResizeObserver === "undefined") {
      return () => {
        if (frame !== 0) window.cancelAnimationFrame(frame);
      };
    }
    const observer = new ResizeObserver(scheduleMeasure);
    for (const element of content.querySelectorAll<HTMLElement>(
      `[${READER_SEGMENT_INDEX_ATTRIBUTE}]`,
    )) {
      observer.observe(element);
    }
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [isPagedReader, virtualRange.end, virtualRange.start, viewportSize.width]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node || isPagedReader) return;
    setVirtualRange(
      virtualRangeForScroll(
        node.scrollTop,
        node.clientHeight,
        segmentOffsets,
        READER_SCROLL_OVERSCAN_PX,
      ),
    );
  }, [isPagedReader, segmentOffsets, viewportSize.height]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || appearance.customJs.trim() === "") return;
    try {
      const run = new Function("container", appearance.customJs);
      run(content);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[reader] custom JS failed", error);
    }
  }, [
    appearance.customJs,
    isPagedReader,
    renderedHtml,
    virtualRange.end,
    virtualRange.start,
  ]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || !onMediaError) return;
    const handleMediaError = (event: Event) => {
      const source = mediaErrorSource(event.target);
      if (!source || !isRemoteMediaUrl(source)) return;
      logReaderMediaPipeline("remote-media-error", {
        host: mediaLogHost(source),
      });
      onMediaError(source);
    };
    content.addEventListener("error", handleMediaError, true);
    return () => {
      content.removeEventListener("error", handleMediaError, true);
    };
  }, [
    isPagedReader,
    onMediaError,
    renderedHtml,
    virtualRange.end,
    virtualRange.start,
  ]);

  useEffect(() => {
    if (!general.showBatteryAndTime) return;
    const interval = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(interval);
  }, [general.showBatteryAndTime]);

  useEffect(() => {
    if (!general.showBatteryAndTime) {
      setBattery(null);
      return;
    }
    const nav = navigator as Navigator & {
      getBattery?: () => Promise<BatteryManagerLike>;
    };
    let manager: BatteryManagerLike | null = null;
    let disposed = false;
    const update = () => {
      if (!manager || disposed) return;
      setBattery(
        `${Math.round(manager.level * 100)}%${
          manager.charging ? ` ${t("readerContent.charging")}` : ""
        }`,
      );
    };
    void nav
      .getBattery?.()
      .then((nextManager) => {
        if (disposed) return;
        manager = nextManager;
        update();
        manager.addEventListener?.("levelchange", update);
        manager.addEventListener?.("chargingchange", update);
      })
      .catch(() => setBattery(null));
    return () => {
      disposed = true;
      manager?.removeEventListener?.("levelchange", update);
      manager?.removeEventListener?.("chargingchange", update);
    };
  }, [general.showBatteryAndTime, t]);

  useEffect(() => {
    if (!general.keepScreenOn) return;
    const nav = navigator as Navigator & {
      wakeLock?: {
        request: (type: "screen") => Promise<{ release: () => Promise<void> }>;
      };
    };
    let lock: { release: () => Promise<void> } | null = null;
    let disposed = false;
    void nav.wakeLock
      ?.request("screen")
      .then((nextLock) => {
        if (disposed) {
          void nextLock.release();
          return;
        }
        lock = nextLock;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      if (lock) void lock.release();
    };
  }, [general.keepScreenOn]);

  useEffect(() => {
    if (!general.autoScroll || isPagedReader) return;
    const interval = window.setInterval(() => {
      const node = viewportRef.current;
      if (!node) return;
      node.scrollBy({ top: general.autoScrollOffset, behavior: "auto" });
    }, general.autoScrollInterval);
    return () => window.clearInterval(interval);
  }, [
    general.autoScroll,
    general.autoScrollInterval,
    general.autoScrollOffset,
    isPagedReader,
  ]);

  useEffect(
    () => () => {
      if (progressTimerRef.current !== null) {
        window.clearTimeout(progressTimerRef.current);
      }
      if (wheelCooldownTimerRef.current !== null) {
        window.clearTimeout(wheelCooldownTimerRef.current);
      }
      cancelPagedScrollAnimation();
      flushProgress(latestProgressRef.current);
    },
    [cancelPagedScrollAnimation, flushProgress],
  );

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (interactionBlocked) return;
    if (isInteractiveTarget(event.target)) return;
    const node = viewportRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();

    const zone = getTapZone(rect, event.clientX, event.clientY);
    const action: ReaderTapAction =
      zone === "middleCenter"
        ? "menu"
        : general.tapToScroll
          ? general.tapZones[zone]
          : "none";

    switch (action) {
      case "previous":
        scrollByPage(-1, "tap-previous");
        break;
      case "next":
        scrollByPage(1, "tap-next");
        break;
      case "menu":
        onToggleChrome?.();
        break;
      case "none":
        break;
    }
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (interactionBlocked || event.ctrlKey) return;
    if (isInteractiveTarget(event.target)) return;

    const delta = getNormalizedWheelDelta(event);
    if (Math.abs(delta) < 1) return;
    if (!isPagedReader) {
      nativeWheelActionLockedUntilRef.current =
        performance.now() + NATIVE_WHEEL_ACTION_LOCK_MS;
      return;
    }

    event.preventDefault();
    const node = getActiveScrollNode();
    if (wheelPagingLockedRef.current) {
      logReaderInput("wheel-suppressed", () => ({
        delta: Math.round(delta),
        reason: "wheel-cooldown",
        snapshot: getReaderDebugSnapshot(node),
      }));
      return;
    }

    wheelDeltaRef.current += delta;
    if (Math.abs(wheelDeltaRef.current) < WHEEL_PAGE_DELTA_THRESHOLD) {
      logReaderInput("wheel-accumulate", () => ({
        delta: Math.round(delta),
        accumulated: Math.round(wheelDeltaRef.current),
        snapshot: getReaderDebugSnapshot(node),
      }));
      return;
    }

    const direction: 1 | -1 = wheelDeltaRef.current > 0 ? 1 : -1;
    wheelDeltaRef.current = 0;
    wheelPagingLockedRef.current = true;
    logReaderInput("wheel-page-step", () => ({
      direction,
      snapshot: getReaderDebugSnapshot(node),
    }));
    scrollByPage(direction, "wheel-page-step");

    if (wheelCooldownTimerRef.current !== null) {
      window.clearTimeout(wheelCooldownTimerRef.current);
    }
    wheelCooldownTimerRef.current = window.setTimeout(() => {
      wheelPagingLockedRef.current = false;
      wheelCooldownTimerRef.current = null;
    }, WHEEL_PAGE_COOLDOWN_MS);
  };

  const seekToProgress = useCallback(
    (value: number) => {
      const node = getActiveScrollNode();
      if (!node) return;
      const clamped = clampProgress(value);
      if (clamped < 97) {
        completedForNavigationRef.current = false;
      }
      if (isPagedReader) {
        scrollToProgress(node, clamped, true, "auto");
        const nextProgress = clampProgress(getProgress(node, true));
        latestProgressRef.current = nextProgress;
        setProgress(nextProgress);
        applyPageInfo(getPageInfo(node, true));
        scheduleProgressSave(nextProgress);
        return;
      }
      scrollToProgress(node, clamped, false, "auto");
      const nextProgress = clampProgress(getProgress(node, false));
      latestProgressRef.current = nextProgress;
      setProgress(nextProgress);
      applyPageInfo(getPageInfo(node, false));
      scheduleProgressSave(nextProgress);
    },
    [
      applyPageInfo,
      getActiveScrollNode,
      isPagedReader,
      scheduleProgressSave,
    ],
  );

  const commitSeekProgress = useCallback(() => {
    flushProgress(latestProgressRef.current);
  }, [flushProgress]);

  const contentStyle = useMemo<CSSProperties>(
    () =>
      ({
        "--lnr-reader-page-media-max-height": `${Math.max(
          1,
          viewportHeightPx - appearance.padding * 2,
        )}px`,
        boxSizing: "border-box",
        color: appearance.textColor,
        fontSize: `${appearance.textSize}px`,
        lineHeight: appearance.lineHeight,
        textAlign: appearance.textAlign,
        fontFamily: appearance.fontFamily || undefined,
        padding: `${appearance.padding}px`,
      }) as CSSProperties,
    [
      appearance.fontFamily,
      appearance.lineHeight,
      appearance.padding,
      appearance.textAlign,
      appearance.textColor,
      appearance.textSize,
      viewportHeightPx,
    ],
  );
  const pagedViewportWidth =
    viewportWidth > 0
      ? viewportWidth
      : typeof window !== "undefined"
        ? window.innerWidth
        : 0;
  const pageColumnGap = appearance.padding * 2;
  const pageContentWidth = Math.max(
    1,
    pagedViewportWidth - appearance.padding * 2,
  );
  const pageColumnWidth = Math.max(
    1,
    Math.floor(
      pageColumnsPerSpread > 1
        ? (pageContentWidth - pageColumnGap) / pageColumnsPerSpread
        : pageContentWidth,
    ),
  );
  const pageStyle = useMemo<CSSProperties>(
    () =>
      isPagedReader
        ? ({
            "--lnr-reader-page-column-width": `${pageColumnWidth}px`,
            columnFill: "auto",
            columnWidth: `${pageColumnWidth}px`,
            columnGap: `${pageColumnGap}px`,
            height: "100%",
            maxWidth: "none",
            overflowX: "auto",
            overflowY: "hidden",
          } as CSSProperties)
        : {
            maxWidth: "none",
            minHeight: "100%",
            margin: "0",
            width: "100%",
          },
    [isPagedReader, pageColumnGap, pageColumnWidth],
  );
  const contentBoxStyle = useMemo<CSSProperties>(
    () => ({
      ...contentStyle,
      ...pageStyle,
    }),
    [contentStyle, pageStyle],
  );
  const readerContentRuntimeCss = useMemo(() => {
    const pageDividerGradients =
      pageColumnsPerSpread > 1
        ? Array.from({ length: pageColumnsPerSpread - 1 }, (_, index) => {
            const dividerLeft =
              appearance.padding +
              (index + 1) * pageColumnWidth +
              index * pageColumnGap +
              pageColumnGap / 2;
            const start = Math.max(0, dividerLeft - 0.5);
            const end = dividerLeft + 0.5;
            return `linear-gradient(to right, transparent ${start}px, color-mix(in srgb, currentColor 28%, transparent) ${start}px, color-mix(in srgb, currentColor 28%, transparent) ${end}px, transparent ${end}px)`;
          }).join(",\n")
        : "";
    const readerMediaSelector = cssSelectorList(
      ".reader-content ",
      READER_PAGE_MEDIA_ELEMENTS,
    );
    const pagedMediaSelector = cssSelectorList(
      ".reader-viewport-paged .reader-content ",
      READER_PAGE_MEDIA_ELEMENTS,
    );
    const pagedAtomicMediaSelector = cssSelectorList(
      ".reader-viewport-paged .reader-content ",
      ["figure", "picture", ...READER_PAGE_MEDIA_ELEMENTS],
    );
    const autoMediaSelector = cssSelectorList(
      '.reader-viewport-paged .reader-content[data-image-paging="auto"] ',
      READER_PAGE_MEDIA_ELEMENTS,
    );
    const nextPageMediaSelector = cssSelectorList(
      '.reader-viewport-paged .reader-content[data-image-paging="next-page"] ',
      READER_PAGE_MEDIA_ELEMENTS,
    );
    const nextPageFirstMediaSelector = [
      cssSelectorList(
        '.reader-viewport-paged .reader-content[data-image-paging="next-page"] > ',
        READER_PAGE_MEDIA_ELEMENTS,
        ":first-child",
      ),
      cssSelectorList(
        '.reader-viewport-paged .reader-content[data-image-paging="next-page"] > :first-child ',
        READER_PAGE_MEDIA_ELEMENTS,
      ),
    ].join(",\n");
    const singleImageFlowSelector = cssSelectorList(
      '.reader-viewport-paged .reader-content[data-image-paging="single-image"] > ',
      READER_PAGE_SINGLE_FLOW_ELEMENTS,
    );
    const singleImageMediaSelector = cssSelectorList(
      '.reader-viewport-paged .reader-content[data-image-paging="single-image"] ',
      READER_PAGE_SINGLE_MEDIA_ELEMENTS,
    );
    const singleImageFirstMediaSelector = [
      cssSelectorList(
        '.reader-viewport-paged .reader-content[data-image-paging="single-image"] > ',
        READER_PAGE_SINGLE_MEDIA_ELEMENTS,
        ":first-child",
      ),
      cssSelectorList(
        '.reader-viewport-paged .reader-content[data-image-paging="single-image"] > :first-child ',
        READER_PAGE_SINGLE_MEDIA_ELEMENTS,
        ":first-child",
      ),
    ].join(",\n");
    const singleImageLastMediaSelector = [
      cssSelectorList(
        '.reader-viewport-paged .reader-content[data-image-paging="single-image"] > ',
        READER_PAGE_SINGLE_MEDIA_ELEMENTS,
        ":last-child",
      ),
      cssSelectorList(
        '.reader-viewport-paged .reader-content[data-image-paging="single-image"] > :last-child ',
        READER_PAGE_SINGLE_MEDIA_ELEMENTS,
        ":last-child",
      ),
    ].join(",\n");
    const fragmentMediaSelector = cssSelectorList(
      '.reader-viewport-paged .reader-content[data-image-paging="fragment"] ',
      READER_PAGE_MEDIA_ELEMENTS,
    );

    return `
          ${readerMediaSelector} {
            max-width: 100%;
            height: auto;
          }
          ${pagedMediaSelector} {
            max-height: var(--lnr-reader-page-media-max-height);
            object-fit: contain;
          }
          ${pagedAtomicMediaSelector} {
            break-inside: avoid;
            page-break-inside: avoid;
          }
          .reader-content,
          .reader-content [data-norea-reader-virtual-spacer] {
            overflow-anchor: none;
          }
          ${autoMediaSelector} {
            break-inside: avoid;
            page-break-inside: avoid;
          }
          ${nextPageMediaSelector} {
            break-before: column;
            break-inside: avoid;
            page-break-inside: avoid;
          }
          ${nextPageFirstMediaSelector} {
            break-before: auto;
          }
          ${singleImageFlowSelector} {
            break-inside: auto !important;
            page-break-inside: auto !important;
          }
          ${singleImageMediaSelector} {
            break-before: column !important;
            break-after: column !important;
            break-inside: avoid !important;
            page-break-before: always !important;
            page-break-after: always !important;
            page-break-inside: avoid !important;
          }
          ${singleImageFirstMediaSelector} {
            break-before: auto !important;
            page-break-before: auto !important;
          }
          ${singleImageLastMediaSelector} {
            break-after: auto !important;
            page-break-after: auto !important;
          }
          ${fragmentMediaSelector} {
            break-inside: auto;
            page-break-inside: auto;
          }
          .reader-content p {
            margin-block: ${
              general.removeExtraParagraphSpacing ? "0.65em" : "1em"
            };
          }
          .reader-viewport-paged .reader-content p {
            -webkit-column-break-inside: avoid;
            break-inside: avoid;
            page-break-inside: avoid;
          }
          .reader-content strong {
            font-weight: 800;
          }
          .reader-viewport-paged.reader-viewport-multi-page .reader-content .reader-epub-content,
          .reader-viewport-paged.reader-viewport-multi-page .reader-content .reader-epub-section,
          .reader-viewport-paged.reader-viewport-multi-page .reader-content .reader-epub-body,
          .reader-viewport-paged.reader-viewport-multi-page .reader-content .reader-epub-body > .body {
            box-sizing: border-box;
            max-width: var(--lnr-reader-page-column-width) !important;
            width: var(--lnr-reader-page-column-width) !important;
          }
          .reader-viewport-paged.reader-viewport-multi-page::after {
            content: none;
          }
          .reader-viewport-paged.reader-viewport-multi-page .reader-content {
            background-attachment: local;
            background-image: ${pageDividerGradients};
            background-repeat: repeat-x;
            background-size: ${pagedViewportWidth}px 100%;
          }
          .reader-viewport-paged {
            overscroll-behavior-x: contain;
          }
          .reader-viewport-paged .reader-content {
            scrollbar-width: none;
          }
          .reader-viewport-paged[data-paged-renderer="columns"] .reader-content {
            scroll-snap-type: x mandatory;
          }
          .reader-viewport-paged .reader-content::-webkit-scrollbar {
            display: none;
          }
        `;
  }, [
    appearance.padding,
    general.removeExtraParagraphSpacing,
    pageColumnGap,
    pageColumnWidth,
    pageColumnsPerSpread,
    pagedViewportWidth,
  ]);

  const viewportClassName = `reader-viewport ${
    isPagedReader ? "reader-viewport-paged" : "reader-viewport-scroll"
  }${isMultiPageReader ? " reader-viewport-multi-page reader-viewport-two-page" : ""}`;
  const normalizedVirtualRange = {
    start: Math.max(0, virtualRange.start),
    end: Math.min(virtualDocument.segments.length - 1, virtualRange.end),
  };
  const visibleSegments =
    normalizedVirtualRange.end >= normalizedVirtualRange.start
      ? virtualDocument.segments.slice(
          normalizedVirtualRange.start,
          normalizedVirtualRange.end + 1,
        )
      : virtualDocument.segments.slice(0, Math.min(8, virtualDocument.segments.length));
  const firstVisibleIndex = visibleSegments[0]?.index ?? 0;
  const lastVisibleIndex =
    visibleSegments[visibleSegments.length - 1]?.index ?? -1;
  const topSpacerHeight = segmentOffsets[firstVisibleIndex] ?? 0;
  const bottomSpacerHeight =
    lastVisibleIndex >= 0
      ? Math.max(
          0,
          virtualContentHeight - (segmentOffsets[lastVisibleIndex + 1] ?? 0),
        )
      : 0;
  const visibleSegmentsHtml = useMemo(
    () => visibleSegments.map((segment) => segment.html).join(""),
    [firstVisibleIndex, lastVisibleIndex, virtualDocument.segments],
  );
  const virtualSpacerStyle = useMemo(
    () =>
      ({
        "--norea-reader-bottom-spacer-height": `${bottomSpacerHeight}px`,
        "--norea-reader-content-height": `${virtualContentHeight}px`,
        "--norea-reader-top-spacer-height": `${topSpacerHeight}px`,
      }) as CSSProperties,
    [bottomSpacerHeight, topSpacerHeight, virtualContentHeight],
  );
  const scrollVirtualHtml = useMemo(
    () =>
      protectLocalReaderMediaCached(
        [
          displayStaticHtml,
          '<div data-norea-reader-virtual-canvas style="height:var(--norea-reader-content-height,0px);position:relative;width:100%">',
          '<div data-norea-reader-virtual-window style="left:0;position:absolute;right:0;top:var(--norea-reader-top-spacer-height,0px)">',
          visibleSegmentsHtml,
          "</div></div>",
        ].join(""),
        resolvedLocalMediaMap,
      ),
    [displayStaticHtml, resolvedLocalMediaMap, visibleSegmentsHtml],
  );
  const pagedFullHtml = useMemo(
    () =>
      protectLocalReaderMediaCached(
        displayStaticHtml +
          virtualDocument.segments.map((segment) => segment.html).join(""),
        resolvedLocalMediaMap,
      ),
    [displayStaticHtml, resolvedLocalMediaMap, virtualDocument.segments],
  );
  const readerContentHtml = isPagedReader ? pagedFullHtml : scrollVirtualHtml;
  const readerContentStyle = useMemo<CSSProperties>(
    () =>
      isPagedReader
        ? contentBoxStyle
        : { ...contentBoxStyle, ...virtualSpacerStyle },
    [contentBoxStyle, isPagedReader, virtualSpacerStyle],
  );

  useLayoutEffect(() => {
    const patches = [...latestMediaElementPatchesRef.current.values()];
    if (patches.length === 0) return;
    const content = contentRef.current;
    if (content) patchReaderMediaElements(content, patches);
  }, [readerContentHtml]);

  return (
    <Box
      className="lnr-reader-content-stage"
      style={{
        height: viewportHeight,
        background: appearance.backgroundColor,
        color: appearance.textColor,
      }}
    >
      <Box
        ref={viewportRef}
        className={viewportClassName}
        data-page-columns={isPagedReader ? pageColumnsPerSpread : undefined}
        data-paged-renderer={isPagedReader ? "columns" : undefined}
        onClickCapture={stopReaderMediaClick}
        onDoubleClickCapture={stopReaderMediaClick}
        onClick={handleClick}
        onScroll={isPagedReader ? undefined : updateProgressFromScroll}
        onWheel={handleWheel}
        onTouchStart={(event) => {
          if (interactionBlocked) return;
          const touch = event.changedTouches[0];
          if (touch) {
            touchStartRef.current = { x: touch.clientX, y: touch.clientY };
          }
        }}
        onTouchEnd={(event) => {
          if (interactionBlocked) {
            touchStartRef.current = null;
            return;
          }
          if (!general.swipeGestures || !touchStartRef.current) return;
          const touch = event.changedTouches[0];
          if (!touch) return;
          const dx = touch.clientX - touchStartRef.current.x;
          const dy = touch.clientY - touchStartRef.current.y;
          touchStartRef.current = null;
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
            scrollByPage(dx < 0 ? 1 : -1, "swipe");
          }
        }}
        style={{
          position: "relative",
          height: "100%",
          overflowX: "hidden",
          overflowY: isPagedReader ? "hidden" : "auto",
          color: appearance.textColor,
          cursor: "pointer",
          scrollBehavior: "auto",
        }}
      >
        <Box
          ref={contentRef}
          className={virtualDocument.contentClassName}
          data-image-paging={
            isPagedReader ? general.htmlImagePagingMode : undefined
          }
          dir={virtualDocument.contentDirection}
          lang={virtualDocument.contentLanguage}
          onScroll={isPagedReader ? updateProgressFromScroll : undefined}
          style={readerContentStyle}
          dangerouslySetInnerHTML={{
            __html: readerContentHtml,
          }}
        />
        <style>{readerContentRuntimeCss}</style>
        {appearance.customCss.trim() ? (
          <style>{appearance.customCss}</style>
        ) : null}
        {(general.showScrollPercentage || general.showBatteryAndTime) && (
          <Box
            style={{
              position: "fixed",
              left: "0.75rem",
              right: "0.75rem",
              bottom: overlayBottom,
              display: "flex",
              justifyContent: "space-between",
              gap: "0.75rem",
              color: appearance.textColor,
              fontSize: "0.75rem",
              pointerEvents: "none",
              opacity: 0.78,
              zIndex: 4,
            }}
          >
            <span>
              {general.showScrollPercentage
                ? isPagedReader
                  ? `${pageInfo.current}/${pageInfo.total}`
                  : `${Math.round(progress)}%`
                : ""}
            </span>
            <span>
              {general.showBatteryAndTime
                ? [battery, formatClock(now, locale)].filter(Boolean).join(" | ")
                : ""}
            </span>
          </Box>
        )}
      </Box>
      <ReaderSeekbars
        bottomOffset={overlayBottom}
        label={t("reader.progressAria", { progress: Math.round(progress) })}
        onActivity={onSeekbarActivity}
        onActiveChange={onSeekbarActiveChange}
        onCommit={commitSeekProgress}
        onSeek={seekToProgress}
        progress={progress}
        showHorizontal={general.showSeekbar}
        showVertical={general.showSeekbar && general.verticalSeekbar}
      />
    </Box>
  );
}

export const ReaderContent = memo(forwardRef(ReaderContentInner));
