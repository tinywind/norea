import { type MouseEvent } from "react";
import { type ChapterMediaElementPatch } from "../../lib/chapter-media";
import {
  READER_DOM_PREPROCESS_MAX_HTML_LENGTH,
  READER_INERT_LOCAL_MEDIA_SRC_PREFIX,
  READER_MEDIA_INDEX_ATTRIBUTE,
  READER_MEDIA_PATCH_SELECTOR,
  READER_MEDIA_SOURCE_URL_ATTRIBUTE,
  READER_PENDING_BACKGROUND_ATTRIBUTE,
  READER_PENDING_DISPLAY_ATTRIBUTE,
  READER_PENDING_HEIGHT_ATTRIBUTE,
  READER_PENDING_MEDIA_ATTRIBUTE,
  READER_PENDING_PLACEHOLDER_HEIGHT,
  READER_PENDING_PLACEHOLDER_SRC,
  type ReaderVirtualSegment,
} from "../reader-document";
import { readerHtmlHasMedia } from "../reader-virtualization";
interface ReaderMediaPatchTargetIndex {
  byIndex: Map<number, HTMLElement[]>;
  bySource: Map<string, HTMLElement[]>;
  elements: HTMLElement[];
}

const READER_MEDIA_EVENT_SELECTOR =
  "img,picture,svg,video,audio,canvas,iframe,figure";

export const READER_MEDIA_PATCH_ATTRIBUTES = [
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

const READER_EMPTY_MEDIA_PLACEHOLDER_SRC =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%221%22%20height%3D%221%22%2F%3E";

const READER_LOCAL_MEDIA_SRC_PREFIX = "norea-media://reader-asset/";

const READER_LOCAL_MEDIA_SCOPED_SRC_PREFIX =
  "norea-media://reader-asset/~cache/";

const READER_LOCAL_MEDIA_RELATIVE_SRC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const READER_STYLE_URL_PATTERN =
  /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*?))\s*\)/gi;

const READER_PROTECTED_HTML_CACHE_LIMIT = 12;

const readerProtectedHtmlCache = new Map<string, string>();

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

export function logReaderMediaPipeline(
  event: string,
  details: Record<string, unknown>,
): void {
  console.warn("[reader-media:content]", event, details);
}

const READER_MEDIA_DEBUG_STORAGE_KEY = "norea.readerMediaDebug";

function readerMediaDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const debugWindow = window as Window & {
      __NOREA_READER_MEDIA_DEBUG?: boolean;
    };
    return (
      debugWindow.__NOREA_READER_MEDIA_DEBUG === true ||
      window.localStorage.getItem(READER_MEDIA_DEBUG_STORAGE_KEY) === "1"
    );
  } catch {
    return false;
  }
}

export function logReaderMediaDebug(
  event: string,
  getDetails: () => Record<string, unknown>,
): void {
  if (!readerMediaDebugEnabled()) return;
  console.warn("[reader-media:debug]", event, getDetails());
}

export function readerMediaDebugHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getReaderEventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

export function isReaderMediaEventTarget(target: EventTarget | null): boolean {
  const element = getReaderEventElement(target);
  if (!element) return false;
  if (element.closest(READER_MEDIA_EVENT_SELECTOR)) return true;
  const link = element.closest("a");
  return !!link?.querySelector(READER_MEDIA_EVENT_SELECTOR);
}

