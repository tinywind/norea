import { listNovelMigrations, saveNovelMigration } from "../../db/queries/content-sync";
import type { NovelDetailRecord } from "../../db/queries/novel";
import { novelStorageRelativeDir } from "../chapter-storage-path";
import { readStoredNovelCover, readStoredNovelMetadata } from "../work-metadata";
import { canonicalMetadataValue, parseNovelMetadata } from "../work-metadata/schema";
import { isChapterPayloadInventory } from "../chapter-content/inventory";
import { useContentSyncStore } from "../../store/content-sync";
import { registerContentDevice } from "./device";
import { ContentServerError, contentServerRequest } from "./client";
import { runServerWorkDeletion } from "./deletion-exclusions";
import { contentWorkId, recordDeletedWorkMetadata, type WorkCatalogEntry } from "./works";
import type {
  CopyWorkMigrationChapterRequest, FinalizeWorkMigrationRequest, MigrationWorkIdentity, NovelMigrationChapter,
  NovelMigrationTargetMetadata, PendingNovelMigration, WorkMigrationSnapshot,
} from "./novel-migration-types";

export class PendingNovelMigrationError extends Error {
  constructor(readonly count: number, readonly reason: string, readonly retryable = true) {
    super(`Server migration is pending for ${count} merged work(s). The original server copies were retained. ${reason}`);
    this.name = "PendingNovelMigrationError";
  }
}

class MigrationReviewRequiredError extends Error {}

function sameIdentity(left: MigrationWorkIdentity, right: MigrationWorkIdentity): boolean {
  return left.pluginId === right.pluginId && left.novelId === right.novelId && left.novelPath === right.novelPath;
}

function validSnapshot(snapshot: WorkMigrationSnapshot, id: string, identity: MigrationWorkIdentity): boolean {
  if (!snapshot?.work || snapshot.work.id !== id || !snapshot.work.revision || !sameIdentity(snapshot.work.identity, identity)
    || !Array.isArray(snapshot.chapters)) return false;
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const chapter of snapshot.chapters) {
    if (!chapter || typeof chapter.id !== "string" || !chapter.id || typeof chapter.revision !== "string" || !chapter.revision
      || typeof chapter.chapterPath !== "string" || !chapter.chapterPath || ids.has(chapter.id) || paths.has(chapter.chapterPath)
      || typeof chapter.available !== "boolean" || typeof chapter.complete !== "boolean") return false;
    ids.add(chapter.id);
    paths.add(chapter.chapterPath);
  }
  return true;
}


function sameSourceSnapshot(expected: WorkMigrationSnapshot, current: WorkMigrationSnapshot): boolean {
  if (expected.work.id !== current.work.id || expected.work.revision !== current.work.revision
    || !sameIdentity(expected.work.identity, current.work.identity) || expected.chapters.length !== current.chapters.length) return false;
  const byId = new Map(current.chapters.map(chapter => [chapter.id, chapter]));
  return expected.chapters.every(chapter => {
    const actual = byId.get(chapter.id);
    return actual?.revision === chapter.revision && actual.chapterPath === chapter.chapterPath
      && actual.chapterNumber === chapter.chapterNumber && actual.complete === chapter.complete && actual.available === chapter.available;
  });
}

/** No baseline is invented when the original server work cannot be verified before merging. */
export async function captureNovelMigrationSourceSnapshot(
  server: string,
  identity: MigrationWorkIdentity,
  signal?: AbortSignal,
): Promise<WorkMigrationSnapshot | undefined> {
  signal?.throwIfAborted();
  try {
    const token = await registerContentDevice(server, useContentSyncStore.getState().deviceName, signal);
    const capabilities = await contentServerRequest<{ workMigrationVersion?: number; workMigrationLineageVersion?: number; workMigrationCopyVersion?: number; workCoverDeletionVersion?: number }>(
      server, "/capabilities", token, "GET", undefined, signal,
    );
    signal?.throwIfAborted();
    if (capabilities.workMigrationVersion !== 1 || capabilities.workMigrationLineageVersion !== 1
      || capabilities.workMigrationCopyVersion !== 1 || capabilities.workCoverDeletionVersion !== 1) {
      throw new MigrationReviewRequiredError("Update the content server before merging works so their metadata, chapter decisions and history can migrate together.");
    }
    const id = await contentWorkId(identity);
    const snapshot = await contentServerRequest<WorkMigrationSnapshot>(
      server, `/works/${id}/migration-snapshot`, token, "GET", undefined, signal,
    );
    signal?.throwIfAborted();
    return validSnapshot(snapshot, id, identity) ? snapshot : undefined;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof MigrationReviewRequiredError) throw error;
    return undefined;
  }
}

