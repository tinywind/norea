import { Alert, Checkbox, Group, Modal, MultiSelect, Select, Stack, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { listCategories, UNCATEGORIZED_CATEGORY_ID } from "../db/queries/category";
import { useTranslation, type TranslationKey } from "../i18n";
import {
  approveChapterCleanupTargets, chapterCleanupProtectedCounts, previewChapterCleanup,
  type ChapterCleanupFilters, type ChapterCleanupPreview, type ChapterCleanupServerMode, type ChapterCleanupSkipReason,
} from "../lib/chapter-cleanup";
import { listGoalProtectedChapterIds } from "../lib/download-goals/goal-protection";
import { enqueueChapterCleanup, type ChapterCleanupResult } from "../lib/tasks/chapter-cleanup";
import { taskScheduler } from "../lib/tasks/scheduler";
import { useContentSyncStore } from "../store/content-sync";
import { TextButton } from "./TextButton";
import { useStopDownloadGoalsOffer } from "./use-stop-download-goals-offer";

const SERVER_OPTIONS: Record<ChapterCleanupServerMode, TranslationKey> = {
  "server-present": "chapterCleanup.server.present",
  "server-coverage": "chapterCleanup.server.coverage",
  "server-contains-local": "chapterCleanup.server.contains",
  any: "chapterCleanup.server.any",
};
const SKIP_LABELS: Record<ChapterCleanupSkipReason, TranslationKey> = {
  "no-payload": "chapterCleanup.skip.noPayload",
  "no-server": "chapterCleanup.skip.noServer",
  "server-missing": "chapterCleanup.skip.serverMissing",
  "server-conflict": "chapterCleanup.skip.serverConflict",
  "server-error": "chapterCleanup.skip.serverError",
  "server-auth": "chapterCleanup.skip.serverAuth",
  "server-unavailable": "chapterCleanup.skip.serverUnavailable",
  "server-timeout": "chapterCleanup.skip.serverTimeout",
  "storage-error": "chapterCleanup.skip.storageError",
  "not-covered": "chapterCleanup.skip.notCovered",
  "not-contained": "chapterCleanup.skip.notContained",
  "not-comparable": "chapterCleanup.skip.notComparable",
  changed: "chapterCleanup.skip.changed",
  "ambiguous-storage": "chapterCleanup.skip.ambiguousStorage",
};

function cleanupFailureDetail(value: string): string {
  return value.replace(/https?:\/\/\S+/gi, "[server]")
    .replace(/(?:token|password|authorization|secret|key)\s*[:=]\s*\S+/gi, "[credential]")
    .replace(/(?:\/[^\s:]+){2,}|[A-Za-z]:\\[^\s]+/g, "[path]")
    .slice(0, 180);
}

function formatBytes(bytes: number, locale: string): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes); let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 0 || value >= 10 ? 0 : 1 }).format(value) + " " + units[unit];
}

