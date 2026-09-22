import { invoke } from "@tauri-apps/api/core";
import {
  androidStoragePathSize,
  androidStorageZipEntryExists,
  androidStorageZipEntrySizes,
  archiveAndroidStorageDirectory,
  clearAndroidStorageRoot,
  deleteAndroidStoragePath,
  deleteAndroidStoragePaths,
  prepareAndroidReaderMediaCache,
  readAndroidStorageText,
  writeAndroidStorageBytes,
  writeAndroidStorageText,
} from "../android-storage";
import { chapterMediaDirectoryRelativePath } from "../chapter-storage-path";
import {
  type NativeStreamInfo,
  cancelNativeStream,
  createNativeStream,
  finishNativeStream,
  writeNativeStream,
} from "../native-stream";
import { isAndroidRuntime, isTauriRuntime } from "../tauri-runtime";
import { localChapterMediaSources } from "./html";
import {
  emptyChapterMediaManifest,
  parseChapterMediaManifest,
  serializeChapterMediaManifest,
} from "./manifest";
import {
  androidReaderLocalChapterMediaSrc,
  androidReaderMediaCacheToken,
  chapterMediaByteLength,
  chapterMediaBytesToArray,
  LOCAL_MEDIA_SRC_PREFIX,
  localChapterMediaFileName,
  localChapterMediaOutputSrc,
  localChapterMediaSourceForContext,
  localChapterMediaSrc,
  mimeTypeFromFileName,
  parseLocalChapterMediaSrc,
} from "./sources";
import {
  androidChapterMediaArchiveRelativePathCandidates,
  androidChapterMediaArchiveRelativePathForContext,
  androidChapterMediaManifestRelativePath,
  androidChapterMediaManifestRelativePathCandidates,
  androidChapterMediaRelativePathCandidates,
  androidChapterMediaRelativePathForContext,
  androidChapterMediaSourceCandidates,
  androidChapterMediaTransactionPaths,
  chapterMediaManifestLogContext,
  hasStorageContext,
  resolvedAndroidChapterStoragePath,
  storageChapterPathInput,
  storageContextForChapter,
  storageNovelPathInput,
} from "./storage-paths";
import {
  type ChapterMediaArchiveInput,
  type ChapterMediaManifest,
  type ChapterMediaManifestFile,
  type ChapterMediaStorageContext,
  type ChapterMediaStoreInput,
} from "./types";

const CHAPTER_MEDIA_STREAM_DOMAIN = "chapter-media";

export async function writeChapterMediaManifest({
  complete = false,
  context,
  files,
}: {
  complete?: boolean;
  context: ChapterMediaStorageContext;
  files: ChapterMediaManifestFile[];
}): Promise<void> {
  const manifestPath = androidChapterMediaManifestRelativePath(context);
  if (isAndroidRuntime()) {
    console.info("[chapter-media] write media manifest", {
      complete,
      fileCount: files.length,
      manifestPath,
      ...chapterMediaManifestLogContext(context),
    });
    await writeAndroidStorageText(
      manifestPath,
      serializeChapterMediaManifest(files, complete),
    );
    return;
  }
  await invoke("chapter_media_write_manifest", {
    complete,
    files,
    ...(context.chapterId ? { chapterId: context.chapterId } : {}),
    ...(context.chapterName ? { chapterName: context.chapterName } : {}),
    ...(context.chapterNumber ? { chapterNumber: context.chapterNumber } : {}),
    ...(context.chapterPosition
      ? { chapterPosition: context.chapterPosition }
      : {}),
    ...(context.novelId ? { novelId: context.novelId } : {}),
    ...(context.novelName ? { novelName: context.novelName } : {}),
    ...(context.novelPath ? { novelPath: context.novelPath } : {}),
    ...(context.sourceId ? { sourceId: context.sourceId } : {}),
  });
}

