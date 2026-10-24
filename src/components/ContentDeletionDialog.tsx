import { Alert, Checkbox, Group, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { getNovelById } from "../db/queries/novel";
import { useTranslation } from "../i18n";
import { usePageBackNavigation } from "../lib/android-back-navigation";
import { prepareContentDeletion, runContentDeletion, type ContentDeletionAction, type ContentDeletionRequest, type ContentDeletionResult } from "../lib/content-deletion";
import { removeDeletedServerWorkFromQueries } from "../lib/content-sync/management-query-cache";
import { describeError } from "../lib/errors";
import { markUpdatesIndexDirty } from "../lib/updates/update-index-events";
import { finishContentDeletion, useContentDeletionStore } from "../store/content-deletion";
import { TextButton } from "./TextButton";

export function ContentDeletionDialog() {
  const pending = useContentDeletionStore(state => state.pending);
  return pending ? <DeletionConfirmation key={pending.id} id={pending.id} request={pending.request} /> : null;
}

function DeletionConfirmation({ id, request }: { id: number; request: ContentDeletionRequest }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [openedNovelId] = useState(() => {
    const location = router.state.location;
    return location.pathname === "/novel" && typeof location.search.id === "number" ? location.search.id : null;
  });
  const [options, setOptions] = useState({ local: false, server: false });
  const [actions, setActions] = useState<ContentDeletionAction[] | null>(null);
  const [results, setResults] = useState<ContentDeletionResult[]>([]);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const fromServer = request.kind === "server-work" || request.kind === "server-chapters";
  const serverUrl = "source" in request ? request.source.serverUrl : request.serverUrl;
  const close = () => { if (!running.current) finishContentDeletion(id, results.some(result => result.status === "succeeded")); };
  usePageBackNavigation(() => { close(); return true; });
  const execute = async () => {
    if (running.current) return;
    running.current = true; setBusy(true); setError(null);
    try {
      const plan = actions ?? await prepareContentDeletion(request, options);
      setActions(plan);
      const next = await runContentDeletion(plan, results, setResults);
      const actionsById = new Map(plan.map(action => [action.id, action]));
      const previouslySucceeded = new Set(results.filter(result => result.status === "succeeded").map(result => result.id));
      for (const result of next) {
        const action = actionsById.get(result.id);
        if (result.deletedWork && action?.source && !previouslySucceeded.has(result.id)) {
          await removeDeletedServerWorkFromQueries(queryClient, action.source, result.deletedWork);
        }
      }
      if (request.kind === "server-work" && options.local && openedNovelId !== null
        && router.state.location.pathname === "/novel" && router.state.location.search.id === openedNovelId
        && !await getNovelById(openedNovelId)) {
        await router.navigate({ to: "/", replace: true });
      }
      markUpdatesIndexDirty("library-membership");
      for (const key of ["novel", "chapter", "category", "download-cache", "content-server"]) {
        await queryClient.cancelQueries({ queryKey: [key] });
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      if (next.every(result => result.status === "succeeded")) {
        notifications.show({ message: t("contentDeletion.done") });
        finishContentDeletion(id, next.length > 0);
      }
    } catch (cause) { setError(describeError(cause)); }
    finally { running.current = false; setBusy(false); }
  };
  const failed = results.filter(result => result.status === "failed");
  const succeeded = new Set(results.filter(result => result.status === "succeeded").map(result => result.id));
  const defaultLabel = request.kind === "library" ? "contentDeletion.unregister" : fromServer
    ? request.kind === "server-work" ? "contentDeletion.serverWork" : "contentDeletion.serverChapters" : "contentDeletion.localDownloads";
  return <Modal opened onClose={close} title={t("contentDeletion.title")} centered zIndex={400}
    closeOnClickOutside={!busy} closeOnEscape={!busy} withCloseButton={!busy}>
    <Stack>
      <Text fw={600}>{request.title}</Text>
      <Text size="sm">{request.kind === "server-work" ? t("contentDeletion.workCount", { count: 1 })
        : request.kind === "server-chapters" ? t("contentDeletion.chapterCount", { count: request.chapters.length })
        : request.kind === "downloads" && request.scope === "all" ? t("contentDeletion.allDownloads")
        : t(request.kind === "downloads" && request.scope === "chapter" ? "contentDeletion.chapterCount" : "contentDeletion.workCount", { count: new Set(request.ids).size })}</Text>
      {busy ? <Text size="sm" role="status">{t("contentDeletion.waiting")}</Text> : null}
      <Text size="sm" c="dimmed">{t("contentDeletion.hint")}</Text>
      <Checkbox checked disabled label={t(defaultLabel)} />
      {request.kind === "library" || fromServer ? <Checkbox checked={options.local} disabled={busy || actions !== null}
        onChange={event => { const checked = event.currentTarget.checked; setOptions(current => ({ ...current, local: checked })); }}
        label={t(request.kind === "server-work" ? "contentDeletion.localWork" : "contentDeletion.localDownloads")} /> : null}
      {!fromServer ? <Checkbox checked={options.server} disabled={busy || actions !== null || !serverUrl}
        onChange={event => { const checked = event.currentTarget.checked; setOptions(current => ({ ...current, server: checked })); }}
        label={t(request.kind === "library" ? "contentDeletion.serverWork" : "contentDeletion.serverChapters")} /> : null}
      {serverUrl ? <Text size="xs" c="dimmed" className="norea-server-address">{serverUrl}</Text> : <Text size="xs" c="dimmed">{t("contentSync.notConfigured")}</Text>}
      {request.kind === "server-work" && options.local ? <Alert color="orange">{t("contentDeletion.localWorkHint")}</Alert> : null}
      {actions ? <Stack gap="xs" aria-live="polite">
        {(["library", "device", "server"] as const).map(side => {
          const targets = actions.filter(action => action.side === side);
          if (!targets.length) return null;
          const done = targets.filter(action => succeeded.has(action.id)).length;
          return <Text size="sm" key={side}>{t(`contentDeletion.${side}`)}: {done}/{targets.length}</Text>;
        })}
        {failed.length ? <Alert color="red" title={t("contentDeletion.partialFailure", { count: failed.length })}>
          <Stack gap="xs">{failed.slice(0, 10).map(result => <Text size="sm" key={result.id}>
            {actions.find(action => action.id === result.id)?.name}: {result.error}
          </Text>)}</Stack>
        </Alert> : null}
      </Stack> : null}
      {error ? <Alert color="red" title={t("common.actionFailed")}>{error}</Alert> : null}
      <Group justify="flex-end">
        <TextButton disabled={busy} onClick={close}>{t(results.length ? "common.done" : "common.cancel")}</TextButton>
        <TextButton tone="danger" loading={busy} onClick={() => { void execute(); }}>{t(failed.length ? "contentDeletion.retry" : "contentDeletion.confirm")}</TextButton>
      </Group>
    </Stack>
  </Modal>;
}
