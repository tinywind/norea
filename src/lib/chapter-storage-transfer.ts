import { invoke } from "@tauri-apps/api/core";
import {
  finalizeAndroidChapterStorageTransfer,
  prepareAndroidChapterStorageTransfer,
  removeAndroidChapterStorageDirectory,
  rollbackAndroidChapterStorageTransfer,
} from "./android-storage";
import { isAndroidRuntime, isTauriRuntime } from "./tauri-runtime";

export interface ChapterStorageTransferEntry {
  entryId: string;
  sourceRelativeDir: string;
  targetRelativeDir: string;
}

export type ChapterStorageTransferOutcome =
  | "copiedSource"
  | "keptTarget"
  | "sourceNotDownloaded";

export interface ChapterStorageTransferPreparedEntry
  extends ChapterStorageTransferEntry {
  contentBytes: number;
  contentFile: string | null;
  mediaBytes: number;
  outcome: ChapterStorageTransferOutcome;
  replacedTarget: boolean;
}

export interface ChapterStorageTransferPreparation {
  entries: ChapterStorageTransferPreparedEntry[];
  token: string;
}

function transferResponseRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Chapter storage transfer returned an invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function transferResponseString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Chapter storage transfer returned an invalid ${label}.`);
  }
  return value;
}

function transferResponseBytes(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`Chapter storage transfer returned invalid ${label}.`);
  }
  return value;
}

function parseChapterStorageTransferPreparation(
  value: unknown,
): ChapterStorageTransferPreparation {
  const preparation = transferResponseRecord(value, "preparation");
  const token = transferResponseString(preparation.token, "token");
  if (!Array.isArray(preparation.entries)) {
    throw new Error("Chapter storage transfer returned an invalid entry list.");
  }
  const entries = preparation.entries.map<ChapterStorageTransferPreparedEntry>(
    (value) => {
      const entry = transferResponseRecord(value, "entry");
      const outcome = entry.outcome;
      if (
        outcome !== "copiedSource" &&
        outcome !== "keptTarget" &&
        outcome !== "sourceNotDownloaded"
      ) {
        throw new Error("Chapter storage transfer returned an invalid outcome.");
      }
      if (typeof entry.replacedTarget !== "boolean") {
        throw new Error(
          "Chapter storage transfer returned an invalid replacement flag.",
        );
      }
      const contentFile = entry.contentFile;
      if (
        contentFile !== null &&
        (typeof contentFile !== "string" || contentFile.trim() === "")
      ) {
        throw new Error(
          "Chapter storage transfer returned an invalid content path.",
        );
      }
      if (
        outcome === "sourceNotDownloaded"
          ? contentFile !== null
          : contentFile === null
      ) {
        throw new Error(
          "Chapter storage transfer returned content inconsistent with its outcome.",
        );
      }
      return {
        entryId: transferResponseString(entry.entryId, "entry id"),
        sourceRelativeDir: transferResponseString(
          entry.sourceRelativeDir,
          "source path",
        ),
        targetRelativeDir: transferResponseString(
          entry.targetRelativeDir,
          "target path",
        ),
        contentBytes: transferResponseBytes(entry.contentBytes, "content bytes"),
        contentFile,
        mediaBytes: transferResponseBytes(entry.mediaBytes, "media bytes"),
        outcome,
        replacedTarget: entry.replacedTarget,
      };
    },
  );
  return { entries, token };
}

function requireChapterStorageRuntime(): void {
  if (!isTauriRuntime()) {
    throw new Error("Chapter storage transfer requires the Tauri runtime.");
  }
}

export async function prepareChapterStorageTransfer(
  entries: readonly ChapterStorageTransferEntry[],
): Promise<ChapterStorageTransferPreparation> {
  requireChapterStorageRuntime();
  const preparation = isAndroidRuntime()
    ? await prepareAndroidChapterStorageTransfer(entries)
    : await invoke<unknown>("chapter_storage_prepare_transfer", { entries });
  return parseChapterStorageTransferPreparation(preparation);
}

export async function finalizeChapterStorageTransfer(
  preparation: ChapterStorageTransferPreparation,
): Promise<void> {
  requireChapterStorageRuntime();
  if (isAndroidRuntime()) {
    await finalizeAndroidChapterStorageTransfer(preparation);
    return;
  }
  await invoke("chapter_storage_finalize_transfer", { preparation });
}

export async function rollbackChapterStorageTransfer(
  preparation: ChapterStorageTransferPreparation,
): Promise<void> {
  requireChapterStorageRuntime();
  if (isAndroidRuntime()) {
    await rollbackAndroidChapterStorageTransfer(preparation);
    return;
  }
  await invoke("chapter_storage_rollback_transfer", { preparation });
}

export async function removeChapterStorageDirectory(
  relativeDir: string,
): Promise<void> {
  requireChapterStorageRuntime();
  if (isAndroidRuntime()) {
    await removeAndroidChapterStorageDirectory(relativeDir);
    return;
  }
  await invoke("chapter_storage_remove_dir", { relativeDir });
}
