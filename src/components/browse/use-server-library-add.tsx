import { Button, Checkbox, Group, Loader, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { listCategories } from "../../db/queries/category";
import { useTranslation } from "../../i18n";
import { isAbortError } from "../../lib/abort";
import type { ServerWorkSummary } from "../../lib/content-sync/browse";
import { describeError } from "../../lib/errors";
import type { TaskHandle } from "../../lib/tasks/scheduler";
import { ResponsiveSheet, SheetActions } from "../ui/ResponsiveSheet";
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
 * The confirm sheet for a bulk server add: the work count and an optional
 * set of manual categories for the added works. A prompt with
 * `downloadChaptersOf` also queues those works' chapters after the add.
 * Render `sheet` once in the page.
 */
export function useServerLibraryAdd(server: string): {
  request: (prompt: ServerLibraryAddPrompt) => void;
  sheet: ReactNode;
} {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState<ServerLibraryAddPrompt | null>(null);
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const categoriesQuery = useQuery({
    meta: { errorPresentation: "inline" },
    queryKey: ["category", "list"],
    queryFn: () => listCategories(),
    enabled: prompt !== null,
  });
  const categories = (categoriesQuery.data ?? []).filter(category => !category.isSystem);
  const close = () => setPrompt(null);
  const confirm = () => {
    if (!prompt) return;
    const handle = startServerLibraryAdd({ categoryIds, count: prompt.count, server, works: prompt.works }, t, queryClient);
    if (prompt.downloadChaptersOf) void downloadServerWorksOnce(prompt.downloadChaptersOf, handle.promise, t, queryClient, server);
    notifications.show({ message: t("serverLibraryAdd.started", { count: prompt.count }) });
    prompt.onStarted?.();
    setPrompt(null);
  };

  const sheet = (
    <ResponsiveSheet
      footer={
        <SheetActions>
          <Button onClick={close} type="button" variant="default">{t("common.cancel")}</Button>
          <Button disabled={!prompt} onClick={confirm} type="button">{t("quickAdd.add")}</Button>
        </SheetActions>
      }
      onClose={close}
      opened={prompt !== null}
      title={t("serverLibraryAdd.confirmTitle", { count: prompt?.count ?? 0 })}
    >
      <Stack gap="md">
        <Text c="dimmed" size="sm">
          {t(prompt?.downloadChaptersOf ? "serverLibraryAdd.downloadAllConfirmMessage" : "serverLibraryAdd.confirmMessage")}
        </Text>
        <Text fw="var(--norea-weight-bold)" size="sm">{t("serverLibraryAdd.categories")}</Text>
        {categoriesQuery.isPending ? <Loader size="sm" /> : null}
        {categoriesQuery.error ? <Text c="danger" role="alert" size="sm">{t("categories.loadFailed")}</Text> : null}
        {categories.map(category => (
          <Checkbox
            checked={categoryIds.includes(category.id)}
            key={category.id}
            label={category.name}
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              setCategoryIds(current => checked ? [...current, category.id] : current.filter(id => id !== category.id));
            }}
          />
        ))}
        {!categoriesQuery.isPending && !categoriesQuery.error && categories.length === 0 ? (
          <Text c="dimmed" size="sm">{t("categories.noManual")}</Text>
        ) : null}
      </Stack>
    </ResponsiveSheet>
  );

  return {
    request: (next) => {
      setCategoryIds([]);
      setPrompt(next);
    },
    sheet,
  };
}
