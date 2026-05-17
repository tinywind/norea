import { load, type CheerioAPI } from "cheerio";
import * as csstree from "css-tree";
import {
  listZipEntries,
  readZipFile,
  type PluginZipEntryInfo,
} from "./plugins/shims";

export const EPUB_HTML_RESOURCE_PREFIX = "norea-epub-resource://";

export const EPUB_HTML_LIMITS = {
  containerBytes: 256 * 1024,
  cssBytes: 1024 * 1024,
  opfBytes: 2 * 1024 * 1024,
  sectionBytes: 4 * 1024 * 1024,
  resourceBytes: 4 * 1024 * 1024,
  totalResourceBytes: 24 * 1024 * 1024,
} as const;

type ZipEntryInfo = PluginZipEntryInfo;
type ZipIpcBytes = Uint8Array | number[];
type CheerioInput = NonNullable<Parameters<CheerioAPI>[0]>;

interface EpubManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties?: string;
}

interface EpubPackageMetadata {
  author?: string;
  direction?: string;
  language?: string;
  title: string;
}

interface EpubResourceRecord {
  bytes: Uint8Array;
  fileName: string;
  mediaType: string;
  path: string;
  placeholder: string;
}

interface EpubResourceContext {
  entries: Map<string, ZipEntryInfo>;
  manifestByPath: Map<string, EpubManifestItem>;
  metadata?: EpubPackageMetadata;
  packageDir: string;
  resourceBudget: { usedBytes: number };
  resources: Map<string, EpubResourceRecord>;
  zipBytes: ZipIpcBytes;
}

export interface EpubHtmlResource {
  bytes: Uint8Array;
  fileName: string;
  mediaType: string;
  placeholder: string;
  sourcePath: string;
}

export interface EpubHtmlSection {
  html: string;
  href: string;
  name: string;
  resources: EpubHtmlResource[];
}

export interface EpubHtmlConversion {
  author?: string;
  direction?: string;
  language?: string;
  sections: EpubHtmlSection[];
  title: string;
}

const XHTML_MEDIA_TYPES = new Set([
  "application/xhtml+xml",
  "text/html",
  "application/html+xml",
]);

const CSS_MEDIA_TYPES = new Set(["text/css"]);

const SUPPORTED_RESOURCE_MEDIA_TYPES: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".ogv": "video/ogg",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".vtt": "text/vtt",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const SVG_TAGS = new Set([
  "circle",
  "clipPath",
  "defs",
  "ellipse",
  "g",
  "image",
  "line",
  "linearGradient",
  "path",
  "polygon",
  "polyline",
  "rect",
  "stop",
  "svg",
  "text",
  "tspan",
  "use",
]);

const EPUB_ALLOWED_TAGS = new Set([
  "a",
  "abbr",
  "article",
  "aside",
  "audio",
  "b",
  "blockquote",
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
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "li",
  "mark",
  "main",
  "nav",
  "ol",
  "p",
  "picture",
  "pre",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "section",
  "small",
  "source",
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
  "track",
  "tr",
  "u",
  "ul",
  "video",
  ...SVG_TAGS,
]);

const EPUB_UNSAFE_TAGS = new Set([
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
  "textarea",
]);

const EPUB_GLOBAL_ATTRIBUTES = new Set([
  "aria-label",
  "class",
  "dir",
  "epub:type",
  "id",
  "lang",
  "role",
  "title",
  "xml:lang",
]);

