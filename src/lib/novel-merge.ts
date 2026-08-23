import { listChaptersByNovel, type ChapterListRow } from "../db/queries/chapter";
import {
  applyNovelMergeInDb,
  type NovelMergeChapterDecision,
  type NovelMergeDatabaseResult,
  type PreparedNovelMergeDownload,
} from "../db/queries/novel-merge";
import { getNovelById, type NovelDetailRecord } from "../db/queries/novel";
import {
  storedChapterContentType,
  type ChapterContentType,
} from "./chapter-content";
import { reconcileStoredChapterContent } from "./chapter-content-storage";
import { clearResolvedChapterStorageDirs } from "./chapter-storage-resolution";
import { chapterStorageRelativeDir, novelStorageRelativeDir } from "./chapter-storage-path";
import {
  finalizeChapterStorageTransfer,
  prepareChapterStorageTransfer,
  removeChapterStorageDirectory,
  rollbackChapterStorageTransfer,
  type ChapterStorageTransferEntry,
  type ChapterStorageTransferPreparedEntry,
  type ChapterStorageTransferPreparation,
} from "./chapter-storage-transfer";
import { pluginManager } from "./plugins/manager";
import { syncNovelFromSource } from "./plugins/sync-novel";
import type { NovelItem, Plugin } from "./plugins/types";
import { runExclusiveChapterStorageOperation } from "./tasks/chapter-storage-operation";
import { cancelNovelChapterDownloadWork } from "./tasks/download-cache-delete";
import { enqueueSourceTask } from "./tasks/source-tasks";
import { markUpdatesIndexDirty } from "./updates/update-index-events";

export type { NovelMergeChapterDecision } from "../db/queries/novel-merge";

export interface NovelMergeTarget {
  pluginId: string;
  item: NovelItem;
}

export interface ExecuteNovelMergeInput {
  sourceNovelId: number;
  target: NovelMergeTarget;
  decisions: readonly NovelMergeChapterDecision[];
  artifactSourceChapterIdByTargetPath?: Readonly<Record<string, number>>;
}

export interface NovelMergeResult extends NovelMergeDatabaseResult {
  cleanupWarnings: string[];
}

interface MergeChapterResolution {
  sourceChapters: ChapterListRow[];
  sourcesByTargetPath: Map<string, ChapterListRow[]>;
  targetByPath: Map<string, ChapterListRow>;
}

const STORAGE_RECONCILIATION_BATCH_SIZE = 16;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfNovelMergeAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new DOMException("Novel merge was cancelled.", "AbortError");
}

function parentRelativePath(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  if (index <= 0) {
    throw new Error("Stored chapter content path has no chapter directory.");
  }
  return relativePath.slice(0, index);
}

function validateChapterDecisions(
  sourceChapters: readonly ChapterListRow[],
  targetChapters: readonly ChapterListRow[],
  decisions: readonly NovelMergeChapterDecision[],
): MergeChapterResolution {
  const sourceById = new Map(sourceChapters.map((chapter) => [chapter.id, chapter]));
  const targetByPath = new Map(targetChapters.map((chapter) => [chapter.path, chapter]));
  const decisionBySourceId = new Map<number, NovelMergeChapterDecision>();
  const sourcesByTargetPath = new Map<string, ChapterListRow[]>();

  for (const decision of decisions) {
    if (decisionBySourceId.has(decision.sourceChapterId)) {
      throw new Error("Each source chapter must have exactly one decision.");
    }
    const source = sourceById.get(decision.sourceChapterId);
    if (!source) {
      throw new Error("A decision references a source chapter that no longer exists.");
    }
    decisionBySourceId.set(decision.sourceChapterId, decision);
    if (decision.kind === "exclude") continue;
    if (!targetByPath.has(decision.targetChapterPath)) {
      throw new Error("A mapped target chapter no longer exists. Review the comparison again.");
    }
    const mapped = sourcesByTargetPath.get(decision.targetChapterPath) ?? [];
    mapped.push(source);
    sourcesByTargetPath.set(decision.targetChapterPath, mapped);
  }

  if (
    decisionBySourceId.size !== sourceChapters.length ||
    sourceChapters.some((chapter) => !decisionBySourceId.has(chapter.id))
  ) {
    throw new Error("Every source chapter must be mapped or excluded before merging.");
  }

  return {
    sourceChapters: [...sourceChapters],
    sourcesByTargetPath,
    targetByPath,
  };
}

