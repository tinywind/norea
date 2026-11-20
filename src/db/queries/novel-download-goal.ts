import { invokeDbMutation, invokeDbQuery } from "../ipc";

/** Automatic download ranges; stored per-novel positive goals are retained as legacy data, while `none` is an explicit pause. */
export type NovelDownloadGoal =
  | { kind: "keep_ahead"; count: number }
  | { kind: "all_remaining" }
  | { kind: "entire" }
  | { kind: "none" };

export interface StoredNovelDownloadGoal {
  novelId: number;
  goal: NovelDownloadGoal;
  updatedAt: number;
}

export async function getNovelDownloadGoal(
  novelId: number,
): Promise<StoredNovelDownloadGoal | null> {
  return invokeDbQuery<StoredNovelDownloadGoal | null>("db_novel_goal_get", {
    novelId,
    mode: "queued",
  });
}

export async function listNovelDownloadGoals(): Promise<
  StoredNovelDownloadGoal[]
> {
  return invokeDbQuery<StoredNovelDownloadGoal[]>("db_novel_goal_list", {
    mode: "queued",
  });
}

/**
 * Stores the novel's goal, or removes it when `goal` is null so the default applies again.
 * Returns false when the novel row no longer exists.
 */
export async function setNovelDownloadGoal(
  novelId: number,
  goal: NovelDownloadGoal | null,
  now = Date.now(),
): Promise<boolean> {
  return invokeDbMutation<boolean>("db_novel_goal_set", {
    novelId,
    goal,
    now,
  });
}

export interface DownloadGoalNovel {
  id: number;
  pluginId: string;
  path: string;
  name: string;
  /** Unix seconds of the latest chapter open, or null. */
  lastReadAt: number | null;
  /** Retained legacy intent; only the global policy determines the active download range. */
  goal: Exclude<NovelDownloadGoal, { kind: "none" }> | null;
}

export type DownloadGoalActiveFilter =
  | { kind: "none" }
  | { kind: "since"; seconds: number }
  | { kind: "all" };

/** Active library source novels covered by the global policy, except explicit pauses; most recently read first. */
export async function listDownloadGoalNovels(
  activeFilter: DownloadGoalActiveFilter,
  novelIds?: readonly number[],
): Promise<DownloadGoalNovel[]> {
  if (activeFilter.kind === "none") return [];
  const ids = novelIds
    ? [...new Set(novelIds)].filter(Number.isSafeInteger)
    : undefined;
  if (ids?.length === 0) return [];
  return invokeDbQuery<DownloadGoalNovel[]>("db_novel_goal_list_novels", {
    activeFilter,
    novelIds: ids ?? null,
    mode: "queued",
  });
}

/** Active, unpaused library source novels in a deletion scope that the global automatic policy covers. */
export async function listGoalNovelIdsForDownloadScope(
  scope: "chapter" | "novel" | "all",
  ids: readonly number[],
  activeFilter: DownloadGoalActiveFilter = { kind: "none" },
): Promise<number[]> {
  if (activeFilter.kind === "none") return [];
  const unique = [...new Set(ids)].filter(Number.isSafeInteger);
  if (scope !== "all" && unique.length === 0) return [];
  return invokeDbQuery<number[]>("db_novel_goal_list_ids_for_scope", {
    scope,
    ids: unique,
    activeFilter,
    mode: "queued",
  });
}

/**
 * Keeps chapters the user deleted or cancelled out of future automatic work, including after policy changes.
 * Chapters that no longer exist are skipped.
 */
export async function excludeChaptersFromDownloadGoals(
  chapterIds: readonly number[],
  now = Date.now(),
): Promise<void> {
  const unique = [...new Set(chapterIds)].filter(Number.isSafeInteger);
  if (unique.length === 0) return;
  await invokeDbMutation("db_novel_goal_exclude_chapters", {
    chapterIds: unique,
    now,
  });
}

export async function listDownloadGoalExcludedChapterIds(
  novelId: number,
): Promise<number[]> {
  return invokeDbQuery<number[]>("db_novel_goal_list_excluded_chapter_ids", {
    novelId,
    mode: "queued",
  });
}

/** Clears only an explicit per-novel pause; legacy positive goals, queues, failures and chapter exclusions stay intact. */
export async function resumeStoppedNovelDownloadGoal(
  novelId: number,
): Promise<boolean> {
  return invokeDbMutation<boolean>("db_novel_goal_resume_stopped", { novelId });
}

/** Library source novels without their own goal, which follow the default keep-ahead. */
export async function listLibraryNovelsWithoutDownloadGoal(): Promise<
  { id: number; pluginId: string }[]
> {
  return invokeDbQuery<{ id: number; pluginId: string }[]>(
    "db_novel_goal_list_library_without_goal",
    { mode: "queued" },
  );
}
