import {
  MEDIA_SOURCE_SELECTOR,
  MEDIA_SOURCE_URL_ATTRIBUTE,
  MEDIA_SRCSET_SOURCE_ATTRIBUTE,
  MEDIA_SRC_ATTRIBUTES,
  MEDIA_STYLE_SELECTOR,
  absoluteMediaUrl,
  fileNameFromLocalMediaSrc,
  localChapterMediaSources,
  localMediaSrc,
  parseSrcset,
  styleMediaSlots,
} from "./html";
import { localChapterMediaOutputSrc, localChapterMediaSrc } from "./sources";
import { getStoredChapterMediaBytes } from "./storage";
import {
  type ChapterMediaManifest,
  type ChapterMediaStorageContext,
  type ExistingMediaSlots,
  type MediaSrcTarget,
  type MediaSrcsetTarget,
  type MediaStyleTarget,
} from "./types";

function collectExistingMediaSlots(
  root: DocumentFragment,
  context?: ChapterMediaStorageContext,
): ExistingMediaSlots {
  const srcSlots: Array<string | null> = [];
  const srcsetSlots: Array<Array<string | null>> = [];
  const styleSlots: Array<Array<string | null>> = [];

  for (const element of root.querySelectorAll<Element>(MEDIA_SOURCE_SELECTOR)) {
    for (const attribute of MEDIA_SRC_ATTRIBUTES) {
      const rawSource = element.getAttribute(attribute);
      if (rawSource === null) continue;
      srcSlots.push(localMediaSrc(rawSource, context));
    }

    const rawSrcset = element.getAttribute("srcset");
    if (rawSrcset === null) continue;
    srcsetSlots.push(
      parseSrcset(rawSrcset).map((candidate) =>
        localMediaSrc(candidate.source, context),
      ),
    );
  }

  for (const element of root.querySelectorAll<Element>(MEDIA_STYLE_SELECTOR)) {
    styleSlots.push(
      styleMediaSlots(element.getAttribute("style") ?? "", context),
    );
  }

  return { srcSlots, srcsetSlots, styleSlots };
}

function collectMetadataReusableMediaSources(
  root: DocumentFragment,
  baseUrl: string | null | undefined,
  context: ChapterMediaStorageContext,
  urls: Set<string>,
): Map<string, string> {
  const reusable = new Map<string, string>();

  for (const element of root.querySelectorAll<Element>(
    `[${MEDIA_SOURCE_URL_ATTRIBUTE}]`,
  )) {
    const sourceUrl = absoluteMediaUrl(
      element.getAttribute(MEDIA_SOURCE_URL_ATTRIBUTE) ?? "",
      baseUrl,
    );
    const src = localMediaSrc(element.getAttribute("src"), context);
    if (sourceUrl && src && urls.has(sourceUrl)) {
      reusable.set(sourceUrl, src);
    }
  }

  for (const element of root.querySelectorAll<Element>(
    `[${MEDIA_SRCSET_SOURCE_ATTRIBUTE}]`,
  )) {
    const sourceCandidates = parseSrcset(
      element.getAttribute(MEDIA_SRCSET_SOURCE_ATTRIBUTE) ?? "",
    );
    const localCandidates = parseSrcset(
      element.getAttribute("srcset") ?? "",
    ).map((candidate) => localMediaSrc(candidate.source, context));
    for (
      let index = 0;
      index < sourceCandidates.length && index < localCandidates.length;
      index += 1
    ) {
      const sourceUrl = absoluteMediaUrl(
        sourceCandidates[index]!.source,
        baseUrl,
      );
      const src = localCandidates[index];
      if (sourceUrl && src && urls.has(sourceUrl)) {
        reusable.set(sourceUrl, src);
      }
    }
  }

  return reusable;
}

function collectSlotReusableMediaSources({
  baseUrl,
  context,
  root,
  srcTargets,
  srcsetTargets,
  styleTargets,
}: {
  baseUrl: string | null | undefined;
  context: ChapterMediaStorageContext;
  root: DocumentFragment;
  srcTargets: MediaSrcTarget[];
  srcsetTargets: MediaSrcsetTarget[];
  styleTargets: MediaStyleTarget[];
}): Map<string, string> {
  const reusable = new Map<string, string>();
  const existingSlots = collectExistingMediaSlots(root, context);

  for (const target of srcTargets) {
    const src = existingSlots.srcSlots[target.slotIndex];
    if (src) reusable.set(target.url, src);
  }

  for (const target of srcsetTargets) {
    const localCandidates = existingSlots.srcsetSlots[target.slotIndex] ?? [];
    for (
      let candidateIndex = 0;
      candidateIndex < target.candidates.length &&
      candidateIndex < localCandidates.length;
      candidateIndex += 1
    ) {
      const sourceUrl = absoluteMediaUrl(
        target.candidates[candidateIndex]!.source,
        baseUrl,
      );
      const src = localCandidates[candidateIndex];
      if (sourceUrl && src) reusable.set(sourceUrl, src);
    }
  }

  for (const target of styleTargets) {
    const localSources = existingSlots.styleSlots[target.slotIndex] ?? [];
    for (
      let styleIndex = 0;
      styleIndex < target.urls.length && styleIndex < localSources.length;
      styleIndex += 1
    ) {
      const src = localSources[styleIndex];
      if (src) reusable.set(target.urls[styleIndex]!.url, src);
    }
  }

  return reusable;
}