function validateArtifactSelections(
  resolution: MergeChapterResolution,
  selections: Readonly<Record<string, number>>,
): void {
  for (const [targetPath, sourceChapterId] of Object.entries(selections)) {
    const mappedSources = resolution.sourcesByTargetPath.get(targetPath);
    if (!mappedSources) {
      throw new Error("A download selection references an unmapped target chapter.");
    }
    const source = mappedSources.find(
      (candidate) => candidate.id === sourceChapterId,
    );
    if (!source) {
      throw new Error("A download selection must reference a chapter mapped to its target.");
    }
    if (!source.isDownloaded) {
      throw new Error("A download selection must reference a downloaded source chapter.");
    }
  }
}

async function collectSourceArtifacts(
  sourceChapters: readonly ChapterListRow[],
): Promise<Map<number, Awaited<ReturnType<typeof reconcileStoredChapterContent>>>> {
  const artifactsByChapterId = new Map<
    number,
    Awaited<ReturnType<typeof reconcileStoredChapterContent>>
  >();
  const downloadedChapters = sourceChapters.filter(
    (chapter) => chapter.isDownloaded,
  );
  for (
    let offset = 0;
    offset < downloadedChapters.length;
    offset += STORAGE_RECONCILIATION_BATCH_SIZE
  ) {
    const batch = downloadedChapters.slice(
      offset,
      offset + STORAGE_RECONCILIATION_BATCH_SIZE,
    );
    const results = await Promise.allSettled(
      batch.map((chapter) => reconcileStoredChapterContent(chapter.id)),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
    batch.forEach((chapter, index) => {
      const result = results[index]!;
      if (result.status === "fulfilled") {
        artifactsByChapterId.set(chapter.id, result.value);
      }
    });
  }
  return artifactsByChapterId;
}

async function buildStorageTransferEntries(
  sourceNovel: NovelDetailRecord,
  targetNovel: NovelDetailRecord,
  resolution: MergeChapterResolution,
  selections: Readonly<Record<string, number>>,
): Promise<{
  cleanupRelativeDirs: Set<string>;
  entries: ChapterStorageTransferEntry[];
}> {
  const sourceArtifacts = await collectSourceArtifacts(resolution.sourceChapters);
  const cleanupRelativeDirs = new Set<string>();
  for (const artifacts of sourceArtifacts.values()) {
    if (artifacts.status === "present") {
      const chapterRelativeDir = parentRelativePath(artifacts.contentFile);
      cleanupRelativeDirs.add(chapterRelativeDir);
      cleanupRelativeDirs.add(parentRelativePath(chapterRelativeDir));
    }
  }

  const entries: ChapterStorageTransferEntry[] = [];
  for (const [targetPath, mappedSources] of resolution.sourcesByTargetPath) {
    const targetChapter = resolution.targetByPath.get(targetPath)!;
    const downloadedSources = mappedSources.filter(
      (source) => source.isDownloaded,
    );
    const selectedSourceChapterId = selections[targetPath];
    if (selectedSourceChapterId === undefined && downloadedSources.length > 1) {
      throw new Error(
        "Choose which A download should be moved when multiple A chapters map to one B chapter.",
      );
    }
    const selectedSource = selectedSourceChapterId === undefined
      ? downloadedSources[0]
      : downloadedSources.find(
          (source) => source.id === selectedSourceChapterId,
        );
    if (!selectedSource) continue;
    const selectedArtifacts = sourceArtifacts.get(selectedSource.id);
    const sourceRelativeDir =
      selectedArtifacts?.status === "present"
        ? parentRelativePath(selectedArtifacts.contentFile)
        : chapterStorageRelativeDir(sourceNovel, selectedSource);

    entries.push({
      entryId: String(selectedSource.id),
      sourceRelativeDir,
      targetRelativeDir: chapterStorageRelativeDir(targetNovel, targetChapter),
    });
  }

  return { cleanupRelativeDirs, entries };
}

function validateStoragePreparation(
  requestedEntries: readonly ChapterStorageTransferEntry[],
  preparation: ChapterStorageTransferPreparation,
): ChapterStorageTransferPreparedEntry[] {
  if (preparation.entries.length !== requestedEntries.length) {
    throw new Error("Chapter storage transfer returned an incomplete result.");
  }
  const requestedById = new Map(
    requestedEntries.map((entry) => [entry.entryId, entry]),
  );
  const seenIds = new Set<string>();
  for (const prepared of preparation.entries) {
    const requested = requestedById.get(prepared.entryId);
    if (!requested || seenIds.has(prepared.entryId)) {
      throw new Error("Chapter storage transfer returned an unexpected entry.");
    }
    seenIds.add(prepared.entryId);
    if (
      prepared.sourceRelativeDir !== requested.sourceRelativeDir ||
      prepared.targetRelativeDir !== requested.targetRelativeDir
    ) {
      throw new Error("Chapter storage transfer returned mismatched paths.");
    }
    if (prepared.outcome === "sourceNotDownloaded") {
      throw new Error(
        "An A download disappeared while it was being moved. No novels were merged.",
      );
    }
    if (
      !prepared.contentFile ||
      parentRelativePath(prepared.contentFile) !== requested.targetRelativeDir
    ) {
      throw new Error("Chapter storage transfer returned an invalid B content path.");
    }
    if (
      !Number.isSafeInteger(prepared.contentBytes) ||
      prepared.contentBytes < 0 ||
      !Number.isSafeInteger(prepared.mediaBytes) ||
      prepared.mediaBytes < 0
    ) {
      throw new Error("Chapter storage transfer returned invalid byte counts.");
    }
  }
  return preparation.entries;
}

function storedArtifactContentType(
  chapter: ChapterListRow,
  contentFile: string,
): ChapterContentType {
  if (contentFile.endsWith(".pdf")) return "pdf";
  if (chapter.contentType === "pdf") return "html";
  return storedChapterContentType(chapter.contentType);
}

async function rollbackPreparation(
  preparation: ChapterStorageTransferPreparation,
  originalError: unknown,
): Promise<never> {
  try {
    await rollbackChapterStorageTransfer(preparation);
  } catch (rollbackError) {
    throw new Error(
      `${errorMessage(originalError)} Storage rollback also failed: ${errorMessage(rollbackError)}`,
      { cause: originalError },
    );
  }
  throw originalError;
}

async function mergeNovelStorageAndRecords(
  input: ExecuteNovelMergeInput,
  sourceNovel: NovelDetailRecord,
  targetNovel: NovelDetailRecord,
  signal: AbortSignal,
): Promise<NovelMergeResult> {
  await cancelNovelChapterDownloadWork([sourceNovel.id, targetNovel.id]);
  throwIfNovelMergeAborted(signal);
  const [sourceChapters, targetChapters] = await Promise.all([
    listChaptersByNovel(sourceNovel.id),
    listChaptersByNovel(targetNovel.id),
  ]);
  throwIfNovelMergeAborted(signal);
  const resolution = validateChapterDecisions(
    sourceChapters,
    targetChapters,
    input.decisions,
  );
  const artifactSelections = input.artifactSourceChapterIdByTargetPath ?? {};
  validateArtifactSelections(resolution, artifactSelections);
  const { cleanupRelativeDirs, entries } = await buildStorageTransferEntries(
    sourceNovel,
    targetNovel,
    resolution,
    artifactSelections,
  );
  throwIfNovelMergeAborted(signal);

  let preparation: ChapterStorageTransferPreparation | null = null;
  if (entries.length > 0) {
    preparation = await prepareChapterStorageTransfer(entries);
  }

  let databaseResult: NovelMergeDatabaseResult;
  try {
    throwIfNovelMergeAborted(signal);
    const preparedEntries = preparation
      ? validateStoragePreparation(entries, preparation)
      : [];
    const sourceById = new Map(
      resolution.sourceChapters.map((chapter) => [chapter.id, chapter]),
    );
    const decisionBySourceId = new Map(
      input.decisions.map((decision) => [decision.sourceChapterId, decision]),
    );
    const preparedDownloads: PreparedNovelMergeDownload[] = preparedEntries.map(
      (entry) => {
        const sourceChapterId = Number(entry.entryId);
        const source = sourceById.get(sourceChapterId);
        const decision = decisionBySourceId.get(sourceChapterId);
        if (!source || decision?.kind !== "map" || !entry.contentFile) {
          throw new Error("Chapter storage transfer returned an unknown A chapter.");
        }
        const target = resolution.targetByPath.get(decision.targetChapterPath);
        if (!target) {
          throw new Error("Chapter storage transfer returned an unknown B chapter.");
        }
        const metadataChapter = entry.outcome === "copiedSource" ? source : target;
        return {
          sourceChapterId,
          contentType: storedArtifactContentType(metadataChapter, entry.contentFile),
          contentBytes: entry.contentBytes,
          mediaBytes: entry.mediaBytes,
          transferredFromSource: entry.outcome === "copiedSource",
        };
      },
    );
    throwIfNovelMergeAborted(signal);
    databaseResult = await applyNovelMergeInDb({
      sourceNovelId: sourceNovel.id,
      targetNovelId: targetNovel.id,
      decisions: input.decisions,
      preparedDownloads,
    });
  } catch (error) {
    if (preparation) return rollbackPreparation(preparation, error);
    throw error;
  }

  const cleanupWarnings: string[] = [];
  let canDeleteSourceStorage = true;
  try {
    await cancelNovelChapterDownloadWork([sourceNovel.id]);
  } catch (error) {
    canDeleteSourceStorage = false;
    cleanupWarnings.push(
      `A download work could not be settled; A files were retained: ${errorMessage(error)}`,
    );
  }
  if (preparation && canDeleteSourceStorage) {
    try {
      await finalizeChapterStorageTransfer(preparation);
    } catch (error) {
      canDeleteSourceStorage = false;
      cleanupWarnings.push(
        `Storage finalization failed; A files were retained: ${errorMessage(error)}`,
      );
    }
  }

  if (canDeleteSourceStorage) {
    const sourceNovelRelativeDir = novelStorageRelativeDir(sourceNovel);
    cleanupRelativeDirs.add(sourceNovelRelativeDir);
    const cleanupDirs = [...cleanupRelativeDirs].sort(
      (left, right) => right.split("/").length - left.split("/").length,
    );
    for (const relativeDir of cleanupDirs) {
      try {
        await removeChapterStorageDirectory(relativeDir);
      } catch (error) {
        cleanupWarnings.push(errorMessage(error));
      }
    }
  }

  clearResolvedChapterStorageDirs();
  markUpdatesIndexDirty("library-membership");
  return { ...databaseResult, cleanupWarnings };
}

async function executeNovelMergeWithPlugin(
  input: ExecuteNovelMergeInput,
  targetPlugin: Plugin,
  signal: AbortSignal,
): Promise<NovelMergeResult> {
  throwIfNovelMergeAborted(signal);
  const sourceNovel = await getNovelById(input.sourceNovelId);
  if (!sourceNovel) throw new Error("Source novel no longer exists.");
  if (sourceNovel.isLocal) {
    throw new Error("Novel merge supports remote novels only.");
  }
  if (sourceNovel.pluginId === targetPlugin.id) {
    throw new Error("Choose a target from a different source plugin.");
  }

  const targetSync = await syncNovelFromSource(targetPlugin, input.target.item, {
    chapterRefreshMode: "full",
  });
  throwIfNovelMergeAborted(signal);
  const targetNovel = await getNovelById(targetSync.novelId);
  if (!targetNovel) throw new Error("Target novel could not be stored.");
  if (targetNovel.id === sourceNovel.id || targetNovel.isLocal) {
    throw new Error("Source and target must be different remote novels.");
  }

  return runExclusiveChapterStorageOperation(
    {
      kind: "sources",
      sourceIds: [sourceNovel.pluginId, targetNovel.pluginId],
    },
    signal,
    () => mergeNovelStorageAndRecords(input, sourceNovel, targetNovel, signal),
  );
}

export async function executeNovelMerge(
  input: ExecuteNovelMergeInput,
): Promise<NovelMergeResult> {
  await pluginManager.loadInstalledFromDb();
  const plugin = pluginManager.getPlugin(input.target.pluginId);
  if (!plugin) throw new Error("Target source plugin is not installed.");

  const handle = enqueueSourceTask<NovelMergeResult>({
    plugin,
    kind: "source.mergeNovel",
    canCancel: false,
    priority: "interactive",
    title: input.target.item.name,
    subject: {
      novelId: input.sourceNovelId,
      novelName: input.target.item.name,
      path: input.target.item.path,
      pluginId: input.target.pluginId,
    },
    dedupeKey: `source.mergeNovel:${input.sourceNovelId}:${input.target.pluginId}:${input.target.item.path}`,
    run: (context) => {
      const runtimePlugin = pluginManager.getPluginForExecutor(
        input.target.pluginId,
        context.executor ?? "immediate",
      );
      return executeNovelMergeWithPlugin(input, runtimePlugin, context.signal);
    },
  });
  return handle.promise;
}