export async function readChapterMediaManifest(
  context: ChapterMediaStorageContext,
): Promise<ChapterMediaManifest> {
  if (isAndroidRuntime()) {
    const manifestPaths =
      androidChapterMediaManifestRelativePathCandidates(context);
    console.info("[chapter-media] read media manifest candidates", {
      ...chapterMediaManifestLogContext(context),
      manifestPaths,
    });
    for (const manifestPath of manifestPaths) {
      let raw: string | null;
      try {
        raw = await readAndroidStorageText(manifestPath);
      } catch (error) {
        console.warn("[chapter-media] read media manifest failed", {
          error,
          manifestPath,
          ...chapterMediaManifestLogContext(context),
        });
        throw error;
      }
      if (raw !== null) {
        const manifest = parseChapterMediaManifest(raw);
        console.info("[chapter-media] read media manifest hit", {
          complete: manifest.complete,
          fileCount: manifest.media.files.length,
          manifestPath,
          ...chapterMediaManifestLogContext(context),
        });
        return manifest;
      }
      console.info("[chapter-media] read media manifest miss", {
        manifestPath,
        ...chapterMediaManifestLogContext(context),
      });
    }
    console.info("[chapter-media] read media manifest empty", {
      ...chapterMediaManifestLogContext(context),
      manifestPaths,
    });
    return emptyChapterMediaManifest();
  }
  const raw = await invoke<string | null>("chapter_media_read_manifest", {
    chapterId: context.chapterId,
    ...(context.chapterName ? { chapterName: context.chapterName } : {}),
    ...(context.chapterNumber ? { chapterNumber: context.chapterNumber } : {}),
    ...(context.chapterPosition
      ? { chapterPosition: context.chapterPosition }
      : {}),
    ...(context.novelId ? { novelId: context.novelId } : {}),
    ...(context.novelName ? { novelName: context.novelName } : {}),
    ...(context.novelPath ? { novelPath: context.novelPath } : {}),
    ...(context.sourceId ? { sourceId: context.sourceId } : {}),
  });
  return parseChapterMediaManifest(raw);
}

async function androidRelativePathsFromLocalMediaSrc(
  src: string,
  context?: ChapterMediaStorageContext,
): Promise<string[]> {
  const fileName = localChapterMediaFileName(src, context);
  if (!fileName) return [];
  return androidChapterMediaRelativePathCandidates(context, fileName);
}

export async function getStoredChapterMediaBytes(
  html: string,
  context?: ChapterMediaStorageContext,
): Promise<number> {
  if (!isTauriRuntime()) return 0;
  const directSource = localChapterMediaSourceForContext(html, context);
  const mediaSrcs = directSource
    ? [directSource]
    : localChapterMediaSources(html, context);
  if (mediaSrcs.length === 0) return 0;
  if (isAndroidRuntime()) {
    let total = 0;
    const countedArchives = new Set<string>();
    for (const source of mediaSrcs) {
      const relativePaths = await androidRelativePathsFromLocalMediaSrc(
        source,
        context,
      );
      let hasDirectMedia = false;
      for (const path of relativePaths) {
        const directSize = await androidStoragePathSize(path);
        if (directSize > 0) {
          total += directSize;
          hasDirectMedia = true;
          break;
        }
      }
      if (hasDirectMedia) continue;

      const parsed = parseLocalChapterMediaSrc(source);
      if (!parsed) continue;
      for (const archivePath of androidChapterMediaArchiveRelativePathCandidates(
        context,
      )) {
        if (countedArchives.has(archivePath)) continue;
        if (
          !(await androidStorageZipEntryExists(archivePath, parsed.fileName))
        ) {
          continue;
        }
        total += await androidStoragePathSize(archivePath);
        countedArchives.add(archivePath);
        break;
      }
    }
    return total;
  }
  return invoke<number>("chapter_media_total_size", {
    mediaSrcs,
    ...(context?.chapterId ? { chapterId: context.chapterId } : {}),
    ...(context?.chapterName ? { chapterName: context.chapterName } : {}),
    ...(context?.chapterNumber ? { chapterNumber: context.chapterNumber } : {}),
    ...(context?.chapterPosition
      ? { chapterPosition: context.chapterPosition }
      : {}),
    ...(context?.novelId ? { novelId: context.novelId } : {}),
    ...(context?.novelName ? { novelName: context.novelName } : {}),
    ...(context?.novelPath ? { novelPath: context.novelPath } : {}),
    ...(context?.sourceId ? { sourceId: context.sourceId } : {}),
  });
}

function chapterMediaStoreArgs({
  chapterId,
  chapterName,
  chapterNumber,
  chapterPosition,
  fileName,
  novelId,
  novelName,
  novelPath,
  sourceId,
}: Omit<ChapterMediaStoreInput, "body" | "contentType">): Record<
  string,
  unknown
> {
  return {
    chapterId,
    ...(chapterName ? { chapterName } : {}),
    ...(chapterNumber ? { chapterNumber } : {}),
    ...(chapterPosition ? { chapterPosition } : {}),
    fileName,
    ...(novelId ? { novelId } : {}),
    ...(novelName ? { novelName } : {}),
    ...(novelPath ? { novelPath } : {}),
    ...(sourceId ? { sourceId } : {}),
  };
}

function isNativeStreamInfo(value: unknown): value is NativeStreamInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as NativeStreamInfo).handle === "string" &&
    (value as NativeStreamInfo).handle.trim() !== ""
  );
}