function sameMetadata(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalMetadataValue(left)) === JSON.stringify(canonicalMetadataValue(right));
}

/** Captures only the freshly parsed target, never metadata inferred from the original work. */
export async function captureNovelMigrationTargetMetadata(
  novel: Pick<NovelDetailRecord, "pluginId" | "sourceNovelId" | "path" | "name" | "cover" | "author" | "artist" | "summary" | "status" | "genres" | "rating" | "isLocal">,
  signal?: AbortSignal,
): Promise<NovelMigrationTargetMetadata> {
  signal?.throwIfAborted();
  const stored = await readStoredNovelMetadata(novelStorageRelativeDir(novel));
  const identity = { pluginId: novel.pluginId, novelId: novel.sourceNovelId!, novelPath: novel.path };
  const fields = { name: novel.name, author: novel.author, artist: novel.artist, summary: novel.summary,
    status: novel.status, genres: novel.genres, rating: novel.rating, isLocal: novel.isLocal };
  if (!stored || !sameIdentity(stored.metadata.identity, identity) || !sameMetadata(stored.metadata.novel, fields)
    || Boolean(stored.metadata.cover) !== Boolean(novel.cover?.trim())) {
    throw new Error("The target metadata changed after its source refresh. No novels were merged.");
  }
  const body = stored.metadata.cover ? await readStoredNovelCover(stored.directory, stored.metadata) : null;
  signal?.throwIfAborted();
  if (stored.metadata.cover && !body?.length) throw new Error("The refreshed target cover is unavailable. No novels were merged.");
  const coverSha256 = body ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(body))), byte => byte.toString(16).padStart(2, "0")).join("") : null;
  signal?.throwIfAborted();
  return { novel: stored.metadata.novel, cover: stored.metadata.cover, coverSha256 };
}

function verifiedTargetMetadata(job: PendingNovelMigration): NovelMigrationTargetMetadata {
  const expected = job.targetMetadata;
  if (!expected || !Object.hasOwn(expected, "cover") || !Object.hasOwn(expected, "coverSha256")) {
    throw new MigrationReviewRequiredError("The latest target metadata was not captured before the merge. Review the target before completing its migration.");
  }
  try {
    const parsed = parseNovelMetadata({ schemaVersion: 1, identity: job.target, novel: expected.novel, cover: expected.cover, chapters: {} });
    if (parsed.novel.isLocal || !sameMetadata(parsed.novel, expected.novel) || !sameMetadata(parsed.cover, expected.cover)
      || (expected.cover === null ? expected.coverSha256 !== null : typeof expected.coverSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expected.coverSha256))) throw new Error();
  } catch {
    throw new MigrationReviewRequiredError("The captured target metadata proof is invalid. Its original server copy was retained.");
  }
  return expected;
}

