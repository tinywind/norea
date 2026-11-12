import { invoke } from "@tauri-apps/api/core";
import { clearNovelDownloadFiles, listNovelDeletionChapterIds } from "../../db/queries/content-deletion";
import type { NovelDetailRecord } from "../../db/queries/novel";
import { forgetNovelMetadataFile } from "../../db/work-metadata";
import { forgetNovelStorageDirs } from "../chapter-storage-resolution";
import { removeChapterStorageDirectory } from "../chapter-storage-transfer";
import { novelStorageRelativeDir } from "../chapter-storage-path";
import { runWorkContentStorageOperation } from "../content-sync/storage-operation";
import { clearNovelCoverDisplayCache } from "../novel-cover-storage";
import { waitForChapterDownloadWrites, withChapterDownloadDeletion } from "../chapter-download-writes";
import { discardQueuedChapterDownloads } from "./chapter-download";
import { taskScheduler } from "./scheduler";


/** Unshelving with local deletion removes the entire source work folder in one request. */
export async function deleteUnshelvedNovelDownloads(novel: NovelDetailRecord): Promise<void> {
  if (novel.isLocal) return;
  const directory = novelStorageRelativeDir(novel);
  const chapterIds = await listNovelDeletionChapterIds(novel.id);
  const wanted = new Set(chapterIds);
  await withChapterDownloadDeletion(chapterIds, async () => {
    const discarded = discardQueuedChapterDownloads(chapterIds);
    void discarded.catch(error => console.warn("[download-cache] could not discard queued downloads:", error));
    for (const task of taskScheduler.getSnapshot().records) {
      if ((task.kind === "chapter.download" || task.kind === "chapter.repairMedia") &&
          (task.subject?.novelId === novel.id || (task.subject?.chapterId !== undefined && wanted.has(task.subject.chapterId)))) {
        taskScheduler.cancel(task.id);
      }
    }
    await waitForChapterDownloadWrites(chapterIds);
    if (chapterIds.length) await invoke("chapter_download_queue_remove", { chapterIds });
    await runWorkContentStorageOperation(novel.pluginId, novel.path, async () => {
      await clearNovelDownloadFiles(novel, () => removeChapterStorageDirectory(directory));
      forgetNovelMetadataFile(novel.pluginId, novel.path);
      forgetNovelStorageDirs(novel.id, chapterIds);
      clearNovelCoverDisplayCache(novel.id, { pluginId: novel.pluginId, path: novel.path });
    });
  });
}
