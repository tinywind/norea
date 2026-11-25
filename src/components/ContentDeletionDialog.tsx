import { Button, Checkbox, Divider, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { getNovelById } from "../db/queries/novel";
import { useTranslation } from "../i18n";
import { deletedDownloadChapterIds, prepareContentDeletion, runContentDeletion, type ContentDeletionAction, type ContentDeletionRequest, type ContentDeletionResult } from "../lib/content-deletion";
import { removeDeletedServerWorkFromQueries } from "../lib/content-sync/management-query-cache";
import { noteDownloadDeletion } from "../lib/download-goals/goal-service";
import { describeError } from "../lib/errors";
import { markUpdatesIndexDirty } from "../lib/updates/update-index-events";
import { finishContentDeletion, useContentDeletionStore } from "../store/content-deletion";
import { WarningIcon } from "./ui/icons";
import { ResponsiveSheet, SheetActions } from "./ui/ResponsiveSheet";
import { StatusAlert } from "./ui/StatusAlert";
import { useStopDownloadGoalsOffer } from "./use-stop-download-goals-offer";

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
  const [confirmingServerDelete, setConfirmingServerDelete] = useState(false);
  const [actions, setActions] = useState<ContentDeletionAction[] | null>(null);
  const [results, setResults] = useState<ContentDeletionResult[]>([]);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const offerToStopDownloadGoals = useStopDownloadGoalsOffer();
  const isServerWorkDeletion = request.kind === "server-work" || request.kind === "server-works";
  const fromServer = isServerWorkDeletion || request.kind === "server-chapters";
  const serverUrl = request.kind === "server-work" || request.kind === "server-chapters"
    ? request.source.serverUrl
    : request.kind === "server-works"
      ? request.works[0]?.source.serverUrl ?? ""
      : request.serverUrl;
  const close = async () => {
    if (running.current) return;
    const deletedChapterIds = request.kind === "downloads" && actions ? deletedDownloadChapterIds(actions, results) : [];
    if (deletedChapterIds.length) {
      running.current = true; setBusy(true);
      try { await offerToStopDownloadGoals(deletedChapterIds); }
      catch (cause) { console.warn("[content-deletion] could not offer to stop download goals:", cause); }
      finally { running.current = false; setBusy(false); }
    }
    finishContentDeletion(id, results.some(result => result.status === "succeeded"));
  };
  const execute = async () => {
    if (running.current) return;
    running.current = true; setBusy(true); setError(null);
    try {
      const plan = actions ?? await prepareContentDeletion(request, options);
      setActions(plan);
      setConfirmingServerDelete(false);
      if (plan.some(action => action.side === "server")) {
        await Promise.all(["chapter-differences", "manage-work", "novel-chapters"].map(key =>
          queryClient.cancelQueries({ queryKey: ["content-server", key] })));
      }
      const next = await runContentDeletion(plan, results, setResults);
      const actionsById = new Map(plan.map(action => [action.id, action]));
      const previouslySucceeded = new Set(results.filter(result => result.status === "succeeded").map(result => result.id));
      for (const result of next) {
        const action = actionsById.get(result.id);
        if (result.deletedWork && action?.source && !previouslySucceeded.has(result.id)) {
          await removeDeletedServerWorkFromQueries(queryClient, action.source, result.deletedWork);
        }
      }
      if (isServerWorkDeletion && options.local && openedNovelId !== null
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
        if (request.kind === "downloads") await offerToStopDownloadGoals(deletedDownloadChapterIds(plan, next));
        finishContentDeletion(id, next.length > 0);
      } else if (request.kind === "downloads") {
        // Closing the sheet makes the offer; the exclusions must hold before then.
        const deletedChapterIds = deletedDownloadChapterIds(plan, next);
        if (deletedChapterIds.length) await noteDownloadDeletion(deletedChapterIds);
      }
    } catch (cause) { setError(describeError(cause)); }
    finally { running.current = false; setBusy(false); }
  };
  const failed = results.filter(result => result.status === "failed");
  const succeeded = new Set(results.filter(result => result.status === "succeeded").map(result => result.id));
  const libraryCount = request.kind === "library" ? new Set(request.ids).size : 0;
  const serverWorksCount = request.kind === "server-works"
    ? new Set(request.works.map(work => work.source.workId)).size
    : 0;
  // One sentence states what the confirm button does; the optional extras follow as checkboxes.
  const summary = request.kind === "library" ? t("contentDeletion.summary.library", { count: libraryCount })
    : request.kind === "server-work" ? t("contentDeletion.summary.serverWork")
    : request.kind === "server-works" ? t("contentDeletion.summary.serverWorks", { count: serverWorksCount })
    : request.kind === "server-chapters" ? t("contentDeletion.summary.serverChapters", { count: request.chapters.length })
    : request.scope === "all" ? t("contentDeletion.summary.allDownloads")
    : t(request.scope === "chapter" ? "contentDeletion.summary.chapterDownloads" : "contentDeletion.summary.novelDownloads",
      { count: new Set(request.ids).size });
  const unshelve = request.kind === "library";
  const localOption = request.kind === "library" && request.downloadedCount !== undefined
    ? request.downloadedCount > 0 ? t("contentDeletion.alsoDeleteDownloads", { count: request.downloadedCount }) : null
    : t(
      request.kind === "server-work"
        ? "contentDeletion.localWork"
        : request.kind === "server-works"
          ? "contentDeletion.localWorks"
          : "contentDeletion.localDownloads",
    );
  const serverOption = !fromServer && serverUrl && !(request.kind === "library" && request.serverWork === false)
    ? t(request.kind === "library" ? "contentDeletion.alsoDeleteFromServer" : "contentDeletion.serverChapters")
    : null;
  // Library unshelving isolates server deletion into a second confirmation step so an accidental
  // checkbox tap cannot permanently wipe works from the content server.
  const inServerConfirmStep = unshelve && options.server && confirmingServerDelete && actions === null;
  const needsServerConfirmStep = unshelve && options.server && !confirmingServerDelete && actions === null;
  // Deletion opens from inside sheets and managers, so it takes the nested layer.
  return <ResponsiveSheet busy={busy} nested opened onClose={() => { void close(); }} subtitle={request.title}
    title={t(inServerConfirmStep ? "contentDeletion.serverConfirmTitle" : unshelve ? "contentDeletion.unshelveTitle" : "contentDeletion.title")}
    footer={<SheetActions>
      <Button
        disabled={busy}
        onClick={() => {
          if (inServerConfirmStep) {
            setError(null);
            setConfirmingServerDelete(false);
          } else {
            void close();
          }
        }}
        variant="default"
      >
        {t(inServerConfirmStep ? "common.back" : results.length ? "common.done" : "common.cancel")}
      </Button>
      <Button
        color="danger"
        loading={busy}
        onClick={() => {
          if (needsServerConfirmStep) {
            setError(null);
            setConfirmingServerDelete(true);
          } else {
            void execute();
          }
        }}
      >
        {t(
          failed.length
            ? "contentDeletion.retry"
            : inServerConfirmStep
              ? "contentDeletion.confirmServerDeletion"
              : needsServerConfirmStep
                ? "contentDeletion.reviewServerDeletion"
                : unshelve && !options.local && !options.server
                  ? "common.remove"
                  : "contentDeletion.confirm",
        )}
      </Button>
    </SheetActions>}>
    <Stack>
      {inServerConfirmStep ? (
        <>
          <StatusAlert color="danger" title={t("contentDeletion.serverDangerTitle")}>
            {t("contentDeletion.serverConfirmSummary", { count: libraryCount })}
          </StatusAlert>
          {options.local && localOption ? <Text size="sm">{localOption}</Text> : null}
          {busy ? <Text size="sm" role="status">{t("contentDeletion.waiting")}</Text> : null}
        </>
      ) : (
        <>
          <Text size="sm">{summary}</Text>
          {busy ? <Text size="sm" role="status">{t("contentDeletion.waiting")}</Text> : null}
          {isServerWorkDeletion ? (
            <StatusAlert color="danger" title={t("contentDeletion.serverDangerTitle")}>
              {t("contentDeletion.serverDangerWarning")}
            </StatusAlert>
          ) : null}
          {(request.kind === "library" || fromServer) && localOption ? <Checkbox checked={options.local} disabled={busy || actions !== null}
            onChange={event => { const checked = event.currentTarget.checked; setOptions(current => ({ ...current, local: checked })); }}
            label={localOption} /> : null}
          {serverOption && unshelve ? (
            <>
              <Divider />
              <div className="norea-content-deletion-danger-zone">
                <div className="norea-content-deletion-danger-heading">
                  <WarningIcon size="1rem" />
                  <span>{t("contentDeletion.serverDangerTitle")}</span>
                </div>
                <p className="norea-content-deletion-danger-copy">
                  {t("contentDeletion.serverDangerWarning")}
                </p>
                <Checkbox
                  checked={options.server}
                  color="danger"
                  disabled={busy || actions !== null}
                  onChange={event => {
                    const checked = event.currentTarget.checked;
                    setOptions(current => ({ ...current, server: checked }));
                    if (!checked) setConfirmingServerDelete(false);
                  }}
                  label={serverOption}
                />
              </div>
            </>
          ) : serverOption ? (
            <Checkbox checked={options.server} disabled={busy || actions !== null}
              onChange={event => { const checked = event.currentTarget.checked; setOptions(current => ({ ...current, server: checked })); }}
              label={serverOption} />
          ) : null}
          {isServerWorkDeletion && options.local ? <StatusAlert color="warn">{t("contentDeletion.localWorkHint")}</StatusAlert> : null}
          {actions ? <Stack gap="xs" aria-live="polite">
            {(["library", "device", "server"] as const).map(side => {
              const targets = actions.filter(action => action.side === side);
              if (!targets.length) return null;
              const done = targets.filter(action => succeeded.has(action.id)).length;
              return <Text size="sm" key={side}>{t(`contentDeletion.${side}`)}: {done}/{targets.length}</Text>;
            })}
            {failed.length ? <StatusAlert color="danger" title={t("contentDeletion.partialFailure", { count: failed.length })}>
              <Stack gap="xs">{failed.slice(0, 10).map(result => <Text size="sm" key={result.id}>
                {actions.find(action => action.id === result.id)?.name}: {result.error}
              </Text>)}</Stack>
            </StatusAlert> : null}
          </Stack> : null}
        </>
      )}
      {error ? <StatusAlert color="danger" title={t("common.actionFailed")}>{error}</StatusAlert> : null}
    </Stack>
  </ResponsiveSheet>;
}
