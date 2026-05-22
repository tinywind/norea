import {
  getChapterById,
  saveChapterContent,
  saveChapterPartialContent,
} from "../../db/queries/chapter";
import { getNovelById } from "../../db/queries/novel";
import { useBrowseStore } from "../../store/browse";
import {
  CHAPTER_BINARY_RESOURCE_MEDIA_TYPES,
  chapterContentToHtml,
  isBinaryChapterContentType,
  isHtmlLikeChapterContentType,
  normalizeChapterContentType,
  storedChapterContentType,
  type ChapterContentType,
} from "../chapter-content";
import {
  cacheHtmlChapterMedia,
  clearChapterMedia,
  getStoredChapterMediaBytes,
  hasRemoteChapterMedia,
  localChapterMediaSources,
  protectRemoteChapterMediaForPartialHtml,
  storeEmbeddedChapterMedia,
  type ChapterMediaElementPatch,
} from "../chapter-media";
import { mirrorStoredChapterContent } from "../chapter-content-storage";
import { convertEpubToHtml, mergeEpubHtmlSections } from "../epub-html";
import { getPluginBaseUrl } from "../plugins/base-url";
import { pluginManager } from "../plugins/manager";
import type { ChapterBinaryResource, Plugin } from "../plugins/types";
import { isTauriRuntime } from "../tauri-runtime";
import {
  sourceBaseDomainKey,
  TASK_PAUSE_ABORT_MESSAGE,
  taskScheduler,
  type TaskEvent,
  type TaskHandle,
  type TaskPriority,
  type TaskRecord,
} from "./scheduler";
import { MAX_SCHEDULER_MATERIALIZED_TASKS } from "../performance-budgets";
import { runBoundedTaskBatch } from "./batch-window";

export interface ChapterDownloadJob {
  id: number;
  batchId?: string;
  batchTitle?: string;
  pluginId: string;
  pluginName?: string;
  chapterPath: string;
  chapterName?: string;
  contentType?: ChapterContentType;
  novelId?: number;
  novelName?: string;
  novelPath?: string;
  priority?: TaskPriority;
  title: string;
}

export interface ChapterMediaRepairJob {
  id: number;
  pluginId: string;
  pluginName?: string;
  priority?: TaskPriority;
  title: string;
}

export type ChapterDownloadStatus =
  | { kind: "queued" }
  | { kind: "running" }
  | { kind: "done" }
  | { kind: "cancelled" }
  | { kind: "failed"; error: string };

export interface ChapterDownloadEvent {
  job: ChapterDownloadJob;
  status: ChapterDownloadStatus;
  task: TaskRecord;
}

export interface ChapterPartialContentEvent {
  chapterId: number;
  html: string;
}

export interface ChapterMediaPatchEvent {
  chapterId: number;
  patches: ChapterMediaElementPatch[];
}

export interface ChapterDownloadBatchResult {
  cancelled: number;
  failed: number;
  succeeded: number;
  total: number;
}

export interface ChapterDownloadBatchJob {
  jobs: Iterable<ChapterDownloadJob>;
  title: string;
  total?: number;
  windowSize?: number;
}

export interface ChapterDownloadBatchProgress {
  current: number;
  total: number;
}

interface ChapterDownloadBatchState extends ChapterDownloadBatchResult {
  settledChapterIds: Set<number>;
}

type ChapterDownloadBatchSettlement = "cancelled" | "failed" | "succeeded";

const chapterDownloadBatchStates = new Map<
  string,
  ChapterDownloadBatchState
>();
const chapterPartialContentListeners = new Set<
  (event: ChapterPartialContentEvent) => void
>();
const chapterMediaPatchListeners = new Set<
  (event: ChapterMediaPatchEvent) => void
>();
const CHAPTER_DOWNLOAD_QUEUE_STORAGE_KEY = "chapter-download-queue";
const CHAPTER_DOWNLOAD_QUEUE_STORAGE_VERSION = 1;
export const MAX_CHAPTER_DOWNLOAD_BATCH_WINDOW = Math.min(
  100,
  MAX_SCHEDULER_MATERIALIZED_TASKS,
);

