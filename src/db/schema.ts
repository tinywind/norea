import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const contentSyncCacheTable = sqliteTable("content_sync_cache", {
  cacheKey: text("cache_key").primaryKey().notNull(),
  payload: text("payload").notNull(),
});

export const workMetadataDirtyTable = sqliteTable("work_metadata_dirty", {
  pluginId: text("plugin_id").notNull(),
  path: text("path").notNull(),
}, (table) => ({ identity: primaryKey({ columns: [table.pluginId, table.path] }) }));

export const workMetadataCacheStateTable = sqliteTable("work_metadata_cache_state", {
  id: integer("id").primaryKey(),
}, (table) => ({ singleton: check("work_metadata_cache_state_singleton", sql`${table.id}=1`) }));

export const workMetadataFileCacheTable = sqliteTable("work_metadata_file_cache", {
  pluginId: text("plugin_id").notNull(),
  path: text("path").notNull(),
  novelId: integer("novel_id").notNull(),
  directory: text("directory").notNull(),
  fingerprint: text("fingerprint").notNull(),
}, (table) => ({ identity: primaryKey({ columns: [table.pluginId, table.path] }) }));

export const workMetadataSyncJournalTable = sqliteTable("work_metadata_sync_journal", {
  pluginId: text("plugin_id").notNull(),
  path: text("path").notNull(),
  revision: integer("revision").notNull(),
}, (table) => ({ identity: primaryKey({ columns: [table.pluginId, table.path] }) }));

export const workMetadataDirectoryCacheTable = sqliteTable("work_metadata_directory_cache", {
  chapterId: integer("chapter_id").primaryKey(),
  novelId: integer("novel_id").notNull(),
  directory: text("directory").notNull(),
}, (table) => ({ novelIdx: index("work_metadata_directory_novel").on(table.novelId) }));

export const workMetadataReadingStateTable = sqliteTable("work_metadata_reading_state", {
  pluginId: text("plugin_id").notNull(),
  novelPath: text("novel_path").notNull(),
  chapterPath: text("chapter_path").notNull(),
  progress: integer("progress").notNull(),
  bookmark: integer("bookmark", { mode: "boolean" }).notNull(),
  unread: integer("unread", { mode: "boolean" }).notNull(),
  readAt: integer("read_at"),
}, (table) => ({ identity: primaryKey({ columns: [table.pluginId, table.novelPath, table.chapterPath] }) }));

// Novel: a title in the user's library or browsable from a source plugin.
export const novelTable = sqliteTable(
  "novel",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    pluginId: text("plugin_id").notNull(),
    sourceNovelId: text("source_novel_id"),
    path: text("path").notNull(),
    name: text("name").notNull(),
    cover: text("cover"),
    summary: text("summary"),
    author: text("author"),
    artist: text("artist"),
    status: text("status"),
    genres: text("genres"),
    rating: real("rating"),
    inLibrary: integer("in_library", { mode: "boolean" })
      .notNull()
      .default(false),
    isLocal: integer("is_local", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    libraryAddedAt: integer("library_added_at", { mode: "timestamp" }),
    lastReadAt: integer("last_read_at", { mode: "timestamp" }),
  },
  (t) => ({
    pluginPathUniq: uniqueIndex("novel_plugin_path_uniq").on(
      t.pluginId,
      t.path,
    ),
    pluginSourceIdUniq: uniqueIndex("novel_plugin_source_id_uniq").on(t.pluginId, sql`lower(${t.sourceNovelId})`),
    inLibraryIdx: index("novel_in_library_idx").on(t.inLibrary),
  }),
);

