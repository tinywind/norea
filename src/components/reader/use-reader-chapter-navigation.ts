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
  hasStoredChapterContent,
  type ChapterListRow,
} from "../../db/queries/chapter";
import { getNovelById } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { usePageBackNavigation } from "../../lib/android-back-navigation";
import {
  findPreviousAppHistoryEntry,
  trimAppNavigationHistoryTo,
} from "../../lib/navigation-history";
import { useNetworkStore } from "../../lib/network";
import { usePageActivity } from "../../lib/page-activity";
import {
  chapterDetailQueryKey,
  chapterListQueryKey,
  novelChaptersQueryKey,
  novelDetailQueryKey,
  novelLibraryQueryKey,
} from "../../lib/reader-query-invalidation";
import { cancelChapterDownloadBatches, enqueueChapterDownload } from "../../lib/tasks/chapter-download";
import { isServerChapterMissingFailure } from "../../lib/tasks/download-failure";
import { taskScheduler, type TaskHandle } from "../../lib/tasks/scheduler";
import { type ReaderContentHandle } from "../ReaderContent";

type ReaderNavigationChapter = Pick<
  ChapterListRow,
  | "id"
  | "novelId"
  | "position"
  | "isDownloaded"
  | "contentBytes"
  | "path"
  | "name"
  | "chapterNumber"
  | "contentType"
>;
type ReaderChapterUnavailable =
  | { reason: "failed"; message: string }
  | { reason: "offline" };
interface ReaderChapterNavigationOptions {
  chapterId: number;
  routeInitialProgress?: number;
  chapter: ReaderNavigationChapter | undefined;
  previousChapter: ReaderNavigationChapter | undefined;
  nextChapter: ReaderNavigationChapter | undefined;
  readerProgressPersistenceReady: boolean;
  contentRef: RefObject<ReaderContentHandle | null>;
  openedChapterRef: RefObject<number | null>;
  onBeforeBack?: () => void;
}

function isNovelHrefForId(href: string, novelId: number): boolean {
  try {
    const parsed = new URL(href, "http://norea.local");
    return (
      parsed.pathname === "/novel" &&
      Number(parsed.searchParams.get("id")) === novelId
    );
  } catch {
    return false;
  }
}