let restorePersistedChapterDownloadsStarted = false;

interface PersistedChapterDownloadQueue {
  jobs: ChapterDownloadJob[];
  version: typeof CHAPTER_DOWNLOAD_QUEUE_STORAGE_VERSION;
}

function chapterDownloadDedupeKey(chapterId: number): string {
  return `chapter.download:${chapterId}`;
}

function chapterMediaRepairDedupeKey(chapterId: number): string {
  return `chapter.repairMedia:${chapterId}`;
}

function chapterDownloadCooldownKey(sourceKey: string): string {
  return `chapter.download:${sourceKey}`;
}

function chapterDownloadCooldownMs(): number {
  return useBrowseStore.getState().chapterDownloadCooldownSeconds * 1_000;
}

function absolutePluginUrl(plugin: Plugin, path: string): string | null {
  const candidates: string[] = [];
  if (plugin.resolveUrl) {
    try {
      candidates.push(plugin.resolveUrl(path, false));
    } catch {
      // Fall back to the opaque path and source base URL below.
    }
  }
  candidates.push(path);

  for (const candidate of candidates) {
    try {
      return new URL(candidate).href;
    } catch {
      try {
        return new URL(candidate, getPluginBaseUrl(plugin)).href;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function resourceBytes(bytes: unknown): Uint8Array {
  if (bytes instanceof Uint8Array) {
    return bytes;
  }
  if (bytes instanceof ArrayBuffer) {
    return new Uint8Array(bytes);
  }
  throw new Error("Chapter resource bytes must be an ArrayBuffer or Uint8Array.");
}

function validateChapterResource(
  resource: unknown,
  contentType: "pdf" | "epub",
): Uint8Array {
  if (!resource || typeof resource !== "object") {
    throw new Error("Chapter resource must be a binary resource.");
  }
  const candidate = resource as Partial<ChapterBinaryResource>;
  if (candidate.type !== "binary") {
    throw new Error("Chapter resource must be a binary resource.");
  }
  if (candidate.contentType !== contentType) {
    throw new Error(
      `Chapter resource contentType "${candidate.contentType}" does not match "${contentType}".`,
    );
  }
  const expectedMediaType = CHAPTER_BINARY_RESOURCE_MEDIA_TYPES[contentType];
  if (candidate.mediaType !== expectedMediaType) {
    throw new Error(
      `Chapter resource mediaType "${candidate.mediaType}" does not match "${expectedMediaType}".`,
    );
  }
  const bytes = resourceBytes(candidate.bytes);
  if (bytes.byteLength <= 0) {
    throw new Error("Chapter resource bytes are empty.");
  }
  if (
    candidate.byteLength !== undefined &&
    candidate.byteLength !== bytes.byteLength
  ) {
    throw new Error("Chapter resource byteLength does not match bytes.");
  }
  return bytes;
}

async function loadChapterResource(
  plugin: Plugin,
  chapterPath: string,
  contentType: "pdf" | "epub",
): Promise<Uint8Array> {
  if (!plugin.parseChapterResource) {
    throw new Error(
      `Plugin must implement parseChapterResource() for ${contentType} chapters.`,
    );
  }
  return validateChapterResource(
    await plugin.parseChapterResource(chapterPath),
    contentType,
  );
}

function makeChapterDownloadBatchId(): string {
  return `chapter-download-batch-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 9)}`;
}

function normalizeChapterDownloadBatchTotal(
  jobs: Iterable<ChapterDownloadJob>,
  total: number | undefined,
): number {
  if (total !== undefined) {
    if (!Number.isFinite(total) || total < 0) {
      throw new Error("Chapter download batch total must be a finite count.");
    }
    return Math.floor(total);
  }
  if (Array.isArray(jobs)) return jobs.length;
  throw new Error(
    "Chapter download batch total is required for non-array job iterables.",
  );
}

function normalizeChapterDownloadBatchWindowSize(
  windowSize: number | undefined,
): number {
  if (windowSize === undefined) return MAX_CHAPTER_DOWNLOAD_BATCH_WINDOW;
  if (!Number.isFinite(windowSize)) return MAX_CHAPTER_DOWNLOAD_BATCH_WINDOW;
  return Math.max(
    1,
    Math.min(MAX_CHAPTER_DOWNLOAD_BATCH_WINDOW, Math.floor(windowSize)),
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isPauseAbort(signal: AbortSignal): boolean {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  return (
    reason instanceof DOMException &&
    reason.name === "AbortError" &&
    reason.message === TASK_PAUSE_ABORT_MESSAGE
  );
}

function missingLocalChapterError(job: ChapterDownloadJob): Error {
  return new Error(
    `chapter-download: local chapter ${job.id} was not found for "${job.title}" from plugin "${job.pluginId}" at path "${job.chapterPath}".`,
  );
}

function missingRepairChapterError(job: ChapterMediaRepairJob): Error {
  return new Error(
    `chapter-media-repair: local chapter ${job.id} was not found for "${job.title}" from plugin "${job.pluginId}".`,
  );
}

function readStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readPositiveIntegerField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    return undefined;
  }
  return value;
}

function normalizePersistedChapterDownloadJob(
  value: unknown,
): ChapterDownloadJob | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = readPositiveIntegerField(record, "id");
  const pluginId = readStringField(record, "pluginId");
  const chapterPath = readStringField(record, "chapterPath");
  const title =
    readStringField(record, "title") ??
    readStringField(record, "chapterName");
  if (!id || !pluginId || !chapterPath || !title) return null;

  return {
    id,
    pluginId,
    pluginName: readStringField(record, "pluginName"),
    chapterPath,
    chapterName: readStringField(record, "chapterName"),
    contentType: normalizeChapterContentType(
      readStringField(record, "contentType"),
    ),
    novelId: readPositiveIntegerField(record, "novelId"),
    novelName: readStringField(record, "novelName"),
    novelPath: readStringField(record, "novelPath"),
    priority: "background",
    title,
  };
}

function readPersistedChapterDownloadJobs(): ChapterDownloadJob[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CHAPTER_DOWNLOAD_QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return [];
    const queue = parsed as Partial<PersistedChapterDownloadQueue>;
    if (
      queue.version !== CHAPTER_DOWNLOAD_QUEUE_STORAGE_VERSION ||
      !Array.isArray(queue.jobs)
    ) {
      return [];
    }
    const jobsById = new Map<number, ChapterDownloadJob>();
    for (const item of queue.jobs) {
      const job = normalizePersistedChapterDownloadJob(item);
      if (job) jobsById.set(job.id, job);
    }
    return [...jobsById.values()];
  } catch (error) {
    console.warn("[chapter-download] failed to read persisted queue:", error);
    return [];
  }
}

function writePersistedChapterDownloadJobs(jobs: ChapterDownloadJob[]): void {
  if (typeof window === "undefined") return;
  try {
    if (jobs.length === 0) {
      window.localStorage.removeItem(CHAPTER_DOWNLOAD_QUEUE_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      CHAPTER_DOWNLOAD_QUEUE_STORAGE_KEY,
      JSON.stringify({
        jobs,
        version: CHAPTER_DOWNLOAD_QUEUE_STORAGE_VERSION,
      } satisfies PersistedChapterDownloadQueue),
    );
  } catch (error) {
    console.warn("[chapter-download] failed to persist queue:", error);
  }
}

function persistChapterDownloadJob(job: ChapterDownloadJob): void {
  const persisted = normalizePersistedChapterDownloadJob(job);
  if (!persisted) return;
  const jobsById = new Map<number, ChapterDownloadJob>();
  for (const existing of readPersistedChapterDownloadJobs()) {
    jobsById.set(existing.id, existing);
  }
  jobsById.set(persisted.id, persisted);
  writePersistedChapterDownloadJobs([...jobsById.values()]);
}

function removePersistedChapterDownloadJob(chapterId: number): void {
  writePersistedChapterDownloadJobs(
    readPersistedChapterDownloadJobs().filter((job) => job.id !== chapterId),
  );
}

function settleChapterDownloadBatchJob(
  batchId: string | undefined,
  chapterId: number,
  settlement: ChapterDownloadBatchSettlement,
): void {
  if (!batchId) return;
  const state = chapterDownloadBatchStates.get(batchId);
  if (!state || state.settledChapterIds.has(chapterId)) return;

  state.settledChapterIds.add(chapterId);
  state[settlement] += 1;
}

export function getActiveChapterDownloadBatchProgress():
  | ChapterDownloadBatchProgress
  | undefined {
  const activeBatches = [...chapterDownloadBatchStates.values()];
  if (activeBatches.length === 0) return undefined;

  return activeBatches.reduce<ChapterDownloadBatchProgress>(
    (sum, batch) => ({
      current: sum.current + batch.settledChapterIds.size,
      total: sum.total + batch.total,
    }),
    { current: 0, total: 0 },
  );
}

function emitChapterPartialContentUpdate(event: ChapterPartialContentEvent): void {
  for (const listener of chapterPartialContentListeners) {
    listener(event);
  }
}

function emitChapterMediaPatchUpdate(event: ChapterMediaPatchEvent): void {
  for (const listener of chapterMediaPatchListeners) {
    listener(event);
  }
}

function statusFromTask(task: TaskRecord): ChapterDownloadStatus | null {
  switch (task.status) {
    case "queued":
      return { kind: "queued" };
    case "running":
      return { kind: "running" };
    case "succeeded":
      return { kind: "done" };
    case "cancelled":
      return { kind: "cancelled" };
    case "failed":
      return { kind: "failed", error: task.error ?? task.title };
  }
}

function eventFromTask(task: TaskRecord): ChapterDownloadEvent | null {
  if (task.kind !== "chapter.download") return null;
  const chapterId = task.subject?.chapterId;
  const pluginId = task.subject?.pluginId ?? task.source?.id;
  const chapterPath = task.subject?.path;
  if (!chapterId || !pluginId || !chapterPath) return null;
  const status = statusFromTask(task);
  if (!status) return null;
  return {
    status,
    task,
    job: {
      id: chapterId,
      batchId: task.subject?.batchId,
      batchTitle: task.subject?.batchTitle,
      pluginId,
      pluginName: task.source?.name,
      chapterPath,
      chapterName: task.subject?.chapterName,
      contentType: normalizeChapterContentType(task.subject?.contentType),
      novelId: task.subject?.novelId,
      novelName: task.subject?.novelName,
      novelPath: task.subject?.novelPath,
      title: task.title,
    },
  };
}

export function enqueueChapterDownload(
  job: ChapterDownloadJob,
): TaskHandle<void> {
  const sourceName = job.pluginName ?? job.pluginId;
  const sourcePlugin = pluginManager.getPlugin(job.pluginId);
  const sourceBaseUrl = sourcePlugin ? getPluginBaseUrl(sourcePlugin) : undefined;
  const sourceCooldownKey = sourceBaseDomainKey(sourceBaseUrl) ?? job.pluginId;
  persistChapterDownloadJob(job);
  const handle = taskScheduler.enqueueSource<void>({
    kind: "chapter.download",
    priority: job.priority ?? "background",
    title: job.title,
    source: { id: job.pluginId, name: sourceName },
    subject: {
      chapterId: job.id,
      chapterName: job.chapterName,
      contentType: job.contentType,
      novelId: job.novelId,
      novelName: job.novelName,
      novelPath: job.novelPath,
      path: job.chapterPath,
      pluginId: job.pluginId,
      batchId: job.batchId,
      batchTitle: job.batchTitle,
    },
    dedupeKey: chapterDownloadDedupeKey(job.id),
    sourceCooldownKey: chapterDownloadCooldownKey(sourceCooldownKey),
    sourceCooldownMs: chapterDownloadCooldownMs(),
    run: async ({ executor, setDetail, setProgress, signal }) => {
      let progressTotal = 1;
      setProgress({ current: 0, total: progressTotal });
      try {
        if (isTauriRuntime()) {
          await pluginManager.loadInstalledFromDb();
        }
        const plugin = pluginManager.getPluginForExecutor(
          job.pluginId,
          executor ?? "immediate",
        );
        const chapter = await getChapterById(job.id);
        if (!chapter) {
          throw missingLocalChapterError(job);
        }
        const novel =
          job.novelPath && job.novelName && job.novelId
            ? {
                id: job.novelId,
                name: job.novelName,
                path: job.novelPath,
                pluginId: job.pluginId,
              }
            : job.novelId
              ? await getNovelById(job.novelId)
              : null;
        const contentType = normalizeChapterContentType(
          job.contentType ?? chapter.contentType,
        );
        const savedContentType = storedChapterContentType(contentType);
        const storageContext = {
          chapterId: job.id,
          chapterName: chapter.name,
          chapterNumber: chapter.chapterNumber,
          chapterPosition: chapter.position,
          novelId: novel?.id ?? chapter.novelId,
          novelName: novel?.name ?? job.novelName,
          novelPath: novel?.path ?? job.novelPath,
          sourceId: job.pluginId,
        };
        const emitPartialHtml = async (partialHtml: string): Promise<void> => {
          const partialSaveResult = await saveChapterPartialContent(
            job.id,
            partialHtml,
            savedContentType,
          );
          if (partialSaveResult.rowsAffected <= 0) {
            throw missingLocalChapterError(job);
          }
          emitChapterPartialContentUpdate({
            chapterId: job.id,
            html: partialHtml,
          });
        };
        if (isBinaryChapterContentType(contentType)) {
          const bytes = await loadChapterResource(
            plugin,
            job.chapterPath,
            contentType,
          );
          if (signal.aborted) {
            throw new DOMException("Task was cancelled.", "AbortError");
          }
          if (contentType === "pdf") {
            const dataUrl = `data:${CHAPTER_BINARY_RESOURCE_MEDIA_TYPES.pdf};base64,${bytesToBase64(bytes)}`;
            const saveResult = await saveChapterContent(
              job.id,
              dataUrl,
              contentType,
              { mediaBytes: 0 },
            );
            if (saveResult.rowsAffected <= 0) {
              throw missingLocalChapterError(job);
            }
            await mirrorStoredChapterContent(job.id);
            await clearChapterMedia(job.id, storageContext);
            settleChapterDownloadBatchJob(job.batchId, job.id, "succeeded");
            setProgress({ current: progressTotal, total: progressTotal });
            return;
          }

          const epub = await convertEpubToHtml(bytes, {
            fallbackTitle: chapter.name,
          });
          const html = mergeEpubHtmlSections(epub.sections, {
            ...(epub.direction ? { direction: epub.direction } : {}),
            ...(epub.language ? { language: epub.language } : {}),
          });
          const embedded = await storeEmbeddedChapterMedia({
            ...storageContext,
            html,
            resources: epub.sections.flatMap((section) =>
              section.resources.map((resource) => ({
                bytes: resource.bytes,
                contentType: resource.mediaType,
                fileName: resource.fileName,
                placeholder: resource.placeholder,
                sourcePath: resource.sourcePath,
              })),
            ),
          });
          const saveResult = await saveChapterContent(
            job.id,
            embedded.html,
            contentType,
            {
              mediaBytes: embedded.mediaBytes,
            },
          );
          if (saveResult.rowsAffected <= 0) {
            throw missingLocalChapterError(job);
          }
          await mirrorStoredChapterContent(job.id);
          if (embedded.storedMediaCount === 0) {
            await clearChapterMedia(job.id, storageContext);
          }
          settleChapterDownloadBatchJob(job.batchId, job.id, "succeeded");
          setProgress({ current: progressTotal, total: progressTotal });
          return;
        }
        const rawContent = await plugin.parseChapter(job.chapterPath);
        if (signal.aborted) {
          throw new DOMException("Task was cancelled.", "AbortError");
        }
        if (rawContent.trim() === "") {
          throw new Error("Downloaded chapter content is empty.");
        }
        let html = chapterContentToHtml(rawContent, contentType);
        let mediaBytes = 0;
        let shouldClearMedia = true;
        if (isHtmlLikeChapterContentType(savedContentType)) {
          const baseUrl = absolutePluginUrl(plugin, job.chapterPath);
          if (hasRemoteChapterMedia(html, baseUrl)) {
            shouldClearMedia = false;
            await emitPartialHtml(
              protectRemoteChapterMediaForPartialHtml(html, baseUrl),
            );
            const media = await cacheHtmlChapterMedia({
              ...(baseUrl ? { baseUrl, contextUrl: baseUrl } : {}),
              chapterId: job.id,
              chapterName: chapter.name,
              chapterNumber: chapter.chapterNumber ?? String(chapter.position),
              chapterPosition: chapter.position,
              html,
              novelId: chapter.novelId,
              novelName: novel?.name ?? job.novelName,
              novelPath: novel?.path ?? job.novelPath,
              onHtmlUpdate: (partialHtml) =>
                emitPartialHtml(
                  protectRemoteChapterMediaForPartialHtml(partialHtml, baseUrl),
                ),
              onMediaPatch: (patches) => {
                emitChapterMediaPatchUpdate({
                  chapterId: job.id,
                  patches,
                });
              },
              onProgress: ({ current, total }) => {
                progressTotal = total + 1;
                setProgress({ current, total: progressTotal });
              },
              previousHtml: chapter.content,
              requestInit: plugin.imageRequestInit,
              repair: false,
              scraperExecutor: executor ?? "immediate",
              signal,
              sourceId: job.pluginId,
            });
            html = media.html;
            mediaBytes = media.mediaBytes;
            if (media.mediaFailures.length > 0) {
              setDetail(
                `${media.mediaFailures.length} media assets using remote fallback`,
              );
            } else if (media.archiveFailure) {
              setDetail("Media archive failed; using extracted media files");
            }
          }
        }
        const saveResult = await saveChapterContent(
          job.id,
          html,
          savedContentType,
          {
            mediaBytes,
          },
        );
        if (saveResult.rowsAffected <= 0) {
          throw missingLocalChapterError(job);
        }
        await mirrorStoredChapterContent(job.id);
        if (shouldClearMedia) {
          await clearChapterMedia(job.id, {
            chapterId: job.id,
            chapterName: chapter.name,
            chapterNumber: chapter.chapterNumber,
            chapterPosition: chapter.position,
            novelId: novel?.id ?? chapter.novelId,
            novelName: novel?.name ?? job.novelName,
            novelPath: novel?.path ?? job.novelPath,
            sourceId: job.pluginId,
          });
        }
        settleChapterDownloadBatchJob(job.batchId, job.id, "succeeded");
        setProgress({ current: progressTotal, total: progressTotal });
      } catch (error) {
        if (!isPauseAbort(signal)) {
          settleChapterDownloadBatchJob(
            job.batchId,
            job.id,
            signal.aborted || isAbortError(error) ? "cancelled" : "failed",
          );
        }
        throw error;
      }
    },
  });
  void handle.promise.then(
    () => removePersistedChapterDownloadJob(job.id),
    () => removePersistedChapterDownloadJob(job.id),
  );
  return handle;
}

export function enqueueChapterMediaRepair(
  job: ChapterMediaRepairJob,
): TaskHandle<void> {
  const sourceName = job.pluginName ?? job.pluginId;
  const sourcePlugin = pluginManager.getPlugin(job.pluginId);
  const sourceBaseUrl = sourcePlugin ? getPluginBaseUrl(sourcePlugin) : undefined;
  const sourceCooldownKey = sourceBaseDomainKey(sourceBaseUrl) ?? job.pluginId;
  return taskScheduler.enqueueSource<void>({
    kind: "chapter.repairMedia",
    priority: job.priority ?? "user",
    title: job.title,
    source: { id: job.pluginId, name: sourceName },
    subject: {
      chapterId: job.id,
      pluginId: job.pluginId,
    },
    dedupeKey: chapterMediaRepairDedupeKey(job.id),
    sourceCooldownKey: chapterDownloadCooldownKey(sourceCooldownKey),
    sourceCooldownMs: chapterDownloadCooldownMs(),
    run: async ({ executor, setDetail, setProgress, signal }) => {
      let progressTotal = 1;
      setProgress({ current: 0, total: progressTotal });
      if (isTauriRuntime()) {
        await pluginManager.loadInstalledFromDb();
      }
      const plugin = pluginManager.getPluginForExecutor(
        job.pluginId,
        executor ?? "immediate",
      );
      const chapter = await getChapterById(job.id);
      if (!chapter) {
        throw missingRepairChapterError(job);
      }
      const contentType = normalizeChapterContentType(chapter.contentType);
      if (
        !chapter.isDownloaded ||
        !isHtmlLikeChapterContentType(contentType) ||
        !chapter.content
      ) {
        setDetail("No downloaded media to repair");
        setProgress({ current: progressTotal, total: progressTotal });
        return;
      }
      const baseUrl = absolutePluginUrl(plugin, chapter.path);
      if (!baseUrl) {
        throw new Error(
          `chapter-media-repair: failed to resolve chapter URL for "${chapter.name}".`,
        );
      }
      if (
        !hasRemoteChapterMedia(chapter.content, baseUrl) &&
        localChapterMediaSources(chapter.content).length === 0
      ) {
        setDetail("No remote media to repair");
        setProgress({ current: progressTotal, total: progressTotal });
        return;
      }
      const novel = await getNovelById(chapter.novelId);
      const storageContext = {
        chapterId: chapter.id,
        chapterName: chapter.name,
        chapterNumber: chapter.chapterNumber,
        chapterPosition: chapter.position,
        novelId: novel?.id ?? chapter.novelId,
        novelName: novel?.name,
        novelPath: novel?.path,
        sourceId: job.pluginId,
      };
      const media = await cacheHtmlChapterMedia({
        baseUrl,
        chapterId: chapter.id,
        chapterName: chapter.name,
        chapterNumber: chapter.chapterNumber ?? String(chapter.position),
        chapterPosition: chapter.position,
        contextUrl: baseUrl,
        html: chapter.content,
        novelId: storageContext.novelId,
        novelName: storageContext.novelName,
        novelPath: storageContext.novelPath,
        onHtmlUpdate: async (partialHtml) => {
          const protectedPartialHtml = protectRemoteChapterMediaForPartialHtml(
            partialHtml,
            baseUrl,
          );
          const partialSaveResult = await saveChapterPartialContent(
            chapter.id,
            protectedPartialHtml,
            contentType,
          );
          if (partialSaveResult.rowsAffected <= 0) {
            throw missingRepairChapterError(job);
          }
          emitChapterPartialContentUpdate({
            chapterId: chapter.id,
            html: protectedPartialHtml,
          });
        },
        onMediaPatch: (patches) => {
          emitChapterMediaPatchUpdate({
            chapterId: chapter.id,
            patches,
          });
        },
        onProgress: ({ current, total }) => {
          progressTotal = total + 1;
          setProgress({ current, total: progressTotal });
        },
        previousHtml: chapter.content,
        requestInit: plugin.imageRequestInit,
        repair: true,
        scraperExecutor: executor ?? "immediate",
        signal,
        sourceId: job.pluginId,
      });
      const mediaBytes = await getStoredChapterMediaBytes(
        media.html,
        storageContext,
      );
      const saveResult = await saveChapterContent(
        chapter.id,
        media.html,
        contentType,
        {
          mediaBytes,
        },
      );
      if (saveResult.rowsAffected <= 0) {
        throw missingRepairChapterError(job);
      }
      await mirrorStoredChapterContent(chapter.id);
      if (media.mediaFailures.length > 0) {
        setDetail(
          `${media.mediaFailures.length} media assets using remote fallback`,
        );
      } else if (media.archiveFailure) {
        setDetail("Media archive failed; using extracted media files");
      } else {
        setDetail(`${media.storedMediaCount} media assets repaired`);
      }
      setProgress({ current: progressTotal, total: progressTotal });
    },
  });
}

export function enqueueChapterDownloadBatch({
  jobs,
  title,
  total: requestedTotal,
  windowSize: requestedWindowSize,
}: ChapterDownloadBatchJob): TaskHandle<ChapterDownloadBatchResult> {
  const batchId = makeChapterDownloadBatchId();
  const total = normalizeChapterDownloadBatchTotal(jobs, requestedTotal);
  const windowSize = normalizeChapterDownloadBatchWindowSize(
    requestedWindowSize,
  );
  chapterDownloadBatchStates.set(batchId, {
    cancelled: 0,
    failed: 0,
    settledChapterIds: new Set(),
    succeeded: 0,
    total,
  });

  const promise = runBoundedTaskBatch({
    items: jobs,
    windowSize,
    materialize: async (job) => {
      try {
        const handle = enqueueChapterDownload({
          ...job,
          batchId,
          batchTitle: title,
        });
        await handle.promise;
        settleChapterDownloadBatchJob(batchId, job.id, "succeeded");
      } catch (error) {
        settleChapterDownloadBatchJob(
          batchId,
          job.id,
          isAbortError(error) ? "cancelled" : "failed",
        );
      }
    },
  })
    .then(() => {
      const state = chapterDownloadBatchStates.get(batchId);
      const result = state
        ? {
            cancelled: state.cancelled,
            failed: state.failed,
            succeeded: state.succeeded,
            total: state.total,
          }
        : { cancelled: 0, failed: 0, succeeded: 0, total };
      if (result.failed > 0) {
        throw new Error(`${result.failed} chapter downloads failed.`);
      }
      return result;
    })
    .finally(() => {
      chapterDownloadBatchStates.delete(batchId);
    });

  return { id: batchId, promise };
}

export function getChapterDownloadStatus(
  chapterId: number,
): ChapterDownloadStatus | undefined {
  const task = taskScheduler.getTaskByDedupeKey(
    chapterDownloadDedupeKey(chapterId),
  );
  return task ? (statusFromTask(task) ?? undefined) : undefined;
}

export function getChapterMediaRepairStatus(
  chapterId: number,
): ChapterDownloadStatus | undefined {
  const task = taskScheduler.getTaskByDedupeKey(
    chapterMediaRepairDedupeKey(chapterId),
  );
  return task ? (statusFromTask(task) ?? undefined) : undefined;
}

export function listChapterDownloadStatuses(): ReadonlyMap<
  number,
  ChapterDownloadStatus
> {
  const statuses = new Map<number, ChapterDownloadStatus>();

  for (const task of taskScheduler.getSnapshot().records) {
    const event = eventFromTask(task);
    if (event) statuses.set(event.job.id, event.status);
  }

  return statuses;
}

export function subscribeChapterDownloads(
  listener: (event: ChapterDownloadEvent) => void,
): () => void {
  return taskScheduler.subscribeEvents((event: TaskEvent) => {
    const chapterEvent = eventFromTask(event.task);
    if (chapterEvent) listener(chapterEvent);
  });
}

export function subscribeChapterPartialContentUpdates(
  listener: (event: ChapterPartialContentEvent) => void,
): () => void {
  chapterPartialContentListeners.add(listener);
  return () => {
    chapterPartialContentListeners.delete(listener);
  };
}

export function subscribeChapterMediaPatches(
  listener: (event: ChapterMediaPatchEvent) => void,
): () => void {
  chapterMediaPatchListeners.add(listener);
  return () => {
    chapterMediaPatchListeners.delete(listener);
  };
}

export async function restorePersistedChapterDownloads(): Promise<void> {
  if (restorePersistedChapterDownloadsStarted || !isTauriRuntime()) return;
  restorePersistedChapterDownloadsStarted = true;

  const jobs = readPersistedChapterDownloadJobs();
  if (jobs.length === 0) return;

  const pendingJobs: ChapterDownloadJob[] = [];
  for (const job of jobs) {
    try {
      const chapter = await getChapterById(job.id);
      if (!chapter?.isDownloaded) pendingJobs.push(job);
    } catch (error) {
      console.warn(
        "[chapter-download] failed to inspect persisted chapter:",
        error,
      );
      pendingJobs.push(job);
    }
  }
  writePersistedChapterDownloadJobs(pendingJobs);
  if (pendingJobs.length === 0) return;

  try {
    await pluginManager.loadInstalledFromDb();
  } catch (error) {
    console.warn(
      "[chapter-download] failed to load plugins for restore:",
      error,
    );
    return;
  }

  for (const job of pendingJobs) {
    enqueueChapterDownload({ ...job, priority: "background" });
  }
}
