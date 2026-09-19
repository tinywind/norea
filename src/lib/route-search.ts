export interface NovelSearch {
  id: number;
}

export interface ReaderSearch {
  chapterId: number;
}

export interface NovelMergeSearch {
  sourceNovelId: number;
}

export interface SourceSearch {
  pluginId: string;
  query: string;
}

function asPositiveId(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function asString(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

export function parseNovelSearch(search: Record<string, unknown>): NovelSearch {
  return { id: asPositiveId(search.id) };
}

export function parseReaderSearch(
  search: Record<string, unknown>,
): ReaderSearch {
  return { chapterId: asPositiveId(search.chapterId) };
}

export function parseNovelMergeSearch(
  search: Record<string, unknown>,
): NovelMergeSearch {
  return { sourceNovelId: asPositiveId(search.sourceNovelId) };
}

export function parseSourceSearch(
  search: Record<string, unknown>,
): SourceSearch {
  return {
    pluginId: asString(search.pluginId),
    query: asString(search.query),
  };
}
