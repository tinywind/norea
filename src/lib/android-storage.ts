import { invoke } from "@tauri-apps/api/core";
import {
  MAX_BACKUP_ARCHIVE_BYTES,
  assertByteBudget,
} from "./performance-budgets";

interface AndroidStorageBridge {
  archiveDirectory: (
    rootUri: string,
    sourceRelativePath: string,
    archiveRelativePath: string,
  ) => string;
  deleteChildrenExcept: (
    rootUri: string,
    relativePath: string,
    keepName: string,
  ) => string;
  deletePath: (rootUri: string, relativePath: string) => string;
  deleteRootChildren: (rootUri: string) => string;
  beginRestore: (rootUri: string, token: string) => string;
  commitRestore: (rootUri: string, token: string) => string;
  pathSize: (rootUri: string, relativePath: string) => string;
  prepareReaderMediaCache?: (
    rootUri: string,
    mediaRelativePath: string,
    archiveRelativePath: string,
    cacheToken: string,
  ) => string;
  pickMediaStorageRoot: (requestId: string) => void;
  readBase64: (rootUri: string, relativePath: string) => string;
  readContentUriBase64: (uri: string) => string;
  readContentUriFile?: (uri: string, maxBytes: string) => string;
  readText: (rootUri: string, relativePath: string) => string;
  readZipEntryBase64: (
    rootUri: string,
    archiveRelativePath: string,
    entryName: string,
  ) => string;
  readZipEntriesBase64?: (
    rootUri: string,
    archiveRelativePath: string,
    entryNamesJson: string,
  ) => string;
  extractZip: (
    rootUri: string,
    archiveRelativePath: string,
    targetRelativePath: string,
  ) => string;
  renamePath: (
    rootUri: string,
    relativePath: string,
    newName: string,
  ) => string;
  rollbackRestore: (rootUri: string, token: string) => string;
  deleteTempFile?: (path: string) => string;
  writeContentUriFile: (
    uri: string,
    inputPath: string,
    mimeType: string,
  ) => string;
  writeContentUriFileCapped?: (
    uri: string,
    inputPath: string,
    mimeType: string,
    maxBytes: string,
  ) => string;
  writeBytes: (
    rootUri: string,
    relativePath: string,
    base64: string,
    mimeType: string,
  ) => string;
  writeContentUriBytes: (
    uri: string,
    base64: string,
    mimeType: string,
  ) => string;
  writeText: (rootUri: string, relativePath: string, text: string) => string;
  zipEntryExists: (
    rootUri: string,
    archiveRelativePath: string,
    entryName: string,
  ) => string;
}

interface AndroidStoragePickPayload {
  cancelled?: boolean;
  error?: string;
  ok: boolean;
  root?: string;
}

interface AndroidStorageResponse {
  error?: string;
  ok: boolean;
}

interface AndroidStorageTextResponse extends AndroidStorageResponse {
  text?: string;
}

interface AndroidStorageBase64Response extends AndroidStorageResponse {
  base64?: string;
  mimeType?: string;
}

interface AndroidStorageZipEntriesResponse extends AndroidStorageResponse {
  entries?: Record<string, { base64?: string; mimeType?: string } | undefined>;
}

interface AndroidStorageSizeResponse extends AndroidStorageResponse {
  bytes?: number;
}

interface AndroidStorageTempFileResponse extends AndroidStorageSizeResponse {
  mimeType?: string;
  path?: string;
}

interface AndroidStorageExistsResponse extends AndroidStorageResponse {
  exists?: boolean;
}

export interface AndroidStorageTempFile {
  bytes: number;
  mimeType: string;
  path: string;
}

type AndroidStorageBytes = Uint8Array | readonly number[];

const ANDROID_STORAGE_NOT_SELECTED =
  "Android media storage folder has not been selected.";
const LEGACY_CONTENTS_NOMEDIA_PATH = "contents/.nomedia";

const pickResolvers = new Map<
  string,
  (payload: AndroidStoragePickPayload) => void
>();
const legacyNomediaCleanupRoots = new Set<string>();