// Chapter: one readable unit, owned by a novel.
export const chapterTable = sqliteTable(
  "chapter",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    novelId: integer("novel_id")
      .notNull()
      .references(() => novelTable.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    name: text("name").notNull(),
    chapterNumber: text("chapter_number"),
    position: integer("position").notNull(),
    page: text("page").notNull().default("1"),
    bookmark: integer("bookmark", { mode: "boolean" })
      .notNull()
      .default(false),
    unread: integer("unread", { mode: "boolean" }).notNull().default(true),
    progress: integer("progress").notNull().default(0),
    isDownloaded: integer("is_downloaded", { mode: "boolean" })
      .notNull()
      .default(false),
    contentType: text("content_type").notNull().default("html"),
    storedContentType: text("stored_content_type"),
    contentBytes: integer("content_bytes").notNull().default(0),
    mediaBytes: integer("media_bytes").notNull().default(0),
    mediaRepairNeeded: integer("media_repair_needed", { mode: "boolean" })
      .notNull()
      .default(false),
    mediaBytesCheckedAt: integer("media_bytes_checked_at", {
      mode: "timestamp",
    }),
    releaseTime: text("release_time"),
    readAt: integer("read_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }),
    foundAt: integer("found_at").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    novelPathUniq: uniqueIndex("chapter_novel_path_uniq").on(
      t.novelId,
      t.path,
    ),
    novelPositionIdx: index("chapter_novel_position_idx").on(
      t.novelId,
      t.position,
    ),
    downloadedUpdatedIdx: index("chapter_downloaded_updated_idx").on(
      t.isDownloaded,
      t.updatedAt,
      t.novelId,
    ),
    novelDownloadedPositionIdx: index("chapter_novel_downloaded_position_idx")
      .on(t.novelId, t.isDownloaded, t.position, t.id),
    unreadFoundPositionIdx: index("chapter_unread_found_position_idx").on(
      t.unread,
      t.foundAt,
      t.position,
      t.id,
    ),
  }),
);

// ChapterDownloadQueue: resumable chapter download work owned by the backend
// queue executor.
export const chapterDownloadQueueTable = sqliteTable(
  "chapter_download_queue",
  {
    chapterId: integer("chapter_id").primaryKey().notNull(),
    jobJson: text("job_json").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    leasedAtMs: integer("leased_at_ms"),
    attemptCount: integer("attempt_count").notNull().default(0),
  },
  (t) => ({
    createdIdx: index("chapter_download_queue_created_idx").on(
      t.createdAtMs,
      t.chapterId,
    ),
  }),
);

// DownloadCacheWork: resumable maintenance work for bulk cache deletion.
export const downloadCacheWorkTable = sqliteTable(
  "download_cache_work",
  {
    id: text("id").primaryKey().notNull(),
    scope: text("scope").notNull(),
    targetIdsJson: text("target_ids_json").notNull(),
    title: text("title"),
    status: text("status").notNull().default("queued"),
    total: integer("total").notNull().default(0),
    completed: integer("completed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    error: text("error"),
    cancelRequested: integer("cancel_requested", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    startedAtMs: integer("started_at_ms"),
    finishedAtMs: integer("finished_at_ms"),
  },
  (t) => ({
    statusIdx: index("download_cache_work_status_idx").on(
      t.status,
      t.updatedAtMs,
    ),
  }),
);

// NovelStats: materialized counters used by Library lists. Keeping
// this separate from novel metadata avoids scanning every chapter on
// each Library entry render.
export const novelStatsTable = sqliteTable(
  "novel_stats",
  {
    novelId: integer("novel_id")
      .primaryKey()
      .references(() => novelTable.id, { onDelete: "cascade" }),
    totalChapters: integer("total_chapters").notNull().default(0),
    chaptersDownloaded: integer("chapters_downloaded").notNull().default(0),
    chaptersUnread: integer("chapters_unread").notNull().default(0),
    progressSum: integer("progress_sum").notNull().default(0),
    readingProgress: integer("reading_progress").notNull().default(0),
    lastChapterUpdatedAt: integer("last_chapter_updated_at")
      .notNull()
      .default(0),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    downloadedIdx: index("novel_stats_downloaded_idx").on(
      t.chaptersDownloaded,
    ),
    unreadIdx: index("novel_stats_unread_idx").on(t.chaptersUnread),
    totalIdx: index("novel_stats_total_idx").on(t.totalChapters),
    lastChapterUpdatedIdx: index("novel_stats_last_chapter_updated_idx").on(
      t.lastChapterUpdatedAt,
    ),
  }),
);

// Category: user-defined Library tab grouping. `is_system` flags
// the seeded "Default" and "Local" categories so the UI can hide
// rename/delete affordances for them.
export const categoryTable = sqliteTable(
  "category",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    sort: integer("sort").notNull(),
    isSystem: integer("is_system", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (t) => ({
    nameUniq: uniqueIndex("category_name_uniq").on(t.name),
    sortIdx: index("category_sort_idx").on(t.sort),
  }),
);

// NovelCategory: many-to-many bridge between Novel and Category.
export const novelCategoryTable = sqliteTable(
  "novel_category",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    novelId: integer("novel_id")
      .notNull()
      .references(() => novelTable.id, { onDelete: "cascade" }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categoryTable.id, { onDelete: "cascade" }),
  },
  (t) => ({
    novelCategoryUniq: uniqueIndex("novel_category_uniq").on(
      t.novelId,
      t.categoryId,
    ),
    categoryIdx: index("novel_category_category_idx").on(t.categoryId),
  }),
);

// Repository: single plugin source registry URL pointing at a JSON
// catalog of available plugins.
export const repositoryTable = sqliteTable(
  "repository",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    url: text("url").notNull(),
    name: text("name"),
    addedAt: integer("added_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    urlUniq: uniqueIndex("repository_url_uniq").on(t.url),
    singletonUniq: uniqueIndex("repository_singleton_uniq").on(sql`(1)`),
  }),
);