export function useReaderChapterNavigation({
  chapterId,
  routeInitialProgress,
  chapter,
  previousChapter,
  nextChapter,
  readerProgressPersistenceReady,
  contentRef,
  openedChapterRef,
  onBeforeBack,
}: ReaderChapterNavigationOptions) {
  const { t } = useTranslation();
  const active = usePageActivity();
  const navigate = useNavigate();
  const currentHref = useRouterState({
    select: (state) => state.location.href,
  });
  const queryClient = useQueryClient();
  const connectivity = useNetworkStore((status) => status.connectivity);
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
  const [downloadFailure, setDownloadFailure] = useState<{
    chapterId: number;
    message: string;
  } | null>(null);
  const [initialProgressOverride, setInitialProgressOverride] = useState<{
    chapterId: number;
    progress: number;
    allowProgressReset?: boolean;
  } | null>(() =>
    active && chapterId > 0 && routeInitialProgress !== undefined
      ? {
          chapterId,
          progress: routeInitialProgress,
          allowProgressReset: routeInitialProgress === 0,
        }
      : null,
  );
  useEffect(() => {
    if (!active) {
      setInitialProgressOverride(null);
      return;
    }
    if (chapterId > 0 && routeInitialProgress !== undefined) {
      setInitialProgressOverride({
        chapterId,
        progress: routeInitialProgress,
        allowProgressReset: routeInitialProgress === 0,
      });
      return;
    }
    setInitialProgressOverride((current) =>
      current?.chapterId === chapterId ? current : null,
    );
  }, [active, chapterId, routeInitialProgress]);
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
      if (!cancelChapterDownloadBatches([activeTask.handle.id])) taskScheduler.cancel(activeTask.handle.id);
      activeChapterOpenTaskRef.current = null;
    }
    autoDownloadingChapterRef.current = null;
    setAutoDownloadingChapterId(null);
  }, [chapterId]);

  const openChapter = useCallback(
    (
      targetChapter: ReaderNavigationChapter,
      options?: { initialProgress?: number; sourceFallback?: boolean },
    ) => {
      if (options?.initialProgress !== undefined) {
        setInitialProgressOverride({
          chapterId: targetChapter.id,
          progress: options.initialProgress,
          allowProgressReset: options.initialProgress === 0,
        });
      } else if (targetChapter.id !== chapterId) {
        setInitialProgressOverride(null);
      }

      if (
        targetChapter.id === chapterId &&
        (hasStoredChapterContent(targetChapter) ||
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
          search:
            options?.initialProgress === 0
              ? { chapterId: targetChapter.id, fromStart: true }
              : { chapterId: targetChapter.id },
          replace: true,
        });
      }

      if (hasStoredChapterContent(targetChapter)) {
        return;
      }

      autoDownloadingChapterRef.current = targetChapter.id;
      setAutoDownloadingChapterId(targetChapter.id);
      setDownloadFailure(null);
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
            ...(options?.sourceFallback ? { sourceFallback: true as const } : {}),
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
        } catch (error) {
          if (openRequestRef.current === requestId) {
            setDownloadFailure({
              chapterId: targetChapter.id,
              message: error instanceof Error ? error.message : String(error),
            });
          }
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
    if (!chapter || hasStoredChapterContent(chapter)) return;
    if (autoDownloadingChapterRef.current === chapter.id) return;
    if (suppressedAutoDownloadChapterRef.current === chapter.id) return;
    if (downloadFailure?.chapterId === chapter.id) return;

    void openChapter(chapter);
  }, [chapter, downloadFailure, openChapter]);

  const retryChapterDownload = useCallback(() => {
    if (!chapter) return;
    const serverMissing = downloadFailure?.chapterId === chapter.id &&
      isServerChapterMissingFailure(downloadFailure.message);
    openChapter(chapter, serverMissing ? { sourceFallback: true } : undefined);
  }, [chapter, downloadFailure, openChapter]);

  const chapterMissingContent = Boolean(
    chapter && !hasStoredChapterContent(chapter),
  );
  const chapterUnavailable: ReaderChapterUnavailable | null =
    !chapterMissingContent
      ? null
      : downloadFailure && downloadFailure.chapterId === chapter?.id
        ? { reason: "failed", message: downloadFailure.message }
        : connectivity === "offline" || connectivity === "limited"
          ? { reason: "offline" }
          : null;

  const openAdjacent = useCallback(
    async (direction: 1 | -1, options?: { skipComplete?: boolean }) => {
      if (!chapter?.novelId || chapter.position === undefined) return;
      if (direction === 1 && !options?.skipComplete) {
        contentRef.current?.completeIfAtEnd();
      }
      const listedAdjacent = direction === 1 ? nextChapter : previousChapter;
      const adjacent =
        listedAdjacent ??
        (await getAdjacentChapter(
          chapter.novelId,
          chapter.position,
          direction,
        ));
      if (!adjacent) return;
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
    onBeforeBack?.();
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
  }, [cancelPendingChapterOpen, chapter?.novelId, currentHref, navigate, onBeforeBack]);

  const handleBackToNovel = useCallback(
    (novelId: number): void => {
      onBeforeBack?.();
      cancelPendingChapterOpen();
      if (novelId > 0) {
        const target = findPreviousAppHistoryEntry(currentHref, ["/reader"]);
        if (target && isNovelHrefForId(target.href, novelId)) {
          trimAppNavigationHistoryTo(target);
          window.history.go(-target.steps);
          return;
        }
        void navigate({ to: "/novel", search: { id: novelId }, replace: true });
        return;
      }
      handleReaderBack();
    },
    [
      cancelPendingChapterOpen,
      currentHref,
      handleReaderBack,
      navigate,
      onBeforeBack,
    ],
  );

  usePageBackNavigation(handleReaderBack);

  useEffect(() => {
    const novelId = chapter?.novelId;
    if (!active || !novelId) return;

    const handleReaderPopState = () => {
      window.setTimeout(() => {
        if (window.location.pathname !== "/reader") return;
        onBeforeBack?.();

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
  }, [active, chapter?.novelId, navigate, onBeforeBack]);

  return {
    autoDownloadingChapterId,
    awaitingChapterDownload: chapterMissingContent && !chapterUnavailable,
    chapterUnavailable,
    retryChapterDownload,
    initialProgressOverride,
    setInitialProgressOverride,
    openChapter,
    openAdjacent,
    handleReaderBack,
    handleBackToNovel,
  };
}
