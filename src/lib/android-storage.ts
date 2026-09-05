import { invoke } from "@tauri-apps/api/core";
import {
  MAX_BACKUP_ARCHIVE_BYTES,
  assertByteBudget,
} from "./performance-budgets";
import type {
  ChapterStorageTransferEntry,
  ChapterStorageTransferPreparation,
} from "./chapter-storage-transfer";

interface AndroidStorageBridge {
  archiveDirectory: (
    requestId: string,
    rootUri: string,
    sourceRelativePath: string,
    archiveRelativePath: string,
  ) => void;
  deleteChildrenExcept: (
    rootUri: string,
    relativePath: string,
    keepName: string,
  ) => string;
  deletePath: (
    requestId: string,
    rootUri: string,
    relativePath: string,
  ) => void;
  deleteRootChildren: (rootUri: string) => string;
  describeContentUri?: (uri: string) => string;
  ensureNoMedia: (rootUri: string) => string;
  ensureNoMediaAsync?: (requestId: string, rootUri: string) => void;
  beginRestore: (rootUri: string, token: string) => string;
  commitRestore: (rootUri: string, token: string) => string;
  pathSize: (
    requestId: string,
    rootUri: string,
    relativePath: string,
  ) => void;
  inspectChapterArtifacts: (
    requestId: string,
    rootUri: string,
    preferredChapterDir: string,
    sourceDir: string,
    novelIdentitySuffix: string,
    chapterIdentityPrefix: string,
    preferredContentFileName: string,
  ) => void;
  inspectNovelCover: (
    requestId: string,
    rootUri: string,
    preferredNovelDir: string,
    sourceDir: string,
    novelIdentitySuffix: string,
    sourceId: string,
    novelPath: string,
    expectedSourceUrl: string,
  ) => void;
  finalizeChapterStorageTransfer: (
    requestId: string,
    rootUri: string,
    preparationJson: string,
  ) => void;
  listChapterStorageDirs: (
    rootUri: string,
    preferredChapterDir: string,
    sourceDir: string,
    novelIdentitySuffix: string,
    chapterIdentityPrefix: string,
  ) => string;
  prepareReaderMediaCache?: (
    rootUri: string,
    mediaRelativePath: string,
    archiveRelativePath: string,
    cacheToken: string,
  ) => string;
  pickMediaStorageRoot: (requestId: string) => void;
  prepareChapterStorageTransfer: (
    requestId: string,
    rootUri: string,
    entriesJson: string,
  ) => void;
  readBase64: (rootUri: string, relativePath: string) => string;
  readContentUriBase64: (uri: string) => string;
  readContentUriFile?: (uri: string, maxBytes: string) => string;
  readText: (
    requestId: string,
    rootUri: string,
    relativePath: string,
  ) => void;
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
  zipEntrySizes?: (
    requestId: string,
    rootUri: string,
    archiveRelativePath: string,
    entryNamesJson: string,
  ) => void;
  extractZip: (
    rootUri: string,
    archiveRelativePath: string,
    targetRelativePath: string,
  ) => string;
  renamePath: (
    requestId: string,
    rootUri: string,
    relativePath: string,
    newName: string,
  ) => void;
  removeChapterStorageDirectory: (
    requestId: string,
    rootUri: string,
    relativeDir: string,
  ) => void;
  rollbackRestore: (rootUri: string, token: string) => string;
  rollbackChapterStorageTransfer: (
    requestId: string,
    rootUri: string,
    preparationJson: string,
  ) => void;
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
    requestId: string,
    rootUri: string,
    relativePath: string,
    base64: string,
    mimeType: string,
  ) => void;
  writeContentUriBytes: (
    uri: string,
    base64: string,
    mimeType: string,
  ) => string;
  writeText: (
    requestId: string,
    rootUri: string,
    relativePath: string,
    text: string,
  ) => void;
  zipEntryExists: (
    requestId: string,
    rootUri: string,
    archiveRelativePath: string,
    entryName: string,
  ) => void;
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

