import { invoke } from "@tauri-apps/api/core";
import {
  androidStoragePathSize,
  androidStorageZipEntryExists,
  androidStorageZipEntrySizes,
  archiveAndroidStorageDirectory,
  clearAndroidStorageRoot,
  deleteAndroidStoragePaths,
  prepareAndroidReaderMediaCache,
  prepareAndroidChapterMediaRepair,
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
  parseChapterMediaManifest,
  serializeChapterMediaManifest,
} from "./manifest";
import {
  androidReaderLocalChapterMediaSrc,
  androidReaderMediaCacheToken,
  chapterMediaByteLength,
  LOCAL_MEDIA_SRC_PREFIX,
  localChapterMediaFileName,
  localChapterMediaOutputSrc,
  localChapterMediaSourceForContext,
  mimeTypeFromFileName,
} from "./sources";
import {
  androidChapterMediaArchiveRelativePathForContext,
  androidChapterMediaManifestRelativePath,
  androidChapterMediaRelativePathForContext,
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
  if (isAndroidRuntime()) {
    const manifestPath = androidChapterMediaManifestRelativePath(context);
    console.info("[chapter-media] write media manifest", {
      complete,
      fileCount: files.length,
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
    ...(context.sourceNovelId ? { sourceNovelId: context.sourceNovelId } : {}),
    ...(context.sourceId ? { sourceId: context.sourceId } : {}),
  });
}

export async function readChapterMediaManifest(
  context: ChapterMediaStorageContext,
  strict = false,
): Promise<ChapterMediaManifest> {
  if (isAndroidRuntime()) {
    const manifestPath = androidChapterMediaManifestRelativePath(context);
    let raw: string | null;
    try {
      raw = await readAndroidStorageText(manifestPath);
    } catch (error) {
      console.warn("[chapter-media] read media manifest failed", {
        error,
        ...chapterMediaManifestLogContext(context),
      });
      throw error;
    }
    return parseChapterMediaManifest(raw, strict);
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
    ...(context.sourceNovelId ? { sourceNovelId: context.sourceNovelId } : {}),
    ...(context.sourceId ? { sourceId: context.sourceId } : {}),
  });
  return parseChapterMediaManifest(raw, strict);
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
    const archivePath = androidChapterMediaArchiveRelativePathForContext(context);
    let archiveCounted = false;
    for (const source of mediaSrcs) {
      const fileName = localChapterMediaFileName(source, context);
      if (!fileName) continue;
      const directSize = await androidStoragePathSize(
        androidChapterMediaRelativePathForContext(context, fileName),
      );
      if (directSize > 0) {
        total += directSize;
        continue;
      }
      if (!archiveCounted && await androidStorageZipEntryExists(archivePath, fileName)) {
        total += await androidStoragePathSize(archivePath);
        archiveCounted = true;
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
    ...(context?.sourceNovelId ? { sourceNovelId: context.sourceNovelId } : {}),
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
  sourceNovelId,
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
    ...(sourceNovelId ? { sourceNovelId } : {}),
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
  sourceNovelId,
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
      sourceNovelId,
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
    sourceNovelId,
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
  sourceNovelId,
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
      sourceNovelId,
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
    ...(sourceNovelId ? { sourceNovelId } : {}),
    ...(sourceId ? { sourceId } : {}),
  });
}

export async function prepareChapterMediaWorkspace(
  context: ChapterMediaStorageContext,
  repair: boolean,
  { preserveExisting = false }: { preserveExisting?: boolean } = {},
): Promise<Map<string, number>> {
  if (isAndroidRuntime()) {
    if (repair) {
      const archivePath = androidChapterMediaArchiveRelativePathForContext(context);
      return prepareAndroidChapterMediaRepair(archivePath.slice(0, -"/media.zip".length));
    }
    if (!repair && !preserveExisting) {
      await deleteAndroidStoragePaths([
        androidChapterMediaRelativePathForContext(context),
        ...androidChapterMediaTransactionPaths({
          archivePath: androidChapterMediaArchiveRelativePathForContext(context),
          manifestPath: androidChapterMediaManifestRelativePath(context),
        }),
      ]);
    }
    return new Map();
  }
  const sizes = await invoke<Record<string, number>>("chapter_media_prepare_workspace", {
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
    ...(context.sourceNovelId ? { sourceNovelId: context.sourceNovelId } : {}),
    ...(context.sourceId ? { sourceId: context.sourceId } : {}),
  });
  return new Map(Object.entries(sizes ?? {}));
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
    const path = androidChapterMediaRelativePathForContext(context, fileName);
    const bytes = await androidStoragePathSize(path);
    if (bytes <= 0) continue;
    storedBytes.set(fileName, bytes);
    archiveCandidates.delete(fileName);
  }

  if (archiveCandidates.size > 0) {
    const archivePath = androidChapterMediaArchiveRelativePathForContext(context);
    const sizes = await androidStorageZipEntrySizes(archivePath, [
      ...archiveCandidates,
    ]);
    for (const fileName of archiveCandidates) {
      const bytes = sizes.get(fileName);
      if (bytes === undefined) continue;
      storedBytes.set(fileName, bytes);
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
    ...(context?.sourceNovelId ? { sourceNovelId: context.sourceNovelId } : {}),
    ...(context?.sourceId ? { sourceId: context.sourceId } : {}),
  };
}

export async function prepareLocalChapterMediaSources(
  sources: string[],
  context?: ChapterMediaStorageContext,
): Promise<Map<string, string | null>> {
  const resolved = new Map<string, string | null>();
  if (!isTauriRuntime() || !isAndroidRuntime()) return resolved;
  if (sources.length === 0 || !hasStorageContext(context)) return resolved;
  const archivePath = androidChapterMediaArchiveRelativePathForContext(context);
  const mediaPath = androidChapterMediaRelativePathForContext(context);
  const prepared = await prepareAndroidReaderMediaCache(
    mediaPath,
    archivePath,
    androidReaderMediaCacheToken(archivePath),
  ).then(() => true).catch(() => false);
  for (const source of sources) {
    const fileName = localChapterMediaFileName(source, context);
    resolved.set(source, prepared && fileName
      ? androidReaderLocalChapterMediaSrc(fileName, archivePath)
      : null);
  }
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
    if (!hasStorageContext(context)) return null;
    const archivePath = androidChapterMediaArchiveRelativePathForContext(context);
    try {
      await prepareAndroidReaderMediaCache(
        androidChapterMediaRelativePathForContext(context),
        archivePath,
        androidReaderMediaCacheToken(archivePath),
      );
      return androidReaderLocalChapterMediaSrc(fileName, archivePath);
    } catch {
      return null;
    }
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
  if (!isTauriRuntime() || isAndroidRuntime()) return;
  const resolvedContext =
    context ?? (await storageContextForChapter(chapterId));
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
    ...(resolvedContext?.sourceNovelId
      ? { sourceNovelId: resolvedContext.sourceNovelId }
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
            archivePath: androidChapterMediaArchiveRelativePathForContext(resolvedContext),
            manifestPath: androidChapterMediaManifestRelativePath(resolvedContext),
          }),
        ]
      : [];
    await deleteAndroidStoragePaths(contextualPaths);
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
    ...(resolvedContext?.sourceNovelId
      ? { sourceNovelId: resolvedContext.sourceNovelId }
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
