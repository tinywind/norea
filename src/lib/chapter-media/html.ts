import {
  LOCAL_CHAPTER_MEDIA_SRC_PATTERN,
  LOCAL_MEDIA_SRC_PREFIX,
  localChapterMediaFileName,
  localChapterMediaOutputSrc,
  localChapterMediaSourceForContext,
  parseLocalChapterMediaSrc,
  relativeChapterMediaFileName,
} from "./sources";
import {
  type CacheChapterMediaOptions,
  type ChapterMediaElementPatch,
  type ChapterMediaStorageContext,
  type MediaSrcTarget,
  type MediaSrcsetTarget,
  type MediaStyleTarget,
  type MediaStyleUrl,
  type SrcsetCandidate,
} from "./types";

export const MEDIA_SOURCE_URL_ATTRIBUTE = "data-norea-media-source-url";

export const MEDIA_SRCSET_SOURCE_ATTRIBUTE = "data-norea-media-srcset-source";

const MEDIA_LAZY_SRC_ATTRIBUTES = [
  "data-src",
  "data-original",
  "data-lazy-src",
  "data-orig-src",
] as const;

export const MEDIA_SRC_ATTRIBUTES = [
  "src",
  "poster",
  "data",
  "href",
  "xlink:href",
  ...MEDIA_LAZY_SRC_ATTRIBUTES,
] as const;

export type MediaSrcAttribute = (typeof MEDIA_SRC_ATTRIBUTES)[number];

const MEDIA_PRIMARY_SOURCE_ELEMENTS = [
  "img",
  "video",
  "audio",
  "source",
  "embed",
  "track",
] as const;

const MEDIA_LAZY_SOURCE_ELEMENTS = ["img", "video", "audio", "source"] as const;

const MEDIA_SOURCE_TARGETS: Array<{
  attribute: MediaSrcAttribute;
  selector: string;
}> = [
  ...MEDIA_PRIMARY_SOURCE_ELEMENTS.map((element) => ({
    attribute: "src" as const,
    selector: `${element}[src]`,
  })),
  ...MEDIA_LAZY_SOURCE_ELEMENTS.flatMap((element) =>
    MEDIA_LAZY_SRC_ATTRIBUTES.map((attribute) => ({
      attribute,
      selector: `${element}[${attribute}]`,
    })),
  ),
  { attribute: "poster", selector: "video[poster]" },
  { attribute: "data", selector: "object[data]" },
  { attribute: "href", selector: 'link[href][rel~="preload"][as="image"]' },
  { attribute: "href", selector: 'link[href][rel~="preload"][as="video"]' },
  { attribute: "href", selector: 'link[href][rel~="preload"][as="audio"]' },
  { attribute: "href", selector: "image[href]" },
  { attribute: "xlink:href", selector: "image[xlink\\:href]" },
  { attribute: "href", selector: "use[href]" },
  { attribute: "xlink:href", selector: "use[xlink\\:href]" },
];

export const MEDIA_SOURCE_SELECTOR = [
  ...MEDIA_SOURCE_TARGETS.map((target) => target.selector),
  "img[srcset]",
  "source[srcset]",
].join(",");

export const MEDIA_STYLE_SELECTOR = "[style]";

const MEDIA_PATCH_SELECTOR = [MEDIA_SOURCE_SELECTOR, MEDIA_STYLE_SELECTOR].join(
  ",",
);

const MEDIA_PATCH_ATTRIBUTES = [
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

export const STYLE_URL_PATTERN =
  /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*?))\s*\)/gi;

const REMOTE_MEDIA_PENDING_PLACEHOLDER_SRC =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%221000%22%20height%3D%221400%22%20viewBox%3D%220%200%201000%201400%22%2F%3E";

const REMOTE_MEDIA_EMPTY_PLACEHOLDER_SRC =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%221%22%20height%3D%221%22%2F%3E";

function isSkippableMediaSource(src: string): boolean {
  return (
    src === "" ||
    src.startsWith("#") ||
    src.startsWith(LOCAL_MEDIA_SRC_PREFIX) ||
    /^(?:data|blob|file|asset):/i.test(src)
  );
}

