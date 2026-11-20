import { invoke } from "@tauri-apps/api/core";
import { runWorkContentStorageOperation } from "./storage-operation";
import { ContentServerError } from "./client";
import { ChapterStorageError } from "../chapter-storage-error";

export interface ContentIdentity {
  pluginId: string;
  novelPath: string;
  chapterPath: string;
}

export type UploadConflictPolicy = "prefer-complete" | "keep-server" | "replace-server";

export interface PackageManifest {
  packageVersion: 1;
  layout: "chapter-files";
  identity: ContentIdentity & { novelId: string };
  novel: { name: string; author?: string | null; summary?: string | null; isLocal: boolean };
  chapter: { name: string; position: number; chapterNumber?: string | null; contentType: "html" | "text" | "markdown" | "pdf" | "epub"; page: string };
  bodyPath: string;
  files: { path: string; size: number; modifiedAt: number }[];
}

export interface CatalogEntry {
  id: string;
  revision: string;
  fileBytes: number;
  complete: boolean;
  manifest: PackageManifest;
  deleted: boolean;
  sequence: number;
}

// An empty ZIP End-of-Central-Directory record is 22 bytes; any archive containing entries is larger.
export const EMPTY_ZIP_ARCHIVE_BYTES = 22;

export function hasUsableServerMediaArchive(entry: Pick<CatalogEntry, "manifest">): boolean {
  return Boolean(
    entry.manifest.files?.some(
      (file) => file.path === "media.zip" && file.size > EMPTY_ZIP_ARCHIVE_BYTES,
    ),
  );
}

export function hasServerMediaManifestWithoutArchive(entry: Pick<CatalogEntry, "manifest">): boolean {
  return Boolean(
    entry.manifest.files?.some((file) => file.path === "manifest.json") &&
      !hasUsableServerMediaArchive(entry),
  );
}

const pendingStageTransfers = new Map<string, Promise<unknown>>();

export async function withContentChapterStage<T>(input: { storageDir: string; identity: Pick<ContentIdentity, "pluginId" | "novelPath">; signal?: AbortSignal; verifySource?: () => Promise<void> }, run: (stagePath: string) => Promise<T>): Promise<T> {
  input.signal?.throwIfAborted();
  const stagePath = await invoke<string>("content_sync_create_stage");
  const removeStage = () => invoke("content_sync_remove_stage", { stagePath });
  try {
    input.signal?.throwIfAborted();
    await runWorkContentStorageOperation(input.identity.pluginId, input.identity.novelPath, async () => {
      input.signal?.throwIfAborted();
      await input.verifySource?.();
      return invoke("content_sync_snapshot", { storageDir: input.storageDir, stagePath });
    });
    input.signal?.throwIfAborted();
    return await run(stagePath);
  } finally {
    const inFlight = pendingStageTransfers.get(stagePath);
    if (inFlight) {
      // Native HTTP may still be reading the snapshot; remove the stage once it settles.
      void inFlight.then(removeStage, removeStage).catch((error) => {
        // eslint-disable-next-line no-console
        console.warn("[content-sync] cancelled upload cleanup failed", error);
      });
    } else {
      await removeStage();
    }
  }
}

export function fingerprintContentChapter(input: { storageDir: string; stagePath: string }): Promise<string> {
  return invoke<string>("content_sync_fingerprint", input);
}

