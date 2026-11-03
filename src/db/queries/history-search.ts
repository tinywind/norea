import { clampRouteQueryLimit } from "../../lib/performance-budgets";
import { getDb, getReadOnlyDb, type DatabaseReadMode } from "../client";
import { sqliteBoolean } from "../sqlite-value";
import type { RecentlyReadEntry } from "./chapter";

const FINISHED_PROGRESS = 100;
export const HISTORY_PAGE_SIZE = 50;

export type HistoryProgressFilter = "all" | "inProgress" | "finished";

export interface HistoryCursor {
  chapterId: number;
  position: number;
  readAt: number;
}

export interface HistoryPage {
  entries: RecentlyReadEntry[];
  nextCursor: HistoryCursor | null;
}

interface RawHistoryEntry
  extends Omit<RecentlyReadEntry, "novelInLibrary" | "novelIsLocal"> {
  novelInLibrary: unknown;
  novelIsLocal: unknown;
}

const PROGRESS_CLAUSES: Record<HistoryProgressFilter, string> = {
  all: "",
  finished: `AND progress >= ${FINISHED_PROGRESS}`,
  inProgress: `AND progress < ${FINISHED_PROGRESS}`,
};

/**
 * One page of reading history: the latest read chapter of every novel,
 * newest first. A search matches the novel name, that chapter's name or its
 * number anywhere in the history, not only among recent entries.
 */
export async function listReadingHistoryPage({
  cursor = null,
  limit = HISTORY_PAGE_SIZE,
  progress = "all",
  readMode = "queued",
  search = "",
}: {
  cursor?: HistoryCursor | null;
  limit?: number;
  progress?: HistoryProgressFilter;
  readMode?: DatabaseReadMode;
  search?: string;
} = {}): Promise<HistoryPage> {
  const db = await (readMode === "committed" ? getReadOnlyDb() : getDb());
  const pageSize = clampRouteQueryLimit(limit, HISTORY_PAGE_SIZE);
  const term = search.trim();
  const params: unknown[] = [pageSize + 1];
  const param = (value: unknown) => `$${params.push(value)}`;
  let searchClause = "";
  if (term) {
    const termParam = param(term);
    searchClause = `AND (
         instr(lower(novelName), lower(${termParam})) > 0
         OR instr(lower(chapterName), lower(${termParam})) > 0
         OR instr(CAST(position AS TEXT), ${termParam}) > 0
       )`;
  }
  let cursorClause = "";
  if (cursor) {
    const readAt = param(cursor.readAt);
    const position = param(cursor.position);
    const chapterId = param(cursor.chapterId);
    cursorClause = `AND (
         readAt < ${readAt}
         OR (readAt = ${readAt} AND position < ${position})
         OR (readAt = ${readAt} AND position = ${position} AND chapterId < ${chapterId})
       )`;
  }
  const rows = await db.select<RawHistoryEntry[]>(
    `WITH latest AS (
       SELECT
         c.id          AS chapterId,
         c.novel_id    AS novelId,
         c.name        AS chapterName,
         c.position    AS position,
         c.read_at     AS readAt,
         c.progress    AS progress,
         n.plugin_id   AS pluginId,
         n.name        AS novelName,
         n.cover       AS novelCover,
         n.in_library  AS novelInLibrary,
         n.is_local    AS novelIsLocal,
         n.path        AS novelPath
       FROM novel n
       JOIN chapter c ON c.id = (
         SELECT c2.id
         FROM chapter c2
         WHERE c2.novel_id = n.id AND c2.read_at IS NOT NULL
         ORDER BY c2.read_at DESC, c2.position DESC, c2.id DESC
         LIMIT 1
       )
     )
     SELECT * FROM latest
     WHERE 1 = 1
       ${searchClause}
       ${PROGRESS_CLAUSES[progress]}
       ${cursorClause}
     ORDER BY readAt DESC, position DESC, chapterId DESC
     LIMIT $1`,
    params,
  );
  const entries = rows.slice(0, pageSize).map((row) => ({
    ...row,
    novelInLibrary: sqliteBoolean(row.novelInLibrary),
    novelIsLocal: sqliteBoolean(row.novelIsLocal),
  }));
  const last = entries.at(-1);
  return {
    entries,
    nextCursor:
      rows.length > pageSize && last
        ? { chapterId: last.chapterId, position: last.position, readAt: last.readAt }
        : null,
  };
}
