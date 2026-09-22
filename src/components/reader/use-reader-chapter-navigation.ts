import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { RefObject } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  getAdjacentChapter,
  type ChapterListRow,
} from "../../db/queries/chapter";
import { getNovelById } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { usePageBackNavigation } from "../../lib/android-back-navigation";
import {
  findPreviousAppHistoryEntry,
  trimAppNavigationHistoryTo,
} from "../../lib/navigation-history";
import { usePageActivity } from "../../lib/page-activity";
import {
  chapterDetailQueryKey,
  chapterListQueryKey,
  novelChaptersQueryKey,
  novelDetailQueryKey,
  novelLibraryQueryKey,
} from "../../lib/reader-query-invalidation";
import { enqueueChapterDownload } from "../../lib/tasks/chapter-download";
import { taskScheduler, type TaskHandle } from "../../lib/tasks/scheduler";
import { type ReaderContentHandle } from "../ReaderContent";

type ReaderNavigationChapter = Pick<
  ChapterListRow,
  | "id"
  | "novelId"
  | "position"
  | "isDownloaded"
  | "path"
  | "name"
  | "chapterNumber"
  | "contentType"
>;
interface ReaderChapterNavigationOptions {
  chapterId: number;
  chapter: ReaderNavigationChapter | undefined;
  previousChapter: ReaderNavigationChapter | undefined;
  nextChapter: ReaderNavigationChapter | undefined;
  readerProgressPersistenceReady: boolean;
  contentRef: RefObject<ReaderContentHandle | null>;
  openedChapterRef: RefObject<number | null>;
}
export function useReaderChapterNavigation({
  chapterId,
  chapter,
  previousChapter,
  nextChapter,
  readerProgressPersistenceReady,
  contentRef,
  openedChapterRef,
}: ReaderChapterNavigationOptions) {
  const { t } = useTranslation();
  const active = usePageActivity();
  const navigate = useNavigate();
  const currentHref = useRouterState({
    select: (state) => state.location.href,
  });
  const queryClient = useQueryClient();
  const openRequestRef = useRef(0);
  const autoDownloadingChapterRef = useRef<number | null>(null);
  const activeChapterOpenTaskRef = useRef<{
    chapterId: number;
    handle: TaskHandle<void>;
  } | null>(null);
  const suppressedAutoDownloadChapterRef = useRef<number | null>(null);
  const readerContentReadyRef = useRef(false);
  const [autoDownloadingChapterId, setAutoDownloadingChapterId] = useState<
    number | null
  >(null);
  const [initialProgressOverride, setInitialProgressOverride] = useState<{
    chapterId: number;
    progress: number;
  } | null>(null);
  useLayoutEffect(() => {
    readerContentReadyRef.current = readerProgressPersistenceReady;
  }, [readerProgressPersistenceReady]);

  const cancelPendingChapterOpen = useCallback(() => {
    if (readerContentReadyRef.current) return;

    const activeTask = activeChapterOpenTaskRef.current;
    const pendingChapterId =
      activeTask?.chapterId ?? autoDownloadingChapterRef.current ?? chapterId;
    openRequestRef.current += 1;
    suppressedAutoDownloadChapterRef.current =
      pendingChapterId > 0 ? pendingChapterId : null;
    if (activeTask) {
      taskScheduler.cancel(activeTask.handle.id);
      activeChapterOpenTaskRef.current = null;
    }
    autoDownloadingChapterRef.current = null;
    setAutoDownloadingChapterId(null);
  }, [chapterId]);

  const openChapter = useCallback(
    (
      targetChapter: ReaderNavigationChapter,
      options?: { initialProgress?: number },
    ) => {
      if (options?.initialProgress !== undefined) {
        setInitialProgressOverride({
          chapterId: targetChapter.id,
          progress: options.initialProgress,
        });
      } else if (targetChapter.id !== chapterId) {
        setInitialProgressOverride(null);
      }

      if (
        targetChapter.id === chapterId &&
        (targetChapter.isDownloaded ||
          autoDownloadingChapterRef.current === targetChapter.id)
      ) {
        return;
      }
      const requestId = openRequestRef.current + 1;
      openRequestRef.current = requestId;
      suppressedAutoDownloadChapterRef.current = null;
      if (targetChapter.id !== chapterId) {
        readerContentReadyRef.current = false;
        openedChapterRef.current = null;
        void navigate({
          to: "/reader",
          search: { chapterId: targetChapter.id },
          replace: true,
        });
      }

      if (targetChapter.isDownloaded) {
        return;
      }

      autoDownloadingChapterRef.current = targetChapter.id;
      setAutoDownloadingChapterId(targetChapter.id);
      void (async () => {
        try {
          const novel = await queryClient.fetchQuery({
            queryKey: novelDetailQueryKey(targetChapter.novelId),
            queryFn: () => getNovelById(targetChapter.novelId),
          });
          if (!novel || openRequestRef.current !== requestId) return;

          const handle = enqueueChapterDownload({
            id: targetChapter.id,
            pluginId: novel.pluginId,
            chapterPath: targetChapter.path,
            chapterName: targetChapter.name,
            chapterNumber: targetChapter.chapterNumber ?? undefined,
            contentType: targetChapter.contentType,
            novelId: novel.id,
            novelName: novel.name,
            novelPath: novel.path,
            priority: "interactive",
            title: t("tasks.task.downloadChapter", {
              name: targetChapter.name,
            }),
          });
          activeChapterOpenTaskRef.current = {
            chapterId: targetChapter.id,
            handle,
          };
          await handle.promise;
          if (openRequestRef.current !== requestId) return;
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: chapterDetailQueryKey(targetChapter.id),
            }),
            queryClient.invalidateQueries({
              queryKey: chapterListQueryKey(targetChapter.novelId),
            }),
            queryClient.invalidateQueries({
              queryKey: novelChaptersQueryKey(targetChapter.novelId),
            }),
          ]);
          void queryClient.invalidateQueries({
            queryKey: novelLibraryQueryKey,
          });
        } catch {
          // The reader stays open and continues showing any partial content.
        } finally {
          if (
            activeChapterOpenTaskRef.current?.chapterId === targetChapter.id &&
            openRequestRef.current === requestId
          ) {
            activeChapterOpenTaskRef.current = null;
          }
          if (
            autoDownloadingChapterRef.current === targetChapter.id &&
            openRequestRef.current === requestId
          ) {
            autoDownloadingChapterRef.current = null;
          }
          if (openRequestRef.current === requestId) {
            setAutoDownloadingChapterId((current) =>
              current === targetChapter.id ? null : current,
            );
          }
        }
      })();
    },
    [chapterId, navigate, queryClient, t],
  );

  useEffect(() => {
    if (!chapter || chapter.isDownloaded) return;
    if (autoDownloadingChapterRef.current === chapter.id) return;
    if (suppressedAutoDownloadChapterRef.current === chapter.id) return;

    void openChapter(chapter);
  }, [chapter, openChapter]);

  const openAdjacent = useCallback(
    async (direction: 1 | -1) => {
      if (!chapter?.novelId || chapter.position === undefined) return;
      const listedAdjacent = direction === 1 ? nextChapter : previousChapter;
      const adjacent =
        listedAdjacent ??
        (await getAdjacentChapter(
          chapter.novelId,
          chapter.position,
          direction,
        ));
      if (!adjacent) return;
      if (direction === 1) {
        contentRef.current?.completeIfAtEnd();
      }
      openChapter(
        adjacent,
        direction === 1 ? { initialProgress: 0 } : undefined,
      );
    },
    [
      chapter?.novelId,
      chapter?.position,
      nextChapter,
      openChapter,
      previousChapter,
    ],
  );

  const handleReaderBack = useCallback((): boolean => {
    cancelPendingChapterOpen();
    const target = findPreviousAppHistoryEntry(currentHref, ["/reader"]);
    if (target) {
      trimAppNavigationHistoryTo(target);
      window.history.go(-target.steps);
      return true;
    }

    const novelId = chapter?.novelId;
    if (novelId) {
      void navigate({ to: "/novel", search: { id: novelId }, replace: true });
      return true;
    }
    if (window.history.length > 1) {
      window.history.back();
      return true;
    }
    void navigate({ to: "/" });
    return true;
  }, [cancelPendingChapterOpen, chapter?.novelId, currentHref, navigate]);

  usePageBackNavigation(handleReaderBack);

  useEffect(() => {
    const novelId = chapter?.novelId;
    if (!active || !novelId) return;

    const handleReaderPopState = () => {
      window.setTimeout(() => {
        if (window.location.pathname !== "/reader") return;

        const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        const target = findPreviousAppHistoryEntry(currentHref, ["/reader"]);
        if (target) {
          trimAppNavigationHistoryTo(target);
          window.history.go(-target.steps);
          return;
        }

        void navigate({ to: "/novel", search: { id: novelId }, replace: true });
      }, 0);
    };

    window.addEventListener("popstate", handleReaderPopState);
    return () => {
      window.removeEventListener("popstate", handleReaderPopState);
    };
  }, [active, chapter?.novelId, navigate]);

  return {
    autoDownloadingChapterId,
    initialProgressOverride,
    setInitialProgressOverride,
    openChapter,
    openAdjacent,
    handleReaderBack,
  };
}
