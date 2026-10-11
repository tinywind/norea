import { invoke } from "@tauri-apps/api/core";
import { snapshotAndroidContentChapter, installAndroidContentChapter } from "../android-storage";
import { isAndroidRuntime } from "../tauri-runtime";

export interface ContentIdentity {
  pluginId: string;
  novelPath: string;
  chapterPath: string;
}

export interface PackageManifest {
  packageVersion: 1;
  identity: ContentIdentity;
  novel: { name: string; author?: string | null; summary?: string | null; isLocal: boolean };
  chapter: { name: string; position: number; chapterNumber?: string | null; contentType: "html" | "text" | "markdown" | "pdf"; page: string };
  bodyPath: string;
  files: { path: string; size: number; sha256: string }[];
}

export interface CatalogEntry {
  id: string;
  revision: string;
  zipSha256: string;
  zipBytes: number;
  manifest: PackageManifest;
  deleted: boolean;
  sequence: number;
}

export async function fingerprintContentChapter(input: { storageDir: string }): Promise<string> {
  const stagePath = await invoke<string>("content_sync_create_stage");
  try {
    if (isAndroidRuntime()) await snapshotAndroidContentChapter(input.storageDir, stagePath);
    return await invoke<string>("content_sync_fingerprint", { storageDir: input.storageDir, stagePath });
  } finally {
    await invoke("content_sync_remove_stage", { stagePath });
  }
}

export async function uploadContentChapter(input: {
  serverUrl: string;
  token: string;
  chapterId: number;
  manifest: Omit<PackageManifest, "files" | "bodyPath">;
  storageDir: string;
}): Promise<CatalogEntry> {
  const stagePath = await invoke<string>("content_sync_create_stage");
  try {
    if (isAndroidRuntime()) await snapshotAndroidContentChapter(input.storageDir, stagePath);
    return await invoke<CatalogEntry>("content_sync_upload", {
      serverUrl: input.serverUrl, token: input.token, manifest: input.manifest,
      storageDir: input.storageDir, stagePath,
    });
  } finally {
    await invoke("content_sync_remove_stage", { stagePath });
  }
}

export async function downloadContentChapter(input: {
  serverUrl: string;
  token?: string;
  entry: CatalogEntry;
  storageDir: string;
  chapterId: number;
}): Promise<{ contentBytes: number; mediaBytes: number }> {
  const stagePath = await invoke<string>("content_sync_create_stage");
  try {
    const result = await invoke<{ contentBytes: number; mediaBytes: number }>("content_sync_download", {
      serverUrl: input.serverUrl, token: input.token ?? null, entry: input.entry,
      storageDir: input.storageDir, stagePath,
    });
    if (isAndroidRuntime()) await installAndroidContentChapter(input.storageDir, stagePath);
    return result;
  } finally {
    await invoke("content_sync_remove_stage", { stagePath });
  }
}