const EPUB_TAG_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(["href"]),
  audio: new Set(["controls", "loop", "muted", "preload", "src"]),
  col: new Set(["span"]),
  img: new Set(["alt", "height", "src", "srcset", "width"]),
  source: new Set(["src", "srcset", "type"]),
  svg: new Set(["height", "preserveAspectRatio", "viewBox", "width"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
  track: new Set(["default", "kind", "label", "src", "srclang"]),
  video: new Set([
    "controls",
    "height",
    "loop",
    "muted",
    "poster",
    "preload",
    "src",
    "width",
  ]),
};

const EPUB_SVG_ATTRIBUTES = new Set([
  "cx",
  "cy",
  "d",
  "fill",
  "height",
  "href",
  "points",
  "preserveAspectRatio",
  "r",
  "rx",
  "ry",
  "stroke",
  "stroke-width",
  "transform",
  "viewBox",
  "width",
  "x",
  "x1",
  "x2",
  "xlink:href",
  "y",
  "y1",
  "y2",
]);

function bytesToArray(bytes: Uint8Array): number[] {
  return Array.from(bytes);
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function normalizeZipPath(path: string): string {
  const parts: string[] = [];
  for (const rawPart of path.replace(/\\/g, "/").split("/")) {
    const part = safeDecodePathPart(rawPart).trim();
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function safeDecodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function directoryName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function extensionName(path: string): string {
  const cleanPath = path.split(/[?#]/, 1)[0] ?? "";
  const dotIndex = cleanPath.lastIndexOf(".");
  return dotIndex < 0 ? "" : cleanPath.slice(dotIndex).toLowerCase();
}

function baseName(path: string): string {
  const cleanPath = path.split(/[?#]/, 1)[0] ?? path;
  const slashIndex = cleanPath.lastIndexOf("/");
  return slashIndex < 0 ? cleanPath : cleanPath.slice(slashIndex + 1);
}

function safeFileName(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "resource.bin";
}

function joinZipPath(basePath: string, href: string): string {
  if (/^[a-z][a-z\d+\-.]*:/i.test(href)) return "";
  const baseParts =
    basePath && !href.startsWith("/") ? basePath.split("/") : [];
  const hrefParts = href.split("#")[0]?.split("?")[0] ?? "";
  return normalizeZipPath([...baseParts, hrefParts].join("/"));
}

function isXhtmlManifestItem(item: EpubManifestItem): boolean {
  if (XHTML_MEDIA_TYPES.has(item.mediaType)) return true;
  const extension = extensionName(item.href);
  return extension === ".xhtml" || extension === ".html" || extension === ".htm";
}

function isCssManifestItem(
  item: EpubManifestItem | undefined,
  path: string,
): boolean {
  return (
    Boolean(item && CSS_MEDIA_TYPES.has(item.mediaType)) ||
    extensionName(path) === ".css"
  );
}

function mediaTypeForResource(
  path: string,
  item?: EpubManifestItem,
): string | null {
  const mediaType = item?.mediaType.toLowerCase();
  if (mediaType && mediaType !== "application/octet-stream") return mediaType;
  return SUPPORTED_RESOURCE_MEDIA_TYPES[extensionName(path)] ?? null;
}

async function invokeZipList(bytes: ZipIpcBytes): Promise<ZipEntryInfo[]> {
  return listZipEntries(bytes);
}

async function invokeZipReadFile(
  bytes: ZipIpcBytes,
  path: string,
  maxBytes: number,
): Promise<Uint8Array> {
  return readZipFile(bytes, {
    path,
    maxBytes,
  });
}

function entryMapByName(entries: ZipEntryInfo[]): Map<string, ZipEntryInfo> {
  const map = new Map<string, ZipEntryInfo>();
  for (const entry of entries) {
    if (entry.isFile) map.set(normalizeZipPath(entry.name), entry);
  }
  return map;
}

function parseContainerRootfile(containerXml: string): string {
  const $ = load(containerXml, { xmlMode: true });
  const rootfilePath = $("rootfile").first().attr("full-path")?.trim();
  if (!rootfilePath) {
    throw new Error("EPUB container.xml does not reference an OPF file.");
  }
  return normalizeZipPath(rootfilePath);
}

function manifestItemsFromOpf(opfXml: string): Map<string, EpubManifestItem> {
  const $ = load(opfXml, { xmlMode: true });
  const manifest = new Map<string, EpubManifestItem>();

  $("manifest item").each((_, element) => {
    const id = $(element).attr("id")?.trim();
    const href = $(element).attr("href")?.trim();
    const mediaType =
      $(element).attr("media-type")?.trim().toLowerCase() ?? "";
    const properties = $(element).attr("properties")?.trim();
    if (!id || !href) return;
    manifest.set(id, { id, href, mediaType, properties });
  });

  return manifest;
}

function manifestItemsByPath(
  manifest: Map<string, EpubManifestItem>,
  packageDir: string,
): Map<string, EpubManifestItem> {
  const items = new Map<string, EpubManifestItem>();
  for (const item of manifest.values()) {
    items.set(joinZipPath(packageDir, item.href), item);
  }
  return items;
}

function spineIdrefsFromOpf(opfXml: string): string[] {
  const $ = load(opfXml, { xmlMode: true });
  const ids: string[] = [];
  $("spine itemref").each((_, element) => {
    const idref = $(element).attr("idref")?.trim();
    if (idref) ids.push(idref);
  });
  return ids;
}

function packageMetadataFromOpf(
  opfXml: string,
  fallbackTitle: string,
): EpubPackageMetadata {
  const $ = load(opfXml, { xmlMode: true });
  const title =
    $("metadata title, dc\\:title")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim() || fallbackTitle;
  const author =
    $("metadata creator, dc\\:creator")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim() || undefined;
  const language =
    $("metadata language, dc\\:language")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim() || undefined;
  const direction = $("spine")
    .first()
    .attr("page-progression-direction")
    ?.trim();
  return {
    ...(author ? { author } : {}),
    ...(direction === "rtl" || direction === "ltr" ? { direction } : {}),
    ...(language ? { language } : {}),
    title,
  };
}

function chapterNameFromHtml(html: string, fallback: string): string {
  const $ = load(html);
  const title =
    $("title, h1, h2, h3")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim() || fallback;
  return title;
}

function bodyOrRootHtml(html: string): string {
  const $ = load(html);
  const bodyHtml = $("body").first().html();
  return bodyHtml ?? ($.root().html() || html);
}

function isAllowedUrl(
  value: string,
  options: { allowMedia: boolean; allowMailto: boolean },
): boolean {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return true;
  if (options.allowMedia && trimmed.startsWith(EPUB_HTML_RESOURCE_PREFIX)) {
    return true;
  }
  if (options.allowMedia && trimmed.startsWith("norea-media://chapter/")) {
    return true;
  }
  if (
    options.allowMedia &&
    /^data:(?:image|audio|video|font)\//i.test(trimmed)
  ) {
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
  if (normalizedName === "srcdoc") return false;
  if (normalizedName.startsWith("aria-")) return true;
  if (
    !EPUB_GLOBAL_ATTRIBUTES.has(normalizedName) &&
    !EPUB_TAG_ATTRIBUTES[tagName]?.has(normalizedName) &&
    !(SVG_TAGS.has(tagName) && EPUB_SVG_ATTRIBUTES.has(normalizedName))
  ) {
    return false;
  }

  if (
    (tagName === "a" && normalizedName === "href") ||
    ((tagName === "use" || tagName === "image") &&
      (normalizedName === "href" || normalizedName === "xlink:href"))
  ) {
    return isAllowedUrl(value, {
      allowMedia: tagName !== "a",
      allowMailto: tagName === "a",
    });
  }
  if (normalizedName === "src" || normalizedName === "poster") {
    return isAllowedUrl(value, { allowMedia: true, allowMailto: false });
  }
  if (normalizedName === "srcset") {
    return normalizeSrcset(value).every((candidate) =>
      isAllowedUrl(candidate.source, { allowMedia: true, allowMailto: false }),
    );
  }
  if (
    normalizedName === "width" ||
    normalizedName === "height" ||
    normalizedName === "colspan" ||
    normalizedName === "rowspan" ||
    normalizedName === "span"
  ) {
    return /^[\d.]{1,8}%?$/.test(value.trim());
  }

  return true;
}

function sanitizeEpubBodyHtml(html: string): string {
  const $ = load(html, {}, false);

  $([...EPUB_UNSAFE_TAGS].join(",")).remove();

  $("*").each((_, element) => {
    const node = element as {
      attribs?: Record<string, string>;
      tagName: string;
    };
    const tagName = node.tagName.toLowerCase();
    if (!EPUB_ALLOWED_TAGS.has(tagName)) {
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

function normalizeSrcset(
  value: string,
): Array<{ descriptor: string; source: string }> {
  return value
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .map((candidate) => {
      const [source = "", ...descriptor] = candidate.split(/\s+/);
      return { descriptor: descriptor.join(" "), source };
    })
    .filter((candidate) => candidate.source !== "");
}

function formatSrcset(
  candidates: Array<{ descriptor: string; source: string }>,
): string {
  return candidates
    .map((candidate) =>
      candidate.descriptor
        ? `${candidate.source} ${candidate.descriptor}`
        : candidate.source,
    )
    .join(", ");
}

function placeholderForPath(path: string): string {
  return `${EPUB_HTML_RESOURCE_PREFIX}${encodeURIComponent(path)}`;
}

async function registerResource(
  context: EpubResourceContext,
  rawPath: string,
): Promise<string | null> {
  const path = normalizeZipPath(rawPath);
  const entry = context.entries.get(path);
  if (!entry) return null;
  const item = context.manifestByPath.get(path);
  const mediaType = mediaTypeForResource(path, item);
  if (!mediaType || CSS_MEDIA_TYPES.has(mediaType)) return null;
  if (entry.uncompressedSize > EPUB_HTML_LIMITS.resourceBytes) return null;
  if (
    context.resourceBudget.usedBytes + entry.uncompressedSize >
    EPUB_HTML_LIMITS.totalResourceBytes
  ) {
    return null;
  }

  const existing = context.resources.get(path);
  if (existing) return existing.placeholder;

  const bytes = await invokeZipReadFile(
    context.zipBytes,
    path,
    EPUB_HTML_LIMITS.resourceBytes,
  );
  context.resourceBudget.usedBytes += bytes.byteLength;
  const placeholder = placeholderForPath(path);
  const index = context.resources.size + 1;
  const fileName = `${String(index).padStart(4, "0")}-${safeFileName(
    baseName(path),
  )}`;
  context.resources.set(path, {
    bytes,
    fileName,
    mediaType,
    path,
    placeholder,
  });
  return placeholder;
}

function scopeSelector(selector: string, scopeSelectorValue: string): string {
  const trimmed = selector.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("@")) return "";
  let scoped = trimmed.replace(/^:root\b/, scopeSelectorValue);
  scoped = scoped.replace(/^html\s+body\b/, scopeSelectorValue);
  scoped = scoped.replace(/^html\b/, scopeSelectorValue);
  scoped = scoped.replace(/^body\b/, scopeSelectorValue);
  if (scoped !== trimmed) return scoped;
  return `${scopeSelectorValue} ${trimmed}`;
}

function extractImportPath(
  prelude: csstree.AtrulePrelude | csstree.Raw | null,
): string | null {
  if (!prelude) return null;
  const generated = csstree.generate(prelude).trim();
  const match =
    generated.match(/^url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]+))\s*\)/i) ??
    generated.match(/^"([^"]+)"/) ??
    generated.match(/^'([^']+)'/);
  return String(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim() || null;
}

async function sanitizeCss(
  context: EpubResourceContext,
  css: string,
  cssPath: string,
  sectionScope: string,
  importDepth = 0,
): Promise<string> {
  let ast: csstree.CssNode;
  try {
    ast = csstree.parse(css, {
      onParseError: () => undefined,
      parseValue: true,
    });
  } catch {
    return "";
  }

  const importCss: string[] = [];
  const cssDir = directoryName(cssPath);
  const pendingUrls: Array<{ node: csstree.Url; path: string }> = [];

  csstree.walk(ast, {
    enter(
      node: csstree.CssNode,
      item: csstree.ListItem<csstree.CssNode>,
      list: csstree.List<csstree.CssNode>,
    ) {
      if (node.type === "Declaration") {
        node.important = false;
        const property = node.property.toLowerCase();
        if (property === "behavior" || property.startsWith("-ms-behavior")) {
          list.remove(item);
          return;
        }
      }
      if (node.type === "Atrule") {
        const name = node.name.toLowerCase();
        if (name === "import") {
          const importPath = extractImportPath(node.prelude);
          if (importPath && importDepth < 8) {
            const path = joinZipPath(cssDir, importPath);
            if (path) {
              importCss.push(path);
            }
          }
          list.remove(item);
          return;
        }
        if (name === "charset" || name === "page" || name === "namespace") {
          list.remove(item);
          return;
        }
      }
      if (node.type === "Url") {
        const value = node.value.trim();
        if (!value || value.startsWith("#") || /^data:/i.test(value)) return;
        if (/^[a-z][a-z\d+\-.]*:/i.test(value)) {
          node.value = "";
          return;
        }
        const path = joinZipPath(cssDir, value);
        if (path) pendingUrls.push({ node, path });
      }
    },
  });

  for (const { node, path } of pendingUrls) {
    node.value = (await registerResource(context, path)) ?? "";
  }

  csstree.walk(ast, {
    visit: "Rule",
    enter(node) {
      if (node.prelude.type !== "SelectorList") return;
      const scopedSelectors = node.prelude.children
        .toArray()
        .map((selector) =>
          scopeSelector(csstree.generate(selector), sectionScope),
        )
        .filter(Boolean);
      try {
        node.prelude = csstree.parse(scopedSelectors.join(", "), {
          context: "selectorList",
        }) as csstree.SelectorList;
      } catch {
        node.prelude = csstree.parse(sectionScope, {
          context: "selectorList",
        }) as csstree.SelectorList;
      }
    },
  });

  const imported = (
    await Promise.all(
      importCss.map(async (path) => {
        const item = context.manifestByPath.get(path);
        if (!isCssManifestItem(item, path) || !context.entries.has(path)) {
          return "";
        }
        const source = utf8Decode(
          await invokeZipReadFile(
            context.zipBytes,
            path,
            EPUB_HTML_LIMITS.cssBytes,
          ),
        );
        return sanitizeCss(context, source, path, sectionScope, importDepth + 1);
      }),
    )
  ).filter(Boolean);

  const generated = csstree.generate(ast, { mode: "safe" });
  return [...imported, generated].filter(Boolean).join("\n");
}

async function sanitizeStyleAttribute(
  context: EpubResourceContext,
  style: string,
  basePath: string,
): Promise<string> {
  let ast: csstree.CssNode;
  try {
    ast = csstree.parse(style, {
      context: "declarationList",
      onParseError: () => undefined,
      parseValue: true,
    });
  } catch {
    return "";
  }

  const baseDir = directoryName(basePath);
  const pendingUrls: Array<{ node: csstree.Url; path: string }> = [];
  csstree.walk(ast, {
    enter(
      node: csstree.CssNode,
      item: csstree.ListItem<csstree.CssNode>,
      list: csstree.List<csstree.CssNode>,
    ) {
      if (node.type === "Declaration") {
        node.important = false;
        const property = node.property.toLowerCase();
        if (property === "behavior" || property.startsWith("-ms-behavior")) {
          list.remove(item);
          return;
        }
      }
      if (node.type !== "Url") return;
      const value = node.value.trim();
      if (!value || value.startsWith("#") || /^data:/i.test(value)) return;
      if (/^[a-z][a-z\d+\-.]*:/i.test(value)) {
        node.value = "";
        return;
      }
      const path = joinZipPath(baseDir, value);
      if (path) pendingUrls.push({ node, path });
    },
  });
  for (const { node, path } of pendingUrls) {
    node.value = (await registerResource(context, path)) ?? "";
  }
  return csstree.generate(ast, { mode: "safe" });
}

async function rewriteResourceAttribute(
  context: EpubResourceContext,
  element: CheerioInput,
  attribute: string,
  basePath: string,
  $: CheerioAPI,
): Promise<void> {
  const rawValue = $(element).attr(attribute)?.trim();
  if (
    !rawValue ||
    rawValue.startsWith("#") ||
    /^[a-z][a-z\d+\-.]*:/i.test(rawValue)
  ) {
    return;
  }
  const path = joinZipPath(directoryName(basePath), rawValue);
  const placeholder = path ? await registerResource(context, path) : null;
  if (placeholder) {
    $(element).attr(attribute, placeholder);
  } else {
    $(element).removeAttr(attribute);
  }
}

async function rewriteSrcsetAttribute(
  context: EpubResourceContext,
  element: CheerioInput,
  basePath: string,
  $: CheerioAPI,
): Promise<void> {
  const rawSrcset = $(element).attr("srcset");
  if (!rawSrcset) return;
  const candidates = await Promise.all(
    normalizeSrcset(rawSrcset).map(async (candidate) => {
      if (/^[a-z][a-z\d+\-.]*:/i.test(candidate.source)) return null;
      const path = joinZipPath(directoryName(basePath), candidate.source);
      const placeholder = path ? await registerResource(context, path) : null;
      return placeholder ? { ...candidate, source: placeholder } : null;
    }),
  );
  const rewritten = candidates.filter(
    (candidate): candidate is { descriptor: string; source: string } =>
      candidate !== null,
  );
  if (rewritten.length > 0) {
    $(element).attr("srcset", formatSrcset(rewritten));
  } else {
    $(element).removeAttr("srcset");
  }
}

async function linkedCssFromDocument(
  context: EpubResourceContext,
  $: CheerioAPI,
  sectionPath: string,
  sectionScope: string,
): Promise<string[]> {
  const styles: string[] = [];
  const links = $("link[href]").toArray();
  for (const element of links) {
    const rel = $(element).attr("rel")?.toLowerCase() ?? "";
    if (!rel.split(/\s+/).includes("stylesheet")) continue;
    const href = $(element).attr("href")?.trim();
    if (!href) continue;
    const path = joinZipPath(directoryName(sectionPath), href);
    const item = context.manifestByPath.get(path);
    if (!isCssManifestItem(item, path) || !context.entries.has(path)) continue;
    const css = utf8Decode(
      await invokeZipReadFile(context.zipBytes, path, EPUB_HTML_LIMITS.cssBytes),
    );
    const sanitized = await sanitizeCss(context, css, path, sectionScope);
    if (sanitized) styles.push(sanitized);
  }
  for (const element of $("style").toArray()) {
    const css = $(element).text();
    if (css.trim()) {
    const sanitized = await sanitizeCss(
      context,
      css,
      sectionPath,
      sectionScope,
    );
      if (sanitized) styles.push(sanitized);
    }
  }
  return styles;
}

async function convertSection(
  context: EpubResourceContext,
  item: EpubManifestItem,
  index: number,
): Promise<EpubHtmlSection> {
  const sectionPath = joinZipPath(context.packageDir, item.href);
  const xhtml = utf8Decode(
    await invokeZipReadFile(
      context.zipBytes,
      sectionPath,
      EPUB_HTML_LIMITS.sectionBytes,
    ),
  );
  const sectionId = `epub-section-${index + 1}`;
  const sectionScope = `.reader-epub-section[data-epub-section="${sectionId}"]`;
  const $ = load(xhtml, { xmlMode: false });
  const styles = await linkedCssFromDocument(
    context,
    $,
    sectionPath,
    sectionScope,
  );
  const inlineStyleRules: string[] = [];

  for (const element of $(
    "img[src], video[src], audio[src], source[src], track[src]",
  ).toArray()) {
    await rewriteResourceAttribute(context, element, "src", sectionPath, $);
  }
  for (const element of $("img[srcset], source[srcset]").toArray()) {
    await rewriteSrcsetAttribute(context, element, sectionPath, $);
  }
  for (const element of $("video[poster]").toArray()) {
    await rewriteResourceAttribute(context, element, "poster", sectionPath, $);
  }
  for (const element of $(
    "image[href], image[xlink\\:href], use[href], use[xlink\\:href]",
  ).toArray()) {
    if ($(element).attr("href")) {
      await rewriteResourceAttribute(context, element, "href", sectionPath, $);
    }
    if ($(element).attr("xlink:href")) {
      await rewriteResourceAttribute(
        context,
        element,
        "xlink:href",
        sectionPath,
        $,
      );
    }
  }
  for (const element of $("[style]").toArray()) {
    const style = $(element).attr("style") ?? "";
    const sanitized = await sanitizeStyleAttribute(context, style, sectionPath);
    if (sanitized) {
      const className = `norea-epub-inline-style-${inlineStyleRules.length + 1}`;
      const classes = ($(element).attr("class") ?? "")
        .split(/\s+/)
        .filter(Boolean);
      classes.push(className);
      $(element).attr("class", classes.join(" "));
      $(element).removeAttr("style");
      inlineStyleRules.push(`${sectionScope} .${className}{${sanitized}}`);
    } else {
      $(element).removeAttr("style");
    }
  }
  styles.push(...inlineStyleRules);

  $("script, iframe, object, embed, link, meta, style").remove();
  const styleElement = styles.length
    ? [
        `<style data-norea-epub-style>@layer norea-epub-author {`,
        styles.join("\n"),
        `}</style>`,
      ].join("\n")
    : "";
  const dir = packageDirectionAttribute(context);
  const body = sanitizeEpubBodyHtml(bodyOrRootHtml($.root().html() ?? xhtml));
  const html = [
    [
      `<section class="reader-epub-section"`,
      ` data-epub-section="${sectionId}"`,
      ` data-epub-href="${escapeAttribute(sectionPath)}"${dir}>`,
    ].join(""),
    styleElement,
    `<div class="reader-epub-body">${body}</div>`,
    "</section>",
  ].join("");
  const resources = [...context.resources.values()]
    .filter((resource) => html.includes(resource.placeholder))
    .map((resource) => ({
      bytes: resource.bytes,
      fileName: resource.fileName,
      mediaType: resource.mediaType,
      placeholder: resource.placeholder,
      sourcePath: resource.path,
    }));
  return {
    html,
    href: sectionPath,
    name: chapterNameFromHtml(xhtml, `Chapter ${index + 1}`),
    resources,
  };
}

function packageDirectionAttribute(context: EpubResourceContext): string {
  if (
    context.metadata?.direction === "rtl" ||
    context.metadata?.direction === "ltr"
  ) {
    return ` dir="${context.metadata.direction}"`;
  }
  return "";
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderedDocumentHtml(
  sections: EpubHtmlSection[],
  metadata: EpubPackageMetadata,
): string {
  const language = metadata.language
    ? ` lang="${escapeAttribute(metadata.language)}"`
    : "";
  const direction = metadata.direction ? ` dir="${metadata.direction}"` : "";
  return [
    `<article class="reader-epub-content" data-epub-rendered="true"${language}${direction}>`,
    ...sections.map((section) => section.html),
    "</article>",
  ].join("");
}

export function isRenderedEpubHtml(content: string): boolean {
  return content
    .trimStart()
    .toLowerCase()
    .startsWith('<article class="reader-epub-content"');
}

export function mergeEpubHtmlSections(
  sections: EpubHtmlSection[],
  metadata: Pick<EpubPackageMetadata, "direction" | "language"> = {},
): string {
  return renderedDocumentHtml(sections, {
    title: "",
    ...metadata,
  });
}

export async function convertEpubToHtml(
  bytes: Uint8Array,
  options: { fallbackTitle: string },
): Promise<EpubHtmlConversion> {
  const zipBytes = bytesToArray(bytes);
  const entries = entryMapByName(await invokeZipList(zipBytes));
  if (!entries.has("META-INF/container.xml")) {
    throw new Error("EPUB archive is missing META-INF/container.xml.");
  }

  const containerXml = utf8Decode(
    await invokeZipReadFile(
      zipBytes,
      "META-INF/container.xml",
      EPUB_HTML_LIMITS.containerBytes,
    ),
  );
  const opfPath = parseContainerRootfile(containerXml);
  const opfXml = utf8Decode(
    await invokeZipReadFile(zipBytes, opfPath, EPUB_HTML_LIMITS.opfBytes),
  );
  const packageDir = directoryName(opfPath);
  const manifest = manifestItemsFromOpf(opfXml);
  const manifestByPath = manifestItemsByPath(manifest, packageDir);
  const spineItems = spineIdrefsFromOpf(opfXml)
    .map((idref) => manifest.get(idref))
    .filter(
      (item): item is EpubManifestItem =>
        item !== undefined && isXhtmlManifestItem(item),
    );

  if (!spineItems.length) {
    throw new Error("EPUB OPF does not contain readable spine items.");
  }

  const metadata = packageMetadataFromOpf(opfXml, options.fallbackTitle);
  const context: EpubResourceContext = {
    entries,
    manifestByPath,
    metadata,
    packageDir,
    resourceBudget: { usedBytes: 0 },
    resources: new Map(),
    zipBytes,
  };
  const sections: EpubHtmlSection[] = [];
  for (const [index, item] of spineItems.entries()) {
    sections.push(await convertSection(context, item, index));
  }

  return {
    ...(metadata.author ? { author: metadata.author } : {}),
    ...(metadata.direction ? { direction: metadata.direction } : {}),
    ...(metadata.language ? { language: metadata.language } : {}),
    sections,
    title: metadata.title,
  };
}
