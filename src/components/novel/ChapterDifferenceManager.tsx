import { Alert, Button, Checkbox, Group, NumberInput, Pagination, Select, Stack, Text } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { applyChapterDifferences, type ChapterDifference, type ChapterDifferenceAction } from "../../lib/content-sync/chapter-differences";
import type { ServerNovelSource } from "../../lib/content-sync/novel-source";
import { describeError } from "../../lib/errors";
import { chaptersKey } from "./novel-detail-model";
import type { ChapterDifferenceScan } from "../../lib/content-sync/chapter-differences";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";

type Scope = "all" | "deviceLarger" | "serverLarger" | "sameSize" | "range" | "selected";

export function ChapterDifferenceManager({ novelId, source, differences, onClose, onRefresh, refreshing, scanErrors, scanError }: {
  novelId: number; source: ServerNovelSource; differences: readonly ChapterDifference[];
  onClose: () => void; onRefresh: () => void; refreshing: boolean; scanErrors: number; scanError: Error | null;
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
    const localBytes = row.local.body!.bytes;
    const remoteBytes = row.remote.inventory.body!.bytes;
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
  const busy = apply.isPending || refreshing;
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
  return <ResponsiveSheet opened fullScreenOnPhone size="xl" busy={busy} className="norea-difference-sheet"
    onClose={() => { if (!busy) onClose(); }} title={t("chapterDifference.title")}>
    <Stack gap="md" className="norea-chapter-differences">
      <Group justify="space-between">
        <Text size="sm">{t("chapterDifference.count", { count: remaining.length })}</Text>
        <Button variant="subtle" size="compact-sm" disabled={apply.isPending} loading={refreshing}
          onClick={() => { setActions(new Map()); setCompleted(new Set()); apply.reset(); onRefresh(); }}>{t("common.refresh")}</Button>
      </Group>
      {scanError ? <Alert color="danger">{describeError(scanError)}</Alert> : null}
      {scanErrors > 0 ? <Alert color="warn">{t("chapterDifference.unchecked", { count: scanErrors })}</Alert> : null}
      <Select label={t("chapterDifference.scope")} value={scope} disabled={busy} allowDeselect={false}
        data={(["all", "deviceLarger", "serverLarger", "sameSize", "range", "selected"] as const).map(value => ({ value, label: t(`chapterDifference.scope.${value}`) }))}
        onChange={value => { setScope(value as Scope); setPage(1); }} />
      {scope === "range" ? <Group grow>
        <NumberInput label={t("chapterDifference.from")} value={from} onChange={setFrom} disabled={busy} min={0} />
        <NumberInput label={t("chapterDifference.to")} value={to} onChange={setTo} disabled={busy} min={0} />
      </Group> : null}
      <div className="norea-difference-assign">
        <Text size="sm">{t("chapterDifference.target", { count: target.length })}</Text>
        <Group gap="xs">
          {options.map(option => <Button key={option.value} variant="default" disabled={busy || target.length === 0}
            onClick={() => assign(option.value as ChapterDifferenceAction)}>{option.label}</Button>)}
        </Group>
      </div>
      <Group gap="xs">
        <Button size="compact-sm" variant="subtle" disabled={busy} onClick={() => setSelected(new Set(target.map(row => row.chapter.chapterId)))}>{t("selection.selectAll")}</Button>
        <Button size="compact-sm" variant="subtle" disabled={busy} onClick={() => setSelected(new Set())}>{t("selection.deselectAll")}</Button>
        <Button size="compact-sm" variant="subtle" disabled={busy} onClick={() => setSelected(new Set(remaining.filter(row => !selected.has(row.chapter.chapterId)).map(row => row.chapter.chapterId)))}>{t("chapterDifference.invert")}</Button>
        <Text size="sm" c="dimmed">{t("novel.selection.selectedCount", { count: selected.size })}</Text>
      </Group>
      <div className="norea-difference-list">
        {target.slice((shownPage - 1) * 100, shownPage * 100).map(row => {
          const id = row.chapter.chapterId;
          return <div key={id} className="norea-difference-row">
            <Checkbox checked={selected.has(id)} disabled={busy} aria-label={t("chapterDifference.select", { name: row.chapter.chapterName })}
              onChange={() => setSelected(current => {
                const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next;
              })} />
            <div className="norea-difference-identity">
              <Text size="sm" fw="var(--norea-weight-medium)">{row.chapter.chapterNumber ?? row.chapter.position} · {row.chapter.chapterName}</Text>
              <Text size="xs" c="dimmed">{t("chapterDifference.sizes", {
                local: (row.local.body!.bytes / 1024).toFixed(1), remote: (row.remote.inventory.body!.bytes / 1024).toFixed(1),
              })}</Text>
            </div>
            <div className="norea-difference-action"><Select aria-label={t("chapterDifference.actionFor", { name: row.chapter.chapterName })} value={actions.get(id) ?? "keep"}
              allowDeselect={false} data={options} disabled={busy} onChange={value => {
                setActions(current => new Map(current).set(id, value as ChapterDifferenceAction)); apply.reset();
              }} /></div>
          </div>;
        })}
        {!target.length ? <Text p="md" c="dimmed">{t("chapterDifference.noMatches")}</Text> : null}
      </div>
      {target.length > 100 ? <Pagination value={shownPage} total={Math.ceil(target.length / 100)} onChange={setPage} disabled={busy} siblings={0} /> : null}
      {apply.error ? <Alert color="danger">{describeError(apply.error)}</Alert> : null}
      {apply.data ? <Alert color={apply.data.errors.length ? "warn" : "ok"}>
        {t("chapterDifference.result", { completed: apply.data.completed.length, failed: apply.data.errors.length })}
        {apply.data.errors.length ? <details><summary>{t("common.details")}</summary>
          {apply.data.errors.map(error => <Text size="sm" key={error.chapterId}>{differences.find(row => row.chapter.chapterId === error.chapterId)?.chapter.chapterName} · {error.message}</Text>)}
        </details> : null}
      </Alert> : null}
      <div className="norea-difference-footer">
        <Text size="sm" aria-live="polite">{apply.isPending ? t("chapterDifference.progress", progress) : t("chapterDifference.plan", {
          upload: uploadCount, download: downloadCount, keep: remaining.length - uploadCount - downloadCount,
        })}</Text>
        <Button disabled={busy || uploadCount + downloadCount === 0} loading={apply.isPending} onClick={() => {
          setProgress({ done: 0, total: uploadCount + downloadCount }); apply.mutate();
        }}>{t("chapterDifference.apply")}</Button>
      </div>
    </Stack>
  </ResponsiveSheet>;
}
