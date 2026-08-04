import { load } from "cheerio";
import { marked } from "marked";

export const CHAPTER_CONTENT_TYPES = [
  "html",
  "text",
  "pdf",
  "markdown",
  "epub",
] as const;

export type ChapterContentType = (typeof CHAPTER_CONTENT_TYPES)[number];

export const DEFAULT_CHAPTER_CONTENT_TYPE: ChapterContentType = "html";

export const CHAPTER_BINARY_RESOURCE_MEDIA_TYPES = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
} as const satisfies Partial<Record<ChapterContentType, string>>;

interface SanitizableElement {
  attribs?: Record<string, string>;
  tagName: string;
}

const DATA_IMAGE_SOURCE_PATTERN =
  /^data:image\/(?:avif|gif|jpeg|jpg|png|webp);base64,[a-z\d+/]+=*$/i;

const UNSAFE_TAGS = new Set([
  "applet",
  "base",
  "button",
  "embed",
  "form",
  "frame",
  "frameset",
  "iframe",
  "input",
  "link",
  "meta",
  "object",
  "script",
  "select",
  "style",
  "textarea",
]);

const ALLOWED_TAGS = new Set([
  "a",
  "abbr",
  "article",
  "aside",
  "b",
  "blockquote",
  "body",
  "br",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "hr",
  "html",
  "i",
  "img",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "u",
  "ul",
]);

const GLOBAL_ALLOWED_ATTRIBUTES = new Set([
  "aria-label",
  "dir",
  "lang",
  "title",
]);

const IMAGE_SOURCE_ATTRIBUTES = new Set([
  "src",
  "data-src",
  "data-original",
  "data-lazy-src",
  "data-orig-src",
]);

const TAG_ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(["href"]),
  img: new Set(["alt", "height", ...IMAGE_SOURCE_ATTRIBUTES, "width"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
};

export function normalizeChapterContentType(
  value: unknown,
): ChapterContentType {
  return CHAPTER_CONTENT_TYPES.includes(value as ChapterContentType)
    ? (value as ChapterContentType)
    : DEFAULT_CHAPTER_CONTENT_TYPE;
}

export function isKnownChapterContentType(
  value: unknown,
): value is ChapterContentType {
  return CHAPTER_CONTENT_TYPES.includes(value as ChapterContentType);
}

export function isHtmlLikeChapterContentType(
  contentType: ChapterContentType,
): boolean {
  return (
    contentType === "html" ||
    contentType === "markdown" ||
    contentType === "epub"
  );
}

export function isBinaryChapterContentType(
  contentType: ChapterContentType,
): contentType is keyof typeof CHAPTER_BINARY_RESOURCE_MEDIA_TYPES {
  return contentType === "pdf" || contentType === "epub";
}

export const isChapterResourceContentType = isBinaryChapterContentType;

export function storedChapterContentType(
  contentType: ChapterContentType,
): ChapterContentType {
  return contentType === "text" || contentType === "markdown"
    ? "html"
    : contentType;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isAllowedUrl(
  value: string,
  options: { allowDataImages: boolean; allowMailto: boolean },
): boolean {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return true;
  if (options.allowDataImages && DATA_IMAGE_SOURCE_PATTERN.test(trimmed)) {
    return true;
  }

  try {
    const url = new URL(trimmed, "https://norea.invalid/");
    return (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      (options.allowMailto && url.protocol === "mailto:")
    );
  } catch {
    return false;
  }
}

function isAllowedAttribute(
  tagName: string,
  attributeName: string,
  value: string,
): boolean {
  const normalizedName = attributeName.toLowerCase();
  if (normalizedName.startsWith("on")) return false;
  if (normalizedName === "style" || normalizedName === "srcdoc") return false;
  if (
    !GLOBAL_ALLOWED_ATTRIBUTES.has(normalizedName) &&
    !TAG_ALLOWED_ATTRIBUTES[tagName]?.has(normalizedName)
  ) {
    return false;
  }

  if (tagName === "a" && normalizedName === "href") {
    return isAllowedUrl(value, {
      allowDataImages: false,
      allowMailto: true,
    });
  }
  if (tagName === "img" && IMAGE_SOURCE_ATTRIBUTES.has(normalizedName)) {
    return isAllowedUrl(value, {
      allowDataImages: true,
      allowMailto: false,
    });
  }
  if (
    (tagName === "img" &&
      (normalizedName === "width" || normalizedName === "height")) ||
    ((tagName === "td" || tagName === "th") &&
      (normalizedName === "colspan" || normalizedName === "rowspan"))
  ) {
    return /^\d{1,4}$/.test(value.trim());
  }

  return true;
}

export function sanitizeReaderHtml(html: string): string {
  const $ = load(html, {}, false);

  $([...UNSAFE_TAGS].join(",")).remove();

  $("*").each((_, element) => {
    const node = element as SanitizableElement;
    const tagName = node.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tagName)) {
      $(element).replaceWith($(element).contents());
      return;
    }

    for (const attribute of Object.keys(node.attribs ?? {})) {
      const value = $(element).attr(attribute) ?? "";
      if (!isAllowedAttribute(tagName, attribute, value)) {
        $(element).removeAttr(attribute);
      }
    }
  });

  return $.root().html() ?? "";
}

function markdownToHtml(content: string): string {
  const rendered = marked.parse(content, {
    async: false,
    gfm: true,
  }) as string;
  return `<section class="reader-markdown-content">${sanitizeReaderHtml(rendered)}</section>`;
}

function textLineToHtml(line: string, lineIndex: number): string {
  return `<span class="reader-text-line" data-line-index="${lineIndex}">${escapeHtml(line)}</span>`;
}

function textParagraphToHtml(lines: string[], paragraphIndex: number): string {
  return `<p class="reader-text-paragraph" data-paragraph-index="${paragraphIndex}">${lines
    .map((line, lineIndex) => textLineToHtml(line, lineIndex))
    .join("")}</p>`;
}

function textSectionToHtml(paragraphs: string[], sectionIndex: number): string {
  return `<section class="reader-text-section" data-section-index="${sectionIndex}">${paragraphs.join("")}</section>`;
}

function textSectionBreakToHtml(blankLines: number): string {
  return `<div class="reader-text-break" data-blank-lines="${blankLines}" aria-hidden="true"></div>`;
}

function textToHtml(content: string): string {
  const articleParts: string[] = [];
  const paragraphs: string[] = [];
  let paragraphLines: string[] = [];
  let pendingBlankLines = 0;
  let sectionIndex = 0;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    paragraphs.push(textParagraphToHtml(paragraphLines, paragraphs.length));
    paragraphLines = [];
  };

  const flushSection = () => {
    if (paragraphs.length === 0) return;
    articleParts.push(textSectionToHtml(paragraphs, sectionIndex));
    paragraphs.length = 0;
    sectionIndex += 1;
  };

  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trim() === "") {
      pendingBlankLines += 1;
      continue;
    }

    if (pendingBlankLines > 0) {
      flushParagraph();
      if (pendingBlankLines >= 2 && paragraphs.length > 0) {
        flushSection();
        articleParts.push(textSectionBreakToHtml(pendingBlankLines));
      }
      pendingBlankLines = 0;
    }

    paragraphLines.push(line.trimEnd());
  }

  flushParagraph();
  flushSection();

  return `<article class="reader-text-content" data-source-format="text">${articleParts.join("")}</article>`;
}

export function chapterContentToHtml(
  content: string,
  contentType: ChapterContentType,
): string {
  if (contentType === "text") {
    return textToHtml(content);
  }

  if (contentType === "markdown") {
    return markdownToHtml(content);
  }

  return content;
}