function isNativeStoreFallbackError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /native stream unavailable|chapter media handle store unavailable|unknown command|command .*not found|not found.*command|not registered/i.test(
    message,
  );
}

async function storeChapterMediaLegacy(
  input: ChapterMediaStoreInput,
): Promise<string> {
  return invoke<string>("chapter_media_store", {
    body: chapterMediaBytesToArray(input.body),
    ...chapterMediaStoreArgs(input),
  });
}

async function storeChapterMediaHandle(
  input: ChapterMediaStoreInput,
): Promise<string> {
  let handle: string | null = null;
  try {
    const stream = await createNativeStream({
      domain: CHAPTER_MEDIA_STREAM_DOMAIN,
      maxBytes: Math.max(chapterMediaByteLength(input.body), 1),
    });
    if (!isNativeStreamInfo(stream)) {
      throw new Error("native stream unavailable");
    }
    handle = stream.handle;
    await writeNativeStream(handle, input.body);
    await finishNativeStream(handle);
    const storedSrc = await invoke<string>("chapter_media_store_handle", {
      handle,
      ...chapterMediaStoreArgs(input),
    });
    if (typeof storedSrc !== "string" || storedSrc.trim() === "") {
      throw new Error("chapter media handle store unavailable");
    }
    handle = null;
    return storedSrc;
  } catch (error) {
    if (handle) {
      await cancelNativeStream(handle).catch(() => undefined);
    }
    if (isNativeStoreFallbackError(error)) {
      return storeChapterMediaLegacy(input);
    }
    throw error;
  }
}

export async function storeCapturedChapterMediaHandle(
  input: Omit<ChapterMediaStoreInput, "body" | "contentType">,
  handle: string,
): Promise<string> {
  try {
    const storedSrc = await invoke<string>("chapter_media_store_handle", {
      handle,
      ...chapterMediaStoreArgs(input),
    });
    if (typeof storedSrc !== "string" || storedSrc.trim() === "") {
      throw new Error("chapter media captured handle store unavailable");
    }
    return storedSrc;
  } catch (error) {
    await cancelNativeStream(handle).catch(() => undefined);
    throw error;
  }
}

export async function storeChapterMedia({
  body,
  chapterId,
  chapterName,
  chapterNumber,
  chapterPosition,
  contentType,
  fileName,
  novelId,
  novelName,
  novelPath,
  sourceId,
}: ChapterMediaStoreInput): Promise<string> {
  const outputSrc = localChapterMediaOutputSrc(fileName);
  if (isAndroidRuntime()) {
    const context = {
      chapterId,
      chapterName,
      chapterNumber,
      chapterPosition,
      novelId,
      novelName,
      novelPath,
      sourceId,
    };
    const relativePath = androidChapterMediaRelativePathForContext(
      context,
      fileName,
    );
    await writeAndroidStorageBytes(
      relativePath,
      body,
      contentType ?? mimeTypeFromFileName(fileName),
    );
    return outputSrc;
  }
  await storeChapterMediaHandle({
    body,
    chapterId,
    chapterName,
    chapterNumber,
    chapterPosition,
    contentType,
    fileName,
    novelId,
    novelName,
    novelPath,
    sourceId,
  });
  return outputSrc;
}

export async function archiveChapterMediaCache({
  chapterId,
  chapterName,
  chapterNumber,
  chapterPosition,
  novelId,
  novelName,
  novelPath,
  sourceId,
}: ChapterMediaArchiveInput): Promise<number> {
  if (isAndroidRuntime()) {
    const context = {
      chapterId,
      chapterName,
      chapterNumber,
      chapterPosition,
      novelId,
      novelName,
      novelPath,
      sourceId,
    };
    return archiveAndroidStorageDirectory(
      androidChapterMediaRelativePathForContext(context),
      androidChapterMediaArchiveRelativePathForContext(context),
    );
  }
  return invoke<number>("chapter_media_archive_cache", {
    chapterId,
    ...(chapterName ? { chapterName } : {}),
    ...(chapterNumber ? { chapterNumber } : {}),
    ...(chapterPosition ? { chapterPosition } : {}),
    ...(novelId ? { novelId } : {}),
    ...(novelName ? { novelName } : {}),
    ...(novelPath ? { novelPath } : {}),
    ...(sourceId ? { sourceId } : {}),
  });
}

