import type { RefObject } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import {
  resolveLocalChapterMediaPatches,
  type ChapterMediaElementPatch,
  type ChapterMediaStorageContext,
} from "../../lib/chapter-media";
import {
  canClearPendingReaderImage,
  clearReaderPendingMedia,
  clearSettledPendingReaderImages,
  collectMountedLocalMediaPatches,
  countBlankReaderMedia,
  countDataUrlReaderMedia,
  hasLocalMediaSourceAttributes,
  isLocalReaderMediaUrl,
  isRemoteMediaUrl,
  localMediaPatchSignature,
  logReaderMediaDebug,
  logReaderMediaPipeline,
  mediaErrorSource,
  mediaLogHost,
  mergeMediaElementPatches,
  patchReaderMediaElements,
  READER_MEDIA_PATCH_ATTRIBUTES,
  readerMediaDebugHash,
  resolveMountedLocalMediaPatchesFromMap,
} from "./reader-content-media";

interface ReaderContentMediaOptions {
  contentKey?: number | string;
  renderedHtml: string;
  localMediaContext?: ChapterMediaStorageContext;
  contentRef: RefObject<HTMLDivElement | null>;
  activeVirtualRangeStart: number;
  activeVirtualRangeEnd: number;
  isPagedReader: boolean;
  onMediaError?: (source: string | null) => void;
}
export function useReaderContentMedia({
  contentKey,
  renderedHtml,
  localMediaContext,
  contentRef,
  activeVirtualRangeStart,
  activeVirtualRangeEnd,
  isPagedReader,
  onMediaError,
}: ReaderContentMediaOptions) {
  const latestMediaElementPatchesRef = useRef<
    Map<number, ChapterMediaElementPatch>
  >(new Map());
  const localMediaPatchGenerationRef = useRef(0);
  const latestLocalMediaSignatureRef = useRef<string | null>(null);
  const pendingLocalMediaSignatureRef = useRef<string | null>(null);
  const unresolvedLocalMediaSignatureRef = useRef<string | null>(null);
  const latestRenderedHtmlRef = useRef<string | null>(null);
  const onMediaErrorRef = useRef(onMediaError);
  onMediaErrorRef.current = onMediaError;
  const pendingMediaErrorRef = useRef<{ source: string | null } | null>(null);
  const resolvedLocalMediaRef = useRef<Map<string, string>>(new Map());
  const localMediaContextKey = useMemo(
    () =>
      localMediaContext
        ? [
            localMediaContext.chapterId,
            localMediaContext.chapterName ?? "",
            localMediaContext.chapterNumber ?? "",
            localMediaContext.chapterPosition ?? "",
            localMediaContext.novelId ?? "",
            localMediaContext.novelName ?? "",
            localMediaContext.sourceNovelId ?? "",
            localMediaContext.sourceId ?? "",
          ].join("\u0000")
        : "",
    [
      localMediaContext?.chapterId,
      localMediaContext?.chapterName,
      localMediaContext?.chapterNumber,
      localMediaContext?.chapterPosition,
      localMediaContext?.novelId,
      localMediaContext?.novelName,
      localMediaContext?.sourceNovelId,
      localMediaContext?.sourceId,
    ],
  );
  const stableLocalMediaContext = useMemo(
    () => localMediaContext,
    [localMediaContextKey],
  );

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (latestRenderedHtmlRef.current === renderedHtml) return;
    latestRenderedHtmlRef.current = renderedHtml;
    logReaderMediaPipeline("html-replace", {
      blankMediaCount: countBlankReaderMedia(renderedHtml),
      dataUrlMediaCount: countDataUrlReaderMedia(renderedHtml),
      htmlLength: renderedHtml.length,
    });
  }, [renderedHtml]);

  const patchMediaElements = useCallback(
    (patches: ChapterMediaElementPatch[]) => {
      if (patches.length === 0) return;
      mergeMediaElementPatches(latestMediaElementPatchesRef.current, patches);
      const content = contentRef.current;
      if (!content) return;
      patchReaderMediaElements(content, patches);
    },
    [],
  );

  const reportMediaError = useCallback((source: string | null) => {
    if (onMediaErrorRef.current) {
      pendingMediaErrorRef.current = null;
      onMediaErrorRef.current(source);
      return;
    }
    pendingMediaErrorRef.current = { source };
  }, []);

  useEffect(() => {
    if (!onMediaError || !pendingMediaErrorRef.current) return;
    const { source } = pendingMediaErrorRef.current;
    pendingMediaErrorRef.current = null;
    onMediaError(source);
  }, [onMediaError]);

  useLayoutEffect(() => {
    latestMediaElementPatchesRef.current.clear();
    resolvedLocalMediaRef.current.clear();
    pendingMediaErrorRef.current = null;
    latestLocalMediaSignatureRef.current = null;
    pendingLocalMediaSignatureRef.current = null;
    unresolvedLocalMediaSignatureRef.current = null;
    localMediaPatchGenerationRef.current += 1;
  }, [contentKey]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const handlePendingImageLoad = (event: Event) => {
      if (canClearPendingReaderImage(event.target, "load")) {
        clearReaderPendingMedia(event.target);
      }
    };
    const handlePendingImageError = (event: Event) => {
      if (canClearPendingReaderImage(event.target, "error")) {
        clearReaderPendingMedia(event.target);
      }
      const source = mediaErrorSource(event.target);
      if (!source) return;
      if (isRemoteMediaUrl(source)) {
        logReaderMediaPipeline("remote-media-error", {
          host: mediaLogHost(source),
        });
        reportMediaError(source);
        return;
      }
      if (isLocalReaderMediaUrl(source)) {
        logReaderMediaPipeline("local-media-error", {
          host: mediaLogHost(source),
        });
        reportMediaError(source);
      }
    };
    content.addEventListener("load", handlePendingImageLoad, true);
    content.addEventListener("error", handlePendingImageError, true);
    clearSettledPendingReaderImages(content);
    return () => {
      content.removeEventListener("load", handlePendingImageLoad, true);
      content.removeEventListener("error", handlePendingImageError, true);
    };
  }, [
    activeVirtualRangeEnd,
    activeVirtualRangeStart,
    contentRef,
    isPagedReader,
    renderedHtml,
    reportMediaError,
  ]);

  useEffect(() => {
    unresolvedLocalMediaSignatureRef.current = null;
    pendingMediaErrorRef.current = null;
  }, [localMediaContextKey, renderedHtml]);

  useEffect(() => {
    if (!stableLocalMediaContext) {
      return;
    }
    const content = contentRef.current;
    if (!content) return;
    const rawPatches = collectMountedLocalMediaPatches(content, true);
    if (rawPatches.length === 0) return;
    const signature = localMediaPatchSignature(rawPatches);
    const scopedSignature = `${localMediaContextKey}\u0000${signature}`;
    logReaderMediaDebug("local-media-effect", () => ({
      rawPatchCount: rawPatches.length,
      signature: readerMediaDebugHash(signature),
      contextKey: localMediaContextKey,
      renderedHtmlBytes: renderedHtml.length,
      renderedHtmlHash: readerMediaDebugHash(renderedHtml),
      resolvedMapSize: resolvedLocalMediaRef.current.size,
      virtualStart: activeVirtualRangeStart,
      virtualEnd: activeVirtualRangeEnd,
    }));
    const resolvedPatches = resolveMountedLocalMediaPatchesFromMap(
      rawPatches,
      resolvedLocalMediaRef.current,
    );
    if (resolvedPatches) {
      latestLocalMediaSignatureRef.current = scopedSignature;
      unresolvedLocalMediaSignatureRef.current = null;
      mergeMediaElementPatches(
        latestMediaElementPatchesRef.current,
        resolvedPatches,
      );
      logReaderMediaDebug("local-media-map-hit", () => ({
        patchCount: resolvedPatches.length,
        signature: readerMediaDebugHash(signature),
        virtualStart: activeVirtualRangeStart,
        virtualEnd: activeVirtualRangeEnd,
      }));
      patchReaderMediaElements(content, resolvedPatches);
      return;
    }
    const cachedLocalPatches = [
      ...latestMediaElementPatchesRef.current.values(),
    ].filter(hasLocalMediaSourceAttributes);
    if (
      scopedSignature === latestLocalMediaSignatureRef.current &&
      cachedLocalPatches.length > 0
    ) {
      logReaderMediaDebug("local-media-cached-reapply", () => ({
        patchCount: cachedLocalPatches.length,
        signature: readerMediaDebugHash(signature),
        virtualStart: activeVirtualRangeStart,
        virtualEnd: activeVirtualRangeEnd,
      }));
      patchReaderMediaElements(content, cachedLocalPatches);
      return;
    }
    if (scopedSignature === unresolvedLocalMediaSignatureRef.current) {
      logReaderMediaDebug("local-media-skip-unresolved", () => ({
        signature: readerMediaDebugHash(signature),
        virtualStart: activeVirtualRangeStart,
        virtualEnd: activeVirtualRangeEnd,
      }));
      return;
    }
    if (scopedSignature === pendingLocalMediaSignatureRef.current) {
      logReaderMediaDebug("local-media-skip-pending", () => ({
        signature: readerMediaDebugHash(signature),
        virtualStart: activeVirtualRangeStart,
        virtualEnd: activeVirtualRangeEnd,
      }));
      return;
    }
    latestLocalMediaSignatureRef.current = scopedSignature;
    pendingLocalMediaSignatureRef.current = scopedSignature;
    const generation = ++localMediaPatchGenerationRef.current;
    let cancelled = false;
    logReaderMediaDebug("local-media-resolve-start", () => ({
      generation,
      rawPatchCount: rawPatches.length,
      signature: readerMediaDebugHash(signature),
      virtualStart: activeVirtualRangeStart,
      virtualEnd: activeVirtualRangeEnd,
    }));
    void (async () => {
      try {
        const patches = await resolveLocalChapterMediaPatches(
          rawPatches,
          stableLocalMediaContext,
        );
        if (
          cancelled ||
          generation !== localMediaPatchGenerationRef.current ||
          contentRef.current !== content
        ) {
          logReaderMediaDebug("local-media-resolve-discard", () => ({
            cancelled,
            generation,
            currentGeneration: localMediaPatchGenerationRef.current,
            contentChanged: contentRef.current !== content,
          }));
          return;
        }
        logReaderMediaDebug("local-media-resolve-done", () => ({
          generation,
          patchCount: patches.length,
          signature: readerMediaDebugHash(signature),
          virtualStart: activeVirtualRangeStart,
          virtualEnd: activeVirtualRangeEnd,
        }));
        if (patches.length > 0) {
          unresolvedLocalMediaSignatureRef.current = null;
          const resolvedByIndex = new Map(
            patches.map((patch) => [patch.index, patch]),
          );
          for (const rawPatch of rawPatches) {
            const resolvedPatch = resolvedByIndex.get(rawPatch.index);
            if (!resolvedPatch) continue;
            for (const attribute of READER_MEDIA_PATCH_ATTRIBUTES) {
              const source = rawPatch.sourceAttributes?.[attribute];
              const resolved = resolvedPatch.attributes[attribute];
              if (!source || !resolved) {
                continue;
              }
              resolvedLocalMediaRef.current.set(source, resolved);
            }
          }
          mergeMediaElementPatches(latestMediaElementPatchesRef.current, patches);
          patchReaderMediaElements(content, patches);
        } else if (!cancelled) {
          logReaderMediaDebug("local-media-resolve-empty", () => ({
            generation,
            signature: readerMediaDebugHash(signature),
            virtualStart: activeVirtualRangeStart,
            virtualEnd: activeVirtualRangeEnd,
          }));
          unresolvedLocalMediaSignatureRef.current = scopedSignature;
        }
        if (!cancelled && patches.length < rawPatches.length) {
          const resolvedIndices = new Set(patches.map((patch) => patch.index));
          const unresolvedPatch = rawPatches.find(
            (patch) => !resolvedIndices.has(patch.index),
          );
          const unresolvedSource = unresolvedPatch
            ? (READER_MEDIA_PATCH_ATTRIBUTES.map(
                (attribute) => unresolvedPatch.sourceAttributes?.[attribute],
              ).find(Boolean) ?? null)
            : null;
          logReaderMediaPipeline("local-media-unresolved", {
            rawPatchCount: rawPatches.length,
            resolvedPatchCount: patches.length,
          });
          reportMediaError(unresolvedSource);
        }
      } finally {
        if (pendingLocalMediaSignatureRef.current === scopedSignature) {
          pendingLocalMediaSignatureRef.current = null;
        }
      }
    })();
    return () => {
      cancelled = true;
      if (pendingLocalMediaSignatureRef.current === scopedSignature) {
        pendingLocalMediaSignatureRef.current = null;
      }
    };
  }, [
    activeVirtualRangeEnd,
    activeVirtualRangeStart,
    localMediaContextKey,
    renderedHtml,
    reportMediaError,
    stableLocalMediaContext,
  ]);

  const restoreMediaPatches = useCallback(
    (readerContentHtml: string) => {
      const content = contentRef.current;
      const patches = [...latestMediaElementPatchesRef.current.values()];
      logReaderMediaDebug("content-html-commit", () => ({
        htmlBytes: readerContentHtml.length,
        htmlHash: readerMediaDebugHash(readerContentHtml),
        patchCount: patches.length,
        virtualStart: activeVirtualRangeStart,
        virtualEnd: activeVirtualRangeEnd,
      }));
      if (!content) return;
      if (patches.length > 0) {
        patchReaderMediaElements(content, patches);
      }
      if (resolvedLocalMediaRef.current.size > 0) {
        const rawPatches = collectMountedLocalMediaPatches(content, true);
        if (rawPatches.length > 0) {
          const resolvedPatches = resolveMountedLocalMediaPatchesFromMap(
            rawPatches,
            resolvedLocalMediaRef.current,
            { allowPartial: true },
          );
          if (resolvedPatches && resolvedPatches.length > 0) {
            mergeMediaElementPatches(
              latestMediaElementPatchesRef.current,
              resolvedPatches,
            );
            patchReaderMediaElements(content, resolvedPatches);
          }
        }
      }
      clearSettledPendingReaderImages(content);
    },
    [activeVirtualRangeEnd, activeVirtualRangeStart, contentRef],
  );

  return {
    patchMediaElements,
    restoreMediaPatches,
    hasLocalMediaContext: Boolean(stableLocalMediaContext),
  };
}