/** Returns true only for the explicit absence of a cover in the captured source result. */
function targetCoverNeedsRemoval(job: PendingNovelMigration, target: WorkMigrationSnapshot): boolean {
  const expected = verifiedTargetMetadata(job);
  if (!target.work.metadata || !Object.hasOwn(target.work, "coverSha256")) {
    throw new MigrationReviewRequiredError("Update the content server to verify the migrated target metadata and cover.");
  }
  let metadata;
  try { metadata = parseNovelMetadata(target.work.metadata); }
  catch { throw new MigrationReviewRequiredError("The server target metadata proof is invalid."); }
  const digest = target.work.coverSha256;
  if (!sameIdentity(metadata.identity, job.target) || !sameMetadata(metadata.novel, expected.novel)) {
    throw new MigrationReviewRequiredError("The server target metadata does not match the latest source result. Its original server copy was retained.");
  }
  if (digest !== null && (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) {
    throw new MigrationReviewRequiredError("The server target cover proof is invalid.");
  }
  if (expected.cover === null) return metadata.cover !== null || digest !== null;
  if (!sameMetadata(metadata.cover, expected.cover) || digest !== expected.coverSha256) {
    throw new MigrationReviewRequiredError("The refreshed target cover is not stored on the server. Its original server copy was retained.");
  }
  return false;
}

function numberKey(value: string | null): string | null {
  return value !== null && /^\d+(?:\.\d+)?$/.test(value) ? String(Number(value)) : null;
}

function sourceMapping(
  chapter: WorkMigrationSnapshot["chapters"][number],
  mappings: readonly NovelMigrationChapter[],
): NovelMigrationChapter | undefined {
  const exact = mappings.filter(mapping => mapping.sourceChapterPath === chapter.chapterPath);
  if (exact.length === 1) return exact[0];
  if (exact.length || !chapter.chapterPath.startsWith("norea-folder:")) return undefined;
  const number = numberKey(chapter.chapterNumber);
  if (number === null) return undefined;
  const aliases = mappings.filter(mapping => numberKey(mapping.sourceChapterNumber) === number);
  return aliases.length === 1 ? aliases[0] : undefined;
}

function targetChapter(
  mapping: NovelMigrationChapter,
  chapters: WorkMigrationSnapshot["chapters"],
): WorkMigrationSnapshot["chapters"][number] | undefined {
  const exact = chapters.filter(chapter => chapter.chapterPath === mapping.targetChapterPath);
  if (exact.length === 1) return exact[0];
  if (exact.length) return undefined;
  const number = numberKey(mapping.targetChapterNumber);
  if (number === null) return undefined;
  const aliases = chapters.filter(chapter => chapter.chapterPath.startsWith("norea-folder:") && numberKey(chapter.chapterNumber) === number);
  return aliases.length === 1 ? aliases[0] : undefined;
}

export function buildFinalizeNovelMigrationRequest(
  job: PendingNovelMigration,
  source: WorkMigrationSnapshot,
  target: WorkMigrationSnapshot,
): FinalizeWorkMigrationRequest {
  const usedTargets = new Set<string>();
  const chapterDecisions = job.chapters.map(({ sourceChapterPath, sourceChapterNumber, targetChapterPath, targetChapterNumber }) => ({ sourceChapterPath, sourceChapterNumber, targetChapterPath, targetChapterNumber }));
  if (new Set(chapterDecisions.map(chapter => chapter.sourceChapterPath)).size !== chapterDecisions.length
    || chapterDecisions.some(chapter => !chapter.sourceChapterPath || (chapter.targetChapterPath === null ? chapter.targetChapterNumber !== null : !chapter.targetChapterPath))) {
    throw new MigrationReviewRequiredError("The complete migration decisions are invalid. The original server work was retained.");
  }
  const mappings: FinalizeWorkMigrationRequest["mappings"] = source.chapters.map(chapter => {
    const mapping = sourceMapping(chapter, job.chapters);
    if (mapping?.targetChapterPath === null && mapping.targetChapterNumber === null && mapping.decision === null) {
      return { sourceChapterId: chapter.id, decision: "delete-source" as const };
    }
    if (!mapping?.targetChapterPath || !mapping.decision) {
      throw new MigrationReviewRequiredError("The original server work contains chapters that were not transferred. Review the chapter mapping before removing it.");
    }
    const destination = targetChapter(mapping, target.chapters);
    if (!chapter.available || !destination?.available || !destination.complete) {
      throw new MigrationReviewRequiredError("A transferred chapter is not complete on the server. Its original copy was retained.");
    }
    if (usedTargets.has(destination.id)) {
      throw new MigrationReviewRequiredError("Multiple original chapters share one target. Their server copies require review.");
    }
    usedTargets.add(destination.id);
    if (mapping.decision === "keep-target" && !isChapterPayloadInventory(mapping.expectedTargetInventory)) {
      throw new MigrationReviewRequiredError("The retained target download has no verified inventory.");
    }
    return {
      sourceChapterId: chapter.id, targetChapterId: destination.id, targetRevision: destination.revision,
      decision: mapping.decision,
      ...(mapping.decision === "keep-target" ? { expectedTargetInventory: mapping.expectedTargetInventory } : {}),
    };
  });
  return {
    operationId: job.operationId,
    source: { revision: source.work.revision, chapters: source.chapters.map(({ id, revision }) => ({ id, revision })) },
    target: { id: target.work.id, revision: target.work.revision },
    chapterDecisions,
    mappings,
  };
}

async function copyMissingServerMigrationChapters(
  server: string, token: string, job: PendingNovelMigration,
  source: WorkMigrationSnapshot, initialTarget: WorkMigrationSnapshot,
  copyVersion: number | undefined, assertCurrent: () => void,
): Promise<WorkMigrationSnapshot> {
  let target = initialTarget;
  const performCopy = async (request: CopyWorkMigrationChapterRequest) => {
    if (copyVersion !== 1) throw new MigrationReviewRequiredError("Update the content server before copying a server-only migration chapter.");
    const original = source.chapters.find(chapter => chapter.id === request.source.chapter.id);
    const mapping = original && sourceMapping(original, job.chapters);
    if (!original?.available || !original.complete || request.source.revision !== source.work.revision
      || request.source.chapter.revision !== original.revision || request.target.id !== target.work.id
      || mapping?.decision !== "copy-source" || !mapping.targetChapter
      || !sameMetadata(request.target.chapter, {
        chapterPath: mapping.targetChapterPath, chapterNumber: mapping.targetChapterNumber, ...mapping.targetChapter,
      })) throw new MigrationReviewRequiredError("The prepared server copy no longer matches the approved chapter mapping.");
    assertCurrent();
    const copied = await contentServerRequest<{ entry: { id: string } }>(
      server, `/works/${source.work.id}/migration-copy`, token, "POST", request, undefined, 300,
    );
    assertCurrent();
    target = await contentServerRequest<WorkMigrationSnapshot>(server, `/works/${target.work.id}/migration-snapshot`, token);
    assertCurrent();
    if (!validSnapshot(target, initialTarget.work.id, job.target) || targetCoverNeedsRemoval(job, target)) {
      throw new MigrationReviewRequiredError("The target metadata changed while its server chapters were being copied.");
    }
    const destination = targetChapter(mapping, target.chapters);
    if (!destination?.available || !destination.complete || destination.id !== copied.entry?.id) {
      throw new Error("The server did not confirm the copied migration chapter.");
    }
    delete job.pendingCopyRequest;
    await saveNovelMigration(job);
  };
  // A lost response must replay its original conditional copy, never silently take a new revision.
  if (job.pendingCopyRequest) await performCopy(job.pendingCopyRequest);
  for (const chapter of source.chapters) {
    const mapping = sourceMapping(chapter, job.chapters);
    if (mapping?.decision !== "copy-source" || !mapping.targetChapterPath) continue;
    const destination = targetChapter(mapping, target.chapters);
    if (destination?.available) continue;
    if (!mapping.targetChapter || !mapping.targetChapter.name.trim()
      || !Number.isSafeInteger(mapping.targetChapter.position) || mapping.targetChapter.position < 1
      || !mapping.targetChapter.page?.trim()) {
      throw new MigrationReviewRequiredError("The target chapter catalog was not captured before the merge. Review the server-only copy.");
    }
    job.pendingCopyRequest = {
      decision: "copy-source", source: { revision: source.work.revision, chapter: { id: chapter.id, revision: chapter.revision } },
      target: {
        id: target.work.id, revision: target.work.revision,
        chapter: { chapterPath: mapping.targetChapterPath, chapterNumber: mapping.targetChapterNumber, ...mapping.targetChapter },
        expectedChapter: destination ? { id: destination.id, revision: destination.revision } : null,
      },
    };
    await saveNovelMigration(job);
    await performCopy(job.pendingCopyRequest);
  }
  return target;
}

function migrationErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/g, "$1[redacted]@")
    .replace(/\b(?:ghp_|github_pat_)[A-Za-z0-9_]+/g, "[redacted]")
    .slice(0, 1500);
}