export function stopReaderMediaClick(event: MouseEvent<HTMLDivElement>): void {
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

export function isRemoteMediaUrl(value: string): boolean {
  try {
    const parsed = new URL(value, window.location.href);
    if (parsed.host === "asset.localhost") return false;
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return value.startsWith("//");
  }
}

export function mediaErrorSource(target: EventTarget | null): string | null {
  if (target instanceof HTMLImageElement) {
    return target.currentSrc || target.src || target.getAttribute("src");
  }
  if (
    target instanceof HTMLVideoElement ||
    target instanceof HTMLAudioElement
  ) {
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

export function mediaLogHost(value: string): string {
  try {
    return new URL(value, window.location.href).host;
  } catch {
    return "invalid";
  }
}

function hasRelativeLocalChapterMediaValue(
  value: string | null,
): value is string {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  if (
    trimmed.startsWith(".") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("#") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes(":") ||
    trimmed.includes("?") ||
    trimmed.includes("&") ||
    trimmed.includes("=")
  ) {
    return false;
  }
  return READER_LOCAL_MEDIA_RELATIVE_SRC_PATTERN.test(trimmed);
}

function restoreInertLocalMediaValue(value: string): string {
  return value.replaceAll(
    READER_INERT_LOCAL_MEDIA_SRC_PREFIX,
    READER_LOCAL_MEDIA_SRC_PREFIX,
  );
}

function hasLocalMediaHtmlCandidate(html: string): boolean {
  return (
    html.includes(READER_LOCAL_MEDIA_SRC_PREFIX) ||
    html.includes(READER_INERT_LOCAL_MEDIA_SRC_PREFIX)
  );
}

function hasLocalChapterMediaValue(
  value: string | null,
  allowRelative = false,
): value is string {
  const trimmed = value ? restoreInertLocalMediaValue(value).trim() : value;
  if (!trimmed) return false;
  if (trimmed.startsWith(READER_LOCAL_MEDIA_SCOPED_SRC_PREFIX)) return false;
  if (trimmed.includes(READER_LOCAL_MEDIA_SRC_PREFIX)) return true;
  return allowRelative && hasRelativeLocalChapterMediaValue(trimmed);
}

function hasLocalChapterMediaSrcsetValue(
  value: string | null,
  allowRelative: boolean,
): value is string {
  if (!value) return false;
  return value.split(",").some((candidate) => {
    const source = candidate.trim().split(/\s+/)[0] ?? "";
    return hasLocalChapterMediaValue(source, allowRelative);
  });
}

function hasLocalChapterMediaStyleValue(
  value: string | null,
  allowRelative: boolean,
): value is string {
  if (!value) return false;
  READER_STYLE_URL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = READER_STYLE_URL_PATTERN.exec(value)) !== null) {
    const source = String(match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (hasLocalChapterMediaValue(source, allowRelative)) return true;
  }
  return false;
}

function hasLocalChapterMediaAttributeValue(
  attribute: string,
  value: string | null,
  allowRelative: boolean,
): value is string {
  if (attribute === "style") {
    return hasLocalChapterMediaStyleValue(value, allowRelative);
  }
  if (attribute === "srcset") {
    return hasLocalChapterMediaSrcsetValue(value, allowRelative);
  }
  return hasLocalChapterMediaValue(value, allowRelative);
}

function protectedLocalMediaAttribute(attribute: string): string | undefined {
  return READER_PROTECTED_LOCAL_MEDIA_ATTRIBUTES[
    attribute as keyof typeof READER_PROTECTED_LOCAL_MEDIA_ATTRIBUTES
  ];
}

function encodeProtectedLocalMediaValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeProtectedLocalMediaValue(value: string | null): string | null {
  if (value === null) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function protectedLocalMediaAttributeValue(
  element: Element,
  attribute: string,
): string | null {
  const protectedAttribute = protectedLocalMediaAttribute(attribute);
  if (!protectedAttribute) return null;
  return decodeProtectedLocalMediaValue(
    element.getAttribute(protectedAttribute),
  );
}

function setReaderLocalMediaPlaceholder(
  element: Element,
  attribute: string,
  value: string,
  resolvedLocalMedia?: ReadonlyMap<string, string>,
  allowRelative = false,
): void {
  const sourceValue = restoreInertLocalMediaValue(value);
  const resolvedValue = resolvedLocalMedia?.get(sourceValue);
  if (resolvedValue) {
    element.setAttribute(attribute, resolvedValue);
    return;
  }
  const protectedAttribute = protectedLocalMediaAttribute(attribute);
  if (!protectedAttribute) return;
  element.setAttribute(
    protectedAttribute,
    encodeProtectedLocalMediaValue(sourceValue),
  );
  if (attribute === "style") {
    element.setAttribute(
      "style",
      sourceValue.replace(
        READER_STYLE_URL_PATTERN,
        (match, doubleQuoted, singleQuoted, unquoted) => {
          const source = String(
            doubleQuoted ?? singleQuoted ?? unquoted ?? "",
          ).trim();
          if (!hasLocalChapterMediaValue(source, allowRelative)) return match;
          const restoredStyleSource = restoreInertLocalMediaValue(source);
          const resolvedStyleUrl = resolvedLocalMedia?.get(restoredStyleSource);
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
  allowRelative = false,
): string {
  if (
    typeof document === "undefined" ||
    (!allowRelative && !hasLocalMediaHtmlCandidate(html))
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
      if (
        !hasLocalChapterMediaAttributeValue(attribute, value, allowRelative)
      ) {
        continue;
      }
      setReaderLocalMediaPlaceholder(
        element,
        attribute,
        value,
        resolvedLocalMedia,
        allowRelative,
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

export function stripLocalMediaFontFaces(html: string): string {
  if (!hasLocalMediaHtmlCandidate(html)) return html;
  return html.replace(
    /@font-face\s*{[^}]*norea-media:\/\/chapter\/[^}]*}/gi,
    "",
  );
}

export function protectLocalReaderMediaCached(
  html: string,
  resolvedLocalMedia?: ReadonlyMap<string, string>,
  allowRelative = false,
): string {
  if (
    typeof document === "undefined" ||
    (!allowRelative && !hasLocalMediaHtmlCandidate(html))
  ) {
    return html;
  }
  const key = [
    "protect:v1",
    allowRelative ? "relative" : "absolute",
    readerStringFingerprint(html),
    readerLocalMediaMapFingerprint(resolvedLocalMedia),
  ].join("|");
  const cached = readerProtectedHtmlCache.get(key);
  if (cached !== undefined) return cached;
  return rememberReaderCacheValue(
    readerProtectedHtmlCache,
    key,
    protectLocalReaderMedia(html, resolvedLocalMedia, allowRelative),
    READER_PROTECTED_HTML_CACHE_LIMIT,
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

export function mergeMediaElementPatches(
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
  const key = readerMediaPatchSourceKey(
    attribute,
    restoreInertLocalMediaValue(source),
  );
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
          protectedLocalMediaAttributeValue(element, attribute),
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

export function patchReaderMediaElements(
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
    const targets = localTargets
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

export function collectMountedLocalMediaPatches(
  container: HTMLElement,
  allowRelative: boolean,
): ChapterMediaElementPatch[] {
  const elements = [
    ...container.querySelectorAll<HTMLElement>(READER_MEDIA_PATCH_SELECTOR),
  ];
  const patches: ChapterMediaElementPatch[] = [];
  elements.forEach((element, index) => {
    const attributes: Record<string, string> = {};
    const sourceAttributes: Record<string, string> = {};
    for (const attribute of READER_MEDIA_PATCH_ATTRIBUTES) {
      const value =
        protectedLocalMediaAttributeValue(element, attribute) ??
        element.getAttribute(attribute);
      if (hasLocalChapterMediaAttributeValue(attribute, value, allowRelative)) {
        const sourceValue = restoreInertLocalMediaValue(value);
        attributes[attribute] = sourceValue;
        sourceAttributes[attribute] = sourceValue;
      }
    }
    if (Object.keys(attributes).length > 0) {
      patches.push({ index, attributes, sourceAttributes });
    }
  });
  return patches;
}

export function localMediaPatchSignature(
  patches: ChapterMediaElementPatch[],
): string {
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

export function hasLocalMediaSourceAttributes(
  patch: ChapterMediaElementPatch,
): boolean {
  return (
    !!patch.sourceAttributes && Object.keys(patch.sourceAttributes).length > 0
  );
}

export function resolveMountedLocalMediaPatchesFromMap(
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

export function countBlankReaderMedia(html: string): number {
  if (html.length > READER_DOM_PREPROCESS_MAX_HTML_LENGTH) {
    return (
      html.match(/<img\b[^>]*\bsrc\s*=\s*["']\s*["'][^>]*>/gi)?.length ?? 0
    );
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

export function countDataUrlReaderMedia(html: string): number {
  if (html.length > READER_DOM_PREPROCESS_MAX_HTML_LENGTH) {
    return (
      html.match(/\b(?:src|poster|data|href)\s*=\s*["']data:/gi)?.length ?? 0
    );
  }
  if (typeof document === "undefined") return 0;
  const template = document.createElement("template");
  template.innerHTML = html;
  return [...template.content.querySelectorAll<HTMLImageElement>("img")].filter(
    (image) => (image.getAttribute("src") ?? "").startsWith("data:"),
  ).length;
}

export function readerVirtualSegmentHasMedia(
  segment: ReaderVirtualSegment,
): boolean {
  return readerHtmlHasMedia(segment.html);
}
