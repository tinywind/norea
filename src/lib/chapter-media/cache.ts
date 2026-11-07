import { throwIfAborted } from "../abort";
import { withChapterDownloadWrite } from "../chapter-download-writes";
import { pluginMediaFetch, takeCapturedMediaHandle } from "../http";
import { HttpStatusError, isHttpNotFoundError } from "../http/status-error";
import { cancelNativeStream } from "../native-stream";
import { runBoundedTaskBatch } from "../tasks/batch-window";
import { isTauriRuntime } from "../tauri-runtime";
import {
  CHAPTER_MEDIA_CANCELLED_MESSAGE,
  ChapterMediaDownloadSession,
} from "./download-session";
import {
  ChapterMediaFinalizationError,
  ChapterMediaIncompleteError,
  isMediaAbortError,
  recordChapterMediaFailure,
} from "./errors";
import {
  applyRemoteMediaFallback,
  applyResolvedMediaSource,
  clearMediaSourceMetadata,
  collectMediaTargets,
  emitHtmlUpdate,
  emitMediaPatchUpdate,
  fileNameFromLocalMediaSrc,
  localChapterMediaSources,
  normalizeLocalChapterMediaOutput,
  tagCollectedMediaTargets,
} from "./html";
import { emptyChapterMediaManifest } from "./manifest";
import { createChapterMediaManifestWriter } from "./manifest-writer";
import {
  collectStoredManifestMediaSources,
} from "./recovery";
import {
  bytesFromArrayBuffer,
  chapterMediaByteLength,
  mediaFileName,
  localChapterMediaOutputSrc,
  uniqueFileName,
} from "./sources";
import {
  androidStoredManifestFileBytes,
  archiveChapterMediaCache,
  prepareChapterMediaWorkspace,
  readChapterMediaManifest,
  storeCapturedChapterMediaHandle,
  storeChapterMedia,
  writeChapterMediaManifest,
} from "./storage";
import {
  type CacheChapterMediaOptions,
  type CacheChapterMediaResult,
  type ChapterMediaFailure,
  type ChapterMediaManifestFile,
  type ChapterMediaStorageContext,
  type EmbeddedChapterMediaResource,
} from "./types";

const DEFAULT_MEDIA_ACCEPT =
  "image/avif,image/webp,image/apng,image/svg+xml,image/*,video/*,audio/*,*/*;q=0.8";

const CHAPTER_MEDIA_STORE_WINDOW = 1;