interface AndroidStorageZipEntrySizesResponse extends AndroidStorageResponse {
  sizes?: Record<string, number | undefined>;
}

interface AndroidStorageSizeResponse extends AndroidStorageResponse {
  bytes?: number;
}

interface AndroidStorageTempFileResponse extends AndroidStorageSizeResponse {
  mimeType?: string;
  path?: string;
}

interface AndroidContentUriDescriptorResponse extends AndroidStorageResponse {
  fileName?: string;
  mimeType?: string;
  size?: number | null;
}

interface AndroidStorageExistsResponse extends AndroidStorageResponse {
  exists?: boolean;
}

interface AndroidChapterArtifactsResponse extends AndroidStorageResponse {
  status?: "missing" | "present";
  contentFile?: string;
  contentBytes?: number;
  mediaBytes?: number;
}

interface AndroidChapterStorageDirsResponse extends AndroidStorageResponse {
  chapterDirs?: string[];
}

interface AndroidChapterStorageTransferResponse extends AndroidStorageResponse {
  preparation?: ChapterStorageTransferPreparation;
}

interface AndroidNovelCoverResponse extends AndroidStorageResponse {
  status?: "missing" | "present";
  manifest?: string;
  relativePath?: string;
}

export interface AndroidChapterArtifacts {
  status: "missing" | "present";
  contentFile: string | null;
  contentBytes: number;
  mediaBytes: number;
}

export interface AndroidChapterStorageLookupInput {
  preferredChapterDir: string;
  sourceDir: string;
  novelIdentitySuffix: string;
  chapterIdentityPrefix: string;
}

export interface AndroidNovelCoverInspection {
  manifest: string;
  relativePath: string;
}

export interface AndroidNovelCoverLookupInput {
  expectedSourceUrl: string | null;
  novelPath: string;
  preferredNovelDir: string;
  sourceId: string;
  sourceDir: string;
  novelIdentitySuffix: string;
}

export interface AndroidContentUriDescriptor {
  fileName: string;
  mimeType: string;
  size: number | null;
}

export interface AndroidStorageTempFile {
  bytes: number;
  mimeType: string;
  path: string;
}

type AndroidStorageBytes = Uint8Array | readonly number[];
const ANDROID_STORAGE_BASE64_CHUNK_SIZE = 0x6000;
const ANDROID_STORAGE_BASE64_YIELD_INTERVAL = 16;

const ANDROID_STORAGE_NOT_SELECTED =
  "Android media storage folder has not been selected.";

const pickResolvers = new Map<
  string,
  (payload: AndroidStoragePickPayload) => void
>();
const chapterArtifactResolvers = new Map<string, (response: string) => void>();
const novelCoverInspectionResolvers = new Map<
  string,
  (response: string) => void
>();
const chapterStorageTransferResolvers = new Map<
  string,
  (response: string) => void
>();
const storageOperationResolvers = new Map<
  string,
  (response: string) => void
>();
const nomediaRoots = new Set<string>();
const nomediaRootPromises = new Map<string, Promise<void>>();
const novelCoverInspectionsByBridge = new WeakMap<
  AndroidStorageBridge,
  Map<string, Promise<AndroidNovelCoverInspection | null>>
>();