export async function uploadContentChapter(input: {
  serverUrl: string;
  token: string;
  chapterId: number;
  conflictPolicy: UploadConflictPolicy;
  manifest: Omit<PackageManifest, "layout" | "files" | "bodyPath">;
  storageDir: string;
  stagePath: string;
  signal?: AbortSignal;
}): Promise<CatalogEntry> {
  if (input.manifest.identity.pluginId === "local" || input.manifest.novel.isLocal) {
    throw new Error("Local files cannot be uploaded to the content server.");
  }
  let onAbort: (() => void) | undefined;
  try {
    input.signal?.throwIfAborted();
    const interrupted = input.signal ? new Promise<never>((_, reject) => {
      onAbort = () => reject(input.signal!.reason);
      input.signal!.addEventListener("abort", onAbort, { once: true });
    }) : undefined;
    const transfer = invoke<CatalogEntry>("content_sync_upload", {
      serverUrl: input.serverUrl, token: input.token, manifest: input.manifest,
      conflictPolicy: input.conflictPolicy,
      storageDir: input.storageDir, stagePath: input.stagePath,
    }).catch(async (error: unknown) => {
      const rejected = /^content sync: server returned (\d{3}): ([\s\S]*)$/.exec(String(error));
      if (!rejected) throw error;
      const status = Number(rejected[1]);
      if (status === 401) {
        const { forgetContentDeviceRegistration } = await import("./device");
        forgetContentDeviceRegistration(input.serverUrl, input.token);
      }
      throw new ContentServerError(status, rejected[2]);
    });
    const tracked = transfer.finally(() => {
      if (pendingStageTransfers.get(input.stagePath) === tracked) {
        pendingStageTransfers.delete(input.stagePath);
      }
    });
    pendingStageTransfers.set(input.stagePath, tracked);
    if (interrupted) void tracked.catch(() => undefined);
    return await (interrupted ? Promise.race([tracked, interrupted]) : tracked);
  } finally {
    if (onAbort) input.signal?.removeEventListener("abort", onAbort);
  }
}

function nativeChapterStorageError(error: unknown): ChapterStorageError | null {
  const failure = /^chapter-storage-failed: ([^:]+):/.exec(String(error));
  return failure ? new ChapterStorageError(failure[1], error) : null;
}

export interface ContentChapterDownloadResult {
  contentBytes: number;
  mediaBytes: number;
  mediaComplete: boolean;
}

export async function withDownloadedContentChapter<T>(input: {
  serverUrl: string;
  token?: string;
  entry: CatalogEntry;
  storageDir: string;
  chapterId: number;
  signal?: AbortSignal;
}, apply: (sizes: ContentChapterDownloadResult, install: (storageDir: string) => Promise<void>) => Promise<T>): Promise<T> {
  input.signal?.throwIfAborted();
  const stagePath = await invoke<string>("content_sync_create_stage").catch((error: unknown) => {
    throw new ChapterStorageError("create content download stage", error);
  });
  const removeStage = () => invoke<void>("content_sync_remove_stage", { stagePath }).catch((error: unknown) => {
    throw new ChapterStorageError("remove content download stage", error);
  });
  let transfer: Promise<ContentChapterDownloadResult> | undefined;
  let settled = false;
  let onAbort: (() => void) | undefined;
  try {
    input.signal?.throwIfAborted();
    const interrupted = input.signal ? new Promise<never>((_, reject) => {
      onAbort = () => reject(input.signal!.reason);
      input.signal!.addEventListener("abort", onAbort, { once: true });
    }) : undefined;
    transfer = invoke<ContentChapterDownloadResult>("content_sync_download", {
      serverUrl: input.serverUrl, token: input.token ?? null, entry: input.entry,
      storageDir: input.storageDir, stagePath,
    }).catch(async (error: unknown) => {
      const storageFailure = nativeChapterStorageError(error);
      if (storageFailure) throw storageFailure;
      const rejected = /^content sync: server returned (\d{3}): ([\s\S]*)$/.exec(String(error));
      if (!rejected) throw error;
      const status = Number(rejected[1]);
      if (status === 401 && input.token) {
        const { forgetContentDeviceRegistration } = await import("./device");
        forgetContentDeviceRegistration(input.serverUrl, input.token);
      }
      throw new ContentServerError(status, rejected[2]);
    }).finally(() => { settled = true; });
    const result = await (interrupted ? Promise.race([transfer, interrupted]) : transfer);
    input.signal?.throwIfAborted();
    return await apply(result, async storageDir => {
      try {
        await invoke("content_sync_install", { storageDir, stagePath });
      } catch (error) {
        throw nativeChapterStorageError(error) ?? error;
      }
    });
  } finally {
    if (onAbort) input.signal?.removeEventListener("abort", onAbort);
    if (transfer && !settled) {
      // Native HTTP may still be writing; a cancelled transfer only owns its private stage.
      void transfer.then(removeStage, removeStage).catch(error => {
        // eslint-disable-next-line no-console
        console.warn("[content-sync] cancelled download cleanup failed", error);
      });
    } else await removeStage();
  }
}
