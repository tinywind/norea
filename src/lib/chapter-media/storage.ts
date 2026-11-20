import { invoke } from "@tauri-apps/api/core";
import { ChapterStorageError, isChapterStorageError } from "../chapter-storage-error";
import { isMediaAbortError } from "./errors";
import {
  type NativeStreamInfo,
  cancelNativeStream,
  createNativeStream,
  finishNativeStream,
  writeNativeStream,
} from "../native-stream";
import { isAndroidRuntime, isTauriRuntime } from "../tauri-runtime";
import { localChapterMediaSources } from "./html";
import { parseChapterMediaManifest } from "./manifest";
import {
  androidReaderLocalChapterMediaSrc,
  androidReaderMediaCacheToken,
  chapterMediaByteLength,
  LOCAL_MEDIA_SRC_PREFIX,
  localChapterMediaFileName,
  localChapterMediaOutputSrc,
  localChapterMediaSourceForContext,
} from "./sources";
import {
  androidChapterMediaArchiveRelativePathForContext,
  androidChapterMediaRelativePathForContext,
  hasStorageContext,
  storageContextForChapter,
} from "./storage-paths";
import {
  type ChapterMediaArchiveInput,
  type ChapterMediaManifest,
  type ChapterMediaManifestFile,
  type ChapterMediaStorageContext,
  type ChapterMediaStoreInput,
} from "./types";

const CHAPTER_MEDIA_STREAM_DOMAIN = "chapter-media";

