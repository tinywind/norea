import { contentServerRequest } from "./client";
import type { PackageManifest } from "./native";
import type { ServerNovelSource } from "./novel-source";

export type ServerChapterSummary = PackageManifest["chapter"] & {
  id: string;
  chapterPath: string;
};
export interface ServerChapterPage { items: ServerChapterSummary[]; total: number; hasMore: boolean }

export function fetchServerChapterPage(source: ServerNovelSource, token: string, offset: number, signal?: AbortSignal): Promise<ServerChapterPage> {
  return contentServerRequest(source.serverUrl,
    `/catalog/works/${encodeURIComponent(source.workId)}/chapters?offset=${offset}&limit=100`,
    token, "GET", undefined, signal);
}

export async function fetchServerChapters(source: ServerNovelSource, token: string, signal?: AbortSignal): Promise<ServerChapterSummary[]> {
  const chapters: ServerChapterSummary[] = [];
  for (;;) {
    signal?.throwIfAborted();
    const page = await fetchServerChapterPage(source, token, chapters.length, signal);
    signal?.throwIfAborted();
    chapters.push(...page.items);
    if (!page.hasMore) return chapters;
    if (!page.items.length) throw new Error("Server chapter catalog did not advance.");
  }
}