export async function prepareChapterMediaWorkspace(
  context: ChapterMediaStorageContext,
  repair: boolean,
  { preserveExisting = false }: { preserveExisting?: boolean } = {},
): Promise<void> {
  if (isAndroidRuntime()) {
    if (!repair && !preserveExisting) {
      await deleteAndroidStoragePaths([
        ...androidChapterMediaRelativePathCandidates(context),
        ...androidChapterMediaTransactionPaths({
          archivePaths:
            androidChapterMediaArchiveRelativePathCandidates(context),
          manifestPaths:
            androidChapterMediaManifestRelativePathCandidates(context),
        }),
      ]);
    }
    return;
  }
  await invoke("chapter_media_prepare_workspace", {
    repair,
    preserveExisting,
    chapterId: context.chapterId,
    ...(context.chapterName ? { chapterName: context.chapterName } : {}),
    ...(context.chapterNumber ? { chapterNumber: context.chapterNumber } : {}),
    ...(context.chapterPosition
      ? { chapterPosition: context.chapterPosition }
      : {}),
    ...(context.novelId ? { novelId: context.novelId } : {}),
    ...(context.novelName ? { novelName: context.novelName } : {}),
    ...(context.novelPath ? { novelPath: context.novelPath } : {}),
    ...(context.sourceId ? { sourceId: context.sourceId } : {}),
  });
}

export async function androidStoredManifestFileBytes(
  context: ChapterMediaStorageContext,
  manifest: ChapterMediaManifest,
): Promise<Map<string, number> | null> {
  if (!isAndroidRuntime()) return null;
  const fileNames = new Set(
    manifest.media.files
      .filter((file) => file.status === "stored" && file.bytes > 0)
      .map((file) => file.fileName),
  );
  const storedBytes = new Map<string, number>();
  const archiveCandidates = new Set(fileNames);

  for (const fileName of fileNames) {
    for (const path of await androidRelativePathsFromLocalMediaSrc(
      localChapterMediaSrc(fileName),
      context,
    )) {
      const bytes = await androidStoragePathSize(path);
      if (bytes <= 0) continue;
      storedBytes.set(fileName, bytes);
      archiveCandidates.delete(fileName);
      break;
    }
  }

  for (const archivePath of androidChapterMediaArchiveRelativePathCandidates(
    context,
  )) {
    if (archiveCandidates.size === 0) break;
    const sizes = await androidStorageZipEntrySizes(archivePath, [
      ...archiveCandidates,
    ]);
    if (sizes == null) return null;
    for (const fileName of archiveCandidates) {
      const bytes = sizes.get(fileName);
      if (bytes === undefined) continue;
      storedBytes.set(fileName, bytes);
      archiveCandidates.delete(fileName);
    }
  }
  return storedBytes;
}

function chapterMediaInvokeArgs(
  mediaSrc: string,
  context?: ChapterMediaStorageContext,
): Record<string, unknown> {
  return {
    mediaSrc,
    ...(context?.chapterId ? { chapterId: context.chapterId } : {}),
    ...(context?.chapterName ? { chapterName: context.chapterName } : {}),
    ...(context?.chapterNumber ? { chapterNumber: context.chapterNumber } : {}),
    ...(context?.chapterPosition
      ? { chapterPosition: context.chapterPosition }
      : {}),
    ...(context?.novelId ? { novelId: context.novelId } : {}),
    ...(context?.novelName ? { novelName: context.novelName } : {}),
    ...(context?.novelPath ? { novelPath: context.novelPath } : {}),
    ...(context?.sourceId ? { sourceId: context.sourceId } : {}),
  };
}

export async function prepareLocalChapterMediaSources(
  sources: string[],
  context?: ChapterMediaStorageContext,
): Promise<Map<string, string | null>> {
  const resolved = new Map<string, string | null>();
  if (!isTauriRuntime() || !isAndroidRuntime()) return resolved;
  const preparedArchives = new Map<string, Promise<boolean>>();

  const prepareArchive = (
    mediaPath: string,
    archivePath: string,
  ): Promise<boolean> => {
    const key = `${mediaPath}\u0000${archivePath}`;
    const cached = preparedArchives.get(key);
    if (cached) return cached;
    const result = Promise.resolve(
      prepareAndroidReaderMediaCache(
        mediaPath,
        archivePath,
        androidReaderMediaCacheToken(archivePath),
      ),
    )
      .then(() => true)
      .catch(() => false);
    preparedArchives.set(key, result);
    return result;
  };

  await Promise.all(
    sources.map(async (source) => {
      const fileName = localChapterMediaFileName(source, context);
      if (!fileName) {
        resolved.set(source, null);
        return;
      }
      for (const {
        archivePath,
        mediaPath,
      } of androidChapterMediaSourceCandidates(context)) {
        if (await prepareArchive(mediaPath, archivePath)) {
          resolved.set(
            source,
            androidReaderLocalChapterMediaSrc(fileName, archivePath),
          );
          return;
        }
      }
      resolved.set(source, null);
    }),
  );
  return resolved;
}

