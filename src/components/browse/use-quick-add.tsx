import { Button, Group } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { getNovelById, setNovelInLibrary } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { isAbortError } from "../../lib/abort";
import { openServerNovel, type ServerWorkSummary } from "../../lib/content-sync/browse";
import { userFacingErrorKey } from "../../lib/errors";
import { saveNovelCoverFromSource } from "../../lib/novel-cover-storage";
import { enqueueOpenNovelFromSourceTask } from "../../lib/plugins/open-novel-task";
import type { NovelItem, Plugin } from "../../lib/plugins/types";
import { markUpdatesIndexDirty } from "../../lib/updates/update-index-events";
import { NovelCategoryEditor } from "../novel/NovelCategoryEditor";

export type QuickAddTarget =
  | { kind: "source"; item: NovelItem; plugin: Plugin }
  | { kind: "server"; server: string; work: ServerWorkSummary };

export function quickAddKey(target: QuickAddTarget): string {
  return target.kind === "source"
    ? JSON.stringify(["source", target.plugin.id, target.item.path])
    : JSON.stringify(["server", target.server, target.work.id]);
}

function quickAddName(target: QuickAddTarget): string {
  return target.kind === "source" ? target.item.name : target.work.novel.name;
}

/**
 * Imports a cover-grid item into the library without leaving the grid. A
 * source item runs the background open-novel import; a server work uses the
 * server install path.
 */
export async function addQuickAddTargetToLibrary(
  target: QuickAddTarget,
  taskTitle: string,
): Promise<number> {
  const novelId = target.kind === "source"
    ? await enqueueOpenNovelFromSourceTask({
        item: target.item,
        plugin: target.plugin,
        priority: "user",
        title: taskTitle,
      }).promise
    : await openServerNovel(target.server, target.work);
  await setNovelInLibrary(novelId, true);
  markUpdatesIndexDirty("library-membership");
  if (target.kind === "source") {
    const novel = await getNovelById(novelId);
    if (novel?.cover && !novel.isLocal) {
      void saveNovelCoverFromSource(
        target.plugin,
        { id: novel.id, name: novel.name, path: novel.path, pluginId: novel.pluginId },
        novel.cover,
      ).catch((error: unknown) => {
        console.warn("[quick-add] failed to store novel cover", { error, novelId });
      });
    }
  }
  return novelId;
}

/**
 * RD8 quick add: `add` ignores a target that is already pending, then toasts
 * "Added · Change category" or "Couldn't add · Retry". Render `categorySheet`
 * once in the page so the toast action can open it.
 */
export function useQuickAddToLibrary(): {
  add: (target: QuickAddTarget) => void;
  categorySheet: ReactNode;
  isPending: (target: QuickAddTarget) => boolean;
} {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const pendingRef = useRef(new Set<string>());
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [categoryTarget, setCategoryTarget] = useState<{ id: number; name: string } | null>(null);

  const setPending = useCallback((key: string, pending: boolean) => {
    if (pending) pendingRef.current.add(key);
    else pendingRef.current.delete(key);
    setPendingKeys(new Set(pendingRef.current));
  }, []);

  const add = useCallback(
    (target: QuickAddTarget) => {
      const key = quickAddKey(target);
      if (pendingRef.current.has(key)) return;
      const name = quickAddName(target);
      setPending(key, true);
      void addQuickAddTargetToLibrary(target, t("tasks.task.addToLibrary", { name }))
        .then((novelId) => {
          void queryClient.invalidateQueries({ queryKey: ["novel"] });
          const toastId = `quick-add:${key}`;
          notifications.show({
            color: "ok",
            id: toastId,
            message: (
              <Group gap="xs" justify="space-between" wrap="nowrap">
                <span>{t("quickAdd.added", { name })}</span>
                <Button
                  onClick={() => {
                    notifications.hide(toastId);
                    setCategoryTarget({ id: novelId, name });
                  }}
                  size="compact-sm"
                  variant="subtle"
                >
                  {t("quickAdd.changeCategory")}
                </Button>
              </Group>
            ),
          });
        })
        .catch((error: unknown) => {
          if (isAbortError(error)) return;
          const toastId = `quick-add-failed:${key}`;
          notifications.show({
            color: "danger",
            id: toastId,
            message: (
              <Group gap="xs" justify="space-between" wrap="nowrap">
                <span>{t(userFacingErrorKey(error))}</span>
                <Button
                  onClick={() => {
                    notifications.hide(toastId);
                    add(target);
                  }}
                  size="compact-sm"
                  variant="subtle"
                >
                  {t("common.retry")}
                </Button>
              </Group>
            ),
            title: t("quickAdd.failed", { name }),
          });
        })
        .finally(() => setPending(key, false));
    },
    [queryClient, setPending, t],
  );

  const isPending = useCallback(
    (target: QuickAddTarget) => pendingKeys.has(quickAddKey(target)),
    [pendingKeys],
  );

  const categorySheet = categoryTarget ? (
    <NovelCategoryEditor
      key={categoryTarget.id}
      active
      novelId={categoryTarget.id}
      novelName={categoryTarget.name}
      onCloseSheet={() => setCategoryTarget(null)}
      onOpenSheet={() => undefined}
      sheetOpen
      sheetOnly
    />
  ) : null;

  return { add, categorySheet, isPending };
}