declare global {
  interface Window {
    __lnrResolveAndroidStoragePick?: (
      requestId: string,
      payload: AndroidStoragePickPayload,
    ) => void;
    __lnrResolveAndroidChapterArtifacts?: (
      requestId: string,
      response: string,
    ) => void;
    __lnrResolveAndroidNovelCover?: (
      requestId: string,
      response: string,
    ) => void;
    __lnrResolveAndroidChapterStorageTransfer?: (
      requestId: string,
      response: string,
    ) => void;
    __lnrResolveAndroidStorageOperation?: (
      requestId: string,
      response: string,
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

async function bytesToBase64Cooperatively(
  bytes: AndroidStorageBytes,
): Promise<string> {
  const encodedChunks: string[] = [];
  for (
    let index = 0;
    index < bytes.length;
    index += ANDROID_STORAGE_BASE64_CHUNK_SIZE
  ) {
    const chunk = Array.from(
      bytes.slice(index, index + ANDROID_STORAGE_BASE64_CHUNK_SIZE),
    );
    encodedChunks.push(btoa(String.fromCharCode(...chunk)));
    if (
      encodedChunks.length % ANDROID_STORAGE_BASE64_YIELD_INTERVAL === 0 &&
      index + ANDROID_STORAGE_BASE64_CHUNK_SIZE < bytes.length
    ) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    }
  }
  return encodedChunks.join("");
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

async function ensureAndroidStorageNomedia(root: string): Promise<void> {
  if (nomediaRoots.has(root)) return;
  const pending = nomediaRootPromises.get(root);
  if (pending) return pending;

  const bridge = androidStorageBridge();
  const ensure = bridge.ensureNoMediaAsync
    ? runAndroidStorageOperation((requestId) =>
        bridge.ensureNoMediaAsync!(requestId, root),
      ).then(() => undefined)
    : Promise.resolve().then(() => {
        parseStorageResponse(bridge.ensureNoMedia(root));
      });
  nomediaRootPromises.set(root, ensure);
  try {
    await ensure;
    nomediaRoots.add(root);
  } finally {
    nomediaRootPromises.delete(root);
  }
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
  await ensureAndroidStorageNomedia(root);
  return root;
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

function ensureChapterArtifactResolver(): void {
  window.__lnrResolveAndroidChapterArtifacts ??= (requestId, response) => {
    const resolve = chapterArtifactResolvers.get(requestId);
    if (!resolve) return;
    chapterArtifactResolvers.delete(requestId);
    resolve(response);
  };
}

function ensureStorageOperationResolver(): void {
  window.__lnrResolveAndroidStorageOperation ??= (requestId, response) => {
    const resolve = storageOperationResolvers.get(requestId);
    if (!resolve) return;
    storageOperationResolvers.delete(requestId);
    resolve(response);
  };
}

async function runAndroidStorageOperation<T extends AndroidStorageResponse>(
  start: (requestId: string) => void,
): Promise<T> {
  ensureStorageOperationResolver();
  const requestId = makeRequestId();
  const rawResponse = await new Promise<string>((resolve, reject) => {
    storageOperationResolvers.set(requestId, resolve);
    try {
      start(requestId);
    } catch (error) {
      storageOperationResolvers.delete(requestId);
      reject(error);
    }
  });
  return parseStorageResponse<T>(rawResponse);
}

function ensureNovelCoverInspectionResolver(): void {
  window.__lnrResolveAndroidNovelCover ??= (requestId, response) => {
    const resolve = novelCoverInspectionResolvers.get(requestId);
    if (!resolve) return;
    novelCoverInspectionResolvers.delete(requestId);
    resolve(response);
  };
}

function novelCoverInspectionCache(
  bridge: AndroidStorageBridge,
): Map<string, Promise<AndroidNovelCoverInspection | null>> {
  let cache = novelCoverInspectionsByBridge.get(bridge);
  if (!cache) {
    cache = new Map();
    novelCoverInspectionsByBridge.set(bridge, cache);
  }
  return cache;
}

function novelCoverInspectionKey(input: AndroidNovelCoverLookupInput): string {
  return JSON.stringify([
    input.expectedSourceUrl,
    input.novelPath,
    input.preferredNovelDir,
    input.sourceId,
    input.sourceDir,
    input.novelIdentitySuffix,
  ]);
}

function clearNovelCoverInspectionCache(bridge: AndroidStorageBridge): void {
  novelCoverInspectionsByBridge.get(bridge)?.clear();
}

function isNovelCoverStoragePath(relativePath: string): boolean {
  const segments = relativePath.split("/").filter(Boolean);
  const fileName = segments.at(-1)?.toLowerCase() ?? "";
  return (
    segments.length === 4 &&
    segments[0] === "contents" &&
    (fileName === "cover.json" || fileName.startsWith("cover."))
  );
}

function isNovelStorageDirectoryPath(relativePath: string): boolean {
  const segments = relativePath.split("/").filter(Boolean);
  return segments.length === 3 && segments[0] === "contents";
}

function ensureChapterStorageTransferResolver(): void {
  window.__lnrResolveAndroidChapterStorageTransfer ??= (
    requestId,
    response,
  ) => {
    const resolve = chapterStorageTransferResolvers.get(requestId);
    if (!resolve) return;
    chapterStorageTransferResolvers.delete(requestId);
    resolve(response);
  };
}

async function runAndroidChapterStorageTransfer(
  start: (requestId: string, root: string) => void,
): Promise<AndroidChapterStorageTransferResponse> {
  const root = await androidStorageRoot();
  ensureChapterStorageTransferResolver();
  const requestId = makeRequestId();
  const rawResponse = await new Promise<string>((resolve, reject) => {
    chapterStorageTransferResolvers.set(requestId, resolve);
    try {
      start(requestId, root);
    } catch (error) {
      chapterStorageTransferResolvers.delete(requestId);
      reject(error);
    }
  });
  return parseStorageResponse<AndroidChapterStorageTransferResponse>(
    rawResponse,
  );
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
  clearNovelCoverInspectionCache(androidStorageBridge());
  nomediaRoots.delete(root);
  await ensureAndroidStorageNomedia(root);
  return root;
}

export async function writeAndroidStorageBytes(
  relativePath: string,
  body: AndroidStorageBytes,
  mimeType: string,
): Promise<void> {
  const root = await androidStorageRoot();
  const bridge = androidStorageBridge();
  const base64 = await bytesToBase64Cooperatively(body);
  await runAndroidStorageOperation((requestId) =>
    bridge.writeBytes(requestId, root, relativePath, base64, mimeType),
  );
  if (isNovelCoverStoragePath(relativePath)) {
    clearNovelCoverInspectionCache(bridge);
  }
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
  if (!bridge.readContentUriFile) return null;
  const response = parseStorageResponse<AndroidStorageTempFileResponse>(
    bridge.readContentUriFile(
      uri,
      String(normalizeContentUriMaxBytes(maxBytes)),
    ),
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

export async function describeAndroidContentUri(
  uri: string,
): Promise<AndroidContentUriDescriptor> {
  const bridge = androidStorageBridge();
  if (!bridge.describeContentUri) {
    throw new Error("Android content URI descriptor bridge is unavailable.");
  }
  const response = parseStorageResponse<AndroidContentUriDescriptorResponse>(
    bridge.describeContentUri(uri),
  );
  if (!response.fileName) {
    throw new Error("Android content URI descriptor has no file name.");
  }
  return {
    fileName: response.fileName,
    mimeType: response.mimeType ?? "application/octet-stream",
    size: response.size ?? null,
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
  const bridge = androidStorageBridge();
  await runAndroidStorageOperation((requestId) =>
    bridge.writeText(requestId, root, relativePath, text),
  );
  if (isNovelCoverStoragePath(relativePath)) {
    clearNovelCoverInspectionCache(bridge);
  }
}

export async function archiveAndroidStorageDirectory(
  sourceRelativePath: string,
  archiveRelativePath: string,
): Promise<number> {
  const root = await androidStorageRoot();
  const bridge = androidStorageBridge();
  const response = await runAndroidStorageOperation<AndroidStorageSizeResponse>(
    (requestId) => bridge.archiveDirectory(
      requestId,
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
  const bridge = androidStorageBridge();
  try {
    const response = await runAndroidStorageOperation<AndroidStorageTextResponse>(
      (requestId) => bridge.readText(requestId, root, relativePath),
    );
    return response.text ?? "";
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) return null;
    throw error;
  }
}

export function inspectAndroidNovelCover(
  input: AndroidNovelCoverLookupInput,
): Promise<AndroidNovelCoverInspection | null> {
  const bridge = androidStorageBridge();
  const cache = novelCoverInspectionCache(bridge);
  const cacheKey = novelCoverInspectionKey(input);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const inspection = inspectAndroidNovelCoverUncached(bridge, input);
  cache.set(cacheKey, inspection);
  void inspection.catch(() => {
    if (cache.get(cacheKey) === inspection) cache.delete(cacheKey);
  });
  return inspection;
}

async function inspectAndroidNovelCoverUncached(
  bridge: AndroidStorageBridge,
  input: AndroidNovelCoverLookupInput,
): Promise<AndroidNovelCoverInspection | null> {
  const root = await androidStorageRoot();
  ensureNovelCoverInspectionResolver();
  const requestId = makeRequestId();
  const rawResponse = await new Promise<string>((resolve, reject) => {
    novelCoverInspectionResolvers.set(requestId, resolve);
    try {
      bridge.inspectNovelCover(
        requestId,
        root,
        input.preferredNovelDir,
        input.sourceDir,
        input.novelIdentitySuffix,
        input.sourceId,
        input.novelPath,
        input.expectedSourceUrl ?? "",
      );
    } catch (error) {
      novelCoverInspectionResolvers.delete(requestId);
      reject(error);
    }
  });
  const response = parseStorageResponse<AndroidNovelCoverResponse>(
    rawResponse,
  );
  if (
    response.status !== "present" ||
    !response.manifest?.trim() ||
    !response.relativePath?.trim()
  ) {
    return null;
  }
  return {
    manifest: response.manifest,
    relativePath: response.relativePath.trim(),
  };
}

export async function inspectAndroidChapterArtifacts(input: AndroidChapterStorageLookupInput & {
  preferredContentFileName: string;
}): Promise<AndroidChapterArtifacts> {
  const root = await androidStorageRoot();
  const bridge = androidStorageBridge();
  ensureChapterArtifactResolver();
  const requestId = makeRequestId();
  const rawResponse = await new Promise<string>((resolve, reject) => {
    chapterArtifactResolvers.set(requestId, resolve);
    try {
      bridge.inspectChapterArtifacts(
        requestId,
        root,
        input.preferredChapterDir,
        input.sourceDir,
        input.novelIdentitySuffix,
        input.chapterIdentityPrefix,
        input.preferredContentFileName,
      );
    } catch (error) {
      chapterArtifactResolvers.delete(requestId);
      reject(error);
    }
  });
  const response = parseStorageResponse<AndroidChapterArtifactsResponse>(
    rawResponse,
  );
  return {
    status: response.status === "present" ? "present" : "missing",
    contentFile: response.contentFile ?? null,
    contentBytes: response.contentBytes ?? 0,
    mediaBytes: response.mediaBytes ?? 0,
  };
}

export async function listAndroidChapterStorageDirs(
  input: AndroidChapterStorageLookupInput,
): Promise<string[]> {
  const root = await androidStorageRoot();
  const response = parseStorageResponse<AndroidChapterStorageDirsResponse>(
    androidStorageBridge().listChapterStorageDirs(
      root,
      input.preferredChapterDir,
      input.sourceDir,
      input.novelIdentitySuffix,
      input.chapterIdentityPrefix,
    ),
  );
  return [...new Set(response.chapterDirs ?? [])];
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
  const bridge = androidStorageBridge();
  const response = await runAndroidStorageOperation<AndroidStorageSizeResponse>(
    (requestId) => bridge.pathSize(requestId, root, relativePath),
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
  const bridge = androidStorageBridge();
  const response = await runAndroidStorageOperation<AndroidStorageExistsResponse>(
    (requestId) =>
      bridge.zipEntryExists(
        requestId,
        root,
        archiveRelativePath,
        entryName,
      ),
  );
  return response.exists ?? false;
}

export async function androidStorageZipEntrySizes(
  archiveRelativePath: string,
  entryNames: readonly string[],
): Promise<Map<string, number> | null> {
  const bridge = androidStorageBridge();
  if (!bridge.zipEntrySizes) return null;
  const uniqueEntryNames = [...new Set(entryNames)].filter(
    (entryName) => entryName.trim() !== "",
  );
  if (uniqueEntryNames.length === 0) return new Map();

  const root = await androidStorageRoot();
  const response =
    await runAndroidStorageOperation<AndroidStorageZipEntrySizesResponse>(
      (requestId) =>
        bridge.zipEntrySizes!(
          requestId,
          root,
          archiveRelativePath,
          JSON.stringify(uniqueEntryNames),
        ),
  );
  const sizes = new Map<string, number>();
  for (const [entryName, bytes] of Object.entries(response.sizes ?? {})) {
    if (typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0) {
      sizes.set(entryName, bytes);
    }
  }
  return sizes;
}

export async function deleteAndroidStoragePath(
  relativePath: string,
): Promise<void> {
  const root = await androidStorageRoot();
  const bridge = androidStorageBridge();
  await runAndroidStorageOperation((requestId) =>
    bridge.deletePath(requestId, root, relativePath),
  );
  if (
    isNovelCoverStoragePath(relativePath) ||
    isNovelStorageDirectoryPath(relativePath)
  ) {
    clearNovelCoverInspectionCache(bridge);
  }
}

export async function prepareAndroidChapterStorageTransfer(
  entries: readonly ChapterStorageTransferEntry[],
): Promise<ChapterStorageTransferPreparation> {
  const response = await runAndroidChapterStorageTransfer((requestId, root) => {
    androidStorageBridge().prepareChapterStorageTransfer(
      requestId,
      root,
      JSON.stringify(entries),
    );
  });
  if (!response.preparation) {
    throw new Error(
      "Android storage bridge did not return a transfer preparation.",
    );
  }
  return response.preparation;
}

export async function finalizeAndroidChapterStorageTransfer(
  preparation: ChapterStorageTransferPreparation,
): Promise<void> {
  await runAndroidChapterStorageTransfer((requestId, root) => {
    androidStorageBridge().finalizeChapterStorageTransfer(
      requestId,
      root,
      JSON.stringify(preparation),
    );
  });
}

export async function rollbackAndroidChapterStorageTransfer(
  preparation: ChapterStorageTransferPreparation,
): Promise<void> {
  await runAndroidChapterStorageTransfer((requestId, root) => {
    androidStorageBridge().rollbackChapterStorageTransfer(
      requestId,
      root,
      JSON.stringify(preparation),
    );
  });
}

export async function removeAndroidChapterStorageDirectory(
  relativeDir: string,
): Promise<void> {
  await runAndroidChapterStorageTransfer((requestId, root) => {
    androidStorageBridge().removeChapterStorageDirectory(
      requestId,
      root,
      relativeDir,
    );
  });
}

export async function beginAndroidStorageRestore(): Promise<string> {
  const root = await androidStorageRoot();
  const token = makeRequestId();
  parseStorageResponse(androidStorageBridge().beginRestore(root, token));
  return token;
}

export async function commitAndroidStorageRestore(token: string): Promise<void> {
  const root = await androidStorageRoot();
  const bridge = androidStorageBridge();
  parseStorageResponse(bridge.commitRestore(root, token));
  clearNovelCoverInspectionCache(bridge);
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
  const bridge = androidStorageBridge();
  await runAndroidStorageOperation((requestId) =>
    bridge.renamePath(requestId, root, relativePath, newName),
  );
  if (
    isNovelCoverStoragePath(relativePath) ||
    isNovelStorageDirectoryPath(relativePath)
  ) {
    clearNovelCoverInspectionCache(bridge);
  }
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
  const bridge = androidStorageBridge();
  parseStorageResponse(bridge.deleteRootChildren(root));
  clearNovelCoverInspectionCache(bridge);
  nomediaRoots.delete(root);
  await ensureAndroidStorageNomedia(root);
}
