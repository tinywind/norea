import { isTauriRuntime } from "../tauri-runtime";
import {
  formatSrcset,
  localStyleMediaSources,
  MEDIA_SOURCE_SELECTOR,
  MEDIA_SRC_ATTRIBUTES,
  MEDIA_STYLE_SELECTOR,
  mediaOutputAttribute,
  parseSrcset,
  STYLE_URL_PATTERN,
} from "./html";
import { LOCAL_MEDIA_SRC_PREFIX, localChapterMediaFileName } from "./sources";
import {
  prepareLocalChapterMediaSources,
  resolveLocalChapterMediaSrc,
} from "./storage";
import {
  type ChapterMediaElementPatch,
  type ChapterMediaStorageContext,
  type SrcsetCandidate,
} from "./types";

function collectLocalChapterMediaSources(
  patches: ChapterMediaElementPatch[],
  context?: ChapterMediaStorageContext,
): string[] {
  const sources = new Set<string>();
  for (const patch of patches) {
    for (const [attribute, value] of Object.entries(patch.attributes)) {
      if (attribute === "srcset") {
        for (const candidate of parseSrcset(value)) {
          if (localChapterMediaFileName(candidate.source, context)) {
            sources.add(candidate.source);
          }
        }
        continue;
      }
      if (attribute === "style") {
        for (const source of localStyleMediaSources(value, context)) {
          sources.add(source);
        }
        continue;
      }
      if (localChapterMediaFileName(value, context)) {
        sources.add(value);
      }
    }
  }
  return [...sources];
}

function resolveCachedLocalChapterMediaSrc(
  cache: Map<string, Promise<string | null>>,
  src: string,
  context?: ChapterMediaStorageContext,
): Promise<string | null> {
  if (!localChapterMediaFileName(src, context)) {
    return Promise.resolve(src);
  }
  const cached = cache.get(src);
  if (cached) return cached;
  const resolved = resolveLocalChapterMediaSrc(src, context);
  cache.set(src, resolved);
  return resolved;
}

export async function resolveLocalChapterMediaPatches(
  patches: ChapterMediaElementPatch[],
  context?: ChapterMediaStorageContext,
): Promise<ChapterMediaElementPatch[]> {
  const resolvedMedia = new Map<string, Promise<string | null>>();
  {
    const preparedMedia = await prepareLocalChapterMediaSources(
      collectLocalChapterMediaSources(patches, context),
      context,
    );
    for (const [source, resolved] of preparedMedia) {
      resolvedMedia.set(source, Promise.resolve(resolved));
    }
  }
  const resolvedPatches = await Promise.all(
    patches.map(async (patch) => {
      const attributes: Record<string, string> = {};
      await Promise.all(
        Object.entries(patch.attributes).map(async ([attribute, value]) => {
          if (attribute === "srcset") {
            const resolvedCandidates = (
              await Promise.all(
                parseSrcset(value).map(async (candidate) => {
                  if (!localChapterMediaFileName(candidate.source, context)) {
                    return candidate;
                  }
                  const src = await resolveCachedLocalChapterMediaSrc(
                    resolvedMedia,
                    candidate.source,
                    context,
                  );
                  return src ? { ...candidate, source: src } : null;
                }),
              )
            ).filter(
              (candidate): candidate is SrcsetCandidate => candidate !== null,
            );
            if (resolvedCandidates.length > 0) {
              attributes[attribute] = formatSrcset(resolvedCandidates);
            }
            return;
          }
          if (attribute === "style") {
            const localSources = localStyleMediaSources(value, context);
            if (localSources.length === 0) return;
            const resolvedSources = new Map<string, string | null>();
            await Promise.all(
              localSources.map(async (source) => {
                if (!resolvedSources.has(source)) {
                  resolvedSources.set(
                    source,
                    await resolveCachedLocalChapterMediaSrc(
                      resolvedMedia,
                      source,
                      context,
                    ),
                  );
                }
              }),
            );
            attributes[attribute] = value.replace(
              STYLE_URL_PATTERN,
              (match, doubleQuoted, singleQuoted, unquoted) => {
                const source = String(
                  doubleQuoted ?? singleQuoted ?? unquoted ?? "",
                ).trim();
                if (!localChapterMediaFileName(source, context)) return match;
                return `url("${resolvedSources.get(source) ?? ""}")`;
              },
            );
            return;
          }
          if (!localChapterMediaFileName(value, context)) return;
          const src = await resolveCachedLocalChapterMediaSrc(
            resolvedMedia,
            value,
            context,
          );
          if (src) attributes[attribute] = src;
        }),
      );
      return { ...patch, attributes };
    }),
  );
  return resolvedPatches.filter(
    (patch) => Object.keys(patch.attributes).length > 0,
  );
}

