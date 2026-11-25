import { Button, Group } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { isAbortError } from "../../lib/abort";
import type { ServerWorkSummary } from "../../lib/content-sync/browse";
import { describeError } from "../../lib/errors";
import type { TaskHandle } from "../../lib/tasks/scheduler";
import {
  enqueueServerLibraryAdd,
  failedWorkNames,
  ServerLibraryAddError,
  serverLibraryAddSummary,
  type ServerLibraryAddRequest,
  type ServerLibraryAddResult,
} from "./server-library-add";
import { downloadServerWorksOnce } from "./server-download-all";

type Translate = ReturnType<typeof useTranslation>["t"];

function retryToast(id: string, title: string, message: ReactNode, retryLabel: string, retry: () => void) {
  notifications.show({
    color: "danger",
    id,
    message: (
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <span>{message}</span>
        <Button onClick={() => { notifications.hide(id); retry(); }} size="compact-sm" variant="subtle">
          {retryLabel}
        </Button>
      </Group>
    ),
    title,
  });
}

/**
 * Starts the background add and toasts its outcome: "Added 118 · 2 failed ·
 * Retry" retries only the failed works. The toast and retries do not depend on
 * the page that started the add staying mounted.
 */
export function startServerLibraryAdd(
  request: ServerLibraryAddRequest,
  t: Translate,
  queryClient: QueryClient,
): TaskHandle<ServerLibraryAddResult> {
  const restart = (works: ServerLibraryAddRequest["works"]) => startServerLibraryAdd(
    { ...request, count: Array.isArray(works) ? works.length : request.count, works },
    t,
    queryClient,
  );
  const handle = enqueueServerLibraryAdd(request, t, restart);
  const toastId = `server-library-add:${handle.id}`;
  void handle.promise
    .then((result) => {
      notifications.show({ color: "ok", id: toastId, message: serverLibraryAddSummary(t, result) });
    })
    .catch((error: unknown) => {
      if (isAbortError(error)) return;
      if (error instanceof ServerLibraryAddError) {
        retryToast(toastId, serverLibraryAddSummary(t, error.result), failedWorkNames(error.result), t("common.retry"),
          () => restart(error.result.failed.map(failure => failure.work)));
        return;
      }
      retryToast(toastId, t("serverLibraryAdd.failed"), describeError(error), t("common.retry"), () => restart(request.works));
    })
    .finally(() => {
      void queryClient.invalidateQueries({ queryKey: ["novel"] });
      void queryClient.invalidateQueries({ queryKey: ["category"] });
    });
  return handle;
}

export interface ServerLibraryAddPrompt {
  count: number;
  /** Works whose chapters not downloaded yet are queued once the add settles; may include works already in the library. */
  downloadChaptersOf?: readonly ServerWorkSummary[];
  /** Runs once the task has been queued, for example to leave selection mode. */
  onStarted?: () => void;
  works: ServerLibraryAddRequest["works"];
}

/**
 * Starts a bulk server library add immediately without opening a category selection sheet.
 * A request with `downloadChaptersOf` also queues those works' chapters after the add.
 */
export function useServerLibraryAdd(server: string): {
  request: (prompt: ServerLibraryAddPrompt) => void;
} {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return {
    request: (prompt) => {
      const handle = startServerLibraryAdd(
        { categoryIds: [], count: prompt.count, server, works: prompt.works },
        t,
        queryClient,
      );
      if (prompt.downloadChaptersOf) {
        void downloadServerWorksOnce(
          prompt.downloadChaptersOf,
          handle.promise,
          t,
          queryClient,
          server,
        );
      }
      notifications.show({
        message: t("serverLibraryAdd.started", { count: prompt.count }),
      });
      prompt.onStarted?.();
    },
  };
}
