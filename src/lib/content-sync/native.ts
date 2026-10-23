import { invoke } from "@tauri-apps/api/core";
import { snapshotAndroidContentChapter, installAndroidContentChapter } from "../android-storage";
import { isAndroidRuntime } from "../tauri-runtime";
import { runWorkContentStorageOperation } from "./storage-operation";
import { ContentServerError } from "./client";

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
  chapter: { name: string; position: number; chapterNumber?: string | null; contentType: "html" | "text" | "markdown" | "pdf"; page: string };
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

export async function withContentChapterStage<T>(input: { storageDir: string; identity: Pick<ContentIdentity, "pluginId" | "novelPath">; signal?: AbortSignal }, run: (stagePath: string) => Promise<T>): Promise<T> {
  input.signal?.throwIfAborted();
  const stagePath = await invoke<string>("content_sync_create_stage");
  try {
    input.signal?.throwIfAborted();
    if (isAndroidRuntime()) await snapshotAndroidContentChapter(input.storageDir, stagePath);
    else await runWorkContentStorageOperation(input.identity.pluginId, input.identity.novelPath,
      () => {
        input.signal?.throwIfAborted();
        return invoke("content_sync_snapshot", { storageDir: input.storageDir, stagePath });
      });
    input.signal?.throwIfAborted();
    return await run(stagePath);
  } finally {
    await invoke("content_sync_remove_stage", { stagePath });
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
  try {
    input.signal?.throwIfAborted();
    return await invoke<CatalogEntry>("content_sync_upload", {
      serverUrl: input.serverUrl, token: input.token, manifest: input.manifest,
      conflictPolicy: input.conflictPolicy,
      storageDir: input.storageDir, stagePath: input.stagePath,
    });
  } catch (error) {
    const rejected = /^content sync: server returned (\d{3}): ([\s\S]*)$/.exec(String(error));
    if (!rejected) throw error;
    const status = Number(rejected[1]);
    if (status === 401) {
      const { forgetContentDeviceRegistration } = await import("./device");
      forgetContentDeviceRegistration(input.serverUrl, input.token);
    }
    throw new ContentServerError(status, rejected[2]);
  }
}

export async function withDownloadedContentChapter<T>(input: {
  serverUrl: string;
  token?: string;
  entry: CatalogEntry;
  storageDir: string;
  chapterId: number;
  signal?: AbortSignal;
}, apply: (sizes: { contentBytes: number; mediaBytes: number }, install: (storageDir: string) => Promise<void>) => Promise<T>): Promise<T> {
  input.signal?.throwIfAborted();
  const stagePath = await invoke<string>("content_sync_create_stage");
  const removeStage = () => invoke<void>("content_sync_remove_stage", { stagePath });
  let transfer: Promise<{ contentBytes: number; mediaBytes: number }> | undefined;
  let settled = false;
  let onAbort: (() => void) | undefined;
  try {
    input.signal?.throwIfAborted();
    const interrupted = input.signal ? new Promise<never>((_, reject) => {
      onAbort = () => reject(input.signal!.reason);
      input.signal!.addEventListener("abort", onAbort, { once: true });
    }) : undefined;
    transfer = invoke<{ contentBytes: number; mediaBytes: number }>("content_sync_download", {
      serverUrl: input.serverUrl, token: input.token ?? null, entry: input.entry,
      storageDir: input.storageDir, stagePath,
    }).finally(() => { settled = true; });
    const result = await (interrupted ? Promise.race([transfer, interrupted]) : transfer);
    input.signal?.throwIfAborted();
    return await apply(result, async storageDir => {
      if (isAndroidRuntime()) await installAndroidContentChapter(storageDir, stagePath);
      else await invoke("content_sync_install", { storageDir, stagePath });
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
