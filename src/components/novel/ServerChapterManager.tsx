import { Alert, Badge, Group, Loader, Modal, Pagination, Stack, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { NovelDetailRecord } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { usePageBackNavigation } from "../../lib/android-back-navigation";
import type { ServerChapterPage, ServerChapterSummary } from "../../lib/content-sync/chapters";
import { findServerWork, loadServerChapterPage } from "../../lib/content-sync/management";
import type { ServerNovelSource } from "../../lib/content-sync/novel-source";
import { describeError } from "../../lib/errors";
import { confirmContentDeletion } from "../../store/content-deletion";
import { useContentSyncStore } from "../../store/content-sync";
import { StateView } from "../AppFrame";
import { ConsolePanel, ConsoleSectionHeader } from "../ConsolePrimitives";
import { ServerWorkDeleteButton } from "../ServerWorkDeleteButton";
import { TextButton } from "../TextButton";

interface ServerChapterManagerProps {
  novel: Pick<NovelDetailRecord, "name" | "pluginId" | "path">;
  source: ServerNovelSource | null | undefined;
  active: boolean;
}

export function ServerChapterManager({ novel, source, active }: ServerChapterManagerProps) {
  const { t } = useTranslation();
  const server = useContentSyncStore(state => state.serverUrl);
  const sourceServer = source?.serverUrl ?? server;
  const [managedSource, setManagedSource] = useState<ServerNovelSource | null>(null);
  const presence = useQuery({
    queryKey: ["content-server", "manage-work", sourceServer, novel.pluginId, novel.path],
    queryFn: async ({ signal }) => {
      try { return await findServerWork(sourceServer, { pluginId: novel.pluginId, novelPath: novel.path }, signal); }
      catch { return source ?? null; } // Background discovery must not surface server errors on the work page.
    },
    enabled: active && !!sourceServer,
    staleTime: 30_000,
    retry: false,
  });
  const available = presence.data === undefined ? source : presence.data;
  return <>
    {available ? <TextButton size="sm" onClick={() => setManagedSource({ ...available })}>
      {t("contentSync.manageChapters")}
    </TextButton> : null}
    {managedSource ? <ServerChapterManagerContent source={managedSource} name={novel.name} onClose={() => setManagedSource(null)} /> : null}
  </>;
}

function ServerChapterManagerContent({ source, name, onClose }: { source: ServerNovelSource; name: string; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [workDeletionActive, setWorkDeletionActive] = useState(false);
  const queryKey = ["content-server", source.serverUrl, "managed-chapters", source.workId];
  const chapters = useQuery({
    queryKey: [...queryKey, page],
    queryFn: ({ signal }) => loadServerChapterPage(source, (page - 1) * 100, signal),
    retry: false,
    staleTime: 0,
  });
  const rows = chapters.data?.items ?? [];
  const selectedIds = rows.filter(chapter => selected.has(chapter.id)).map(chapter => chapter.id);
  const remove = useMutation({
    mutationFn: (selectedChapters: readonly ServerChapterSummary[]) => confirmContentDeletion({ kind: "server-chapters", source, title: name, chapters: selectedChapters }),
    onSuccess: async changed => {
      if (!changed) return;
      setSelected(new Set());
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: ["content-server", "novel-chapters", source.serverUrl, source.workId] }),
        queryClient.invalidateQueries({ queryKey: ["content-server", source.serverUrl, "browse"] }),
      ]);
      const remaining = queryClient.getQueryData<ServerChapterPage>([...queryKey, page]);
      if (remaining) setPage(current => Math.min(current, Math.max(1, Math.ceil(remaining.total / 100))));
    },
  });
  usePageBackNavigation(() => {
    if (workDeletionActive) return false;
    if (remove.isPending) return true;
    onClose();
    return true;
  });
  const busy = remove.isPending || workDeletionActive;
  const unavailable = chapters.isFetching || !!chapters.error || busy;
  const refresh = () => { setSelected(new Set()); remove.reset(); void chapters.refetch(); };
  const changePage = (next: number) => { setSelected(new Set()); remove.reset(); setPage(next); };
  const error = remove.error ?? chapters.error;
  const close = () => { if (!busy) onClose(); };
  return <Modal opened onClose={close} fullScreen title={t("contentSync.manageChapters")}
    classNames={{ inner: "norea-server-management-modal", content: "norea-server-management-dialog" }}
    closeOnEscape={!busy} withCloseButton={!busy}>
    <Stack className="norea-server-management" gap="md">
      <ConsoleSectionHeader title={name} eyebrow={t("contentSync.manageChapters")}
        actions={<TextButton onClick={close} disabled={busy}>{t("contentSync.backToWork")}</TextButton>} />
      <ConsolePanel p="md">
        <Stack gap="xs">
          <Group gap="sm"><Badge variant="light">{t("contentSync.serverDataOnly")}</Badge>
            <Text className="norea-server-address" size="sm" c="dimmed">{source.serverUrl}</Text></Group>
          <Text size="sm">{t("contentSync.manageChaptersHint")}</Text>
          <Group>
            <ServerWorkDeleteButton source={source} name={name} disabled={remove.isPending}
              onOpenChange={setWorkDeletionActive} onDeleted={onClose} />
          </Group>
        </Stack>
      </ConsolePanel>
      <ConsolePanel className="norea-server-chapters-panel">
        <ConsoleSectionHeader title={t("contentSync.serverChapters")} count={t("contentSync.catalogCount", { count: chapters.data?.total ?? 0 })}
          actions={<TextButton size="sm" onClick={refresh} disabled={chapters.isFetching || busy}>{t("common.refresh")}</TextButton>} />
        <div className="norea-server-selection-bar">
          <Text size="sm" aria-live="polite">{t("novel.selection.selectedCount", { count: selectedIds.length })}</Text>
          <Group gap="xs" wrap="wrap">
            <TextButton size="sm" disabled={unavailable || !rows.length} onClick={() => setSelected(new Set(rows.map(chapter => chapter.id)))}>{t("contentSync.selectPage")}</TextButton>
            <TextButton size="sm" disabled={busy || !selectedIds.length} onClick={() => setSelected(new Set())}>{t("novel.selection.clearSelected")}</TextButton>
            <TextButton size="sm" tone="danger" disabled={unavailable || !selectedIds.length} loading={remove.isPending}
              onClick={() => remove.mutate(rows.filter(chapter => selected.has(chapter.id)))}>{t("contentSync.deleteSelectedServer", { count: selectedIds.length })}</TextButton>
          </Group>
        </div>
        {error ? <Alert color="red" title={t("common.actionFailed")}>{describeError(error)}</Alert> : null}
        {chapters.isFetching ? <Group p="md"><Loader size="sm" /><Text>{t("contentSync.loadingServerChapters")}</Text></Group> : null}
        {!chapters.isPending && !error && !rows.length ? <StateView title={t("contentSync.noServerChapters")} /> : null}
        <div className="norea-server-chapter-list" aria-label={t("contentSync.serverChapters")}>
          {rows.map(chapter => <label className="norea-server-chapter-row" key={chapter.id}>
            <input type="checkbox" checked={selected.has(chapter.id)} disabled={unavailable} onChange={() => setSelected(current => {
              const next = new Set(current); if (next.has(chapter.id)) next.delete(chapter.id); else next.add(chapter.id); return next;
            })} />
            <span className="norea-server-chapter-number">{chapter.chapterNumber ?? chapter.position}</span>
            <span className="norea-server-chapter-title">{chapter.name}</span>
          </label>)}
        </div>
        {(chapters.data?.total ?? 0) > 100 || page > 1 ? <Group p="md" justify="center">
          <Pagination value={page} total={Math.max(page, Math.ceil((chapters.data?.total ?? 0) / 100))} onChange={changePage} disabled={unavailable} siblings={0} boundaries={1} />
        </Group> : null}
      </ConsolePanel>
    </Stack>
  </Modal>;
}
