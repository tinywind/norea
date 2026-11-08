import { chapterCompositionCatalog } from "../chapter-composition";
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
  const previous = current?.chapterComposition;
  const next = incoming.chapterComposition;
  const chapterComposition = next && (!previous || next.updatedAt > previous.updatedAt) ? next : previous;
  return {
    ...incoming, novel,
    ...(chapterComposition ? { chapterComposition } : {}),
    chapters: chapterComposition ? chapterCompositionCatalog(chapterComposition) : { ...current?.chapters, ...incoming.chapters },
  };
}
