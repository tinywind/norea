import type { RefObject } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  resolveLocalChapterMediaPatches,
  type ChapterMediaElementPatch,
  type ChapterMediaStorageContext,
} from "../../lib/chapter-media";
import {
  collectMountedLocalMediaPatches,
  countBlankReaderMedia,
  countDataUrlReaderMedia,
  hasLocalMediaSourceAttributes,
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
  const [resolvedLocalMedia, setResolvedLocalMedia] = useState<
    Record<string, string>
  >({});
  const resolvedLocalMediaMap = useMemo(
    () => new Map(Object.entries(resolvedLocalMedia)),
    [resolvedLocalMedia],
  );
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
            localMediaContext.novelPath ?? "",
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
      localMediaContext?.novelPath,
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

  useLayoutEffect(() => {
    latestMediaElementPatchesRef.current.clear();
    latestLocalMediaSignatureRef.current = null;
    pendingLocalMediaSignatureRef.current = null;
    unresolvedLocalMediaSignatureRef.current = null;
    localMediaPatchGenerationRef.current += 1;
    setResolvedLocalMedia((current) =>
      Object.keys(current).length === 0 ? current : {},
    );
  }, [contentKey]);

  useEffect(() => {
    unresolvedLocalMediaSignatureRef.current = null;
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
      resolvedMapSize: Object.keys(resolvedLocalMediaMap).length,
      virtualStart: activeVirtualRangeStart,
      virtualEnd: activeVirtualRangeEnd,
    }));
    const resolvedPatches = resolveMountedLocalMediaPatchesFromMap(
      rawPatches,
      resolvedLocalMediaMap,
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
          setResolvedLocalMedia((current) => {
            let changed = false;
            const next = { ...current };
            rawPatches.forEach((rawPatch, patchIndex) => {
              const resolvedPatch = patches[patchIndex];
              if (!resolvedPatch) return;
              for (const attribute of READER_MEDIA_PATCH_ATTRIBUTES) {
                const source = rawPatch.sourceAttributes?.[attribute];
                const resolved = resolvedPatch.attributes[attribute];
                if (!source || !resolved || next[source] === resolved) {
                  continue;
                }
                next[source] = resolved;
                changed = true;
              }
            });
            return changed ? next : current;
          });
          for (const [index, patch] of latestMediaElementPatchesRef.current) {
            if (hasLocalMediaSourceAttributes(patch)) {
              latestMediaElementPatchesRef.current.delete(index);
            }
          }
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
    resolvedLocalMediaMap,
    stableLocalMediaContext,
  ]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || !onMediaError) return;
    const handleMediaError = (event: Event) => {
      const source = mediaErrorSource(event.target);
      if (!source || !isRemoteMediaUrl(source)) return;
      logReaderMediaPipeline("remote-media-error", {
        host: mediaLogHost(source),
      });
      onMediaError(source);
    };
    content.addEventListener("error", handleMediaError, true);
    return () => {
      content.removeEventListener("error", handleMediaError, true);
    };
  }, [
    activeVirtualRangeEnd,
    activeVirtualRangeStart,
    isPagedReader,
    onMediaError,
    renderedHtml,
  ]);

  const restoreMediaPatches = useCallback(
    (readerContentHtml: string) => {
      const patches = [...latestMediaElementPatchesRef.current.values()];
      logReaderMediaDebug("content-html-commit", () => ({
        htmlBytes: readerContentHtml.length,
        htmlHash: readerMediaDebugHash(readerContentHtml),
        patchCount: patches.length,
        virtualStart: activeVirtualRangeStart,
        virtualEnd: activeVirtualRangeEnd,
      }));
      if (patches.length === 0) return;
      const content = contentRef.current;
      if (content) patchReaderMediaElements(content, patches);
    },
    [activeVirtualRangeEnd, activeVirtualRangeStart],
  );

  return {
    patchMediaElements,
    restoreMediaPatches,
    resolvedLocalMediaMap,
    hasLocalMediaContext: Boolean(stableLocalMediaContext),
  };
}