export function collectReusableMediaSources({
  baseUrl,
  chapterId,
  context,
  previousHtml,
  srcTargets,
  srcsetTargets,
  styleTargets,
  urls,
}: {
  baseUrl: string | null | undefined;
  chapterId: number;
  context: ChapterMediaStorageContext;
  previousHtml: string | null | undefined;
  srcTargets: MediaSrcTarget[];
  srcsetTargets: MediaSrcsetTarget[];
  styleTargets: MediaStyleTarget[];
  urls: string[];
}): Map<string, string> {
  if (!previousHtml) {
    return new Map();
  }

  const template = document.createElement("template");
  template.innerHTML = previousHtml;
  const urlSet = new Set(urls);
  const reusable = collectMetadataReusableMediaSources(
    template.content,
    baseUrl,
    context,
    urlSet,
  );
  const slotReusable = collectSlotReusableMediaSources({
    baseUrl,
    context,
    root: template.content,
    srcTargets,
    srcsetTargets,
    styleTargets,
  });
  for (const [url, src] of slotReusable) {
    if (!reusable.has(url)) reusable.set(url, src);
  }

  for (const [url, src] of reusable) {
    if (!urlSet.has(url) || !fileNameFromLocalMediaSrc(src, chapterId)) {
      reusable.delete(url);
    }
  }
  return reusable;
}

export async function filterExistingReusableMediaSources(
  reusableSources: Map<string, string>,
  context: ChapterMediaStorageContext,
  manifest: ChapterMediaManifest,
  storedFileBytes: ReadonlyMap<string, number> | null,
): Promise<Map<string, string>> {
  const filesBySourceUrl = new Map(
    manifest.media.files.map((file) => [file.sourceUrl, file]),
  );
  const existing = new Map<string, string>();
  for (const [url, src] of reusableSources) {
    const file = filesBySourceUrl.get(url);
    if (
      file?.status === "stored" &&
      file.bytes > 0 &&
      file.fileName === fileNameFromLocalMediaSrc(src, context.chapterId) &&
      (storedFileBytes !== null
        ? storedFileBytes.get(file.fileName) === file.bytes
        : (await getStoredChapterMediaBytes(src, context)) === file.bytes)
    ) {
      existing.set(url, src);
    }
  }
  return existing;
}

export async function collectStoredManifestMediaSources({
  context,
  manifest,
  storedFileBytes,
  urls,
}: {
  context: ChapterMediaStorageContext;
  manifest: ChapterMediaManifest;
  storedFileBytes: ReadonlyMap<string, number> | null;
  urls: string[];
}): Promise<Map<string, string>> {
  const requestedUrls = new Set(urls);
  const existing = new Map<string, string>();
  for (const file of manifest.media.files) {
    if (
      file.status !== "stored" ||
      file.bytes <= 0 ||
      !requestedUrls.has(file.sourceUrl) ||
      !isFetchableMediaUrl(file.sourceUrl)
    ) {
      continue;
    }
    const src = localChapterMediaSrc(file.fileName);
    if (
      storedFileBytes !== null
        ? storedFileBytes.get(file.fileName) === file.bytes
        : (await getStoredChapterMediaBytes(src, context)) === file.bytes
    ) {
      existing.set(file.sourceUrl, localChapterMediaOutputSrc(file.fileName));
    }
  }
  return existing;
}

function isFetchableMediaUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export async function collectMissingManifestMediaSources({
  chapterId,
  context,
  html,
  manifest,
}: {
  chapterId: number;
  context: ChapterMediaStorageContext;
  html: string;
  manifest: ChapterMediaManifest;
}): Promise<Map<string, string>> {
  const filesByName = new Map(
    manifest.media.files.map((file) => [file.fileName, file]),
  );
  const missing = new Map<string, string>();
  for (const src of localChapterMediaSources(html, context)) {
    const fileName = fileNameFromLocalMediaSrc(src, chapterId);
    if (!fileName) continue;
    const manifestFile = filesByName.get(fileName);
    if (!manifestFile || !isFetchableMediaUrl(manifestFile.sourceUrl)) {
      continue;
    }
    if ((await getStoredChapterMediaBytes(src, context)) <= 0) {
      missing.set(manifestFile.sourceUrl, src);
    }
  }
  return missing;
}
