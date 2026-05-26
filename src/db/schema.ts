import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Novel: a title in the user's library or browsable from a source plugin.
export const novelTable = sqliteTable(
  "novel",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    pluginId: text("plugin_id").notNull(),
    path: text("path").notNull(),
    name: text("name").notNull(),
    cover: text("cover"),
    summary: text("summary"),
    author: text("author"),
    artist: text("artist"),
    status: text("status"),
    genres: text("genres"),
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

export type Novel = typeof novelTable.$inferSelect;
export type NovelInsert = typeof novelTable.$inferInsert;
export type Chapter = typeof chapterTable.$inferSelect;
export type ChapterInsert = typeof chapterTable.$inferInsert;
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
