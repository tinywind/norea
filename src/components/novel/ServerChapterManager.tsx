import { Alert, Badge, Group, Loader, Modal, Pagination, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { NovelDetailRecord } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { usePageBackNavigation } from "../../lib/android-back-navigation";
import type { ServerChapterPage } from "../../lib/content-sync/chapters";
import { deleteSelectedServerChapters, findServerWork, loadServerChapterPage } from "../../lib/content-sync/management";
import type { ServerNovelSource } from "../../lib/content-sync/novel-source";
import { describeError } from "../../lib/errors";
import { useContentSyncStore } from "../../store/content-sync";
import { StateView } from "../AppFrame";
import { ConsolePanel, ConsoleSectionHeader } from "../ConsolePrimitives";
import { TextButton } from "../TextButton";

interface ServerChapterManagerProps {
  novel: Pick<NovelDetailRecord, "name" | "pluginId" | "path">;
  source: ServerNovelSource | null | undefined;
  active: boolean;
}

export function ServerChapterManager({ novel, source, active }: ServerChapterManagerProps) {
  const { t } = useTranslation();
  const server = useContentSyncStore(state => state.serverUrl);
  const [managedSource, setManagedSource] = useState<ServerNovelSource | null>(null);
  const presence = useQuery({
    queryKey: ["content-server", "manage-work", server, novel.pluginId, novel.path],
    queryFn: async ({ signal }) => {
      try { return await findServerWork(server, { pluginId: novel.pluginId, novelPath: novel.path }, signal); }
      catch { return null; } // Background discovery must not surface server errors on the work page.
    },
    enabled: active && !!server && !source,
    staleTime: 30_000,
    retry: false,
  });
  const available = source ?? presence.data;
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
  const [confirmation, setConfirmation] = useState<readonly string[] | null>(null);
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
    mutationFn: (ids: readonly string[]) => deleteSelectedServerChapters(source, ids),
    onSuccess: () => notifications.show({ message: t("contentSync.serverDeleteDone") }),
    onSettled: async () => {
      setConfirmation(null);
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
    if (remove.isPending) return true;
    if (confirmation) setConfirmation(null);
    else onClose();
    return true;
  });
  const unavailable = chapters.isFetching || !!chapters.error || remove.isPending;
  const refresh = () => { setSelected(new Set()); remove.reset(); void chapters.refetch(); };
  const changePage = (next: number) => { setSelected(new Set()); remove.reset(); setPage(next); };
  const error = remove.error ?? chapters.error;
  return <Modal opened onClose={onClose} fullScreen title={t("contentSync.manageChapters")}
    closeOnEscape={!confirmation && !remove.isPending} withCloseButton={!remove.isPending}>
    <Stack className="norea-server-management" gap="md">
      <ConsoleSectionHeader title={name} eyebrow={t("contentSync.manageChapters")}
        actions={<TextButton onClick={onClose} disabled={remove.isPending}>{t("contentSync.backToWork")}</TextButton>} />
      <ConsolePanel p="md">
        <Stack gap="xs">
          <Group gap="sm"><Badge variant="light">{t("contentSync.serverDataOnly")}</Badge>
            <Text className="norea-server-address" size="sm" c="dimmed">{source.serverUrl}</Text></Group>
          <Text size="sm">{t("contentSync.manageChaptersHint")}</Text>
        </Stack>
      </ConsolePanel>
      <ConsolePanel className="norea-server-chapters-panel">
        <ConsoleSectionHeader title={t("contentSync.serverChapters")} count={t("contentSync.catalogCount", { count: chapters.data?.total ?? 0 })}
          actions={<TextButton size="sm" onClick={refresh} disabled={chapters.isFetching || remove.isPending}>{t("common.refresh")}</TextButton>} />
        <div className="norea-server-selection-bar">
          <Text size="sm" aria-live="polite">{t("novel.selection.selectedCount", { count: selectedIds.length })}</Text>
          <Group gap="xs" wrap="wrap">
            <TextButton size="sm" disabled={unavailable || !rows.length} onClick={() => setSelected(new Set(rows.map(chapter => chapter.id)))}>{t("contentSync.selectPage")}</TextButton>
            <TextButton size="sm" disabled={remove.isPending || !selectedIds.length} onClick={() => setSelected(new Set())}>{t("novel.selection.clearSelected")}</TextButton>
            <TextButton size="sm" tone="danger" disabled={unavailable || !selectedIds.length} loading={remove.isPending}
              onClick={() => setConfirmation(selectedIds)}>{t("contentSync.deleteSelectedServer", { count: selectedIds.length })}</TextButton>
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
      <Modal opened={confirmation !== null} onClose={() => { if (!remove.isPending) setConfirmation(null); }}
        title={t("contentSync.deleteServer")} centered closeOnClickOutside={!remove.isPending} closeOnEscape={!remove.isPending} withCloseButton={!remove.isPending}>
        <Stack>
          <Text>{t("contentSync.deleteSelectedConfirm", { count: confirmation?.length ?? 0, name })}</Text>
          <Text size="sm" c="dimmed" className="norea-server-address">{source.serverUrl}</Text>
          <Group justify="flex-end">
            <TextButton disabled={remove.isPending} onClick={() => setConfirmation(null)}>{t("common.cancel")}</TextButton>
            <TextButton tone="danger" loading={remove.isPending} disabled={!confirmation?.length}
              onClick={() => { if (confirmation?.length) remove.mutate(confirmation); }}>{t("contentSync.deleteServer")}</TextButton>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  </Modal>;
}
