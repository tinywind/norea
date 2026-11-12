import type Database from "@tauri-apps/plugin-sql";
import { getDb, runDatabaseTransaction } from "../db/client";
import { createNovelMergeStorageJournal, finishNovelMergeStorageInDb, recoverNovelMergeStorageInDb, saveNovelMergeStoragePreparation } from "./novel-merge-storage";
import { getChapterComposition } from "../db/chapter-composition";
import { compileNovelMergeComposition, validateReviewedNovelMergeCatalog, type NovelMergeCompositionEntry, type ReviewedNovelMergeChapterCatalog } from "./novel-merge-composition";
import { hasStoredChapterContent, listChaptersByNovel, type ChapterListRow } from "../db/queries/chapter";
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
import { isChapterPayloadInventory, type ChapterPayloadInventory } from "./chapter-content/inventory";
import { workMetadataOperation } from "./work-metadata";
import { canonicalMetadataValue } from "./work-metadata/schema";
import { clearResolvedChapterStorageDirs } from "./chapter-storage-resolution";
import { chapterStorageRelativeDir, novelStorageRelativeDir } from "./chapter-storage-path";
import {
  prepareChapterStorageTransfer,
  removeChapterStorageDirectory,
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
import { inspectChapterPayloadInventory } from "./chapter-content/storage-platform";
import { useContentSyncStore } from "../store/content-sync";
import { normalizeContentServerUrl } from "./content-sync/client";
import { publishNovelMigrationSourceHold } from "./content-sync/deletion-exclusions";
import { runContentSyncOperation, syncContentServer } from "./content-sync/sync";
import { captureNovelMigrationSourceSnapshot, captureNovelMigrationTargetMetadata } from "./content-sync/novel-migration";
import { verifyMigrationBodyOnlyInventory } from "./content-sync/migration-inventory";
import type { NovelMigrationTargetMetadata, WorkMigrationSnapshot } from "./content-sync/novel-migration-types";

export type { NovelMergeChapterDecision } from "../db/queries/novel-merge";

export interface NovelMergeTarget {
  pluginId: string;
  item: NovelItem;
}

export interface ExecuteNovelMergeInput {
  sourceNovelId: number;
  target: NovelMergeTarget;
  decisions?: readonly NovelMergeChapterDecision[];
  composition?: readonly NovelMergeCompositionEntry[];
  reviewedChapterCatalog?: ReviewedNovelMergeChapterCatalog;
  artifactSourceChapterIdByTargetPath?: Readonly<Record<string, number>>;
  skipSourceContentChapterIds?: readonly number[];
}

export interface NovelMergeResult extends NovelMergeDatabaseResult {
  cleanupWarnings: string[];
  contentSyncPending?: boolean;
}

export interface IncomingNovelMergeOptions {
  signal: AbortSignal;
  recordIncomingMigration: (db: Database) => Promise<void>;
  beforeCommit?: () => Promise<void>;

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
    if (!hasStoredChapterContent(source)) {
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
    (chapter) => hasStoredChapterContent(chapter),
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
  skipSourceContentChapterIds: readonly number[] = [],
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
      (source) => hasStoredChapterContent(source) && !skipSourceContentChapterIds.includes(source.id),
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

function sameLocalPayload(left: ChapterPayloadInventory, right: ChapterPayloadInventory): boolean {
  if (!left.body || !right.body || !isChapterPayloadInventory(left) || !isChapterPayloadInventory(right)) return false;
  const contents = (value: ChapterPayloadInventory) => JSON.stringify([
    value.body!.sha256, value.body!.bytes, value.expectedAssetKeys && [...value.expectedAssetKeys].sort(),
    [...value.storedAssets].sort((a, b) => a.key.localeCompare(b.key)).map(asset => [asset.key, asset.sha256, asset.bytes]),
  ]);
  return contents(left) === contents(right);
}

async function incomingStorageEntries(
  source: NovelDetailRecord, target: NovelDetailRecord, resolution: MergeChapterResolution,
  skipped: readonly number[], signal: AbortSignal,
) {
  const directory = novelStorageRelativeDir(source);
  const { paths } = await workMetadataOperation({ operation: "chapters", path: directory + "/novel.json" });
  if (!paths) throw new Error("Cannot inspect the original work's stored chapters.");
  const occupied = new Set(paths.map(parentRelativePath));
  const owners = new Map<string, number>();
  for (const chapter of resolution.sourceChapters) {
    const folder = chapterStorageRelativeDir(source, chapter);
    if (!occupied.has(folder)) continue;
    if (owners.has(folder)) throw new Error("A stored source chapter has ambiguous ownership. Existing files were retained.");
    owners.set(folder, chapter.id);
  }
  if (owners.size !== occupied.size) throw new Error("A stored source chapter has no local mapping. Existing files were retained.");
  const entries: ChapterStorageTransferEntry[] = [];
  const expected = new Map<string, ChapterPayloadInventory>();
  const excluded = new Set(skipped);
  for (const [path, chapters] of resolution.sourcesByTargetPath) {
    const destination = resolution.targetByPath.get(path)!;
    for (const chapter of chapters) {
      const sourceRelativeDir = chapterStorageRelativeDir(source, chapter);
      if (!occupied.has(sourceRelativeDir) || excluded.has(chapter.id)) continue;
      if (expected.has(path)) throw new Error("Multiple stored source chapters map to one destination. Existing files were retained.");
      const original = await inspectChapterPayloadInventory({ novel: source, chapter }, signal);
      if (!original.body || !isChapterPayloadInventory(original)) throw new Error("The stored source chapter could not be verified. Existing files were retained.");
      const existing = await inspectChapterPayloadInventory({ novel: target, chapter: destination }, signal);
      if ((existing.body || existing.storedAssets.length) && !sameLocalPayload(original, existing)) {
        throw new Error("The destination contains different local chapter files. Existing files were retained.");
      }
      expected.set(path, original);
      entries.push({ entryId: String(chapter.id), sourceRelativeDir, targetRelativeDir: chapterStorageRelativeDir(target, destination) });
    }
  }
  return { entries, expected, cleanupRelativeDirs: new Set<string>([directory]) };
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


async function mergeNovelStorageAndRecords(
  input: Pick<ExecuteNovelMergeInput, "decisions" | "composition" | "reviewedChapterCatalog" | "artifactSourceChapterIdByTargetPath" | "skipSourceContentChapterIds">,
  sourceNovel: NovelDetailRecord,
  targetNovel: NovelDetailRecord,
  signal: AbortSignal,
  contentSyncServerUrl?: string,
  contentSyncSourceSnapshot?: WorkMigrationSnapshot,
  contentSyncTargetMetadata?: NovelMigrationTargetMetadata,
  incoming?: IncomingNovelMergeOptions,
): Promise<NovelMergeResult> {
  await recoverNovelMergeStorageInDb(await getDb(), [sourceNovel.id, targetNovel.id]);
  await cancelNovelChapterDownloadWork([sourceNovel.id, targetNovel.id]);
  throwIfNovelMergeAborted(signal);
  const [sourceChapters, storedTargetChapters] = await Promise.all([
    listChaptersByNovel(sourceNovel.id),
    listChaptersByNovel(targetNovel.id),
  ]);
  throwIfNovelMergeAborted(signal);
  if (input.composition) validateReviewedNovelMergeCatalog(input.reviewedChapterCatalog, sourceChapters, storedTargetChapters);
  const db = input.composition ? await getDb() : null;
  const compiled = input.composition ? compileNovelMergeComposition({
    entries: input.composition, sourceNovel, targetNovel, sourceChapters,
    targetChapters: storedTargetChapters,
    sourceComposition: await getChapterComposition(db!, sourceNovel.id),
    targetComposition: await getChapterComposition(db!, targetNovel.id),
  }) : null;
  const targetChapters = compiled?.targetChapters ?? storedTargetChapters;
  const decisions = compiled?.decisions ?? input.decisions ?? [];
  const resolution = validateChapterDecisions(
    sourceChapters,
    targetChapters,
    decisions,
  );
  const artifactSelections = compiled?.artifactSourceChapterIdByTargetPath ?? input.artifactSourceChapterIdByTargetPath ?? {};
  validateArtifactSelections(resolution, artifactSelections);
  const skipped = compiled?.skipSourceContentChapterIds ?? input.skipSourceContentChapterIds ?? [];
  const localTransfer = incoming ? await incomingStorageEntries(sourceNovel, targetNovel, resolution, skipped, signal) : undefined;
  const { cleanupRelativeDirs, entries } = localTransfer ?? await buildStorageTransferEntries(
    sourceNovel, targetNovel, resolution, artifactSelections, skipped,
  );
  throwIfNovelMergeAborted(signal);

  const storageJournal = entries.length ? await runDatabaseTransaction(db => createNovelMergeStorageJournal(
    db, sourceNovel, targetNovel, entries, [...cleanupRelativeDirs, novelStorageRelativeDir(sourceNovel)],
    compiled?.composition,
  )) : null;
  let preparation: ChapterStorageTransferPreparation | null = null;
  let databaseResult: NovelMergeDatabaseResult;
  try {
    if (storageJournal) {
      preparation = await prepareChapterStorageTransfer(entries, { token: storageJournal.token, moveSource: true });
      validateStoragePreparation(entries, preparation);
      await runDatabaseTransaction(db => saveNovelMergeStoragePreparation(db, storageJournal, preparation!));
    }
    throwIfNovelMergeAborted(signal);
    const preparedEntries = preparation
      ? validateStoragePreparation(entries, preparation)
      : [];
    const sourceById = new Map(
      resolution.sourceChapters.map((chapter) => [chapter.id, chapter]),
    );
    const decisionBySourceId = new Map(
      decisions.map((decision) => [decision.sourceChapterId, decision]),
    );
    const preparedDownloads: PreparedNovelMergeDownload[] = await Promise.all(preparedEntries.map(
      async (entry) => {
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
        const transferredFromSource = entry.outcome === "copiedSource" || entry.outcome === "movedSource";
        const metadataChapter = transferredFromSource ? source : target;
        const inventory = (incoming || contentSyncServerUrl && !transferredFromSource || !metadataChapter.isDownloaded || metadataChapter.mediaRepairNeeded)
          ? await inspectChapterPayloadInventory({
              novel: targetNovel,
              chapter: { ...target, contentType: storedArtifactContentType(metadataChapter, entry.contentFile) },
            }, signal)
          : null;
        if (contentSyncServerUrl && !transferredFromSource && inventory && !inventory.mediaComplete) throw new Error("The retained B download is incomplete. No novels were merged.");
        if (localTransfer) {
          const expected = localTransfer.expected.get(decision.targetChapterPath);
          if (entry.replacedTarget || !expected || !inventory || !sameLocalPayload(inventory, expected)) {
            throw new Error("The local chapter files changed during the move. The original was retained.");
          }
        }
        const targetInventoryBodyOnly = contentSyncServerUrl && inventory?.expectedAssetKeys === null
          ? await verifyMigrationBodyOnlyInventory(entry.contentFile, inventory, signal)
          : false;
        return {
          sourceChapterId,
          contentType: storedArtifactContentType(metadataChapter, entry.contentFile),
          contentBytes: entry.contentBytes,
          mediaBytes: entry.mediaBytes,
          transferredFromSource,
          ...(inventory && !inventory.mediaComplete ? { mediaComplete: false } : {}),
          ...(inventory ? { targetInventory: { body: inventory.body, expectedAssetKeys: inventory.expectedAssetKeys, storedAssets: inventory.storedAssets } } : {}),
          ...(targetInventoryBodyOnly ? { targetInventoryBodyOnly: true } : {}),
        };
      },
    ));
    const preparedCompositionCopies = compiled ? preparedEntries.flatMap(transfer => {
      if (transfer.outcome !== "copiedSource" && transfer.outcome !== "movedSource" || transfer.replacedTarget) return [];
      const sourceChapterId = Number(transfer.entryId);
      const decision = decisionBySourceId.get(sourceChapterId);
      const entry = decision?.kind === "map" ? compiled.composition.entries.find(entry => entry.path === decision.targetChapterPath) : undefined;
      if (!entry || compiled.artifactSourceChapterIdByTargetPath[entry.path] !== sourceChapterId ||
        transfer.targetRelativeDir !== chapterStorageRelativeDir(targetNovel, { chapterNumber: entry.storageChapterNumber })) {
        throw new Error("Prepared chapter copy no longer matches the approved composition.");
      }
      return [{ entry, transfer }];
    }) : [];
    throwIfNovelMergeAborted(signal);
    await incoming?.beforeCommit?.();
    throwIfNovelMergeAborted(signal);
    databaseResult = await applyNovelMergeInDb({
      sourceNovelId: sourceNovel.id,
      targetNovelId: targetNovel.id,
      decisions,
      preparedDownloads,
      skipSourceContentChapterIds: compiled?.skipSourceContentChapterIds ?? input.skipSourceContentChapterIds,
      ...(compiled ? { composition: compiled.composition, preparedCompositionCopies,
        readingStateSourcePathByTargetPath: compiled.readingStateSourcePathByTargetPath } : {}),
      ...(contentSyncServerUrl ? { contentSyncServerUrl } : {}),
      ...(contentSyncSourceSnapshot ? { contentSyncSourceSnapshot } : {}),
      ...(contentSyncTargetMetadata ? { contentSyncTargetMetadata } : {}),
      ...(incoming ? { recordIncomingMigration: incoming.recordIncomingMigration } : {}),
      ...(storageJournal ? { storageTransferToken: storageJournal.token } : {}),
    });
  } catch (error) {
    if (storageJournal) {
      try { await finishNovelMergeStorageInDb(await getDb(), storageJournal.token); }
      catch (recoveryError) { throw new AggregateError([error, recoveryError], "Work merge failed and storage recovery is pending. Existing files were retained."); }
      throw error;
    }
    throw error;
  }

  if (contentSyncServerUrl) {
    try {
      publishNovelMigrationSourceHold(contentSyncServerUrl, { pluginId: sourceNovel.pluginId, novelId: sourceNovel.sourceNovelId! });
    } catch (error) {
      // The committed raw DB hold remains authoritative; notification cannot roll files back.
      console.warn("[novel-merge] source hold notification failed", error);
    }
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
  if (storageJournal && canDeleteSourceStorage) {
    try {
      await finishNovelMergeStorageInDb(await getDb(), storageJournal.token);
    } catch (error) {
      cleanupWarnings.push(`Storage finalization needs recovery: ${errorMessage(error)}`);
    }
    canDeleteSourceStorage = false;
  }

  if (canDeleteSourceStorage) {
    const sourceNovelRelativeDir = novelStorageRelativeDir(sourceNovel);
    cleanupRelativeDirs.add(sourceNovelRelativeDir);
    const cleanupDirs = [...new Set([...cleanupRelativeDirs].map(path => path.split("/").slice(0, 3).join("/")))];
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
  return { ...databaseResult, cleanupWarnings, ...(contentSyncServerUrl ? { contentSyncPending: true } : {}) };
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
  if (sourceNovel.pluginId === targetPlugin.id && sourceNovel.path === input.target.item.path) {
    throw new Error("Source and target must have different work identities.");
  }

  const targetSync = await syncNovelFromSource(targetPlugin, input.target.item, {
    chapterRefreshMode: "full", preserveMissingMetadata: false, refreshCover: true, signal,
  });
  throwIfNovelMergeAborted(signal);
  const targetNovel = await getNovelById(targetSync.novelId);
  if (!targetNovel) throw new Error("Target novel could not be stored.");
  if (targetNovel.id === sourceNovel.id || targetNovel.isLocal ||
    sourceNovel.pluginId === targetNovel.pluginId && sourceNovel.sourceNovelId === targetNovel.sourceNovelId) {
    throw new Error("Source and target must be different remote novels.");
  }
  const fresh = targetSync.authoritativeMetadata;
  const currentFields = { name: targetNovel.name, author: targetNovel.author, artist: targetNovel.artist,
    summary: targetNovel.summary, status: targetNovel.status, genres: targetNovel.genres, rating: targetNovel.rating, isLocal: targetNovel.isLocal };
  if (!fresh || fresh.identity.pluginId !== targetNovel.pluginId || fresh.identity.novelId !== targetNovel.sourceNovelId
    || fresh.identity.novelPath !== targetNovel.path || fresh.coverUrl !== targetNovel.cover
    || JSON.stringify(canonicalMetadataValue(fresh.novel)) !== JSON.stringify(canonicalMetadataValue(currentFields))) {
    throw new Error("The target metadata changed after its source refresh. No novels were merged.");
  }

  const configuredServer = useContentSyncStore.getState().serverUrl;
  const contentSyncServerUrl = configuredServer ? normalizeContentServerUrl(configuredServer) : undefined;
  const merge = () => runExclusiveChapterStorageOperation(
    {
      kind: "sources",
      sourceIds: [sourceNovel.pluginId, targetNovel.pluginId],
    },
    signal,
    async () => {
      const targetMetadata = contentSyncServerUrl
        ? await captureNovelMigrationTargetMetadata(targetNovel, signal)
        : undefined;
      const sourceSnapshot = contentSyncServerUrl && sourceNovel.sourceNovelId
        ? await captureNovelMigrationSourceSnapshot(contentSyncServerUrl, {
            pluginId: sourceNovel.pluginId, novelId: sourceNovel.sourceNovelId, novelPath: sourceNovel.path,
          }, signal)
        : undefined;
      if (contentSyncServerUrl && !sourceSnapshot) {
        throw new Error("The original work could not be verified on the content server. Synchronize the original work with the server, then retry. No novels were merged.");
      }
      return mergeNovelStorageAndRecords(input, sourceNovel, targetNovel, signal, contentSyncServerUrl, sourceSnapshot, targetMetadata);
    },
  );
  return contentSyncServerUrl ? runContentSyncOperation(merge) : merge();
}

/** Applies a confirmed server migration on a recipient without contacting either plugin. */
export async function executeNovelMergeFromServer(
  input: Pick<ExecuteNovelMergeInput, "sourceNovelId" | "decisions" | "artifactSourceChapterIdByTargetPath" | "skipSourceContentChapterIds"> & { targetNovelId: number },
  options: IncomingNovelMergeOptions,
): Promise<NovelMergeResult> {
  throwIfNovelMergeAborted(options.signal);
  const [sourceNovel, targetNovel] = await Promise.all([getNovelById(input.sourceNovelId), getNovelById(input.targetNovelId)]);
  if (!sourceNovel || !targetNovel) throw new Error("A received migration work no longer exists locally.");
  if (sourceNovel.id === targetNovel.id || sourceNovel.isLocal || targetNovel.isLocal ||
    sourceNovel.pluginId === targetNovel.pluginId && sourceNovel.sourceNovelId === targetNovel.sourceNovelId) {
    throw new Error("A received migration requires different remote source works.");
  }
  return runExclusiveChapterStorageOperation({ kind: "sources", sourceIds: [sourceNovel.pluginId, targetNovel.pluginId] }, options.signal,
    () => mergeNovelStorageAndRecords(input, sourceNovel, targetNovel, options.signal, undefined, undefined, undefined, options));
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
  const result = await handle.promise;
  if (result.contentSyncPending) {
    void syncContentServer().catch(error => {
      console.warn("[novel-merge] server migration remains pending", error);
    });
  }
  return result;
}
