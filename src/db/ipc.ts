import { invoke } from "@tauri-apps/api/core";
import {
  forgetAuthoritativeChapterStorageDir,
  forgetResolvedNovelStorageDir,
  rememberAuthoritativeChapterStorageDir,
  rememberResolvedNovelStorageDir,
} from "../lib/chapter-storage-resolution";
import {
  invalidateAllNovelCoverSources,
  notifyNovelCoverChanged,
} from "../lib/novel-cover-storage";
import { startPerformanceObservation } from "../lib/observability";
import { notifyWorkMetadataChanges } from "../lib/work-metadata";
import { notifyContentSyncSequence } from "./content-sync-journal";
import {
  notifyUserStateEffects,
  type UserStateChangePriority,
} from "./user-state-core";
import { forgetNovelMetadataFile } from "./work-metadata";

export type DbReadMode = "queued" | "committed";

export interface WorkDirectoryUpdate {
  novelId: number;
  pluginId: string;
  novelPath: string;
  directory: string | null;
}

export interface ChapterDirectoryUpdate {
  chapterId: number;
  directory: string | null;
}

export interface DbMutationEffects {
  userStatePriority?: UserStateChangePriority;
  userStateLedgerChanged?: boolean;
  userStateDeferredReady?: boolean;
  contentSyncMaxSequence?: number;
  workMetadataChanged?: boolean;
  coverChangedNovelIds?: number[];
  workDirectories?: WorkDirectoryUpdate[];
  chapterDirectories?: ChapterDirectoryUpdate[];
}

export interface DbMutationEnvelope<T> {
  value: T;
  effects: DbMutationEffects;
}

function observationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function applyDbMutationEffects(
  effects?: DbMutationEffects | null,
): void {
  if (!effects) return;

  const workIdentities = new Map<
    number,
    { pluginId: string; path: string }
  >();
  const notifiedWorkKeys = new Set<string>();
  const workNotifications: Array<{ pluginId: string; novelPath: string }> = [];

  for (const work of effects.workDirectories ?? []) {
    workIdentities.set(work.novelId, {
      pluginId: work.pluginId,
      path: work.novelPath,
    });
    if (work.directory !== null) {
      rememberResolvedNovelStorageDir(work.novelId, work.directory);
    } else {
      forgetResolvedNovelStorageDir(work.novelId);
      forgetNovelMetadataFile(work.pluginId, work.novelPath);
    }
    const key = JSON.stringify([work.pluginId, work.novelPath]);
    if (!notifiedWorkKeys.has(key)) {
      notifiedWorkKeys.add(key);
      workNotifications.push({
        pluginId: work.pluginId,
        novelPath: work.novelPath,
      });
    }
  }

  for (const chapter of effects.chapterDirectories ?? []) {
    if (chapter.directory !== null) {
      rememberAuthoritativeChapterStorageDir(
        chapter.chapterId,
        chapter.directory,
      );
    } else {
      forgetAuthoritativeChapterStorageDir(chapter.chapterId);
    }
  }

  if (effects.coverChangedNovelIds?.length) {
    if (effects.coverChangedNovelIds.includes(0)) {
      invalidateAllNovelCoverSources();
    } else {
      for (const novelId of effects.coverChangedNovelIds) {
        notifyNovelCoverChanged(novelId, workIdentities.get(novelId));
      }
    }
  }

  if (effects.workMetadataChanged) {
    if (workNotifications.length > 0) {
      for (const identity of workNotifications) {
        notifyWorkMetadataChanges(identity);
      }
    } else {
      notifyWorkMetadataChanges();
    }
  }

  if (typeof effects.contentSyncMaxSequence === "number") {
    notifyContentSyncSequence(effects.contentSyncMaxSequence);
  }

  if (
    effects.userStatePriority ||
    effects.userStateLedgerChanged ||
    effects.userStateDeferredReady
  ) {
    notifyUserStateEffects({
      priority: effects.userStatePriority,
      ledgerChanged: effects.userStateLedgerChanged,
      deferredReady: effects.userStateDeferredReady,
    });
  }
}

export async function invokeDbQuery<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const finish = startPerformanceObservation("db.query", { command });
  try {
    const result =
      args === undefined
        ? await invoke<T>(command)
        : await invoke<T>(command, args);
    finish({
      rowCount: Array.isArray(result) ? result.length : undefined,
    });
    return result;
  } catch (error) {
    finish({ error: observationError(error), failed: true });
    throw error;
  }
}

export async function invokeDbMutation<T = void>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const finish = startPerformanceObservation("db.mutation", { command });
  try {
    const envelope =
      args === undefined
        ? await invoke<DbMutationEnvelope<T>>(command)
        : await invoke<DbMutationEnvelope<T>>(command, args);
    applyDbMutationEffects(envelope?.effects);
    finish();
    return envelope.value;
  } catch (error) {
    finish({ error: observationError(error), failed: true });
    throw error;
  }
}
