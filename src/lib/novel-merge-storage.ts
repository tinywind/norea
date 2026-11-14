import { invokeDbMutation, invokeDbQuery } from "../db/ipc";
import { flushPendingWorkMetadata } from "../db/work-metadata";
import { base64ToBytes } from "./base64";
import type { ChapterCompositionV1 } from "./chapter-composition";
import { novelStorageRelativeDir } from "./chapter-storage-path";
import {
  finalizeChapterStorageTransfer,
  removeChapterStorageDirectory,
  rollbackChapterStorageTransfer,
  type ChapterStorageTransferEntry,
  type ChapterStorageTransferPreparation,
} from "./chapter-storage-transfer";
import { workMetadataOperation } from "./work-metadata";
import {
  canonicalMetadataValue,
  parseNovelMetadata,
  safeMetadataChild,
} from "./work-metadata/schema";

export interface MergeStorageWork {
  id: number;
  pluginId: string;
  sourceNovelId: string | null;
  path: string;
}

export interface MergeStorageSnapshot extends MergeStorageWork {
  directory: string;
  metadataBody: string | null;
  nextMetadataBody: string | null;
  fingerprint: string | null;
}

export interface NovelMergeStorageJournal {
  version: 1;
  token: string;
  phase: "preparing" | "committed";
  source: MergeStorageSnapshot;
  target: MergeStorageSnapshot;
  entries: ChapterStorageTransferEntry[];
  cleanupDirectories: string[];
  preparation?: ChapterStorageTransferPreparation;
}

export function parseNovelMergeStorageJournal(
  payload: string,
): NovelMergeStorageJournal {
  const job = JSON.parse(payload) as NovelMergeStorageJournal;
  const validDirectory = (path: string, depth: number) =>
    typeof path === "string" &&
    path.split("/").length === depth &&
    path.startsWith("contents/") &&
    path.split("/").every(safeMetadataChild);
  if (
    job.version !== 1 ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(job.token) ||
    !["preparing", "committed"].includes(job.phase) ||
    !job.source ||
    !job.target ||
    job.source.id === job.target.id ||
    job.source.directory === job.target.directory ||
    [job.source, job.target].some(
      (work) =>
        !Number.isSafeInteger(work.id) ||
        work.id <= 0 ||
        typeof work.pluginId !== "string" ||
        typeof work.sourceNovelId !== "string" ||
        typeof work.path !== "string" ||
        !validDirectory(work.directory, 3) ||
        (work.metadataBody !== null && typeof work.metadataBody !== "string") ||
        (work.nextMetadataBody !== null &&
          typeof work.nextMetadataBody !== "string") ||
        (work.fingerprint !== null && typeof work.fingerprint !== "string"),
    ) ||
    !Array.isArray(job.entries) ||
    !job.entries.length ||
    job.entries.some(
      (entry) =>
        typeof entry.entryId !== "string" ||
        !entry.entryId ||
        !validDirectory(entry.sourceRelativeDir, 4) ||
        !validDirectory(entry.targetRelativeDir, 4) ||
        !entry.sourceRelativeDir.startsWith(job.source.directory + "/") ||
        !entry.targetRelativeDir.startsWith(job.target.directory + "/"),
    ) ||
    !Array.isArray(job.cleanupDirectories) ||
    job.cleanupDirectories.some((path) => path !== job.source.directory)
  ) {
    throw new Error(
      "Work merge storage recovery journal is invalid. Existing files were retained.",
    );
  }
  if (
    job.preparation &&
    (job.preparation.token !== job.token ||
      job.preparation.entries.length !== job.entries.length ||
      job.preparation.entries.some(
        (entry, index) =>
          entry.entryId !== job.entries[index]!.entryId ||
          entry.sourceRelativeDir !== job.entries[index]!.sourceRelativeDir ||
          entry.targetRelativeDir !== job.entries[index]!.targetRelativeDir ||
          ![
            "movedSource",
            "copiedSource",
            "keptTarget",
            "sourceNotDownloaded",
          ].includes(entry.outcome),
      ))
  ) {
    throw new Error(
      "Work merge storage receipt does not match its journal. Existing files were retained.",
    );
  }
  return job;
}