export async function resolveLocalChapterMediaSrc(
  src: string,
  context?: ChapterMediaStorageContext,
): Promise<string | null> {
  const fileName = localChapterMediaFileName(src, context);
  if (!fileName) return src.startsWith(LOCAL_MEDIA_SRC_PREFIX) ? null : src;
  if (!isTauriRuntime()) return src;
  if (isAndroidRuntime()) {
    for (const {
      archivePath,
      mediaPath,
    } of androidChapterMediaSourceCandidates(context)) {
      try {
        await prepareAndroidReaderMediaCache(
          mediaPath,
          archivePath,
          androidReaderMediaCacheToken(archivePath),
        );
        return androidReaderLocalChapterMediaSrc(fileName, archivePath);
      } catch {
        continue;
      }
    }
    return null;
  }
  try {
    return await invoke<string>(
      "chapter_media_data_url",
      chapterMediaInvokeArgs(
        localChapterMediaSourceForContext(src, context) ?? src,
        context,
      ),
    );
  } catch {
    return null;
  }
}

export async function pruneChapterMedia(
  chapterId: number,
  context?: ChapterMediaStorageContext,
): Promise<void> {
  if (!isTauriRuntime()) return;
  const resolvedContext =
    context ?? (await storageContextForChapter(chapterId));
  if (isAndroidRuntime()) {
    await deleteAndroidStoragePath(`chapter-media/${chapterId}`);
    return;
  }
  await invoke("chapter_media_prune", {
    chapterId,
    ...(resolvedContext?.chapterName
      ? { chapterName: resolvedContext.chapterName }
      : {}),
    ...(resolvedContext?.chapterNumber
      ? { chapterNumber: resolvedContext.chapterNumber }
      : {}),
    ...(resolvedContext?.chapterPosition
      ? { chapterPosition: resolvedContext.chapterPosition }
      : {}),
    ...(resolvedContext?.novelId ? { novelId: resolvedContext.novelId } : {}),
    ...(resolvedContext?.novelName
      ? { novelName: resolvedContext.novelName }
      : {}),
    ...(resolvedContext?.novelPath
      ? { novelPath: resolvedContext.novelPath }
      : {}),
    ...(resolvedContext?.sourceId
      ? { sourceId: resolvedContext.sourceId }
      : {}),
  });
}

export async function clearChapterMedia(
  chapterId: number,
  context?: ChapterMediaStorageContext,
): Promise<void> {
  if (!isTauriRuntime()) return;
  const resolvedContext =
    context ?? (await storageContextForChapter(chapterId));
  if (isAndroidRuntime()) {
    const contextualPaths = hasStorageContext(resolvedContext)
      ? [
          resolvedAndroidChapterStoragePath(
            resolvedContext,
            chapterMediaDirectoryRelativePath(
              storageNovelPathInput(resolvedContext),
              storageChapterPathInput(resolvedContext),
            ),
          ),
          ...androidChapterMediaTransactionPaths({
            archivePaths: [
              androidChapterMediaArchiveRelativePathForContext(resolvedContext),
            ],
            manifestPaths: [
              androidChapterMediaManifestRelativePath(resolvedContext),
            ],
          }),
        ]
      : [];
    await deleteAndroidStoragePaths([
      ...contextualPaths,
      `chapter-media/${chapterId}`,
    ]);
    return;
  }
  await invoke("chapter_media_clear", {
    chapterId,
    ...(resolvedContext?.chapterName
      ? { chapterName: resolvedContext.chapterName }
      : {}),
    ...(resolvedContext?.chapterNumber
      ? { chapterNumber: resolvedContext.chapterNumber }
      : {}),
    ...(resolvedContext?.chapterPosition
      ? { chapterPosition: resolvedContext.chapterPosition }
      : {}),
    ...(resolvedContext?.novelId ? { novelId: resolvedContext.novelId } : {}),
    ...(resolvedContext?.novelName
      ? { novelName: resolvedContext.novelName }
      : {}),
    ...(resolvedContext?.novelPath
      ? { novelPath: resolvedContext.novelPath }
      : {}),
    ...(resolvedContext?.sourceId
      ? { sourceId: resolvedContext.sourceId }
      : {}),
  });
}

export async function clearAllChapterMedia(): Promise<void> {
  if (!isTauriRuntime()) return;
  if (isAndroidRuntime()) {
    await clearAndroidStorageRoot();
    return;
  }
  await invoke("chapter_media_clear_all");
}
