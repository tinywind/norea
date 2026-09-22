import { useQueryClient } from "@tanstack/react-query";
import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ChapterRow } from "../../db/queries/chapter";
import type { NovelDetailRecord } from "../../db/queries/novel";
import { isHtmlLikeChapterContentType } from "../../lib/chapter-content";
import {
  hasRemoteChapterMedia,
  resolveLocalChapterMediaPatches,
  type ChapterMediaElementPatch,
  type ChapterMediaStorageContext,
} from "../../lib/chapter-media";
import { LOCAL_PLUGIN_ID } from "../../lib/plugins/types";
import type { ReaderChapterRow } from "../../lib/reader-chapter";
import {
  getReaderContentPhaseKey,
  isReaderProgressPersistenceReady,
} from "../../lib/reader-progress-session";
import {
  chapterDetailQueryKey,
  chapterListQueryKey,
  novelChaptersQueryKey,
} from "../../lib/reader-query-invalidation";
import {
  subscribeChapterDownloads,
  subscribeChapterMediaPatches,
  subscribeChapterPartialContentUpdates,
} from "../../lib/tasks/chapter-download";
import { type ReaderContentHandle } from "../ReaderContent";
import { useReaderDocument } from "../use-reader-document";
const READER_FULL_MEDIA_PATCH_MAX_HTML_LENGTH = 350_000;

type ReaderDocumentState = {
  chapterId: number;
  contentType: ChapterRow["contentType"];
  html: string;
};

const READER_RENDERABLE_MEDIA_SELECTOR =
  "img,video,audio,source,embed,track,object,iframe,link[rel~='preload']";

function hasRenderableReaderHtml(html: string): boolean {
  if (html.length > READER_FULL_MEDIA_PATCH_MAX_HTML_LENGTH) {
    return html.trim().length > 0;
  }
  if (typeof document === "undefined") return html.trim().length > 0;
  const template = document.createElement("template");
  template.innerHTML = html;
  if ((template.content.textContent ?? "").trim().length > 0) return true;
  return Boolean(
    template.content.querySelector(READER_RENDERABLE_MEDIA_SELECTOR),
  );
}

function logReaderMediaPipeline(
  event: string,
  details: Record<string, unknown>,
) {
  console.warn("[reader-media:route]", event, details);
}

const SAMPLE_CHAPTER_HTML = `
<h1>Chapter 1 - A long road begins</h1>
<p>
  The wind carried the scent of pine and old rain across the road, and
  for a moment the boy thought he could hear the river even before he
  could see it. He paused at the crest of the hill and looked back the
  way he had come. The village was already a smudge of slate against
  the morning grey. He had not expected leaving to feel this small.
</p>
<p>
  His father had said only that the journey would not be a kind one.
  His mother, who had no patience for either drama or doubt, had
  packed his satchel with practical things: flatbread wrapped in
  oiled paper, three apples, a little sealed pot of honey, the knife
  he had been allowed to whet but not yet to keep, and three coins of
  middling worth.
</p>
<p>
  The road wound down into the valley between elms. He had been told
  they would change colour soon. He had also been told that the wolves
  this year were thin and bold. He hoped neither would inconvenience
  him before sundown.
</p>
<h2>I.</h2>
<p>
  The river crossing came at noon, exactly when his father had said
  it would. There was a stone bridge with a moss-furred handrail and
  a toll-house, and the toll-keeper was asleep against the doorpost
  with a long-stemmed pipe gone cold in his hand. The boy laid one of
  his middling coins on the windowsill and walked across without
  waking him.
</p>
`;

type ReaderChapterDocument = Pick<
  ReaderChapterRow,
  | "id"
  | "novelId"
  | "name"
  | "chapterNumber"
  | "position"
  | "content"
  | "contentType"
  | "isDownloaded"
  | "mediaRepairNeeded"
>;
type ReaderNovelDocument = Pick<
  NovelDetailRecord,
  "id" | "name" | "path" | "pluginId"
