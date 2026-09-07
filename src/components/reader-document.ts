import { load } from "cheerio";
import { readerHtmlHasMedia } from "./reader-virtualization";

export interface ReaderVirtualSegment {
  estimatedHeight: number;
  html: string;
  index: number;
}

export interface ReaderVirtualDocument {
  contentClassName: string;
  contentDirection?: "ltr" | "rtl" | "auto";
  contentLanguage?: string;
  segments: ReaderVirtualSegment[];
  staticHtml: string;
}

export interface PreparedReaderDocument {
  html: string;
  virtualDocument: ReaderVirtualDocument;
}

export const READER_MEDIA_PATCH_SELECTOR = [
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
export const READER_MEDIA_SOURCE_URL_ATTRIBUTE = "data-norea-media-source-url";
export const READER_PENDING_MEDIA_ATTRIBUTE = "data-norea-reader-media-pending";
export const READER_PENDING_BACKGROUND_ATTRIBUTE = "data-norea-reader-media-bg";
export const READER_PENDING_DISPLAY_ATTRIBUTE = "data-norea-reader-media-display";
export const READER_PENDING_HEIGHT_ATTRIBUTE = "data-norea-reader-media-height";
export const READER_MEDIA_INDEX_ATTRIBUTE = "data-norea-reader-media-index";
export const READER_SEGMENT_INDEX_ATTRIBUTE = "data-norea-reader-segment-index";
export const READER_PENDING_PLACEHOLDER_SRC =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%221000%22%20height%3D%221400%22%20viewBox%3D%220%200%201000%201400%22%2F%3E";
export const READER_PENDING_PLACEHOLDER_HEIGHT = "min(72vh, 56rem)";
export const READER_INERT_LOCAL_MEDIA_SRC_PREFIX =
  "norea-media%3A%2F%2Freader-asset%2F";
export const READER_DOM_PREPROCESS_MAX_HTML_LENGTH = 350_000;

const READER_UNSCOPED_LOCAL_MEDIA_SRC_PATTERN =
  /norea-media:\/\/reader-asset\/(?!~cache\/)/g;
const READER_SEGMENT_DEFAULT_HEIGHT = 96;
const READER_SEGMENT_MEDIA_HEIGHT = 520;
const READER_LARGE_SEGMENT_TARGET_LENGTH = 24_000;
const READER_LARGE_SEGMENT_MAX_LENGTH = 80_000;
const READER_TEXT_SEGMENT_TARGET_LENGTH = 2_000;
const READER_TEXT_SEGMENT_MIN_SPLIT_LENGTH = 1_000;
const READER_TEXT_CONTENT_CLASS_PATTERN = /\breader-text-content\b/;
const READER_TEXT_BLOCK_PATTERN =
  /<p\b[^>]*>([\s\S]*?)<\/p>|<div\b(?=[^>]*\breader-text-break\b)[^>]*\bdata-blank-lines=(?:"(\d+)"|'(\d+)'|(\d+))[^>]*>\s*<\/div>/gi;
const READER_TEXT_LINE_PATTERN =
  /<span\b(?=[^>]*\breader-text-line\b)[^>]*>([\s\S]*?)<\/span>/gi;

function inertLocalMediaHtml(html: string): string {
  return html.replace(
    READER_UNSCOPED_LOCAL_MEDIA_SRC_PATTERN,
    READER_INERT_LOCAL_MEDIA_SRC_PREFIX,
  );
}

function hasReaderMediaPatchCandidate(html: string): boolean {
  return /<(?:img|video|audio|source|embed|track|object|link|image|use)\b|\b(?:style|srcset|poster|data-src|data-original|data-lazy-src|data-orig-src)\s*=/i.test(
    html,
  );
}

function prepareReaderHtmlForDisplay(html: string): string {
  if (!html.includes(READER_MEDIA_SOURCE_URL_ATTRIBUTE)) return html;
  const $ = load(html, {}, false);
  let changed = false;
  $(`img[${READER_MEDIA_SOURCE_URL_ATTRIBUTE}]`).each((_, image) => {
    const element = $(image);
    if ((element.attr("src") ?? "").trim() !== "") return;
    element.attr("src", READER_PENDING_PLACEHOLDER_SRC);
    element.attr(READER_PENDING_MEDIA_ATTRIBUTE, "true");
    if (!element.css("display")) {
      element.css("display", "block");
      element.attr(READER_PENDING_DISPLAY_ATTRIBUTE, "true");
    }
    if (!element.css("min-height")) {
      element.css("min-height", READER_PENDING_PLACEHOLDER_HEIGHT);
      element.attr(READER_PENDING_HEIGHT_ATTRIBUTE, "true");
    }
    if (!element.css("background-color")) {
      element.css("background-color", "rgba(148, 163, 184, 0.12)");
      element.attr(READER_PENDING_BACKGROUND_ATTRIBUTE, "true");
    }
    changed = true;
  });
  return changed ? $.html() : html;
}

function annotateReaderMediaElements(html: string): string {
  if (!hasReaderMediaPatchCandidate(html)) return html;
  const $ = load(html, {}, false);
  $(READER_MEDIA_PATCH_SELECTOR).each((index, element) => {
    $(element).attr(READER_MEDIA_INDEX_ATTRIBUTE, String(index));
  });
  return $.html();
}

function preprocessReaderHtmlShell(html: string, bionicReading: boolean): string {
  const localMediaSafeHtml = inertLocalMediaHtml(html);
  if (localMediaSafeHtml.length > READER_DOM_PREPROCESS_MAX_HTML_LENGTH) {
    return localMediaSafeHtml;
  }
  const preparedHtml = prepareReaderHtmlForDisplay(localMediaSafeHtml);
  return annotateReaderMediaElements(
    bionicReading ? applyBionicReading(preparedHtml) : preparedHtml,
  );
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
  if (readerHtmlHasMedia(html)) {
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

function emphasizeWord(word: string): string {
  if (word.length < 4) return word;
  const splitAt = Math.ceil(word.length * 0.42);
  return `<strong>${word.slice(0, splitAt)}</strong>${word.slice(splitAt)}`;
}

function buildReaderVirtualDocument(html: string): ReaderVirtualDocument {
  const textDocument = buildReaderTextVirtualDocument(html);
  if (textDocument) return textDocument;
  if (html.length > READER_DOM_PREPROCESS_MAX_HTML_LENGTH) {
    return buildLargeReaderVirtualDocument(html);
  }

  const $ = load(html, {}, false);
  const staticNodes = $("style");
  const staticHtml = staticNodes.toArray().map((node) => $.html(node)).join("");
  staticNodes.remove();

  const elementChildren = $.root().children();
  const root =
    elementChildren.length === 1 && elementChildren.eq(0).children().length > 0
      ? elementChildren.eq(0)
      : null;
  const sourceNodes = root
    ? root.contents().toArray()
    : $.root().contents().toArray();
  const segments: ReaderVirtualSegment[] = [];
  for (const node of sourceNodes) {
    const index = segments.length;
    if (node.type === "text") {
      if (node.data.trim() === "") continue;
      const paragraph = $("<p></p>");
      paragraph.attr(READER_SEGMENT_INDEX_ATTRIBUTE, String(index));
      paragraph.text(node.data);
      segments.push({
        estimatedHeight: READER_SEGMENT_DEFAULT_HEIGHT,
        html: $.html(paragraph),
        index,
      });
      continue;
    }
    if (node.type !== "tag" && node.type !== "script" && node.type !== "style") {
      continue;
    }
    const element = $(node);
    const textLength = element.text().trim().length;
    const estimatedHeight = element.find(
      "img,picture,svg,video,canvas,iframe",
    ).length
      ? READER_SEGMENT_MEDIA_HEIGHT
      : Math.max(
          READER_SEGMENT_DEFAULT_HEIGHT,
          Math.min(1200, Math.ceil(textLength / 4)),
        );
    element.attr(READER_SEGMENT_INDEX_ATTRIBUTE, String(index));
    segments.push({ estimatedHeight, html: $.html(element), index });
  }

  const classes = new Set(["reader-content"]);
  for (const className of (root?.attr("class") ?? "").split(/\s+/)) {
    if (className) classes.add(className);
  }
  const direction = root?.attr("dir");
  const language = root?.attr("lang");
  return {
    contentClassName: [...classes].join(" "),
    ...(direction === "ltr" || direction === "rtl" || direction === "auto"
      ? { contentDirection: direction }
      : {}),
    ...(language ? { contentLanguage: language } : {}),
    segments,
    staticHtml,
  };
}

function applyBionicReading(html: string): string {
  const $ = load(html);
  const body = $("body");
  const textNodes = body
    .find("*")
    .addBack()
    .contents()
    .toArray()
    .filter((node) => node.type === "text" && node.data.trim() !== "");

  for (const node of textNodes) {
    if (node.type !== "text") continue;
    const parts: string[] = [];
    let offset = 0;
    for (const match of node.data.matchAll(/[A-Za-z0-9]{4,}/g)) {
      parts.push(escapeReaderHtmlText(node.data.slice(offset, match.index)));
      parts.push(emphasizeWord(match[0]));
      offset = match.index + match[0].length;
    }
    parts.push(escapeReaderHtmlText(node.data.slice(offset)));
    $(node).replaceWith("<span>" + parts.join("") + "</span>");
  }
  return body.html() ?? "";
}

export function prepareReaderDocument(
  html: string,
  bionicReading: boolean,
): PreparedReaderDocument {
  const preparedHtml = preprocessReaderHtmlShell(html, bionicReading);
  return {
    html: preparedHtml,
    virtualDocument: buildReaderVirtualDocument(preparedHtml),
  };
}
