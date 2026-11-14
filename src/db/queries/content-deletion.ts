import { invokeDbMutation, invokeDbQuery } from "../ipc";
import type { NovelMetadataV1 } from "../../lib/work-metadata";
import type { NovelDetailRecord } from "./novel";

export async function listStoredDeletionNovelIds(): Promise<number[]> {
  return invokeDbQuery<number[]>("db_content_deletion_list_stored_novel_ids", {
    readMode: "queued",
  });
}

/** Stored chapters of source works, optionally only of these works, that a device download deletion removes. */
export async function listDeletionDownloadedChapterIds(
  novelIds?: readonly number[],
): Promise<number[]> {
  return invokeDbQuery<number[]>(
    "db_content_deletion_list_downloaded_chapter_ids",
    {
      novelIds: novelIds ? [...novelIds] : null,
      readMode: "queued",
    },
  );
}

export async function findLocalDeletionNovel(
  identity: NovelMetadataV1["identity"],
): Promise<NovelDetailRecord | null> {
  return invokeDbQuery<NovelDetailRecord | null>(
    "db_content_deletion_find_local_novel",
    {
      pluginId: identity.pluginId,
      sourceNovelId: identity.novelId,
      readMode: "queued",
    },
  );
}

export async function deleteLocalNovelRecords(
  novel: Pick<NovelDetailRecord, "id" | "pluginId" | "sourceNovelId" | "path">,
  options: { recordUserStateRemoval?: boolean } = {},
): Promise<void> {
  await invokeDbMutation("db_content_deletion_delete_novel_records", {
    input: {
      id: novel.id,
      pluginId: novel.pluginId,
      sourceNovelId: novel.sourceNovelId,
      path: novel.path,
      recordUserStateRemoval: options.recordUserStateRemoval ?? false,
    },
  });
}

/** Remove a source work's files and cached download state without changing reading history. */
export async function clearNovelDownloadFiles(
  novel: Pick<NovelDetailRecord, "id" | "pluginId" | "sourceNovelId" | "path">,
  removeDirectory: () => Promise<void>,
): Promise<void> {
  const guard = {
    id: novel.id,
    pluginId: novel.pluginId,
    sourceNovelId: novel.sourceNovelId,
    path: novel.path,
  };
  const verified = await invokeDbQuery<boolean>(
    "db_content_deletion_verify_download_clear",
    { input: guard, readMode: "queued" },
  );
  if (!verified) return;
  await removeDirectory();
  await invokeDbMutation("db_content_deletion_commit_download_clear", {
    input: guard,
  });
}

export async function listNovelDeletionChapterIds(
  novelId: number,
): Promise<number[]> {
  return invokeDbQuery<number[]>(
    "db_content_deletion_list_novel_chapter_ids",
    { novelId, readMode: "queued" },
  );
}
