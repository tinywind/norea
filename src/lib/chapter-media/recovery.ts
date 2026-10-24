import { localChapterMediaOutputSrc, localChapterMediaSrc } from "./sources";
import { getStoredChapterMediaBytes } from "./storage";
import { type ChapterMediaManifest, type ChapterMediaStorageContext } from "./types";

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
