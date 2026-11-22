import { Button, Checkbox, Group, Loader, NumberInput, Pagination, Select, Stack, Text } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { applyChapterDifferences, type ChapterDifference, type ChapterDifferenceAction } from "../../lib/content-sync/chapter-differences";
import type { ServerNovelSource } from "../../lib/content-sync/novel-source";
import { describeError } from "../../lib/errors";
import { chaptersKey } from "./novel-detail-model";
import type { ChapterDifferenceScan } from "../../lib/content-sync/chapter-differences";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";
import { StatusAlert } from "../ui/StatusAlert";

type Scope = "all" | "deviceLarger" | "serverLarger" | "sameSize" | "range" | "selected";

export function ChapterDifferenceManager({
  novelId,
  source,
  differences,
  onClose,
  onRefresh,
  onCancelScan,
  refreshing,
  scanProgress,
  scanErrors,
  scanError,
}: {
  novelId: number;
  source: ServerNovelSource;
  differences: readonly ChapterDifference[];
  onClose: () => void;
  onRefresh: () => void;
  onCancelScan: () => void;
  refreshing: boolean;
  scanProgress: { checked: number; total: number };
  scanErrors: number;
  scanError: Error | null;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<Scope>("all");
  const [from, setFrom] = useState<string | number>("");
  const [to, setTo] = useState<string | number>("");
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [actions, setActions] = useState<ReadonlyMap<number, ChapterDifferenceAction>>(new Map());
  const [completed, setCompleted] = useState<ReadonlySet<number>>(new Set());
  const [page, setPage] = useState(1);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const remaining = useMemo(() => differences.filter(row => !completed.has(row.chapter.chapterId)), [differences, completed]);
  const target = remaining.filter(row => {
    const localBytes = row.local.bodyBytes;
    const remoteBytes = row.remote.bodyBytes;
    switch (scope) {
      case "deviceLarger": return localBytes > remoteBytes;
      case "serverLarger": return remoteBytes > localBytes;
      case "sameSize": return localBytes === remoteBytes;
      case "selected": return selected.has(row.chapter.chapterId);
      case "range": {
        const number = Number(row.chapter.chapterNumber ?? row.chapter.position);
        return typeof from === "number" && typeof to === "number" && number >= Math.min(from, to) && number <= Math.max(from, to);
      }
      default: return true;
    }
  });
  const uploadCount = remaining.filter(row => actions.get(row.chapter.chapterId) === "upload").length;
  const downloadCount = remaining.filter(row => actions.get(row.chapter.chapterId) === "download").length;
  const apply = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: () => applyChapterDifferences(source, remaining.map(difference => ({ difference,
      action: actions.get(difference.chapter.chapterId) ?? "keep" })), (done, total) => setProgress({ done, total })),
    onSuccess: async result => {
      setCompleted(current => new Set([...current, ...result.completed]));
      setActions(current => new Map([...current].filter(([id]) => !result.completed.includes(id))));
      setSelected(current => new Set([...current].filter(id => !result.completed.includes(id))));
      queryClient.setQueriesData<ChapterDifferenceScan>({ queryKey: ["content-server", "chapter-differences", source.serverUrl, source.workId, novelId] }, previous => previous ? {
        ...previous, differences: previous.differences.filter(row => !result.completed.includes(row.chapter.chapterId)),
      } : previous);
      await queryClient.invalidateQueries({ queryKey: chaptersKey(novelId) });
    },
  });
  // Only active file transfers lock the sheet; scanning remains cancellable via Back, Close, or Cancel.
  const applying = apply.isPending;
  const controlsDisabled = applying || refreshing;
  const handleClose = () => {
    if (applying) return;
    if (refreshing) onCancelScan();
    onClose();
  };
  const options = (["keep", "upload", "download"] as const).map(value => ({ value, label: t(`chapterDifference.${value}`) }));
  const assign = (action: ChapterDifferenceAction) => {
    setActions(current => {
      const next = new Map(current);
      for (const row of target) next.set(row.chapter.chapterId, action);
      return next;
    });
    apply.reset();
  };
  const shownPage = Math.min(page, Math.max(1, Math.ceil(target.length / 100)));
  const scanningLabel = scanProgress.total > 0
    ? t("chapterDifference.checking", scanProgress)
    : t("chapterDifference.checkingStart");
  return <ResponsiveSheet opened fullScreenOnPhone size="xl" busy={applying} className="norea-difference-sheet"
    onClose={handleClose} title={t("chapterDifference.title")}>
    <Stack gap="md" className="norea-chapter-differences">
      <Group justify="space-between">
        {refreshing ? (
          <Group gap="xs" className="norea-difference-scanning" role="status" aria-live="polite">
            <Loader size="xs" />
            <Text size="sm">{scanningLabel}</Text>
          </Group>
        ) : (
          <Text size="sm">{t("chapterDifference.count", { count: remaining.length })}</Text>
        )}
        {refreshing ? (
          <Button variant="subtle" color="danger" size="compact-sm" disabled={applying}
            onClick={onCancelScan}>{t("common.cancel")}</Button>
        ) : (
          <Button variant="subtle" size="compact-sm" disabled={applying}
            onClick={() => { setActions(new Map()); setCompleted(new Set()); apply.reset(); onRefresh(); }}>{t("common.refresh")}</Button>
        )}
      </Group>
      {scanError ? <StatusAlert color="danger">{describeError(scanError)}</StatusAlert> : null}
      {scanErrors > 0 ? <StatusAlert color="warn">{t("chapterDifference.unchecked", { count: scanErrors })}</StatusAlert> : null}
      <Select label={t("chapterDifference.scope")} value={scope} disabled={controlsDisabled} allowDeselect={false}
        data={(["all", "deviceLarger", "serverLarger", "sameSize", "range", "selected"] as const).map(value => ({ value, label: t(`chapterDifference.scope.${value}`) }))}
        onChange={value => { setScope(value as Scope); setPage(1); }} />
      {scope === "range" ? <Group grow>
        <NumberInput label={t("chapterDifference.from")} value={from} onChange={setFrom} disabled={controlsDisabled} min={0} />
        <NumberInput label={t("chapterDifference.to")} value={to} onChange={setTo} disabled={controlsDisabled} min={0} />
      </Group> : null}
      <div className="norea-difference-assign">
        <Text size="sm">{t("chapterDifference.target", { count: target.length })}</Text>
        <Group gap="xs">
          {options.map(option => <Button key={option.value} variant="default" disabled={controlsDisabled || target.length === 0}
            onClick={() => assign(option.value as ChapterDifferenceAction)}>{option.label}</Button>)}
        </Group>
      </div>
      <Group gap="xs">
        <Button size="compact-sm" variant="subtle" disabled={controlsDisabled} onClick={() => setSelected(new Set(target.map(row => row.chapter.chapterId)))}>{t("selection.selectAll")}</Button>
        <Button size="compact-sm" variant="subtle" disabled={controlsDisabled} onClick={() => setSelected(new Set())}>{t("selection.deselectAll")}</Button>
        <Button size="compact-sm" variant="subtle" disabled={controlsDisabled} onClick={() => setSelected(new Set(remaining.filter(row => !selected.has(row.chapter.chapterId)).map(row => row.chapter.chapterId)))}>{t("chapterDifference.invert")}</Button>
        <Text size="sm" c="dimmed">{t("novel.selection.selectedCount", { count: selected.size })}</Text>
      </Group>
      <div className="norea-difference-list">
        {target.slice((shownPage - 1) * 100, shownPage * 100).map(row => {
          const id = row.chapter.chapterId;
          return <div key={id} className="norea-difference-row">
            <Checkbox checked={selected.has(id)} disabled={controlsDisabled} aria-label={t("chapterDifference.select", { name: row.chapter.chapterName })}
              onChange={() => setSelected(current => {
                const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next;
              })} />
            <div className="norea-difference-identity">
              <Text size="sm" fw="var(--norea-weight-medium)">{row.chapter.chapterNumber ?? row.chapter.position} · {row.chapter.chapterName}</Text>
              <Text size="xs" c="dimmed">{t("chapterDifference.sizes", {
                local: (row.local.bodyBytes / 1024).toFixed(1), remote: (row.remote.bodyBytes / 1024).toFixed(1),
              })}</Text>
            </div>
            <div className="norea-difference-action"><Select aria-label={t("chapterDifference.actionFor", { name: row.chapter.chapterName })} value={actions.get(id) ?? "keep"}
              allowDeselect={false} data={options} disabled={controlsDisabled} onChange={value => {
                setActions(current => new Map(current).set(id, value as ChapterDifferenceAction)); apply.reset();
              }} /></div>
          </div>;
        })}
        {!target.length ? <Text p="md" c="dimmed">{refreshing ? scanningLabel : t("chapterDifference.noMatches")}</Text> : null}
      </div>
      {target.length > 100 ? <Pagination value={shownPage} total={Math.ceil(target.length / 100)} onChange={setPage} disabled={controlsDisabled} siblings={0} /> : null}
      {apply.error ? <StatusAlert color="danger">{describeError(apply.error)}</StatusAlert> : null}
      {apply.data ? <StatusAlert color={apply.data.errors.length ? "warn" : "ok"}>
        {t("chapterDifference.result", { completed: apply.data.completed.length, failed: apply.data.errors.length })}
        {apply.data.errors.length ? <details className="norea-state-details"><summary>{t("common.details")}</summary>
          {apply.data.errors.map(error => <Text size="sm" key={error.chapterId}>{differences.find(row => row.chapter.chapterId === error.chapterId)?.chapter.chapterName} · {error.message}</Text>)}
        </details> : null}
      </StatusAlert> : null}
      <div className="norea-difference-footer">
        <Text size="sm" aria-live="polite">{apply.isPending ? t("chapterDifference.progress", progress) : t("chapterDifference.plan", {
          upload: uploadCount, download: downloadCount, keep: remaining.length - uploadCount - downloadCount,
        })}</Text>
        <Button disabled={controlsDisabled || uploadCount + downloadCount === 0} loading={apply.isPending} onClick={() => {
          setProgress({ done: 0, total: uploadCount + downloadCount }); apply.mutate();
        }}>{t("chapterDifference.apply")}</Button>
      </div>
    </Stack>
  </ResponsiveSheet>;
}
