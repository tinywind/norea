import { contentServerRequest } from "./client";
import type { PackageManifest } from "./native";
import type { ServerNovelSource } from "./novel-source";

export type ServerChapterSummary = PackageManifest["chapter"] & {
  id: string;
  chapterPath: string;
  complete: boolean;
};
export interface ServerChapterPage { items: ServerChapterSummary[]; total: number; hasMore: boolean }

export interface ServerChapterDigestSummary {
  id: string;
  revision: string;
  chapterPath: string;
  chapterNumber: string | null;
  position: number;
  complete: boolean;
  payloadHash: string | null;
  bodySha256: string | null;
  bodyBytes: number | null;
  error?: string;
}
export interface ServerChapterDigestPage {
  items: ServerChapterDigestSummary[];
  total: number;
  hasMore: boolean;
}

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

export function fetchServerChapterDigestPage(
  source: ServerNovelSource,
  token: string,
  offset: number,
  signal?: AbortSignal,
): Promise<ServerChapterDigestPage> {
  return contentServerRequest(
    source.serverUrl,
    `/catalog/works/${encodeURIComponent(source.workId)}/chapter-digests?offset=${offset}&limit=2000`,
    token,
    "GET",
    undefined,
    signal,
  );
}

export async function fetchServerChapterDigests(
  source: ServerNovelSource,
  token: string,
  signal?: AbortSignal,
): Promise<ServerChapterDigestSummary[]> {
  const chapters: ServerChapterDigestSummary[] = [];
  for (;;) {
    signal?.throwIfAborted();
    const page = await fetchServerChapterDigestPage(source, token, chapters.length, signal);
    signal?.throwIfAborted();
    chapters.push(...page.items);
    if (!page.hasMore) return chapters;
    if (!page.items.length) throw new Error("Server chapter digest catalog did not advance.");
  }
}