export async function cacheHtmlChapterMedia({
  baseUrl,
  chapterId,
  chapterName,
  chapterNumber,
  chapterPosition,
  contextUrl,
  fetchMissingMedia,
  html,
  novelId,
  novelName,
  sourceNovelId,
  onHtmlUpdate,
  onMediaPatch,
  onProgress,
  requestInit,
  repair = false,
  requireComplete = false,
  scraperExecutor,
  shouldYield,
  signal,
  sourceId,
  sourceAccessUrl,
}: CacheChapterMediaOptions): Promise<CacheChapterMediaResult> {
  if (!isTauriRuntime() || typeof document === "undefined") {
    return {
      html,
      mediaBytes: 0,
      mediaFailures: [],
      storedMediaCount: 0,
    };
  }

  const template = document.createElement("template");
  template.innerHTML = html;
  const { srcTargets, srcsetTargets, styleTargets, urls } = collectMediaTargets(
    template.content,
    baseUrl,
  );

  if (urls.length === 0 && !repair) {
    return {
      html: normalizeLocalChapterMediaOutput(template.innerHTML),
      mediaBytes: 0,
      mediaFailures: [],
      storedMediaCount: 0,
    };
  }

  const storageContext: ChapterMediaStorageContext = {
    chapterId,
    chapterName,
    chapterNumber,
    chapterPosition,
    novelId,
    novelName,
    sourceNovelId,
    sourceId,
  };
  const mediaContextUrl = contextUrl ?? baseUrl ?? undefined;
  const mediaFailures: ChapterMediaFailure[] = [];
  let previousManifest = await readChapterMediaManifest(storageContext, true);
  let storedFileBytes: Map<string, number> | null = repair
    ? await withChapterDownloadWrite(chapterId, signal, () => prepareChapterMediaWorkspace(storageContext, true))
    : null;
  const fetchedSourceUrls = new Set(urls);
  const resetChangedMedia =
    !repair &&
    previousManifest.media.files.some(
      (file) => !fetchedSourceUrls.has(file.sourceUrl),
    );
  if (resetChangedMedia) {
    storedFileBytes = await withChapterDownloadWrite(chapterId, signal, () =>
      prepareChapterMediaWorkspace(storageContext, repair),
    );
  }
  if (resetChangedMedia) previousManifest = emptyChapterMediaManifest();
  const localSources = new Map<string, string>();
  const missingManifestSources = new Map<string, string>();
  if (repair) {
    const names = new Set(previousManifest.media.files.map((file) => file.fileName));
    for (const src of localChapterMediaSources(html, storageContext)) {
      const name = fileNameFromLocalMediaSrc(src, chapterId);
      if (name && !names.has(name)) throw new Error(`Chapter media manifest is missing asset: ${name}`);
    }
    previousManifest.media.files = previousManifest.media.files.map((file) => {
      const bytes = storedFileBytes?.get(file.fileName);
      if (bytes !== undefined && bytes > 0) {
        localSources.set(file.sourceUrl, localChapterMediaOutputSrc(file.fileName));
        return { ...file, bytes, status: "stored" };
      }
      if (!fetchMissingMedia && !/^https?:\/\//i.test(file.sourceUrl)) {
        throw new Error(`Cannot repair media asset without a source URL: ${file.fileName}`);
      }
      missingManifestSources.set(file.sourceUrl, localChapterMediaOutputSrc(file.fileName));
      return { ...file, status: "remote" };
    });
  } else {
    storedFileBytes = await androidStoredManifestFileBytes(storageContext, previousManifest);
    const manifestSources = await collectStoredManifestMediaSources({
      context: storageContext, manifest: previousManifest, storedFileBytes, urls,
    });
    for (const [url, src] of manifestSources) localSources.set(url, src);
  }
  const currentSourceUrls = new Set([
    ...urls,
    ...missingManifestSources.keys(),
  ]);
  const retainedManifestFiles = repair
    ? previousManifest.media.files
    : previousManifest.media.files.filter((file) =>
        currentSourceUrls.has(file.sourceUrl),
      );
  const mediaFilesBySourceUrl = new Map(
    retainedManifestFiles.map((file) => [file.sourceUrl, file]),
  );
  const usedFileNames = new Set(
    [...mediaFilesBySourceUrl.values()].map((file) => file.fileName),
  );
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index]!;
    const existing = mediaFilesBySourceUrl.get(url);
    if (existing) {
      mediaFilesBySourceUrl.set(url, {
        ...existing,
        status: localSources.has(url) ? "stored" : "remote",
      });
      continue;
    }
    const fileName = mediaFileName(index, url, null, usedFileNames);
    mediaFilesBySourceUrl.set(url, {
      bytes: 0,
      fileName,
      path: `media/${fileName}`,
      sourceUrl: url,
      status: "remote",
      updatedAt: Date.now(),
    });
  }
  for (const url of missingManifestSources.keys()) {
    const existing = mediaFilesBySourceUrl.get(url);
    if (existing) {
      mediaFilesBySourceUrl.set(url, {
        ...existing,
        status: "remote",
        updatedAt: Date.now(),
      });
    }
  }
  const downloadUrls = [
    ...new Set(
      [
        ...urls.filter((url) => !localSources.has(url)),
        ...missingManifestSources.keys(),
      ].filter((url) => !localSources.has(url)),
    ),
  ];
  let storedMediaCount = 0;
  const mediaController = new AbortController();
  const mediaSignal = signal
    ? AbortSignal.any([signal, mediaController.signal])
    : mediaController.signal;
  const session = new ChapterMediaDownloadSession({
    total: downloadUrls.length,
    onProgress,
    shouldYield,
    signal,
  });
  tagCollectedMediaTargets(srcTargets, srcsetTargets);
  const reusableChangedElements = new Set<Element>();
  for (const url of localSources.keys()) {
    const changedElements = applyResolvedMediaSource({
      baseUrl,
      localSources,
      srcTargets,
      srcsetTargets,
      styleTargets,
      url,
    });
    for (const element of changedElements) {
      reusableChangedElements.add(element);
    }
  }
  if (reusableChangedElements.size > 0) {
    await emitHtmlUpdate(onHtmlUpdate, template);
    await emitMediaPatchUpdate(onMediaPatch, template, reusableChangedElements);
  }
  if (!repair && !resetChangedMedia) {
    await withChapterDownloadWrite(chapterId, signal, () =>
      prepareChapterMediaWorkspace(storageContext, repair, {
        preserveExisting: true,
      }),
    );
  }
  const manifestWriter = createChapterMediaManifestWriter(
    () => [...mediaFilesBySourceUrl.values()],
    (files) =>
      withChapterDownloadWrite(chapterId, signal, () =>
        writeChapterMediaManifest({ context: storageContext, files }),
      ),
    (error) => {
      session.fail(error);
      mediaController.abort(error);
    },
  );
  if (downloadUrls.length > 0) {
    await manifestWriter.flush();
  }

  const materializeMedia = async (
    url: string,
    index: number,
  ): Promise<void> => {
    if (session.failed) return;
    let capturedHandle: Awaited<ReturnType<typeof takeCapturedMediaHandle>> =
      null;
    let releaseFallbackAcquisition: (() => void) | undefined;
    const releaseMediaAcquisition = (): void => {
      releaseFallbackAcquisition?.();
      releaseFallbackAcquisition = undefined;
    };
    try {
      throwIfAborted(signal, CHAPTER_MEDIA_CANCELLED_MESSAGE);
      const mediaIndex = urls.indexOf(url);
      if (localSources.has(url)) {
        session.reportProgress();
        return;
      }
      const mediaRequest = {
        ...requestInit,
        headers: {
          Accept: DEFAULT_MEDIA_ACCEPT,
          ...(requestInit?.headers ?? {}),
        },
        ...(mediaContextUrl ? { contextUrl: mediaContextUrl } : {}),
        ...(scraperExecutor ? { scraperExecutor } : {}),
        signal: mediaSignal,
        ...(sourceId ? { sourceId } : {}),
        ...(sourceAccessUrl ? { sourceAccessUrl } : {}),
      };
      let response = fetchMissingMedia
        ? await fetchMissingMedia(mediaFilesBySourceUrl.get(url)!, mediaSignal)
        : null;
      if (session.failed) session.throwIfStopped();
      if (!response) {
        const acquisition = await session.acquireCapturedMedia(url, mediaRequest);
        capturedHandle = acquisition.capturedHandle;
        releaseFallbackAcquisition = acquisition.releaseFallback;
        if (session.failed) session.throwIfStopped();
        response = capturedHandle ? null : await pluginMediaFetch(url, mediaRequest);
      }
      if (session.failed) session.throwIfStopped();
      const status = capturedHandle?.status ?? response?.status ?? 0;
      const statusText =
        capturedHandle?.statusText ?? response?.statusText ?? "";
      const responseOk = capturedHandle
        ? capturedHandle.status >= 200 && capturedHandle.status < 300
        : response?.ok === true;
      if (!responseOk) {
        if (status !== 404) {
          throw new HttpStatusError(status, `Chapter media request failed (HTTP ${status} ${statusText}).`);
        }
        if (capturedHandle) {
          await cancelNativeStream(capturedHandle.bodyHandle).catch(
            () => undefined,
          );
          capturedHandle = null;
        }
        await session.runUpdate(async () => {
          recordChapterMediaFailure(mediaFailures, {
            contextUrl: mediaContextUrl ?? url,
            error: `HTTP ${status} ${statusText}`,
            fileName: mediaFilesBySourceUrl.get(url)?.fileName,
            scraperExecutor,
            sourceId,
            status,
            url,
          });
          applyRemoteMediaFallback({
            baseUrl,
            srcTargets,
            srcsetTargets,
            styleTargets,
            url,
          });
        });
      } else {
        throwIfAborted(signal, CHAPTER_MEDIA_CANCELLED_MESSAGE);
        const contentType = capturedHandle
          ? new Headers(capturedHandle.headers).get("content-type")
          : response!.headers.get("content-type");
        const manifestFile =
          mediaFilesBySourceUrl.get(url) ??
          ({
            bytes: 0,
            fileName: mediaFileName(
              mediaIndex >= 0 ? mediaIndex : index,
              url,
              contentType,
              usedFileNames,
            ),
            path: "",
            sourceUrl: url,
            status: "remote",
            updatedAt: Date.now(),
          } satisfies ChapterMediaManifestFile);
        const fileName = manifestFile.fileName;
        let storedBytes: number;
        let src: string;
        if (capturedHandle) {
          storedBytes = capturedHandle.bodyBytes;
          if (storedBytes <= 0) throw new Error("Downloaded chapter media asset is empty.");
          const bodyHandle = capturedHandle.bodyHandle;
          capturedHandle = null;
          src = await withChapterDownloadWrite(chapterId, signal, () =>
            storeCapturedChapterMediaHandle(
              {
                chapterId,
                fileName,
                chapterName,
                chapterNumber,
                chapterPosition,
                novelId,
                novelName,
                sourceNovelId,
                sourceId,
              },
              bodyHandle,
            ),
          );
        } else {
          const body = bytesFromArrayBuffer(await response!.arrayBuffer());
          throwIfAborted(signal, CHAPTER_MEDIA_CANCELLED_MESSAGE);
          storedBytes = chapterMediaByteLength(body);
          if (storedBytes <= 0) throw new Error("Downloaded chapter media asset is empty.");
          src = await withChapterDownloadWrite(chapterId, signal, () =>
            storeChapterMedia({
              body,
              chapterId,
              contentType,
              fileName,
              chapterName,
              chapterNumber,
              chapterPosition,
              novelId,
              novelName,
              sourceNovelId,
              sourceId,
            }),
          );
        }
        await session.runUpdate(async () => {
          localSources.set(url, src);
          mediaFilesBySourceUrl.set(url, {
            ...manifestFile,
            bytes: storedBytes,
            ...(contentType ? { contentType } : {}),
            fileName,
            path: `media/${fileName}`,
            sourceUrl: url,
            status: "stored",
            updatedAt: Date.now(),
          });
          await manifestWriter.progress();
          storedMediaCount += 1;
          const changedElements = applyResolvedMediaSource({
            baseUrl,
            localSources,
            srcTargets,
            srcsetTargets,
            styleTargets,
            url,
          });
          await emitHtmlUpdate(onHtmlUpdate, template);
          await emitMediaPatchUpdate(onMediaPatch, template, changedElements);
        });
      }
    } catch (error) {
      if (capturedHandle) {
        await cancelNativeStream(capturedHandle.bodyHandle).catch(
          () => undefined,
        );
        capturedHandle = null;
      }
      if (signal?.aborted) {
        session.fail(new DOMException("Task was cancelled.", "AbortError"));
        releaseMediaAcquisition();
        return;
      }
      if (isMediaAbortError(error)) {
        session.fail(error);
        releaseMediaAcquisition();
        return;
      }
      if (!isHttpNotFoundError(error)) {
        session.fail(error);
        releaseMediaAcquisition();
        return;
      }
      try {
        await session.runUpdate(async () => {
          recordChapterMediaFailure(mediaFailures, {
            contextUrl: mediaContextUrl ?? url,
            error,
            status: 404,
            fileName: mediaFilesBySourceUrl.get(url)?.fileName,
            scraperExecutor,
            sourceId,
            url,
          });
          applyRemoteMediaFallback({
            baseUrl,
            srcTargets,
            srcsetTargets,
            styleTargets,
            url,
          });
        });
      } catch (updateError) {
        session.fail(updateError);
        releaseMediaAcquisition();
        return;
      }
    }
    releaseMediaAcquisition();
    if (signal?.aborted) {
      session.fail(new DOMException("Task was cancelled.", "AbortError"));
      return;
    }
    session.reportProgress();
  };

  try {
    await runBoundedTaskBatch({
      items: downloadUrls,
      materialize: materializeMedia,
      shouldContinue: () =>
        !session.failed && signal?.aborted !== true && shouldYield?.() !== true,
      windowSize: CHAPTER_MEDIA_STORE_WINDOW,
    });
    session.throwIfStopped();
  } catch (error) {
    // Keep stored media listed for an explicit resume without retrying a failed write.
    try {
      await manifestWriter.flush();
    } catch (flushError) {
      if (!isMediaAbortError(flushError)) throw flushError;
    }
    throw error;
  }

  let mediaBytes: number;
  try {
    await manifestWriter.flush();
    mediaBytes = await withChapterDownloadWrite(chapterId, signal, () =>
      archiveChapterMediaCache({
        chapterId,
        chapterName,
        chapterNumber,
        chapterPosition,
        novelId,
        novelName,
        sourceNovelId,
        sourceId,
      }),
    );
  } catch (error) {
    throwIfAborted(signal, CHAPTER_MEDIA_CANCELLED_MESSAGE);
    if (isMediaAbortError(error)) throw error;
    const finalizationError = new ChapterMediaFinalizationError(error);
    console.warn("[chapter-media] media finalization failed", {
      error: finalizationError.message,
      sourceId,
    });
    throw finalizationError;
  }
  if (requireComplete && mediaFailures.length > 0) {
    throw new ChapterMediaIncompleteError(mediaFailures);
  }
  clearMediaSourceMetadata(template.content);

  return {
    html: normalizeLocalChapterMediaOutput(template.innerHTML),
    mediaFailures,
    mediaBytes,
    storedMediaCount,
  };
}