>;
interface ReaderChapterDocumentOptions {
  chapterId: number;
  chapter: ReaderChapterDocument | undefined;
  currentNovel: ReaderNovelDocument | null;
  bionicReading: boolean;
  contentRef: RefObject<ReaderContentHandle | null>;
}
export function useReaderChapterDocument({
  chapterId,
  chapter,
  currentNovel,
  bionicReading,
  contentRef,
}: ReaderChapterDocumentOptions) {
  const queryClient = useQueryClient();
  const pendingMediaPatchesRef = useRef<
    Map<number, ChapterMediaElementPatch[]>
  >(new Map());
  const [readerDocument, setReaderDocument] =
    useState<ReaderDocumentState | null>(null);
  const [remoteMediaError, setRemoteMediaError] = useState(false);

  useEffect(() => {
    if (!chapter || !isHtmlLikeChapterContentType(chapter.contentType)) return;
    const unsubscribe = subscribeChapterPartialContentUpdates((event) => {
      if (event.chapterId !== chapter.id) return;
      logReaderMediaPipeline("partial-html", {
        chapterId: chapter.id,
        htmlLength: event.html.length,
      });
      setReaderDocument((current) =>
        current?.chapterId === chapter.id
          ? current
          : {
              chapterId: chapter.id,
              contentType: chapter.contentType,
              html: event.html,
            },
      );
    });

    return unsubscribe;
  }, [chapter?.contentType, chapter?.id]);

  useEffect(() => {
    if (!chapter || !isHtmlLikeChapterContentType(chapter.contentType)) return;
    let cancelled = false;
    const unsubscribe = subscribeChapterMediaPatches((event) => {
      if (event.chapterId !== chapter.id) return;
      void (async () => {
        logReaderMediaPipeline("media-patch-raw", {
          chapterId: chapter.id,
          patchCount: event.patches.length,
          firstIndexes: event.patches.slice(0, 8).map((patch) => patch.index),
        });
        const patches = await resolveLocalChapterMediaPatches(event.patches, {
          chapterId: chapter.id,
          chapterName: chapter.name,
          chapterNumber: chapter.chapterNumber,
          chapterPosition: chapter.position,
          novelId: currentNovel?.id ?? chapter.novelId,
          novelName: currentNovel?.name,
          novelPath: currentNovel?.path,
          sourceId: currentNovel?.pluginId,
        });
        logReaderMediaPipeline("media-patch-resolved", {
          chapterId: chapter.id,
          patchCount: patches.length,
          firstIndexes: patches.slice(0, 8).map((patch) => patch.index),
          hasDataUrl: patches.some((patch) =>
            Object.values(patch.attributes).some((value) =>
              value.startsWith("data:"),
            ),
          ),
          hasBlank: patches.some((patch) =>
            Object.values(patch.attributes).some((value) => value === ""),
          ),
        });
        if (cancelled) return;
        const content =
          readerDocument?.chapterId === chapter.id ? contentRef.current : null;
        if (content) {
          content.patchMediaElements(patches);
          return;
        }
        const pending = pendingMediaPatchesRef.current.get(chapter.id) ?? [];
        pendingMediaPatchesRef.current.set(chapter.id, [
          ...pending,
          ...patches,
        ]);
        window.requestAnimationFrame(() => {
          const queued = pendingMediaPatchesRef.current.get(chapter.id);
          const nextContent = contentRef.current;
          if (!queued?.length || !nextContent) return;
          pendingMediaPatchesRef.current.delete(chapter.id);
          nextContent.patchMediaElements(queued);
        });
      })();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    chapter?.chapterNumber,
    chapter?.contentType,
    chapter?.id,
    chapter?.name,
    chapter?.novelId,
    chapter?.position,
    currentNovel?.id,
    currentNovel?.name,
    currentNovel?.path,
    currentNovel?.pluginId,
    readerDocument?.chapterId,
  ]);

  useEffect(() => {
    if (chapterId <= 0) return;
    return subscribeChapterDownloads((event) => {
      if (event.job.id !== chapterId) return;
      if (event.status.kind === "done") {
        void queryClient.invalidateQueries({
          queryKey: chapterDetailQueryKey(chapterId),
        });
        if (event.job.novelId) {
          void queryClient.invalidateQueries({
            queryKey: chapterListQueryKey(event.job.novelId),
          });
          void queryClient.invalidateQueries({
            queryKey: novelChaptersQueryKey(event.job.novelId),
          });
        }
      }
    });
  }, [chapterId, queryClient]);

  const chapterContentHtml = chapter?.content ?? null;

  useEffect(() => {
    if (!chapter || !chapterContentHtml) {
      setReaderDocument((current) =>
        current?.chapterId === chapterId ? current : null,
      );
      return;
    }
    setReaderDocument((current) => {
      const htmlLikeContent = isHtmlLikeChapterContentType(chapter.contentType);
      if (htmlLikeContent && !hasRenderableReaderHtml(chapterContentHtml)) {
        return current?.chapterId === chapter.id ? current : null;
      }
      if (
        htmlLikeContent &&
        current?.chapterId === chapter.id &&
        !chapter.isDownloaded
      ) {
        return current;
      }
      if (!current || current.chapterId !== chapter.id) {
        return {
          chapterId: chapter.id,
          contentType: chapter.contentType,
          html: chapterContentHtml,
        };
      }
      if (htmlLikeContent && !chapter.isDownloaded) {
        return current;
      }
      if (
        current.contentType === chapter.contentType &&
        current.html === chapterContentHtml
      ) {
        return current;
      }
      return {
        chapterId: chapter.id,
        contentType: chapter.contentType,
        html: chapterContentHtml,
      };
    });
  }, [
    chapter?.id,
    chapter?.contentType,
    chapter?.isDownloaded,
    chapterContentHtml,
    chapterId,
  ]);

  const activeReaderDocument =
    readerDocument && readerDocument.chapterId === chapterId
      ? readerDocument
      : null;
  const activeReaderHtml = activeReaderDocument
    ? activeReaderDocument.html
    : chapterContentHtml;
  const activeContentType =
    chapter?.contentType ?? activeReaderDocument?.contentType;
  const activeChapterId = chapter?.id ?? activeReaderDocument?.chapterId;
  const readerProgressPersistenceReady = isReaderProgressPersistenceReady({
    activeContent: activeReaderHtml,
    chapterId: chapter?.id,
    isDownloaded: chapter?.isDownloaded === true,
    requestedChapterId: chapterId,
    storedContent: chapterContentHtml,
  });
  const readerContentKey =
    chapterId > 0
      ? getReaderContentPhaseKey(chapterId, readerProgressPersistenceReady)
      : (activeChapterId ?? "sample");
  const readerLocalMediaContext = useMemo<
    ChapterMediaStorageContext | undefined
  >(
    () =>
      chapter && currentNovel
        ? {
            chapterId: chapter.id,
            chapterName: chapter.name,
            chapterNumber: chapter.chapterNumber,
            chapterPosition: chapter.position,
            novelId: currentNovel.id,
            novelName: currentNovel.name,
            novelPath: currentNovel.path,
            sourceId: currentNovel.pluginId,
          }
        : undefined,
    [
      chapter?.chapterNumber,
      chapter?.id,
      chapter?.name,
      chapter?.novelId,
      chapter?.position,
      currentNovel?.id,
      currentNovel?.name,
      currentNovel?.path,
      currentNovel?.pluginId,
    ],
  );
  useEffect(() => {
    setRemoteMediaError(false);
  }, [activeChapterId]);
  const showMediaRepair = useMemo(
    () =>
      Boolean(
        chapter?.isDownloaded &&
        currentNovel?.pluginId !== LOCAL_PLUGIN_ID &&
        activeContentType &&
        isHtmlLikeChapterContentType(activeContentType) &&
        (chapter.mediaRepairNeeded ||
          remoteMediaError ||
          (activeReaderHtml &&
            activeReaderHtml.length <=
              READER_FULL_MEDIA_PATCH_MAX_HTML_LENGTH &&
            hasRemoteChapterMedia(activeReaderHtml, "https://norea.invalid/"))),
      ),
    [
      activeContentType,
      activeReaderHtml,
      chapter?.isDownloaded,
      chapter?.mediaRepairNeeded,
      currentNovel?.pluginId,
      remoteMediaError,
    ],
  );

  const hasChapterContent = Boolean(activeReaderHtml);
  const content = activeReaderHtml ?? SAMPLE_CHAPTER_HTML;
  const isPdfChapter = hasChapterContent && activeContentType === "pdf";
  const readerPreparation = useReaderDocument(
    isPdfChapter || (chapterId > 0 && !hasChapterContent) ? null : content,
    bionicReading,
    readerContentKey,
  );
  useEffect(() => {
    if (!activeReaderDocument || !readerPreparation.document) return;
    const targetChapterId = activeReaderDocument.chapterId;
    const frame = window.requestAnimationFrame(() => {
      const patches = pendingMediaPatchesRef.current.get(targetChapterId);
      if (!patches?.length || !contentRef.current) return;
      pendingMediaPatchesRef.current.delete(targetChapterId);
      contentRef.current.patchMediaElements(patches);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeReaderDocument?.chapterId,
    activeReaderDocument?.html,
    readerPreparation.document,
  ]);
  const handleRemoteMediaError = useCallback(() => {
    setRemoteMediaError(true);
  }, []);

  return {
    activeChapterId,
    readerProgressPersistenceReady,
    readerContentKey,
    readerLocalMediaContext,
    hasChapterContent,
    content,
    isPdfChapter,
    readerPreparation,
    showMediaRepair,
    remoteMediaError,
    setRemoteMediaError,
    handleRemoteMediaError,
  };
}