/** Runs after ordinary B metadata and chapter uploads, on the existing sync lane. */
export async function finalizePendingNovelMigrations(
  server: string,
  token: string,
  assertCurrent: () => void = () => undefined,
  retryBlocked = true,
): Promise<boolean> {
  const jobs = await listNovelMigrations(server);
  if (!jobs.length) return false;
  const failures: string[] = [];
  let retryable = false;
  for (const job of jobs) {
    assertCurrent();
    if (!retryBlocked && job.status === "blocked") {
      failures.push(job.error ?? "The original server work requires migration review.");
      continue;
    }
    job.attempts += 1;
    job.updatedAt = Date.now();
    try {
      const sourceId = await contentWorkId(job.source);
      if (!job.sourceSnapshot || !validSnapshot(job.sourceSnapshot, sourceId, job.source)) {
        throw new MigrationReviewRequiredError("The source server snapshot was unavailable before the local merge. Review the original server work before completing its migration.");
      }
      if (!job.request) {
        verifiedTargetMetadata(job);
        const capabilities = await contentServerRequest<{ workMigrationVersion?: number; workCoverDeletionVersion?: number; workMigrationLineageVersion?: number; workMigrationCopyVersion?: number }>(server, "/capabilities", token);
        assertCurrent();
        if (capabilities.workMigrationVersion !== 1 || capabilities.workMigrationLineageVersion !== 1) {
          throw new MigrationReviewRequiredError("Update the content server before completing this migration.");
        }
        const source = await contentServerRequest<WorkMigrationSnapshot>(server, `/works/${sourceId}/migration-snapshot`, token);
        assertCurrent();
        const targetId = await contentWorkId(job.target);
        let target = await contentServerRequest<WorkMigrationSnapshot>(server, `/works/${targetId}/migration-snapshot`, token);
        assertCurrent();
        if (!validSnapshot(source, sourceId, job.source) || !validSnapshot(target, targetId, job.target)) {
          throw new MigrationReviewRequiredError("The server migration snapshot does not match the merged works.");
        }
        if (!sameSourceSnapshot(job.sourceSnapshot, source)) {
          throw new MigrationReviewRequiredError("The original server work changed after the merge was prepared. Its server copy was retained for review.");
        }
        if (targetCoverNeedsRemoval(job, target)) {
          if (capabilities.workCoverDeletionVersion !== 1) {
            throw new MigrationReviewRequiredError("Update the content server to clear the target cover selected by the latest source result.");
          }
          if (job.targetCoverDeletionRevision && job.targetCoverDeletionRevision !== target.work.revision) {
            throw new MigrationReviewRequiredError("The target changed after its cover removal was prepared. Review it before completing the migration.");
          }
          if (!job.targetCoverDeletionRevision) {
            job.targetCoverDeletionRevision = target.work.revision;
            await saveNovelMigration(job);
          }
          assertCurrent();
          const cleared = await contentServerRequest<WorkCatalogEntry>(server, `/works/${targetId}/cover`, token, "DELETE", { revision: job.targetCoverDeletionRevision });
          assertCurrent();
          if (cleared.id !== targetId || cleared.deleted || cleared.hasCover || cleared.metadata?.cover !== null
            || !sameIdentity(cleared.metadata.identity, job.target)) throw new Error("The server did not confirm the target cover removal.");
          target = await contentServerRequest<WorkMigrationSnapshot>(server, `/works/${targetId}/migration-snapshot`, token);
          assertCurrent();
          if (!validSnapshot(target, targetId, job.target) || targetCoverNeedsRemoval(job, target)) {
            throw new MigrationReviewRequiredError("The server target cover changed before migration completion.");
          }
        }
        target = await copyMissingServerMigrationChapters(server, token, job, source, target, capabilities.workMigrationCopyVersion, assertCurrent);
        job.request = buildFinalizeNovelMigrationRequest(job, job.sourceSnapshot, target);
        job.status = "pending";
        delete job.error;
        // The exact request survives an ambiguous response or a process restart.
        await saveNovelMigration(job);
      }
      assertCurrent();
      await runServerWorkDeletion(server, sourceId, async () => {
        const result = await contentServerRequest<{ operationId: string; deletedWork: WorkCatalogEntry }>(
          server, `/works/${sourceId}/finalize-migration`, token, "POST", job.request, undefined, 300,
        );
        assertCurrent();
        if (result.operationId !== job.operationId || result.deletedWork?.id !== sourceId || !result.deletedWork.deleted
          || !sameIdentity(result.deletedWork.metadata.identity, job.source)) {
          throw new Error("The server did not confirm the requested migration.");
        }
        await recordDeletedWorkMetadata(server, result.deletedWork);
        job.status = "completed";
        job.updatedAt = Date.now();
        delete job.error;
        await saveNovelMigration(job);
      });
    } catch (error) {
      assertCurrent();
      job.status = error instanceof MigrationReviewRequiredError || (error instanceof ContentServerError && error.status === 409) ? "blocked" : "failed";
      job.error = migrationErrorMessage(error);
      job.updatedAt = Date.now();
      await saveNovelMigration(job);
      failures.push(job.error);
      retryable ||= job.status === "failed";
      if (error instanceof ContentServerError && (error.status === 401 || error.status === 403)) throw error;
    }
  }
  if (failures.length) throw new PendingNovelMigrationError(failures.length, failures[0]!, retryable);
  return true;
}