export async function storeEmbeddedChapterMedia({
  chapterId,
  chapterName,
  chapterNumber,
  chapterPosition,
  html,
  novelId,
  novelName,
  sourceNovelId,
  resources,
  signal,
  sourceId,
}: {
  chapterId: number;
  chapterName?: string | null;
  chapterNumber?: string | null;
  chapterPosition?: number | null;
  html: string;
  novelId?: number | null;
  novelName?: string | null;
  sourceNovelId?: string | null;
  resources: EmbeddedChapterMediaResource[];
  signal?: AbortSignal;
  sourceId?: string | null;
}): Promise<
  Pick<CacheChapterMediaResult, "html" | "mediaBytes" | "storedMediaCount">
> {
  const uniqueResources = [
    ...new Map(
      resources.map((resource) => [resource.placeholder, resource]),
    ).values(),
  ].filter(
    (resource) =>
      resource.placeholder && chapterMediaByteLength(resource.bytes) > 0,
  );
  if (!isTauriRuntime() || uniqueResources.length === 0) {
    return {
      html,
      mediaBytes: 0,
      storedMediaCount: 0,
    };
  }

  const storageContext: ChapterMediaStorageContext = {
    chapterId,
    chapterName,
    chapterNumber,
    chapterPosition,
    novelId,
    novelName,
    sourceNovelId,
    sourceId,
  };
  await withChapterDownloadWrite(chapterId, signal, () =>
    prepareChapterMediaWorkspace(storageContext, false),
  );

  let rewrittenHtml = html;
  const files: ChapterMediaManifestFile[] = [];
  const usedFileNames = new Set<string>();
  let storedMediaCount = 0;
  for (const resource of uniqueResources) {
    const fileName = uniqueFileName(resource.fileName, usedFileNames);
    const src = await withChapterDownloadWrite(chapterId, signal, () =>
      storeChapterMedia({
        body: resource.bytes,
        chapterId,
        chapterName,
        chapterNumber,
        chapterPosition,
        contentType: resource.contentType,
        fileName,
        novelId: novelId ?? undefined,
        novelName,
        sourceNovelId,
        sourceId: sourceId ?? undefined,
      }),
    );
    rewrittenHtml = rewrittenHtml.split(resource.placeholder).join(src);
    files.push({
      bytes: chapterMediaByteLength(resource.bytes),
      ...(resource.contentType ? { contentType: resource.contentType } : {}),
      fileName,
      path: `media/${fileName}`,
      sourceUrl: resource.sourcePath ?? resource.placeholder,
      status: "stored",
      updatedAt: Date.now(),
    });
    storedMediaCount += 1;
  }

  let mediaBytes: number;
  try {
    await withChapterDownloadWrite(chapterId, signal, () =>
      writeChapterMediaManifest({ context: storageContext, files }),
    );
    mediaBytes = await withChapterDownloadWrite(chapterId, signal, () =>
      archiveChapterMediaCache({
        chapterId,
        chapterName,
        chapterNumber,
        chapterPosition,
        novelId: novelId ?? undefined,
        novelName,
        sourceNovelId,
        sourceId: sourceId ?? undefined,
      }),
    );
  } catch (error) {
    throwIfAborted(signal, CHAPTER_MEDIA_CANCELLED_MESSAGE);
    if (isMediaAbortError(error)) throw error;
    const finalizationError = new ChapterMediaFinalizationError(error);
    console.warn("[chapter-media] embedded media finalization failed", {
      error: finalizationError.message,
      sourceId,
    });
    throw finalizationError;
  }
  return {
    html: normalizeLocalChapterMediaOutput(rewrittenHtml),
    mediaBytes,
    storedMediaCount,
  };
}