export function absoluteMediaUrl(
  src: string,
  baseUrl?: string | null,
): string | null {
  const trimmed = src.trim();
  if (isSkippableMediaSource(trimmed)) return null;

  try {
    const url = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function mediaOutputAttribute(attribute: MediaSrcAttribute): string {
  return attribute.startsWith("data-") ? "src" : attribute;
}

function shouldCollectMediaAttribute(
  element: Element,
  attribute: MediaSrcAttribute,
): boolean {
  if (typeof element.matches !== "function") return true;
  return MEDIA_SOURCE_TARGETS.some(
    (target) =>
      target.attribute === attribute && element.matches(target.selector),
  );
}

function collectStyleMediaUrls(
  style: string,
  baseUrl?: string | null,
): MediaStyleUrl[] {
  const urls: MediaStyleUrl[] = [];

  for (const match of style.matchAll(STYLE_URL_PATTERN)) {
    const source = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    const url = absoluteMediaUrl(source, baseUrl);
    if (!url) continue;
    urls.push({ source, url });
  }

  return urls;
}

export function localStyleMediaSources(
  style: string,
  context?: ChapterMediaStorageContext,
): string[] {
  return [...style.matchAll(STYLE_URL_PATTERN)]
    .map((match) => (match[1] ?? match[2] ?? match[3] ?? "").trim())
    .filter((source) => localChapterMediaFileName(source, context) !== null);
}

export function styleMediaSlots(
  style: string,
  context?: ChapterMediaStorageContext,
): Array<string | null> {
  return [...style.matchAll(STYLE_URL_PATTERN)]
    .map((match) => (match[1] ?? match[2] ?? match[3] ?? "").trim())
    .map((source) => localMediaSrc(source, context));
}

function rewriteStyleMediaUrls(
  style: string,
  baseUrl: string | null | undefined,
  replacementForUrl: (url: string) => string | null,
): string {
  return style.replace(
    STYLE_URL_PATTERN,
    (match, doubleQuoted, singleQuoted, unquoted) => {
      const source = String(
        doubleQuoted ?? singleQuoted ?? unquoted ?? "",
      ).trim();
      const url = absoluteMediaUrl(source, baseUrl);
      if (!url) return match;
      const replacement = replacementForUrl(url);
      return replacement === null ? match : `url("${replacement}")`;
    },
  );
}

export function localChapterMediaSources(
  html: string,
  context?: ChapterMediaStorageContext,
): string[] {
  const sources = new Set<string>();
  for (const source of html.match(LOCAL_CHAPTER_MEDIA_SRC_PATTERN) ?? []) {
    sources.add(localChapterMediaSourceForContext(source, context) ?? source);
  }
  if (context && typeof document !== "undefined") {
    const template = document.createElement("template");
    template.innerHTML = html;
    for (const patch of collectMediaElementPatches(
      template.content,
      collectAllMediaPatchElements(template.content),
    )) {
      for (const [attribute, value] of Object.entries(patch.attributes)) {
        if (attribute === "srcset") {
          for (const candidate of parseSrcset(value)) {
            const source = localChapterMediaSourceForContext(
              candidate.source,
              context,
            );
            if (source) sources.add(source);
          }
          continue;
        }
        if (attribute === "style") {
          for (const source of localStyleMediaSources(value, context)) {
            const canonical = localChapterMediaSourceForContext(
              source,
              context,
            );
            if (canonical) sources.add(canonical);
          }
          continue;
        }
        const source = localChapterMediaSourceForContext(value, context);
        if (source) sources.add(source);
      }
    }
  }
  return [...sources];
}

export function hasRemoteChapterMedia(
  html: string,
  baseUrl?: string | null,
): boolean {
  if (typeof document === "undefined") return false;
  const template = document.createElement("template");
  template.innerHTML = html;
  return collectMediaTargets(template.content, baseUrl).urls.length > 0;
}

export function parseSrcset(srcset: string): SrcsetCandidate[] {
  return srcset
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .map((candidate) => {
      const [source = "", ...descriptor] = candidate.split(/\s+/);
      return {
        source,
        descriptor: descriptor.join(" "),
      };
    })
    .filter((candidate) => candidate.source !== "");
}

export function formatSrcset(candidates: SrcsetCandidate[]): string {
  return candidates
    .map((candidate) =>
      candidate.descriptor
        ? `${candidate.source} ${candidate.descriptor}`
        : candidate.source,
    )
    .join(", ");
}

function addUniqueUrl(urls: string[], url: string): void {
  if (!urls.includes(url)) {
    urls.push(url);
  }
}

export function localMediaSrc(
  value: string | null,
  context?: ChapterMediaStorageContext,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const parsed = parseLocalChapterMediaSrc(trimmed);
  if (parsed) return localChapterMediaOutputSrc(parsed.fileName);
  return context && relativeChapterMediaFileName(trimmed)
    ? localChapterMediaOutputSrc(trimmed)
    : null;
}

export function fileNameFromLocalMediaSrc(
  src: string,
  chapterId: number,
): string | null {
  const parsed = parseLocalChapterMediaSrc(src);
  if (parsed) return parsed.fileName;
  return chapterId > 0 ? relativeChapterMediaFileName(src) : null;
}

export function normalizeLocalChapterMediaOutput(html: string): string {
  return html.replace(LOCAL_CHAPTER_MEDIA_SRC_PATTERN, (src) => {
    const parsed = parseLocalChapterMediaSrc(src);
    return parsed ? localChapterMediaOutputSrc(parsed.fileName) : src;
  });
}

export function collectMediaTargets(
  root: DocumentFragment,
  baseUrl?: string | null,
): {
  srcTargets: MediaSrcTarget[];
  srcsetTargets: MediaSrcsetTarget[];
  styleTargets: MediaStyleTarget[];
  urls: string[];
} {
  const srcTargets: MediaSrcTarget[] = [];
  const srcsetTargets: MediaSrcsetTarget[] = [];
  const styleTargets: MediaStyleTarget[] = [];
  const urls: string[] = [];
  let srcSlotIndex = 0;
  let srcsetSlotIndex = 0;
  let styleSlotIndex = 0;

  for (const element of root.querySelectorAll<Element>(MEDIA_SOURCE_SELECTOR)) {
    for (const attribute of MEDIA_SRC_ATTRIBUTES) {
      if (!shouldCollectMediaAttribute(element, attribute)) continue;
      const rawSource = element.getAttribute(attribute);
      if (rawSource === null) continue;
      const url = absoluteMediaUrl(rawSource, baseUrl);
      const slotIndex = srcSlotIndex;
      srcSlotIndex += 1;
      if (url) {
        srcTargets.push({ attribute, element, slotIndex, url });
        addUniqueUrl(urls, url);
      }
    }

    const rawSrcset = element.getAttribute("srcset");
    const slotIndex = srcsetSlotIndex;
    if (rawSrcset === null) continue;
    srcsetSlotIndex += 1;
    if (!rawSrcset) continue;
    const candidates = parseSrcset(rawSrcset);
    let hasRemoteCandidate = false;
    for (const candidate of candidates) {
      const url = absoluteMediaUrl(candidate.source, baseUrl);
      if (!url) continue;
      hasRemoteCandidate = true;
      addUniqueUrl(urls, url);
    }
    if (hasRemoteCandidate) {
      srcsetTargets.push({ candidates, element, slotIndex });
    }
  }

  for (const element of root.querySelectorAll<Element>(MEDIA_STYLE_SELECTOR)) {
    const style = element.getAttribute("style") ?? "";
    const slotIndex = styleSlotIndex;
    styleSlotIndex += 1;
    const styleUrls = collectStyleMediaUrls(style, baseUrl);
    if (styleUrls.length === 0) continue;
    styleTargets.push({ element, slotIndex, style, urls: styleUrls });
    for (const { url } of styleUrls) {
      addUniqueUrl(urls, url);
    }
  }

  return { srcTargets, srcsetTargets, styleTargets, urls };
}

export function protectRemoteChapterMediaForPartialHtml(
  html: string,
  baseUrl?: string | null,
): string {
  if (typeof document === "undefined") return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  const { srcTargets, srcsetTargets, styleTargets, urls } = collectMediaTargets(
    template.content,
    baseUrl,
  );
  if (urls.length === 0) return html;

  for (const target of srcTargets) {
    const isImageSrc =
      target.attribute === "src" &&
      typeof HTMLImageElement !== "undefined" &&
      target.element instanceof HTMLImageElement;
    target.element.setAttribute(MEDIA_SOURCE_URL_ATTRIBUTE, target.url);
    target.element.setAttribute(
      target.attribute,
      isImageSrc
        ? REMOTE_MEDIA_PENDING_PLACEHOLDER_SRC
        : REMOTE_MEDIA_EMPTY_PLACEHOLDER_SRC,
    );
  }
  for (const target of srcsetTargets) {
    const rawSrcset = target.element.getAttribute("srcset");
    if (rawSrcset) {
      target.element.setAttribute(MEDIA_SRCSET_SOURCE_ATTRIBUTE, rawSrcset);
    }
    target.element.setAttribute("srcset", REMOTE_MEDIA_EMPTY_PLACEHOLDER_SRC);
  }
  for (const target of styleTargets) {
    target.element.setAttribute(
      "style",
      target.style.replace(
        STYLE_URL_PATTERN,
        `url("${REMOTE_MEDIA_EMPTY_PLACEHOLDER_SRC}")`,
      ),
    );
  }

  return template.innerHTML;
}

export function restoreProtectedRemoteChapterMediaSources(
  html: string,
  baseUrl?: string | null,
): string {
  if (
    typeof document === "undefined" ||
    (!html.includes(MEDIA_SOURCE_URL_ATTRIBUTE) &&
      !html.includes(MEDIA_SRCSET_SOURCE_ATTRIBUTE))
  ) {
    return html;
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  let changed = false;

  for (const element of template.content.querySelectorAll<Element>(
    `[${MEDIA_SOURCE_URL_ATTRIBUTE}]`,
  )) {
    const source = element.getAttribute(MEDIA_SOURCE_URL_ATTRIBUTE) ?? "";
    const url = absoluteMediaUrl(source, baseUrl);
    if (!url) continue;
    const attribute =
      MEDIA_SRC_ATTRIBUTES.find((candidate) => {
        const value = element.getAttribute(candidate);
        return (
          value === REMOTE_MEDIA_PENDING_PLACEHOLDER_SRC ||
          value === REMOTE_MEDIA_EMPTY_PLACEHOLDER_SRC
        );
      }) ?? "src";
    element.setAttribute(attribute, url);
    changed = true;
  }

  for (const element of template.content.querySelectorAll<Element>(
    `[${MEDIA_SRCSET_SOURCE_ATTRIBUTE}]`,
  )) {
    const source = element.getAttribute(MEDIA_SRCSET_SOURCE_ATTRIBUTE);
    if (!source) continue;
    element.setAttribute("srcset", source);
    changed = true;
  }

  return changed ? template.innerHTML : html;
}

export function tagCollectedMediaTargets(
  srcTargets: MediaSrcTarget[],
  srcsetTargets: MediaSrcsetTarget[],
): void {
  for (const target of srcTargets) {
    target.element.setAttribute(MEDIA_SOURCE_URL_ATTRIBUTE, target.url);
  }
  for (const target of srcsetTargets) {
    target.element.setAttribute(
      MEDIA_SRCSET_SOURCE_ATTRIBUTE,
      formatSrcset(target.candidates),
    );
  }
}

export function clearMediaSourceMetadata(root: DocumentFragment): void {
  for (const element of root.querySelectorAll<Element>(
    `[${MEDIA_SOURCE_URL_ATTRIBUTE}],[${MEDIA_SRCSET_SOURCE_ATTRIBUTE}]`,
  )) {
    element.removeAttribute(MEDIA_SOURCE_URL_ATTRIBUTE);
    element.removeAttribute(MEDIA_SRCSET_SOURCE_ATTRIBUTE);
  }
}

function outputMediaSourceForUrl(
  localSources: Map<string, string>,
  url: string,
): string {
  return localSources.get(url) ?? url;
}

export function applyRemoteMediaFallback({
  baseUrl,
  srcTargets,
  srcsetTargets,
  styleTargets,
  url,
}: {
  baseUrl: string | null | undefined;
  srcTargets: MediaSrcTarget[];
  srcsetTargets: MediaSrcsetTarget[];
  styleTargets: MediaStyleTarget[];
  url: string;
}): void {
  for (const target of srcTargets) {
    if (target.url === url) {
      const outputAttribute = mediaOutputAttribute(target.attribute);
      target.element.setAttribute(outputAttribute, url);
      if (target.attribute !== outputAttribute) {
        target.element.removeAttribute(target.attribute);
      }
    }
  }

  for (const target of srcsetTargets) {
    const currentCandidates = parseSrcset(
      target.element.getAttribute("srcset") ?? "",
    );
    let changed = false;
    const candidates = currentCandidates.map((candidate, index) => {
      const sourceCandidate = target.candidates[index];
      if (
        sourceCandidate &&
        absoluteMediaUrl(sourceCandidate.source, baseUrl) === url
      ) {
        changed = true;
        return { ...candidate, source: url };
      }
      return candidate;
    });
    if (!changed) continue;
    target.element.setAttribute("srcset", formatSrcset(candidates));
  }

  for (const target of styleTargets) {
    if (!target.urls.some((styleUrl) => styleUrl.url === url)) continue;
    const currentStyle = target.element.getAttribute("style") ?? "";
    target.element.setAttribute(
      "style",
      rewriteStyleMediaUrls(currentStyle, baseUrl, (styleUrl) =>
        styleUrl === url ? url : null,
      ),
    );
  }
}

export function applyResolvedMediaSource({
  baseUrl,
  localSources,
  srcTargets,
  srcsetTargets,
  styleTargets,
  url,
}: {
  baseUrl: string | null | undefined;
  localSources: Map<string, string>;
  srcTargets: MediaSrcTarget[];
  srcsetTargets: MediaSrcsetTarget[];
  styleTargets: MediaStyleTarget[];
  url: string;
}): Set<Element> {
  const changedElements = new Set<Element>();
  for (const target of srcTargets) {
    if (target.url !== url) continue;
    const outputAttribute = mediaOutputAttribute(target.attribute);
    target.element.setAttribute(
      outputAttribute,
      outputMediaSourceForUrl(localSources, target.url),
    );
    if (target.attribute !== outputAttribute) {
      target.element.removeAttribute(target.attribute);
    }
    changedElements.add(target.element);
  }

  for (const target of srcsetTargets) {
    if (
      !target.candidates.some(
        (candidate) => absoluteMediaUrl(candidate.source, baseUrl) === url,
      )
    ) {
      continue;
    }
    const candidates = target.candidates
      .map((candidate) => {
        const candidateUrl = absoluteMediaUrl(candidate.source, baseUrl);
        if (!candidateUrl) return candidate;
        return {
          ...candidate,
          source: outputMediaSourceForUrl(localSources, candidateUrl),
        };
      })
      .filter((candidate) => candidate.source !== "");
    target.element.setAttribute("srcset", formatSrcset(candidates));
    changedElements.add(target.element);
  }

  for (const target of styleTargets) {
    if (!target.urls.some((styleUrl) => styleUrl.url === url)) continue;
    target.element.setAttribute(
      "style",
      rewriteStyleMediaUrls(target.style, baseUrl, (styleUrl) =>
        outputMediaSourceForUrl(localSources, styleUrl),
      ),
    );
    changedElements.add(target.element);
  }
  return changedElements;
}

function safeChapterMediaHtml(template: HTMLTemplateElement): string {
  const safeTemplate = document.createElement("template");
  safeTemplate.innerHTML = template.innerHTML;
  clearMediaSourceMetadata(safeTemplate.content);
  return normalizeLocalChapterMediaOutput(safeTemplate.innerHTML);
}

export async function emitHtmlUpdate(
  onHtmlUpdate: CacheChapterMediaOptions["onHtmlUpdate"],
  template: HTMLTemplateElement,
): Promise<void> {
  if (!onHtmlUpdate) return;
  await onHtmlUpdate(safeChapterMediaHtml(template));
}

function collectMediaElementPatches(
  root: DocumentFragment,
  changedElements: Set<Element>,
): ChapterMediaElementPatch[] {
  if (changedElements.size === 0) return [];
  const elements = [...root.querySelectorAll<Element>(MEDIA_PATCH_SELECTOR)];
  const patches: ChapterMediaElementPatch[] = [];
  elements.forEach((element, index) => {
    if (!changedElements.has(element)) return;
    const attributes: Record<string, string> = {};
    for (const attribute of MEDIA_PATCH_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value?.trim()) attributes[attribute] = value;
    }
    if (Object.keys(attributes).length > 0) {
      patches.push({ index, attributes });
    }
  });
  return patches;
}

export function collectChapterMediaElementPatches(
  html: string,
): ChapterMediaElementPatch[] {
  if (typeof document === "undefined") return [];
  const template = document.createElement("template");
  template.innerHTML = html;
  return collectMediaElementPatches(
    template.content,
    collectAllMediaPatchElements(template.content),
  );
}

function collectAllMediaPatchElements(root: DocumentFragment): Set<Element> {
  const changedElements = new Set<Element>();
  for (const element of root.querySelectorAll<Element>(MEDIA_PATCH_SELECTOR)) {
    if (
      MEDIA_PATCH_ATTRIBUTES.some(
        (attribute) => (element.getAttribute(attribute) ?? "").trim() !== "",
      )
    ) {
      changedElements.add(element);
    }
  }
  return changedElements;
}

export async function emitMediaPatchUpdate(
  onMediaPatch: CacheChapterMediaOptions["onMediaPatch"],
  template: HTMLTemplateElement,
  changedElements: Set<Element>,
): Promise<void> {
  if (!onMediaPatch) return;
  const patches = collectMediaElementPatches(template.content, changedElements);
  if (patches.length > 0) {
    await onMediaPatch(patches);
  }
}
