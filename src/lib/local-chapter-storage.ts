import { invoke } from "@tauri-apps/api/core";
import { runDatabaseTransaction } from "../db/client";
import { persistWorkChapterDirectories } from "../db/work-metadata";
import { resolvedChapterStorageDir } from "./chapter-storage-resolution";
import { runWorkContentStorageOperation } from "./content-sync/storage-operation";
import type { ChapterListRow } from "../db/queries/chapter";
import {
  getNovelById,
  renumberLocalNovelChapters,
  type NovelDetailRecord,
} from "../db/queries/novel";
import { listChaptersByNovel } from "../db/queries/chapter";
import {
  deleteAndroidStoragePath,
  renameAndroidStoragePath,
} from "./android-storage";
import { chapterStorageDirectoryName, novelStorageRelativeDir } from "./chapter-storage-path";
import { isAndroidRuntime, isTauriRuntime } from "./tauri-runtime";

type LocalChapterStorageNovel = Pick<
  NovelDetailRecord,
  "id" | "name" | "path" | "pluginId" | "sourceNovelId"
>;

type LocalChapterStorageChapter = Pick<
  ChapterListRow,
  "id" | "name" | "chapterNumber" | "position"
>;

interface SyncLocalChapterStorageInput {
  nextChapters: readonly LocalChapterStorageChapter[];
  novel: LocalChapterStorageNovel;
  previousChapters: readonly LocalChapterStorageChapter[];
  previousNovel?: LocalChapterStorageNovel;
}

function localChapterStorageRelativeDir(
  novel: LocalChapterStorageNovel,
  chapter: LocalChapterStorageChapter,
): string {
  return `${novelStorageRelativeDir(novel)}/${chapterStorageDirectoryName(chapter)}`;
}

function pathParent(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index < 0 ? "" : relativePath.slice(0, index);
}

function pathName(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index < 0 ? relativePath : relativePath.slice(index + 1);
}

function temporaryRelativeDir(relativeDir: string, chapterId: number): string {
  const parent = pathParent(relativeDir);
  const name = `${pathName(relativeDir)}.__norea-moving-${chapterId}`;
  return parent ? `${parent}/${name}` : name;
}

async function removeStorageDir(relativeDir: string): Promise<void> {
  if (!isTauriRuntime()) return;
  if (isAndroidRuntime()) {
    await deleteAndroidStoragePath(relativeDir);
    return;
  }
  await invoke("chapter_storage_remove_dir", { relativeDir });
}

async function relocateStorageDir(
  oldRelativeDir: string,
  newRelativeDir: string,
): Promise<void> {
  if (!isTauriRuntime() || oldRelativeDir === newRelativeDir) return;
  if (isAndroidRuntime()) {
    const oldParent = pathParent(oldRelativeDir);
    const newParent = pathParent(newRelativeDir);
    if (oldParent !== newParent) {
      await deleteAndroidStoragePath(oldRelativeDir);
      return;
    }
    await renameAndroidStoragePath(oldRelativeDir, pathName(newRelativeDir), true);
    return;
  }
  await invoke("chapter_storage_relocate_dir", {
    oldRelativeDir,
    newRelativeDir,
  });
}

async function pruneNovelStorageDir(
  expectedRelativeDirs: readonly string[],
): Promise<void> {
  if (!isTauriRuntime() || isAndroidRuntime() || expectedRelativeDirs.length === 0) {
    return;
  }
  const parent = pathParent(expectedRelativeDirs[0]!);
  if (!expectedRelativeDirs.every((relativeDir) => pathParent(relativeDir) === parent)) {
    return;
  }
  await invoke("chapter_storage_prune_dir_children", {
    keepNames: expectedRelativeDirs.map(pathName),
    relativeDir: parent,
  });
}

export async function syncLocalChapterStorageAfterOrderChange({
  nextChapters,
  novel,
  previousChapters,
  previousNovel,
}: SyncLocalChapterStorageInput): Promise<void> {
  if (!isTauriRuntime()) return;

  await runWorkContentStorageOperation(novel.pluginId, novel.path, async () => {
    const nextById = new Map(nextChapters.map((chapter) => [chapter.id, chapter]));
    const moves: Array<{
      chapterId: number;
      newRelativeDir: string;
      oldRelativeDir: string;
      temporaryRelativeDir: string;
    }> = [];

    for (const previous of previousChapters) {
      const next = nextById.get(previous.id);
      const oldRelativeDir = resolvedChapterStorageDir(previous.id) ?? localChapterStorageRelativeDir(
        previousNovel ?? novel,
        previous,
      );
      if (!next) {
        await removeStorageDir(oldRelativeDir);
        continue;
      }

      const newRelativeDir = localChapterStorageRelativeDir(novel, next);
      if (oldRelativeDir === newRelativeDir) continue;
      moves.push({
        chapterId: previous.id,
        newRelativeDir,
        oldRelativeDir,
        temporaryRelativeDir: temporaryRelativeDir(oldRelativeDir, previous.id),
      });
    }

    for (const move of moves) {
      await relocateStorageDir(move.oldRelativeDir, move.temporaryRelativeDir);
    }
    for (const move of moves) {
      await relocateStorageDir(move.temporaryRelativeDir, move.newRelativeDir);
    }
    await pruneNovelStorageDir(
      nextChapters.map((chapter) => localChapterStorageRelativeDir(novel, chapter)),
    );
    await runDatabaseTransaction(db => persistWorkChapterDirectories(db, novel.id,
      nextChapters.map(chapter => ({ id: chapter.id, directory: localChapterStorageRelativeDir(novel, chapter) }))));
  });
}

export async function repairLocalNovelChapterOrderStorage(
  novelId: number,
): Promise<void> {
  const novel = await getNovelById(novelId);
  if (!novel?.isLocal) return;
  const previousChapters = await listChaptersByNovel(novelId);
  await renumberLocalNovelChapters(novelId);
  const nextChapters = await listChaptersByNovel(novelId);
  await syncLocalChapterStorageAfterOrderChange({
    nextChapters,
    novel,
    previousChapters,
  });
}