export function ChapterCleanupPanel({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t, locale } = useTranslation();
  const queryClient = useQueryClient();
  const serverSetting = useContentSyncStore(state => state.serverUrl);
  const categories = useQuery({ queryKey: ["category", "list"], queryFn: () => listCategories(), staleTime: Infinity, enabled: opened, meta: { errorPresentation: "inline" } });
  const [filters, setFilters] = useState<ChapterCleanupFilters>({ server: "server-contains-local", reading: "read", categories: { mode: "all" } });
  const [preview, setPreview] = useState<ChapterCleanupPreview | null>(null);
  const [goalKeptIds, setGoalKeptIds] = useState<ReadonlySet<number>>(() => new Set());
  const [approval, setApproval] = useState({ includeUnread: false, includeGoalKept: false });
  const offerToStopDownloadGoals = useStopDownloadGoalsOffer();
  const [confirming, setConfirming] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [checked, setChecked] = useState(0);
  const [result, setResult] = useState<ChapterCleanupResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const inspection = useRef<AbortController | null>(null);
  const taskId = useRef<string | null>(null);
  const serverRef = useRef(serverSetting);
  const clearPreview = () => {
    inspection.current?.abort(); inspection.current = null; setInspecting(false); setPreview(null); setConfirming(false); setPage(0);
    setGoalKeptIds(new Set()); setApproval({ includeUnread: false, includeGoalKept: false });
  };
  useEffect(() => {
    if (serverRef.current !== serverSetting) { serverRef.current = serverSetting; clearPreview(); }
  }, [serverSetting]);
  useEffect(() => () => { inspection.current?.abort(); }, []);
  const changeFilters = (next: ChapterCleanupFilters) => { clearPreview(); setResult(null); setError(null); setFilters(next); };
  const createPreview = async () => {
    clearPreview(); setResult(null); setError(null); setChecked(0);
    const controller = new AbortController(); inspection.current = controller; setInspecting(true);
    try {
      const next = await previewChapterCleanup(filters, controller.signal, setChecked);
      const kept = await listGoalProtectedChapterIds([...new Set(next.targets.map(target => target.candidate.identity.novel.id))]);
      if (!controller.signal.aborted) { setGoalKeptIds(kept); setPreview(next); }
    } catch { if (!controller.signal.aborted) setError(t("chapterCleanup.failed")); }
    finally { if (inspection.current === controller) { inspection.current = null; setInspecting(false); } }
  };
  const approved = preview ? approveChapterCleanupTargets(preview, goalKeptIds, approval) : null;
  const protectedCounts = preview ? chapterCleanupProtectedCounts(preview, goalKeptIds) : { unread: 0, goalKept: 0 };
  const execute = async () => {
    if (!approved || !approved.targets.length || running || approved.serverSetting !== useContentSyncStore.getState().serverUrl) return;
    const accepted = approved;
    setConfirming(false); setRunning(true); setResult(null); setError(null);
    try {
      const handle = enqueueChapterCleanup(accepted, t("chapterCleanup.title"), setResult);
      taskId.current = handle.id;
      const finished = await handle.promise;
      setResult(finished);
      for (const key of ["novel", "chapter", "category", "download-cache", "content-server"]) void queryClient.invalidateQueries({ queryKey: [key] });
      const deleted = finished.results.filter(item => item.status === "deleted").map(item => item.chapterId);
      if (deleted.length) await offerToStopDownloadGoals("chapter", deleted);
    } catch { setError(t("chapterCleanup.failed")); }
    finally { taskId.current = null; setRunning(false); setPreview(null); }
  };
  const groups = useMemo(() => {
    const works = new Map<number, { name: string; count: number }>();
    for (const target of approved?.targets ?? []) {
      const { novel } = target.candidate.identity;
      const current = works.get(novel.id);
      if (current) current.count++; else works.set(novel.id, { name: target.candidate.novelName, count: 1 });
    }
    return [...works.entries()];
  }, [approved]);
  const categoryOptions = [
    { value: String(UNCATEGORIZED_CATEGORY_ID), label: t("categories.uncategorized") },
    ...(categories.data ?? []).map(category => ({ value: String(category.id), label: category.name })),
  ];
  const selectedCategoryNames = filters.categories.mode === "all" ? t("categories.all")
    : filters.categories.ids.map(id => categoryOptions.find(option => option.value === String(id))?.label ?? String(id)).join(", ") || t("chapterCleanup.none");
  const skipEntries = Object.entries(preview?.skipped ?? {}) as [ChapterCleanupSkipReason, number][];
  const servers = preview?.checkedServers ?? [];
  const resultReasons = new Map<string, number>();
  for (const item of running ? [] : result?.results ?? []) {
    if (item.reason) {
      const reason = Object.hasOwn(SKIP_LABELS, item.reason) ? item.reason : "other";
      resultReasons.set(reason, (resultReasons.get(reason) ?? 0) + 1);
    }
  }
  const disabled = inspecting || running;
  return <Modal opened={opened} onClose={onClose} title={t("chapterCleanup.title")} size="lg" centered>
    <Stack gap="md">
      <Text size="sm" c="dimmed">{t("chapterCleanup.description")}</Text>
      <Select label={t("chapterCleanup.server.label")} data={Object.entries(SERVER_OPTIONS).map(([value, key]) => ({ value, label: t(key) }))}
        value={filters.server} allowDeselect={false} disabled={disabled}
        onChange={value => { if (value) changeFilters({ ...filters, server: value as ChapterCleanupServerMode }); }} />
      <Text size="xs" c="dimmed">{t("chapterCleanup.coverageExplanation")}</Text>
      <Select label={t("chapterCleanup.reading.label")} data={[{ value: "read", label: t("chapterCleanup.reading.read") }, { value: "all", label: t("chapterCleanup.reading.all") }]}
        value={filters.reading} allowDeselect={false} disabled={disabled}
        onChange={value => { if (value === "read" || value === "all") changeFilters({ ...filters, reading: value }); }} />
      <Select label={t("chapterCleanup.categories.label")} data={[{ value: "all", label: t("categories.all") }, { value: "selected", label: t("chapterCleanup.categories.selected") }]}
        value={filters.categories.mode} allowDeselect={false} disabled={disabled}
        onChange={value => { if (value === "all" || value === "selected") changeFilters({ ...filters, categories: value === "all" ? { mode: "all" } : { mode: "selected", ids: [] } }); }} />
      {filters.categories.mode === "selected" ? <MultiSelect label={t("chapterCleanup.categories.choose")} data={categoryOptions}
        value={filters.categories.ids.map(String)} disabled={disabled || categories.isLoading || categories.isError}
        error={categories.isError ? t("chapterCleanup.categories.error") : undefined}
        onChange={ids => changeFilters({ ...filters, categories: { mode: "selected", ids: ids.map(Number) } })} /> : null}
      <Text size="sm">{t("chapterCleanup.conditions", { server: t(SERVER_OPTIONS[filters.server]), reading: t(filters.reading === "read" ? "chapterCleanup.reading.read" : "chapterCleanup.reading.all"), categories: selectedCategoryNames })}</Text>
      {!running && !confirming ? <Group><TextButton onClick={() => { void createPreview(); }} disabled={inspecting} loading={inspecting}>{t("chapterCleanup.preview")}</TextButton>
        {inspecting ? <TextButton onClick={clearPreview}>{t("common.cancel")}</TextButton> : null}</Group> : null}
      {inspecting ? <Text size="sm" role="status">{t("chapterCleanup.checking", { count: checked })}</Text> : null}
      {preview && approved ? <Stack gap="xs">
        <Text fw={600}>{t("chapterCleanup.summary", { works: approved.workCount, chapters: approved.targets.length, size: formatBytes(approved.payloadBytes, locale) })}</Text>
        {protectedCounts.unread > 0 ? <Checkbox checked={approval.includeUnread} disabled={running || confirming}
          label={t("chapterCleanup.includeUnread", { count: protectedCounts.unread })}
          onChange={event => { const checked = event.currentTarget.checked; setApproval(current => ({ ...current, includeUnread: checked })); }} /> : null}
        {protectedCounts.goalKept > 0 ? <Checkbox checked={approval.includeGoalKept} disabled={running || confirming}
          label={t("chapterCleanup.includeGoalKept", { count: protectedCounts.goalKept })}
          onChange={event => { const checked = event.currentTarget.checked; setApproval(current => ({ ...current, includeGoalKept: checked })); }} /> : null}
        <Text size="xs" c="dimmed">{t("chapterCleanup.estimate")}</Text>
        {filters.server !== "any" ? <Text size="sm">{t("chapterCleanup.servers", { servers: servers.slice(0, 50).join(", ") || t("chapterCleanup.none") })}{servers.length > 50 ? " (+" + (servers.length - 50) + ")" : ""}</Text> : null}
        {skipEntries.map(([reason, count]) => <Text size="sm" key={reason}>{t(SKIP_LABELS[reason])}: {count}</Text>)}
        {groups.length ? <details open><summary>{t("chapterCleanup.works")}</summary>
          <Stack gap={2}>{groups.slice(page * 50, (page + 1) * 50).map(([id, work]) => <Text key={id} size="sm">{work.name}: {work.count}</Text>)}</Stack>
          {groups.length > 50 ? <Group><TextButton size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>{t("chapterCleanup.previous")}</TextButton>
            <Text size="sm">{page + 1} / {Math.ceil(groups.length / 50)}</Text><TextButton size="sm" disabled={(page + 1) * 50 >= groups.length} onClick={() => setPage(page + 1)}>{t("chapterCleanup.next")}</TextButton></Group> : null}
        </details> : null}
        {!running && !confirming ? <TextButton tone="danger" disabled={!approved.targets.length} onClick={() => setConfirming(true)}>{t("chapterCleanup.review")}</TextButton> : null}
        {confirming ? <Alert color="warn" title={t("chapterCleanup.confirmTitle")}><Stack gap="sm"><Text size="sm">{t("chapterCleanup.confirmText", { count: approved.targets.length })}</Text><Group>
          <TextButton onClick={() => setConfirming(false)}>{t("common.cancel")}</TextButton><TextButton tone="danger" onClick={() => { void execute(); }}>{t("chapterCleanup.delete")}</TextButton>
        </Group></Stack></Alert> : null}
      </Stack> : null}
      {running ? <Stack gap="xs"><Text role="status" size="sm">{t("chapterCleanup.progress", { done: result ? result.deleted + result.skipped + result.failed : 0, total: approved?.targets.length ?? result?.total ?? 0 })}</Text>
        <TextButton onClick={() => { if (taskId.current) taskScheduler.cancel(taskId.current); }}>{t("chapterCleanup.cancelTask")}</TextButton></Stack> : null}
      {result && !running ? <Stack gap="xs"><Text fw={600}>{t("chapterCleanup.result", { deleted: result.deleted, skipped: result.skipped, failed: result.failed, cancelled: result.cancelled, size: formatBytes(result.bytesFreed, locale) })}</Text>
        {[...resultReasons.entries()].slice(0, 10).map(([reason, count]) => <Text size="sm" key={reason}>
          {reason === "other" ? t("chapterCleanup.skip.other") : t(SKIP_LABELS[reason as ChapterCleanupSkipReason])}: {count}
        </Text>)}
        {result.results.some(item => item.status === "failed" && item.reason) ? <details>
          <summary>{t("chapterCleanup.failureDetails")}</summary>
          {result.results.filter(item => item.status === "failed" && item.reason).slice(0, 10).map(item =>
            <Text size="sm" key={item.chapterId}>#{item.chapterId}: {cleanupFailureDetail(item.reason!)}</Text>)}
        </details> : null}
        <Text size="sm" c="dimmed">{t("chapterCleanup.retryHint")}</Text></Stack> : null}
      {error ? <Alert color="danger" title={t("common.actionFailed")}>{error}</Alert> : null}
      <Group justify="flex-end"><TextButton onClick={onClose}>{t("common.done")}</TextButton></Group>
    </Stack>
  </Modal>;
}