function chapterMediaContextArgs(
  context?: ChapterMediaStorageContext | null,
): Record<string, unknown> {
  return {
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

export async function writeChapterMediaManifest({
  complete = false,
  context,
  files,
}: {
  complete?: boolean;
  context: ChapterMediaStorageContext;
  files: ChapterMediaManifestFile[];
}): Promise<void> {
  try {
    await invoke("chapter_media_write_manifest", {
      complete,
      files,
      ...chapterMediaContextArgs(context),
    });
  } catch (error) {
    if (isMediaAbortError(error) || isChapterStorageError(error)) throw error;
    throw new ChapterStorageError("write media manifest", error);
  }
}

export async function readChapterMediaManifest(
  context: ChapterMediaStorageContext,
  strict = false,
): Promise<ChapterMediaManifest> {
  try {
    const raw = await invoke<string | null>("chapter_media_read_manifest", {
      chapterId: context.chapterId,
      ...chapterMediaContextArgs(context),
    });
    return parseChapterMediaManifest(raw, strict);
  } catch (error) {
    if (isMediaAbortError(error) || isChapterStorageError(error)) throw error;
    throw new ChapterStorageError("read media manifest", error);
  }
}

export async function getStoredChapterMediaBytes(
  html: string,
  context?: ChapterMediaStorageContext,
): Promise<number> {
  try {
    if (!isTauriRuntime()) return 0;
    const directSource = localChapterMediaSourceForContext(html, context);
    const mediaSrcs = directSource
      ? [directSource]
      : localChapterMediaSources(html, context);
    if (mediaSrcs.length === 0) return 0;
    return await invoke<number>("chapter_media_total_size", {
      mediaSrcs,
      ...chapterMediaContextArgs(context),
    });
  } catch (error) {
    if (isMediaAbortError(error) || isChapterStorageError(error)) throw error;
    throw new ChapterStorageError("inspect stored media size", error);
  }
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
    if (isMediaAbortError(error) || isChapterStorageError(error)) throw error;
    throw new ChapterStorageError("store media stream", error);
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
    if (isMediaAbortError(error) || isChapterStorageError(error)) throw error;
    throw new ChapterStorageError("store captured media", error);
  }
}

export async function storeChapterMedia(
  input: ChapterMediaStoreInput,
): Promise<string> {
  const outputSrc = localChapterMediaOutputSrc(input.fileName);
  await storeChapterMediaHandle(input);
  return outputSrc;
}

export async function archiveChapterMediaCache(
  input: ChapterMediaArchiveInput,
): Promise<number> {
  try {
    return await invoke<number>("chapter_media_archive_cache", {
      chapterId: input.chapterId,
      ...chapterMediaContextArgs(input),
    });
  } catch (error) {
    if (isMediaAbortError(error) || isChapterStorageError(error)) throw error;
    throw new ChapterStorageError("archive chapter media", error);
  }
}

export async function prepareChapterMediaWorkspace(
  context: ChapterMediaStorageContext,
  repair: boolean,
  { preserveExisting = false }: { preserveExisting?: boolean } = {},
): Promise<Map<string, number>> {
  try {
    const sizes = await invoke<Record<string, number>>(
      "chapter_media_prepare_workspace",
      {
        repair,
        preserveExisting,
        chapterId: context.chapterId,
        ...chapterMediaContextArgs(context),
      },
    );
    return new Map(Object.entries(sizes ?? {}));
  } catch (error) {
    if (isMediaAbortError(error) || isChapterStorageError(error)) throw error;
    throw new ChapterStorageError("prepare chapter media storage", error);
  }
}

export async function androidStoredManifestFileBytes(
  context: ChapterMediaStorageContext,
  manifest: ChapterMediaManifest,
): Promise<Map<string, number> | null> {
  try {
    if (!isAndroidRuntime()) return null;
    const fileNames = [
      ...new Set(
        manifest.media.files
          .filter((file) => file.status === "stored" && file.bytes > 0)
          .map((file) => file.fileName),
      ),
    ];
    if (fileNames.length === 0) return new Map();
    const sizes = await invoke<Record<string, number>>(
      "chapter_media_stored_entry_sizes",
      {
        fileNames,
        chapterId: context.chapterId,
        ...chapterMediaContextArgs(context),
      },
    );
    return new Map(Object.entries(sizes ?? {}));
  } catch (error) {
    if (isMediaAbortError(error) || isChapterStorageError(error)) throw error;
    throw new ChapterStorageError("inspect stored media", error);
  }
}

function chapterMediaInvokeArgs(
  mediaSrc: string,
  context?: ChapterMediaStorageContext,
): Record<string, unknown> {
  return {
    mediaSrc,
    ...chapterMediaContextArgs(context),
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
  const prepared = await invoke("chapter_media_prepare_reader_cache", {
    archiveRelativePath: archivePath,
    cacheToken: androidReaderMediaCacheToken(archivePath),
    mediaRelativePath: mediaPath,
  })
    .then(() => true)
    .catch((error: unknown) => {
      console.warn("[chapter-media] failed to prepare reader media cache", {
        archiveRelativePath: archivePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    });
  for (const source of sources) {
    const fileName = localChapterMediaFileName(source, context);
    resolved.set(
      source,
      prepared && fileName
        ? androidReaderLocalChapterMediaSrc(fileName, archivePath)
        : null,
    );
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
      await invoke("chapter_media_prepare_reader_cache", {
        archiveRelativePath: archivePath,
        cacheToken: androidReaderMediaCacheToken(archivePath),
        mediaRelativePath: androidChapterMediaRelativePathForContext(context),
      });
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
  if (!isTauriRuntime()) return;
  const resolvedContext =
    context ?? (await storageContextForChapter(chapterId));
  await invoke("chapter_media_prune", {
    chapterId,
    ...chapterMediaContextArgs(resolvedContext),
  });
}

export async function clearChapterMedia(
  chapterId: number,
  context?: ChapterMediaStorageContext,
): Promise<void> {
  if (!isTauriRuntime()) return;
  const resolvedContext =
    context ?? (await storageContextForChapter(chapterId));
  await invoke("chapter_media_clear", {
    chapterId,
    ...chapterMediaContextArgs(resolvedContext),
  });
}

export async function clearAllChapterMedia(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("chapter_media_clear_all");
}