declare global {
  interface Window {
    __lnrResolveAndroidStoragePick?: (
      requestId: string,
      payload: AndroidStoragePickPayload,
    ) => void;
    __NoreaAndroidStorage?: AndroidStorageBridge;
  }
}

function androidStorageBridge(): AndroidStorageBridge {
  const bridge = window.__NoreaAndroidStorage;
  if (!bridge) {
    throw new Error("Android storage bridge is unavailable.");
  }
  return bridge;
}

function parseStorageResponse<T extends AndroidStorageResponse>(raw: string): T {
  const payload = JSON.parse(raw) as T;
  if (!payload.ok) {
    throw new Error(payload.error ?? "Android storage operation failed.");
  }
  return payload;
}

function bytesToBase64(bytes: AndroidStorageBytes): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = Array.from(bytes.slice(index, index + chunkSize));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): number[] {
  const binary = atob(base64);
  const bytes = new Array<number>(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function makeRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function normalizeContentUriMaxBytes(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Android content URI byte limit must be a positive integer.");
  }
  assertByteBudget(
    maxBytes,
    MAX_BACKUP_ARCHIVE_BYTES,
    "Android content URI byte limit",
  );
  return maxBytes;
}

async function androidStorageRoot(): Promise<string> {
  const root = (await invoke<string | null>(
    "chapter_media_get_storage_root",
  ))?.trim();
  if (!root) {
    throw new Error(ANDROID_STORAGE_NOT_SELECTED);
  }
  if (!root.startsWith("content://")) {
    throw new Error("Android media storage folder must be selected again.");
  }
  return root;
}

async function cleanupAndroidStorageLegacyNomedia(root: string): Promise<void> {
  if (legacyNomediaCleanupRoots.has(root)) return;
  try {
    parseStorageResponse(
      androidStorageBridge().deletePath(root, LEGACY_CONTENTS_NOMEDIA_PATH),
    );
  } catch (error) {
    console.warn("[android-storage] legacy .nomedia cleanup failed", error);
  }
  legacyNomediaCleanupRoots.add(root);
}

function ensurePickResolver(): void {
  window.__lnrResolveAndroidStoragePick ??= (
    requestId: string,
    payload: AndroidStoragePickPayload,
  ) => {
    const resolve = pickResolvers.get(requestId);
    if (!resolve) return;
    pickResolvers.delete(requestId);
    resolve(payload);
  };
}

export async function selectAndroidStorageRoot(): Promise<string | null> {
  ensurePickResolver();
  const requestId = makeRequestId();
  const payload = await new Promise<AndroidStoragePickPayload>((resolve) => {
    pickResolvers.set(requestId, resolve);
    try {
      androidStorageBridge().pickMediaStorageRoot(requestId);
    } catch (error) {
      pickResolvers.delete(requestId);
      throw error;
    }
  });
  if (payload.cancelled) return null;
  if (!payload.ok || !payload.root) {
    throw new Error(payload.error ?? "Android storage folder was not selected.");
  }
  const root = await invoke<string>("chapter_media_set_storage_root", {
    root: payload.root,
  });
  await cleanupAndroidStorageLegacyNomedia(root);
  return root;
}

export async function writeAndroidStorageBytes(
  relativePath: string,
  body: AndroidStorageBytes,
  mimeType: string,
): Promise<void> {
  const root = await androidStorageRoot();
  parseStorageResponse(
    androidStorageBridge().writeBytes(
      root,
      relativePath,
      bytesToBase64(body),
      mimeType,
    ),
  );
}

export async function writeAndroidContentUriBytes(
  uri: string,
  body: number[],
  mimeType: string,
): Promise<void> {
  parseStorageResponse(
    androidStorageBridge().writeContentUriBytes(
      uri,
      bytesToBase64(body),
      mimeType,
    ),
  );
}

export async function writeAndroidContentUriFile(
  uri: string,
  inputPath: string,
  mimeType: string,
  maxBytes: number = MAX_BACKUP_ARCHIVE_BYTES,
): Promise<void> {
  const bridge = androidStorageBridge();
  const cappedWriter = bridge.writeContentUriFileCapped;
  const maxByteLimit = normalizeContentUriMaxBytes(maxBytes);
  if (cappedWriter) {
    parseStorageResponse(
      cappedWriter(uri, inputPath, mimeType, String(maxByteLimit)),
    );
    return;
  }
  parseStorageResponse(
    bridge.writeContentUriFile(uri, inputPath, mimeType),
  );
}

export async function copyAndroidContentUriToTempFile(
  uri: string,
  maxBytes: number = MAX_BACKUP_ARCHIVE_BYTES,
): Promise<AndroidStorageTempFile | null> {
  const bridge = androidStorageBridge();
  const reader = bridge.readContentUriFile;
  if (!reader) return null;
  const response = parseStorageResponse<AndroidStorageTempFileResponse>(
    reader(uri, String(normalizeContentUriMaxBytes(maxBytes))),
  );
  if (!response.path) {
    throw new Error("Android storage bridge did not return a temp file path.");
  }
  return {
    bytes: response.bytes ?? 0,
    mimeType: response.mimeType ?? "application/octet-stream",
    path: response.path,
  };
}

export async function deleteAndroidContentUriTempFile(
  tempFile: AndroidStorageTempFile | string,
): Promise<void> {
  const bridge = androidStorageBridge();
  if (!bridge.deleteTempFile) return;
  const path = typeof tempFile === "string" ? tempFile : tempFile.path;
  parseStorageResponse(bridge.deleteTempFile(path));
}

export async function readAndroidContentUriBytes(uri: string): Promise<number[]> {
  const response = parseStorageResponse<AndroidStorageBase64Response>(
    androidStorageBridge().readContentUriBase64(uri),
  );
  return base64ToBytes(response.base64 ?? "");
}

export async function writeAndroidStorageText(
  relativePath: string,
  text: string,
): Promise<void> {
  const root = await androidStorageRoot();
  parseStorageResponse(
    androidStorageBridge().writeText(root, relativePath, text),
  );
}

export async function archiveAndroidStorageDirectory(
  sourceRelativePath: string,
  archiveRelativePath: string,
): Promise<number> {
  const root = await androidStorageRoot();
  const response = parseStorageResponse<AndroidStorageSizeResponse>(
    androidStorageBridge().archiveDirectory(
      root,
      sourceRelativePath,
      archiveRelativePath,
    ),
  );
  return response.bytes ?? 0;
}

export async function readAndroidStorageText(
  relativePath: string,
): Promise<string | null> {
  const root = await androidStorageRoot();
  try {
    const response = parseStorageResponse<AndroidStorageTextResponse>(
      androidStorageBridge().readText(root, relativePath),
    );
    return response.text ?? "";
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) return null;
    throw error;
  }
}