export async function resolveLocalChapterMedia(
  html: string,
  context?: ChapterMediaStorageContext,
): Promise<string> {
  if (
    !isTauriRuntime() ||
    typeof document === "undefined" ||
    (!context && !html.includes(LOCAL_MEDIA_SRC_PREFIX))
  ) {
    return html;
  }

  const template = document.createElement("template");
  template.innerHTML = html;
  const mediaElements = [
    ...template.content.querySelectorAll<Element>(MEDIA_SOURCE_SELECTOR),
  ];
  const styleElements = [
    ...template.content.querySelectorAll<Element>(MEDIA_STYLE_SELECTOR),
  ];
  const styleSheetElements = [
    ...template.content.querySelectorAll<HTMLStyleElement>("style"),
  ];
  const resolvedMedia = new Map<string, Promise<string | null>>();

  await Promise.all(
    mediaElements.map(async (element) => {
      for (const attribute of MEDIA_SRC_ATTRIBUTES) {
        const rawSource = element.getAttribute(attribute);
        if (!rawSource || !localChapterMediaFileName(rawSource, context)) {
          continue;
        }
        const src = await resolveCachedLocalChapterMediaSrc(
          resolvedMedia,
          rawSource,
          context,
        );
        const outputAttribute = mediaOutputAttribute(attribute);
        if (src) {
          element.setAttribute(outputAttribute, src);
        } else {
          element.removeAttribute(outputAttribute);
        }
        if (attribute !== outputAttribute) {
          element.removeAttribute(attribute);
        }
      }

      const rawSrcset = element.getAttribute("srcset");
      if (
        !rawSrcset ||
        !parseSrcset(rawSrcset).some((candidate) =>
          localChapterMediaFileName(candidate.source, context),
        )
      ) {
        return;
      }
      const resolvedCandidates = (
        await Promise.all(
          parseSrcset(rawSrcset).map(async (candidate) => {
            if (!localChapterMediaFileName(candidate.source, context)) {
              return candidate;
            }
            const src = await resolveCachedLocalChapterMediaSrc(
              resolvedMedia,
              candidate.source,
              context,
            );
            return src ? { ...candidate, source: src } : null;
          }),
        )
      ).filter((candidate): candidate is SrcsetCandidate => candidate !== null);
      if (resolvedCandidates.length > 0) {
        element.setAttribute("srcset", formatSrcset(resolvedCandidates));
      } else {
        element.removeAttribute("srcset");
      }
    }),
  );

  await Promise.all(
    styleElements.map(async (element) => {
      const rawStyle = element.getAttribute("style");
      if (!rawStyle) return;
      const localSources = localStyleMediaSources(rawStyle, context);
      if (localSources.length === 0) return;
      const resolvedSources = new Map<string, string | null>();
      await Promise.all(
        localSources.map(async (source) => {
          if (!resolvedSources.has(source)) {
            resolvedSources.set(
              source,
              await resolveCachedLocalChapterMediaSrc(
                resolvedMedia,
                source,
                context,
              ),
            );
          }
        }),
      );
      const resolvedStyle = rawStyle.replace(
        STYLE_URL_PATTERN,
        (match, doubleQuoted, singleQuoted, unquoted) => {
          const source = String(
            doubleQuoted ?? singleQuoted ?? unquoted ?? "",
          ).trim();
          if (!localChapterMediaFileName(source, context)) return match;
          return `url("${resolvedSources.get(source) ?? ""}")`;
        },
      );
      element.setAttribute("style", resolvedStyle);
    }),
  );

  await Promise.all(
    styleSheetElements.map(async (element) => {
      const rawCss = element.textContent ?? "";
      const localSources = localStyleMediaSources(rawCss, context);
      if (localSources.length === 0) return;
      const resolvedSources = new Map<string, string | null>();
      await Promise.all(
        localSources.map(async (source) => {
          if (!resolvedSources.has(source)) {
            resolvedSources.set(
              source,
              await resolveCachedLocalChapterMediaSrc(
                resolvedMedia,
                source,
                context,
              ),
            );
          }
        }),
      );
      element.textContent = rawCss.replace(
        STYLE_URL_PATTERN,
        (match, doubleQuoted, singleQuoted, unquoted) => {
          const source = String(
            doubleQuoted ?? singleQuoted ?? unquoted ?? "",
          ).trim();
          if (!localChapterMediaFileName(source, context)) return match;
          return `url("${resolvedSources.get(source) ?? ""}")`;
        },
      );
    }),
  );

  return template.innerHTML;
}
