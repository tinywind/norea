import { findNovelBySource } from "../../db/queries/novel";
import type { NovelItem, Plugin } from "./types";
import { syncNovelFromSource } from "./sync-novel";

export interface ImportNovelFromSourceOptions {
  forceRefresh?: boolean;
}

/**
 * Resolve a plugin novel into the local DB and return its `novel.id`.
 *
 * Repeated imports use the cached `(pluginId, path)` row by default.
 * Pass `forceRefresh` when the caller explicitly wants source metadata
 * and chapter list refresh.
 */
export async function importNovelFromSource(
  plugin: Plugin,
  item: NovelItem,
  options: ImportNovelFromSourceOptions = {},
): Promise<number> {
  if (!options.forceRefresh) {
    const cached = await findNovelBySource(plugin.id, item.path);
    if (cached?.path === item.path) return cached.id;
  }

  const result = await syncNovelFromSource(plugin, item);
  return result.novelId;
}