export async function readAndroidStorageDataUrl(
  relativePath: string,
): Promise<string | null> {
  const root = await androidStorageRoot();
  try {
    const response = parseStorageResponse<AndroidStorageBase64Response>(
      androidStorageBridge().readBase64(root, relativePath),
    );
    if (!response.base64) return null;
    return `data:${response.mimeType ?? "application/octet-stream"};base64,${
      response.base64
    }`;
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) return null;
    throw error;
  }
}

export async function readAndroidStorageZipEntryDataUrl(
  archiveRelativePath: string,
  entryName: string,
): Promise<string | null> {
  const root = await androidStorageRoot();
  try {
    const response = parseStorageResponse<AndroidStorageBase64Response>(
      androidStorageBridge().readZipEntryBase64(
        root,
        archiveRelativePath,
        entryName,
      ),
    );
    if (!response.base64) return null;
    return `data:${response.mimeType ?? "application/octet-stream"};base64,${
      response.base64
    }`;
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) return null;
    throw error;
  }
}

export async function readAndroidStorageZipEntriesDataUrls(
  archiveRelativePath: string,
  entryNames: readonly string[],
): Promise<Map<string, string>> {
  const uniqueEntryNames = [...new Set(entryNames)].filter(
    (entryName) => entryName.trim() !== "",
  );
  if (uniqueEntryNames.length === 0) return new Map();

  const root = await androidStorageRoot();
  const bridge = androidStorageBridge();
  if (!bridge.readZipEntriesBase64) {
    const entries = new Map<string, string>();
    await Promise.all(
      uniqueEntryNames.map(async (entryName) => {
        const dataUrl = await readAndroidStorageZipEntryDataUrl(
          archiveRelativePath,
          entryName,
        );
        if (dataUrl) entries.set(entryName, dataUrl);
      }),
    );
    return entries;
  }

  const response = parseStorageResponse<AndroidStorageZipEntriesResponse>(
    bridge.readZipEntriesBase64(
      root,
      archiveRelativePath,
      JSON.stringify(uniqueEntryNames),
    ),
  );
  const entries = new Map<string, string>();
  for (const [entryName, entry] of Object.entries(response.entries ?? {})) {
    if (!entry?.base64) continue;
    entries.set(
      entryName,
      `data:${entry.mimeType ?? "application/octet-stream"};base64,${
        entry.base64
      }`,
    );
  }
  return entries;
}