// InstalledPlugin: persisted plugin source so the in-memory
// PluginManager can rehydrate at app start without re-fetching
// from the repository every time.
export const installedPluginTable = sqliteTable(
  "installed_plugin",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    lang: text("lang").notNull(),
    version: text("version").notNull(),
    iconUrl: text("icon_url").notNull(),
    sourceUrl: text("source_url").notNull(),
    sourceCode: text("source_code").notNull(),
    installedAt: integer("installed_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
);

// RepositoryIndexCache: last-known plugins.json index for the
// configured repository URL so Browse renders instantly on tab open.
// Refresh button re-fetches and overwrites.
export const repositoryIndexCacheTable = sqliteTable(
  "repository_index_cache",
  {
    repoUrl: text("repo_url").primaryKey(),
    fetchedAt: integer("fetched_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    itemsJson: text("items_json").notNull(),
  },
);

// VpnGateServerVerdict: the user's latest result for a public VPN server,
// shared by every listing that resolves to the same canonical IPv4 address.
export const vpnGateServerVerdictTable = sqliteTable(
  "vpn_gate_server_verdict",
  {
    ip: text("ip").primaryKey(),
    verdict: text("verdict", { enum: ["works", "fails"] }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    verdictCheck: check(
      "vpn_gate_server_verdict_verdict_check",
      sql`${t.verdict} IN ('works', 'fails')`,
    ),
  }),
);

export type Novel = typeof novelTable.$inferSelect;
export const contentSyncOriginTable = sqliteTable("content_sync_origin", {
  id: integer("id").primaryKey(),
  remote: integer("remote").notNull().default(0),
});
export const contentSyncJournalTable = sqliteTable("content_sync_journal", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  stateKey: text("state_key").notNull(),
}, (t) => ({ keyIdx: index("content_sync_journal_key_idx").on(t.stateKey, t.sequence) }));
export type NovelInsert = typeof novelTable.$inferInsert;
export type Chapter = typeof chapterTable.$inferSelect;
export type ChapterInsert = typeof chapterTable.$inferInsert;
export type ChapterDownloadQueue =
  typeof chapterDownloadQueueTable.$inferSelect;
export type ChapterDownloadQueueInsert =
  typeof chapterDownloadQueueTable.$inferInsert;
export type NovelStats = typeof novelStatsTable.$inferSelect;
export type NovelStatsInsert = typeof novelStatsTable.$inferInsert;
export type Category = typeof categoryTable.$inferSelect;
export type CategoryInsert = typeof categoryTable.$inferInsert;
export type NovelCategory = typeof novelCategoryTable.$inferSelect;
export type NovelCategoryInsert = typeof novelCategoryTable.$inferInsert;
export type Repository = typeof repositoryTable.$inferSelect;
export type RepositoryInsert = typeof repositoryTable.$inferInsert;
export type InstalledPlugin = typeof installedPluginTable.$inferSelect;
export type InstalledPluginInsert = typeof installedPluginTable.$inferInsert;
export type RepositoryIndexCache = typeof repositoryIndexCacheTable.$inferSelect;
export type RepositoryIndexCacheInsert = typeof repositoryIndexCacheTable.$inferInsert;
export type VpnGateServerVerdict =
  typeof vpnGateServerVerdictTable.$inferSelect;
export type VpnGateServerVerdictInsert =
  typeof vpnGateServerVerdictTable.$inferInsert;
