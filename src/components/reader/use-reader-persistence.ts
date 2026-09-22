import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  getChapterById,
  markChapterOpened,
  updateChapterProgress,
  type ChapterListRow,
  type ChapterRow,
} from "../../db/queries/chapter";
import {
  chapterDetailQueryKey,
  chapterListQueryKey,
  invalidateReaderOpenedQueries,
  invalidateReaderProgressQueries,
  novelChaptersQueryKey,
} from "../../lib/reader-query-invalidation";
import { markUpdatesIndexDirty } from "../../lib/updates/update-index-events";
import { useLibraryStore } from "../../store/library";
import { useReaderStore } from "../../store/reader";
const FINISHED_PROGRESS = 100;

interface ReaderProgressUpdate {
  chapterId: number;
  novelId: number;
  progress: number;
}
export function useReaderPersistence(
  chapter: Pick<ChapterRow, "id" | "novelId" | "isDownloaded"> | undefined,
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
    }: {
      chapterId: number;
      novelId: number;
      progress: number;
      recordHistory: boolean;
    }) =>
      enqueueReaderWrite(() =>
        updateChapterProgress(targetChapterId, progress, {
          recordHistory,
        }),
      ),
    onMutate: ({
      chapterId: targetChapterId,
      novelId: targetNovelId,
      progress,
      recordHistory,
    }) => {
      const applyProgress = <T extends ChapterListRow>(chapter: T): T => ({
        ...chapter,
        progress,
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
      !chapter.isDownloaded ||
      openedChapterRef.current === chapter.id
    ) {
      return;
    }
    openedChapterRef.current = chapter.id;
    setLastReadChapter(chapter.novelId, chapter.id);
    if (!incognitoMode) {
      void enqueueReaderWrite(() => markChapterOpened(chapter.id)).then(() => {
        void invalidateReaderOpenedQueries(queryClient, {
          novelId: chapter.novelId,
        });
      });
    }
  }, [
    chapter,
    enqueueReaderWrite,
    incognitoMode,
    queryClient,
    setLastReadChapter,
  ]);

  const persistProgress = useCallback((update: ReaderProgressUpdate) => {
    progressMutateRef.current({
      ...update,
      recordHistory: !incognitoModeRef.current,
    });
  }, []);
  return { incognitoMode, persistProgress };
}
