import { listNovelMigrations, saveNovelMigration } from "../../db/queries/content-sync";
import { isChapterPayloadInventory } from "../chapter-content/inventory";
import { useContentSyncStore } from "../../store/content-sync";
import { registerContentDevice } from "./device";
import { ContentServerError, contentServerRequest } from "./client";
import { runServerWorkDeletion } from "./deletion-exclusions";
import { contentWorkId, recordDeletedWorkMetadata, type WorkCatalogEntry } from "./works";
import type {
  FinalizeWorkMigrationRequest, MigrationWorkIdentity, NovelMigrationChapter,
  PendingNovelMigration, WorkMigrationSnapshot,
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

/** Unavailable server proof never prevents a local merge or authorizes later remote cleanup. */
export async function captureNovelMigrationSourceSnapshot(
  server: string,
  identity: MigrationWorkIdentity,
  signal?: AbortSignal,
): Promise<WorkMigrationSnapshot | undefined> {
  signal?.throwIfAborted();
  try {
    const token = await registerContentDevice(server, useContentSyncStore.getState().deviceName, signal);
    const id = await contentWorkId(identity);
    const snapshot = await contentServerRequest<WorkMigrationSnapshot>(
      server, `/works/${id}/migration-snapshot`, token, "GET", undefined, signal,
    );
    signal?.throwIfAborted();
    return validSnapshot(snapshot, id, identity) ? snapshot : undefined;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
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
  const mappings = source.chapters.map(chapter => {
    const mapping = sourceMapping(chapter, job.chapters);
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
    mappings,
  };
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
        const capabilities = await contentServerRequest<{ workMigrationVersion?: number }>(server, "/capabilities", token);
        assertCurrent();
        if (capabilities.workMigrationVersion !== 1) {
          throw new MigrationReviewRequiredError("Update the content server before completing this migration.");
        }
        const source = await contentServerRequest<WorkMigrationSnapshot>(server, `/works/${sourceId}/migration-snapshot`, token);
        assertCurrent();
        const targetId = await contentWorkId(job.target);
        const target = await contentServerRequest<WorkMigrationSnapshot>(server, `/works/${targetId}/migration-snapshot`, token);
        assertCurrent();
        if (!validSnapshot(source, sourceId, job.source) || !validSnapshot(target, targetId, job.target)) {
          throw new MigrationReviewRequiredError("The server migration snapshot does not match the merged works.");
        }
        if (!sameSourceSnapshot(job.sourceSnapshot, source)) {
          throw new MigrationReviewRequiredError("The original server work changed after the merge was prepared. Its server copy was retained for review.");
        }
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