export async function createNovelMergeStorageJournal(
  source: MergeStorageWork,
  target: MergeStorageWork,
  entries: ChapterStorageTransferEntry[],
  cleanupDirectories: string[],
  composition?: ChapterCompositionV1,
): Promise<NovelMergeStorageJournal> {
  await flushPendingWorkMetadata();
  const sourceDirectory = novelStorageRelativeDir(source);
  const targetDirectory = novelStorageRelativeDir(target);
  const [sourceRead, targetRead] = await Promise.all([
    workMetadataOperation({
      operation: "read",
      path: `${sourceDirectory}/novel.json`,
    }),
    workMetadataOperation({
      operation: "read",
      path: `${targetDirectory}/novel.json`,
    }),
  ]);
  return invokeDbMutation<NovelMergeStorageJournal>(
    "db_novel_merge_create_storage_journal",
    {
      input: {
        token: crypto.randomUUID(),
        source,
        sourceDirectory,
        sourceMetadataBody: sourceRead.body ?? null,
        target,
        targetDirectory,
        targetMetadataBody: targetRead.body ?? null,
        entries,
        cleanupDirectories: [
          ...new Set(
            cleanupDirectories.map((path) =>
              path.split("/").slice(0, 3).join("/"),
            ),
          ),
        ],
        ...(composition ? { composition } : {}),
      },
    },
  );
}

export async function saveNovelMergeStoragePreparation(
  job: NovelMergeStorageJournal,
  preparation: ChapterStorageTransferPreparation,
): Promise<void> {
  await invokeDbMutation<void>("db_novel_merge_save_storage_preparation", {
    job,
    preparation,
  });
}

export async function commitNovelMergeStorage(token: string): Promise<void> {
  await invokeDbMutation<void>("db_novel_merge_commit_storage_journal", {
    token,
  });
}

export async function finishNovelMergeStorage(token: string): Promise<void> {
  const job = await invokeDbQuery<NovelMergeStorageJournal | null>(
    "db_novel_merge_verify_storage_recovery",
    { token },
  );
  if (!job) return;

  if (job.phase === "preparing") {
    for (const work of [job.source, job.target]) {
      const { body } = await workMetadataOperation({
        operation: "read",
        path: `${work.directory}/novel.json`,
      });
      const current = body ?? null;
      const sameMetadata = (expected: string | null) => {
        if (current === expected) return true;
        if (current === null || expected === null) return false;
        try {
          const parse = (value: string) =>
            canonicalMetadataValue(
              parseNovelMetadata(
                JSON.parse(new TextDecoder().decode(base64ToBytes(value))),
              ),
            );
          return JSON.stringify(parse(current)) === JSON.stringify(parse(expected));
        } catch {
          return false;
        }
      };
      if (!sameMetadata(work.metadataBody) && !sameMetadata(work.nextMetadataBody)) {
        throw new Error(
          "Work merge metadata changed outside the interrupted operation. Existing files were retained.",
        );
      }
    }
  }

  if (job.phase === "committed") {
    if (!job.preparation) {
      throw new Error("Committed work merge storage receipt is missing.");
    }
    await finalizeChapterStorageTransfer(job.preparation);
    for (const directory of job.cleanupDirectories) {
      await removeChapterStorageDirectory(directory);
    }
  } else {
    await rollbackChapterStorageTransfer(
      job.preparation ?? {
        token: job.token,
        entries: job.entries.map((entry) => ({
          ...entry,
          outcome: "movedSource",
          replacedTarget: true,
          contentFile: `${entry.targetRelativeDir}/content.html`,
          contentBytes: 0,
          mediaBytes: 0,
        })),
      },
    );
    for (const work of [job.source, job.target]) {
      await workMetadataOperation(
        work.metadataBody === null
          ? { operation: "remove", path: `${work.directory}/novel.json` }
          : {
              operation: "write",
              path: `${work.directory}/novel.json`,
              body: work.metadataBody,
            },
      );
    }
  }

  await invokeDbMutation<void>("db_novel_merge_delete_storage_journal", {
    token,
  });
}

/** Resolve interrupted moves before metadata scanning can mistake their folders for new downloads. */
export async function recoverNovelMergeStorage(
  workIds?: readonly number[],
): Promise<void> {
  const payloads = await invokeDbQuery<string[]>(
    "db_novel_merge_list_storage_journals",
    { workIds: workIds ? [...workIds] : null },
  );
  for (const payload of payloads) {
    await finishNovelMergeStorage(parseNovelMergeStorageJournal(payload).token);
  }
}
