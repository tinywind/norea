import type { NovelMetadataV1 } from "./schema";

export function mergeIncomingNovelMetadata(
  current: NovelMetadataV1 | null | undefined,
  incoming: NovelMetadataV1,
): NovelMetadataV1 {
  const novel = { ...incoming.novel };
  if (current) {
    for (const key of ["author", "artist", "summary", "status", "genres"] as const) {
      if (!novel[key]?.trim()) novel[key] = current.novel[key];
    }
    novel.rating ??= current.novel.rating;
  }
  return {
    ...incoming,
    novel,
    chapters: { ...current?.chapters, ...incoming.chapters },
  };
}
