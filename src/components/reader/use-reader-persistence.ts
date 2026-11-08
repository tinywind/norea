import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  getChapterById,
  markChapterOpened,
  updateChapterProgress,
  type ChapterListRow,
} from "../../db/queries/chapter";
import {
  chapterDetailQueryKey,
  chapterListQueryKey,
  invalidateReaderOpenedQueries,
  invalidateReaderProgressQueries,
  novelChaptersQueryKey,
} from "../../lib/reader-query-invalidation";
import type { ReaderChapterRow } from "../../lib/reader-chapter";
import { markUpdatesIndexDirty } from "../../lib/updates/update-index-events";
import { useLibraryStore } from "../../store/library";
import { getPortableReaderAnchor, isApplyingSharedReaderResume, useReaderStore } from "../../store/reader";
import { recordUserResume } from "../../db/user-state";
import type { PortableReaderAnchor } from "../../lib/user-state/types";
import { describeError } from "../../lib/errors";
import { useContentSyncStore } from "../../store/content-sync";
import { useUserStateStore } from "../../store/user-state";
const FINISHED_PROGRESS = 100;

function reportResumeFailure(error: unknown): void {
  const server = useContentSyncStore.getState().serverUrl;
  if (server) useUserStateStore.getState().setRuntime(server, "error", describeError(error));
  console.warn("[user-state] reading position could not be recorded", error);
}

interface ReaderProgressUpdate {
  chapterId: number;
  novelId: number;
  progress: number;
}
export function useReaderPersistence(
  chapter: Pick<ReaderChapterRow, "id" | "novelId" | "content"> | undefined,
  openedChapterRef: RefObject<number | null>,
) {
  const queryClient = useQueryClient();
  const readerWriteQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const incognitoMode = useLibraryStore((state) => state.incognitoMode);
  const incognitoModeRef = useRef(incognitoMode);
  useLayoutEffect(() => {
    incognitoModeRef.current = incognitoMode;
  }, [incognitoMode]);
  const setLastReadChapter = useReaderStore(
    (state) => state.setLastReadChapter,
  );
  const enqueueReaderWrite = useCallback(<T,>(write: () => Promise<T>) => {
    const run = readerWriteQueueRef.current.catch(() => undefined).then(write);
    readerWriteQueueRef.current = run.catch(() => undefined);
    return run;
  }, []);

  const progressMutation = useMutation({
    mutationFn: ({
      chapterId: targetChapterId,
      progress,
      recordHistory,
      anchor,
      openedAt,
    }: {
      chapterId: number;
      novelId: number;
      progress: number;
      recordHistory: boolean;
      anchor: PortableReaderAnchor | null;
      openedAt: number;
    }) =>
      enqueueReaderWrite(async () => {
        await updateChapterProgress(targetChapterId, progress, { recordHistory });
        if (recordHistory) await recordUserResume(targetChapterId, anchor, openedAt);
      }),
    onMutate: ({
      chapterId: targetChapterId,
      novelId: targetNovelId,
      progress,
      recordHistory,
    }) => {
      const applyProgress = <T extends ChapterListRow>(chapter: T): T => ({
        ...chapter,
        progress: chapter.progress >= FINISHED_PROGRESS ? chapter.progress : progress,
        unread: progress >= FINISHED_PROGRESS ? false : chapter.unread,
        readAt:
          !recordHistory || progress <= 0
            ? chapter.readAt
            : Math.floor(Date.now() / 1000),
      });
      queryClient.setQueryData<Awaited<ReturnType<typeof getChapterById>>>(
        chapterDetailQueryKey(targetChapterId),
        (chapter) => (chapter ? applyProgress(chapter) : chapter),
      );
      if (targetNovelId > 0) {
        const updateChapterList = (chapters: ChapterListRow[] | undefined) =>
          chapters?.map((chapter) =>
            chapter.id === targetChapterId ? applyProgress(chapter) : chapter,
          );
        queryClient.setQueryData<ChapterListRow[]>(
          chapterListQueryKey(targetNovelId),
          updateChapterList,
        );
        queryClient.setQueryData<ChapterListRow[]>(
          novelChaptersQueryKey(targetNovelId),
          updateChapterList,
        );
      }
    },
    onSuccess: (
      _result,
      { novelId: targetNovelId, progress, recordHistory },
    ) => {
      void invalidateReaderProgressQueries(queryClient, {
        novelId: targetNovelId,
        progress,
        recordHistory,
      });
      if (progress >= FINISHED_PROGRESS) {
        markUpdatesIndexDirty("read-progress");
      }
    },
  });
  const progressMutateRef = useRef(progressMutation.mutate);

  useEffect(() => {
    progressMutateRef.current = progressMutation.mutate;
  }, [progressMutation.mutate]);

  useEffect(() => {
    if (
      !chapter ||
      !chapter.content ||
      openedChapterRef.current === chapter.id
    ) {
      return;
    }
    openedChapterRef.current = chapter.id;
    setLastReadChapter(chapter.novelId, chapter.id);
    if (!incognitoMode) {
      const anchor = getPortableReaderAnchor(useReaderStore.getState().chapterScrollAnchors[chapter.id]);
      const openedAt = Math.floor(Date.now() / 1000);
      void enqueueReaderWrite(async () => {
        await markChapterOpened(chapter.id);
        await recordUserResume(chapter.id, anchor, openedAt);
      }).then(() => {
        void invalidateReaderOpenedQueries(queryClient, { novelId: chapter.novelId });
      }).catch(reportResumeFailure);
    }
  }, [
    chapter,
    enqueueReaderWrite,
    incognitoMode,
    queryClient,
    setLastReadChapter,
  ]);

  useEffect(() => {
    if (!chapter?.id || !chapter.content) return;
    const chapterId = chapter.id;
    return useReaderStore.subscribe((state, previous) => {
      if (isApplyingSharedReaderResume() || incognitoModeRef.current ||
          state.chapterScrollAnchors[chapterId] === previous.chapterScrollAnchors[chapterId]) return;
      const anchor = getPortableReaderAnchor(state.chapterScrollAnchors[chapterId]);
      const prior = getPortableReaderAnchor(previous.chapterScrollAnchors[chapterId]);
      if (JSON.stringify(anchor) === JSON.stringify(prior)) return;
      const openedAt = Math.floor(Date.now() / 1000);
      void enqueueReaderWrite(() => recordUserResume(chapterId, anchor, openedAt)).catch(reportResumeFailure);
    });
  }, [chapter?.id, chapter?.content, enqueueReaderWrite]);

  const persistProgress = useCallback((update: ReaderProgressUpdate) => {
    progressMutateRef.current({
      ...update,
      recordHistory: !incognitoModeRef.current,
      anchor: getPortableReaderAnchor(useReaderStore.getState().chapterScrollAnchors[update.chapterId]),
      openedAt: Math.floor(Date.now() / 1000),
    });
  }, []);
  return { incognitoMode, persistProgress };
}