export async function extractAndroidStorageZip(
  archiveRelativePath: string,
  targetRelativePath: string,
): Promise<number> {
  const root = await androidStorageRoot();
  const response = parseStorageResponse<AndroidStorageSizeResponse>(
    androidStorageBridge().extractZip(
      root,
      archiveRelativePath,
      targetRelativePath,
    ),
  );
  return response.bytes ?? 0;
}

export async function androidStoragePathSize(
  relativePath: string,
): Promise<number> {
  const root = await androidStorageRoot();
  const response = parseStorageResponse<AndroidStorageSizeResponse>(
    androidStorageBridge().pathSize(root, relativePath),
  );
  return response.bytes ?? 0;
}

export async function prepareAndroidReaderMediaCache(
  mediaRelativePath: string,
  archiveRelativePath: string,
  cacheToken: string,
): Promise<void> {
  const bridge = androidStorageBridge();
  if (!bridge.prepareReaderMediaCache) {
    throw new Error("Android reader media cache is unavailable.");
  }
  const root = await androidStorageRoot();
  await cleanupAndroidStorageLegacyNomedia(root);
  parseStorageResponse(
    bridge.prepareReaderMediaCache(
      root,
      mediaRelativePath,
      archiveRelativePath,
      cacheToken,
    ),
  );
}

export async function androidStorageZipEntryExists(
  archiveRelativePath: string,
  entryName: string,
): Promise<boolean> {
  const root = await androidStorageRoot();
  const response = parseStorageResponse<AndroidStorageExistsResponse>(
    androidStorageBridge().zipEntryExists(root, archiveRelativePath, entryName),
  );
  return response.exists ?? false;
}

export async function deleteAndroidStoragePath(
  relativePath: string,
): Promise<void> {
  const root = await androidStorageRoot();
  parseStorageResponse(androidStorageBridge().deletePath(root, relativePath));
}

export async function beginAndroidStorageRestore(): Promise<string> {
  const root = await androidStorageRoot();
  const token = makeRequestId();
  parseStorageResponse(androidStorageBridge().beginRestore(root, token));
  return token;
}

export async function commitAndroidStorageRestore(token: string): Promise<void> {
  const root = await androidStorageRoot();
  parseStorageResponse(androidStorageBridge().commitRestore(root, token));
}

export async function rollbackAndroidStorageRestore(
  token: string,
): Promise<void> {
  const root = await androidStorageRoot();
  parseStorageResponse(androidStorageBridge().rollbackRestore(root, token));
}

export async function renameAndroidStoragePath(
  relativePath: string,
  newName: string,
): Promise<void> {
  const root = await androidStorageRoot();
  parseStorageResponse(
    androidStorageBridge().renamePath(root, relativePath, newName),
  );
}

export async function deleteAndroidStorageChildrenExcept(
  relativePath: string,
  keepName: string,
): Promise<void> {
  const root = await androidStorageRoot();
  parseStorageResponse(
    androidStorageBridge().deleteChildrenExcept(root, relativePath, keepName),
  );
}

export async function clearAndroidStorageRoot(): Promise<void> {
  const root = await androidStorageRoot();
  parseStorageResponse(androidStorageBridge().deleteRootChildren(root));
}
