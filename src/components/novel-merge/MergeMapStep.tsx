import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Button, Text, TextInput } from "@mantine/core";
import type { ChapterListRow } from "../../db/queries/chapter";
import { useTranslation } from "../../i18n";
import type { NovelMergeCompositionEntry } from "../../lib/novel-merge-composition";
import type { NovelMergeChapterMatching } from "../../lib/novel-merge-matching";
import type { ChapterItem } from "../../lib/plugins/types";
import { IconButton } from "../IconButton";
import {
  CheckIcon, ChevronDownIcon, ChevronUpIcon, DownloadedIcon,
  MinusIcon, ResetIcon, SearchIcon, UnlinkIcon,
} from "../ui/icons";
import { MergeVirtualRows } from "./MergeVirtualRows";
import {
  createInitialComposition, excludeCompositionOrigins,
  includeSourceChapters, includeTargetChapters, moveCompositionEntries,
  pairCompositionRanges, selectCompositionRange, splitCompositionEntries,
  summarizeComposition, toggleCompositionSelection,
} from "./merge-composition-editor";

type Translate = ReturnType<typeof useTranslation>["t"];

export function sourceChapterLabel(t: Translate, chapter: ChapterListRow): string {
  return t("novelMerge.chapterLabel", {
    name: chapter.name, number: chapter.displayChapterNumber ?? chapter.chapterNumber ?? String(chapter.position),
  });
}

export function targetChapterLabel(t: Translate, chapter: ChapterItem): string {
  return t("novelMerge.chapterLabel", { name: chapter.name, number: chapter.chapterNumber });
}

const HISTORY_LIMIT = 30;
const chapterRowHeight = () => 4.5;

interface CompositionRow<K extends string | number> {
  key: K;
  ordinal: number;
  name: string;
  searchNumber: string;
  detail: string;
  included: boolean;
  paired?: boolean;
  downloaded?: boolean;
  review?: boolean;
  origin?: string;
}

interface SelectionPaneProps<K extends string | number> {
  badge: string;
  children?: ReactNode;
  footer?: ReactNode;
  label: string;
  name?: string;
  onSelectionChange: (selection: Set<K>) => void;
  rows: readonly CompositionRow<K>[];
  scrollToKey?: string | null;
  selected: ReadonlySet<K>;
  side: "source" | "target" | "final";
}

function SelectionPane<K extends string | number>({
  badge, children, footer, label, name, onSelectionChange,
  rows, scrollToKey, selected, side,
}: SelectionPaneProps<K>) {
  const { t } = useTranslation();
  const id = useId();
  const [query, setQuery] = useState("");
  const [excludedOnly, setExcludedOnly] = useState(false);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [from, setFrom] = useState("1");
  const [to, setTo] = useState(String(rows.length));
  const [anchor, setAnchor] = useState<K | null>(null);
  const normalizedQuery = query.trim().normalize("NFKC").toLocaleLowerCase();
  const filtered = useMemo(() => rows.filter(row =>
    (!excludedOnly || !row.included) &&
    (normalizedQuery === "" || row.name.normalize("NFKC").toLocaleLowerCase().includes(normalizedQuery) || row.searchNumber.startsWith(normalizedQuery) || String(row.ordinal) === normalizedQuery),
  ), [excludedOnly, normalizedQuery, rows]);
  const orderedKeys = useMemo(() => rows.map(row => row.key), [rows]);
  const filteredKeys = useMemo(() => filtered.map(row => row.key), [filtered]);
  const fromNumber = Number(from);
  const toNumber = Number(to);
  const validRange = Number.isSafeInteger(fromNumber) && Number.isSafeInteger(toNumber)
    && fromNumber >= 1 && toNumber >= 1 && fromNumber <= rows.length && toNumber <= rows.length;

  function toggle(key: K, extend: boolean): void {
    onSelectionChange(toggleCompositionSelection(selected, filteredKeys, key, anchor, extend));
    if (!extend || anchor === null) setAnchor(key);
  }

  return (
    <section aria-label={label} className="norea-compose-pane" data-side={side}>
      <header className="norea-compose-pane-header">
        <span aria-hidden="true" className="norea-compose-pane-badge">{badge}</span>
        <div className="norea-compose-pane-heading">
          <h2>{label}</h2>
          {name ? <p title={name}>{name}</p> : null}
        </div>
        <span className="norea-compose-pane-count">{rows.length.toLocaleString()}</span>
      </header>
      <div className="norea-compose-pane-tools">
        <TextInput
          aria-label={t("novelMerge.compose.searchIn", { source: label })}
          leftSection={<SearchIcon size="1rem" />}
          onChange={event => setQuery(event.currentTarget.value)}
          placeholder={t("novelMerge.compose.search")}
          size="xs" type="search" value={query}
        />
        <div className="norea-compose-selection-tools">
          <button disabled={filtered.length === 0} onClick={() => onSelectionChange(new Set(filteredKeys))} type="button">
            {normalizedQuery || excludedOnly ? t("novelMerge.compose.selectResults") : t("novelMerge.compose.selectAll")}
          </button>
          <button aria-controls={`${id}-range`} aria-expanded={rangeOpen} disabled={rows.length === 0} onClick={() => {
            if (!rangeOpen) { setFrom("1"); setTo(String(rows.length)); }
            setRangeOpen(current => !current);
          }} type="button">
            {t("novelMerge.compose.range")}
          </button>
          <button disabled={selected.size === 0} onClick={() => onSelectionChange(new Set())} type="button">
            {t("novelMerge.compose.clearSelection")}
          </button>
          {side !== "final" ? (
            <button aria-pressed={excludedOnly} className="norea-compose-excluded-filter" onClick={() => setExcludedOnly(current => !current)} type="button">
              {t("novelMerge.compose.excludedOnly")}
            </button>
          ) : null}
        </div>
        {rangeOpen ? (
          <div className="norea-compose-range" id={`${id}-range`}>
            <label>
              <span>{t("novelMerge.compose.rangeFrom")}</span>
              <input aria-label={t("novelMerge.compose.rangeFromIn", { source: label })} inputMode="numeric" max={rows.length} min={1} onChange={event => setFrom(event.currentTarget.value)} step={1} type="number" value={from} />
            </label>
            <span aria-hidden="true">–</span>
            <label>
              <span>{t("novelMerge.compose.rangeTo")}</span>
              <input aria-label={t("novelMerge.compose.rangeToIn", { source: label })} inputMode="numeric" max={rows.length} min={1} onChange={event => setTo(event.currentTarget.value)} step={1} type="number" value={to} />
            </label>
            <Button disabled={!validRange} onClick={() => {
              onSelectionChange(selectCompositionRange(orderedKeys, fromNumber, toNumber));
              setAnchor(orderedKeys[toNumber - 1] ?? null);
              setRangeOpen(false);
            }} size="xs" variant="default">{t("novelMerge.compose.selectRange")}</Button>
            <small>{t("novelMerge.compose.rangeHelp")}</small>
          </div>
        ) : null}
        <div className="norea-compose-selection-count" role="status">
          {t("novelMerge.compose.selectionCount", { count: selected.size })}
          {filtered.length !== rows.length ? <span>{t("novelMerge.compose.resultCount", { count: filtered.length })}</span> : null}
        </div>
      </div>
      {children}
      {filtered.length === 0 ? (
        <div className="norea-compose-empty"><Text c="dimmed" size="sm">{rows.length === 0 ? t("novelMerge.compose.emptyCatalog") : t("novelMerge.compose.noMatches")}</Text></div>
      ) : (
        <MergeVirtualRows
          aria-label={t("novelMerge.compose.listIn", { source: label })}
          className="norea-compose-list"
          itemKey={row => String(row.key)} items={filtered}
          onKeyDown={event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
              event.preventDefault();
              onSelectionChange(new Set(filteredKeys));
            }
          }}
          renderItem={row => (
            <button
              aria-pressed={selected.has(row.key)}
              className="norea-compose-row norea-state-layer"
              data-excluded={!row.included || undefined} data-origin={row.origin}
              data-paired={row.paired || undefined} data-review={row.review || undefined}
              onClick={event => toggle(row.key, event.shiftKey)} title={row.name} type="button"
            >
              <span aria-hidden="true" className="norea-compose-check">{selected.has(row.key) ? <CheckIcon size="0.875rem" /> : null}</span>
              <span className="norea-compose-ordinal">{row.ordinal}</span>
              <span className="norea-compose-row-text">
                <span className="norea-compose-row-name">{row.name}</span>
                <span className="norea-compose-row-detail">
                  {row.downloaded ? <DownloadedIcon size="0.8125rem" /> : null}
                  {row.detail}
                </span>
              </span>
              {row.origin ? <span aria-label={t("novelMerge.compose.origin", { source: row.origin })} className="norea-compose-origin">{row.origin}</span> : null}
            </button>
          )}
          rowHeightRem={chapterRowHeight} scrollToKey={scrollToKey}
        />
      )}
      {footer ? <div className="norea-compose-pane-footer">{footer}</div> : null}
    </section>
  );
}

export interface MergeMapStepProps {
  canContinue: boolean;
  composition: readonly NovelMergeCompositionEntry[];
  matching: NovelMergeChapterMatching;
  onCompositionChange: (entries: NovelMergeCompositionEntry[]) => void;
  onContinue: () => void;
  sourceChapters: readonly ChapterListRow[];
  sourceName: string;
  sourcePluginName: string;
  targetChapters: readonly ChapterItem[];
  targetName: string;
  targetPluginName: string;
}

export function MergeMapStep({
  canContinue, composition, matching, onCompositionChange, onContinue,
  sourceChapters, sourceName, sourcePluginName,
  targetChapters, targetName, targetPluginName,
}: MergeMapStepProps) {
  const { t } = useTranslation();
  const [selectedSources, setSelectedSources] = useState<Set<number>>(new Set());
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  const [selectedFinal, setSelectedFinal] = useState<Set<string>>(new Set());
  const [past, setPast] = useState<readonly (readonly NovelMergeCompositionEntry[])[]>([]);
  const [future, setFuture] = useState<readonly (readonly NovelMergeCompositionEntry[])[]>([]);
  const [position, setPosition] = useState("1");
  const [scrollToKey, setScrollToKey] = useState<string | null>(null);
  const [customName, setCustomName] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const sourceById = useMemo(() => new Map(sourceChapters.map(chapter => [chapter.id, chapter])), [sourceChapters]);
  const targetByPath = useMemo(() => new Map(targetChapters.map(chapter => [chapter.path, chapter])), [targetChapters]);
  const downloadedSourceIds = useMemo(() => new Set(sourceChapters.filter(chapter => chapter.isDownloaded || chapter.contentBytes > 0).map(chapter => chapter.id)), [sourceChapters]);
  const summary = useMemo(() => summarizeComposition(composition, sourceChapters, targetChapters), [composition, sourceChapters, targetChapters]);
  const sourceInFinal = useMemo(() => new Map(composition.flatMap((entry, index) => entry.sourceChapterIds.map(id => [id, { entry, ordinal: index + 1 }] as const))), [composition]);
  const targetInFinal = useMemo(() => new Map(composition.flatMap((entry, index) => entry.targetChapterPath === undefined ? [] : [[entry.targetChapterPath, { entry, ordinal: index + 1 }] as const])), [composition]);
  const reviewSources = useMemo(() => new Set(matching.ambiguous.map(chapter => chapter.sourceChapterId)), [matching]);
  const selectedSourceOrder = useMemo(() => sourceChapters.filter(chapter => selectedSources.has(chapter.id)).map(chapter => chapter.id), [selectedSources, sourceChapters]);
  const selectedTargetOrder = useMemo(() => targetChapters.filter(chapter => selectedTargets.has(chapter.path)).map(chapter => chapter.path), [selectedTargets, targetChapters]);
  const selectedFinalEntries = useMemo(() => composition.filter(entry => selectedFinal.has(entry.key)), [composition, selectedFinal]);
  const firstSelectedIndex = composition.findIndex(entry => selectedFinal.has(entry.key));
  const insertionKey = firstSelectedIndex < 0 ? undefined : composition[firstSelectedIndex]?.key;
  const singleSelected = selectedFinalEntries.length === 1 ? selectedFinalEntries[0] : undefined;
  const maxPosition = Math.max(1, composition.length - selectedFinalEntries.length + 1);
  const positionNumber = Number(position);
  const validPosition = Number.isSafeInteger(positionNumber) && positionNumber >= 1 && positionNumber <= maxPosition;
  const canPair = selectedSourceOrder.length > 0 && selectedSourceOrder.length === selectedTargetOrder.length;
  const hasSelectedPairs = selectedFinalEntries.some(entry => entry.sourceChapterIds.length > 0 && entry.targetChapterPath !== undefined);

  useEffect(() => {
    const keys = new Set(composition.map(entry => entry.key));
    setSelectedFinal(current => {
      const next = new Set([...current].filter(key => keys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [composition]);

  useEffect(() => setCustomName(singleSelected?.name ?? ""), [singleSelected?.key, singleSelected?.name]);

  function apply(entries: NovelMergeCompositionEntry[], message?: string): void {
    if (JSON.stringify(entries) === JSON.stringify(composition)) return;
    setPast(current => [...current.slice(-(HISTORY_LIMIT - 1)), composition]);
    setFuture([]);
    onCompositionChange(entries);
    setAnnouncement(message ?? t("novelMerge.compose.updated", { count: entries.length }));
  }

  function undo(): void {
    const previous = past.at(-1);
    if (!previous) return;
    setPast(current => current.slice(0, -1));
    setFuture(current => [...current, composition]);
    onCompositionChange([...previous]);
    setAnnouncement(t("novelMerge.compose.undone"));
  }

  function redo(): void {
    const next = future.at(-1);
    if (!next) return;
    setFuture(current => current.slice(0, -1));
    setPast(current => [...current.slice(-(HISTORY_LIMIT - 1)), composition]);
    onCompositionChange([...next]);
    setAnnouncement(t("novelMerge.compose.redone"));
  }

  function move(positionValue: number): void {
    if (selectedFinalEntries.length === 0) return;
    apply(moveCompositionEntries(composition, selectedFinal, positionValue), t("novelMerge.compose.moved", { count: selectedFinalEntries.length, position: positionValue }));
    setScrollToKey(selectedFinalEntries[0]!.key);
    setPosition(String(positionValue));
  }

  function choosePrimary(primary: "source" | "target"): void {
    apply(composition.map(entry => selectedFinal.has(entry.key)
      && (primary === "source" ? entry.sourceChapterIds.length > 0 : entry.targetChapterPath !== undefined)
      ? { ...entry, primary } : entry));
  }

  function saveName(): void {
    if (!singleSelected) return;
    const name = customName.trim() || undefined;
    if (singleSelected.name === name) return;
    apply(composition.map(entry => entry.key === singleSelected.key ? { ...entry, name } : entry));
  }

  function rowName(entry: NovelMergeCompositionEntry): string {
    const source = sourceById.get(entry.sourceChapterIds[0] ?? -1);
    const target = entry.targetChapterPath === undefined ? undefined : targetByPath.get(entry.targetChapterPath);
    return entry.name ?? (entry.primary === "source" ? source?.name ?? target?.name : target?.name ?? source?.name) ?? "";
  }

  const sourceRows = useMemo((): CompositionRow<number>[] => sourceChapters.map((chapter, index) => {
    const found = sourceInFinal.get(chapter.id);
    const number = chapter.displayChapterNumber ?? chapter.chapterNumber ?? String(chapter.position);
    return {
      key: chapter.id, ordinal: index + 1, name: chapter.name, searchNumber: number,
      detail: found
        ? t("novelMerge.compose.sourceRowIncluded", { number, position: found.ordinal })
        : t("novelMerge.compose.sourceRowExcluded", { number }),
      included: found !== undefined, paired: found?.entry.targetChapterPath !== undefined,
      downloaded: chapter.isDownloaded, review: reviewSources.has(chapter.id),
    };
  }), [reviewSources, sourceChapters, sourceInFinal, t]);
  const targetRows = useMemo((): CompositionRow<string>[] => targetChapters.map((chapter, index) => {
    const found = targetInFinal.get(chapter.path);
    return {
      key: chapter.path, ordinal: index + 1, name: chapter.name, searchNumber: String(chapter.chapterNumber),
      detail: found
        ? t("novelMerge.compose.sourceRowIncluded", { number: chapter.chapterNumber, position: found.ordinal })
        : t("novelMerge.compose.sourceRowExcluded", { number: chapter.chapterNumber }),
      included: found !== undefined, paired: Boolean(found && found.entry.sourceChapterIds.length > 0),
    };
  }), [targetChapters, targetInFinal, t]);
  const finalRows: CompositionRow<string>[] = composition.map((entry, index) => {
    const source = sourceById.get(entry.sourceChapterIds[0] ?? -1);
    const target = entry.targetChapterPath === undefined ? undefined : targetByPath.get(entry.targetChapterPath);
    const paired = Boolean(source && target);
    const origin = paired ? "A+B" : source ? "A" : "B";
    const sourceNumber = source?.displayChapterNumber ?? source?.chapterNumber ?? String(source?.position ?? "");
    return {
      key: entry.key, ordinal: index + 1, name: rowName(entry), searchNumber: String(index + 1),
      detail: paired
        ? t("novelMerge.compose.pairedRow", { sourceNumber, targetNumber: target!.chapterNumber, primary: entry.primary === "source" ? "A" : "B" })
        : t("novelMerge.compose.originRow", { source: origin, number: source ? sourceNumber : target?.chapterNumber ?? "" }),
      included: true, paired,
      downloaded: entry.primary === "source" && entry.sourceChapterIds.some(id => downloadedSourceIds.has(id)), origin,
    };
  });

  return (
    <div className="norea-merge-map norea-compose" onKeyDown={event => {
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]")) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      }
    }}>
      <div className="norea-compose-intro">
        <div><h1>{t("novelMerge.compose.title")}</h1><p>{t("novelMerge.compose.description")}</p></div>
        <div className="norea-compose-history">
          <Button disabled={past.length === 0} onClick={undo} size="xs" variant="default">{t("novelMerge.compose.undo")}</Button>
          <Button disabled={future.length === 0} onClick={redo} size="xs" variant="default">{t("novelMerge.compose.redo")}</Button>
          <IconButton label={t("novelMerge.compose.reset")} onClick={() => apply(createInitialComposition(sourceChapters, targetChapters, matching))} size="sm"><ResetIcon /></IconButton>
        </div>
      </div>
      <div className="norea-compose-link-bar">
        <Text size="xs">{t("novelMerge.compose.pairSelection", { source: selectedSources.size, target: selectedTargets.size })}</Text>
        <Button disabled={!canPair} onClick={() => {
          apply(pairCompositionRanges(composition, selectedSourceOrder, selectedTargetOrder, downloadedSourceIds), t("novelMerge.compose.paired", { count: selectedSourceOrder.length }));
          setSelectedSources(new Set()); setSelectedTargets(new Set());
        }} size="xs" variant="default">{t("novelMerge.compose.pairRanges")}</Button>
        <span className="norea-compose-link-help">{t("novelMerge.compose.pairHelp")}</span>
      </div>
      <div className="norea-compose-panes">
        <SelectionPane
          badge="A"
          footer={<>
            <Button disabled={!selectedSourceOrder.some(id => !sourceInFinal.has(id))} onClick={() => apply(includeSourceChapters(composition, selectedSourceOrder, insertionKey))} size="xs">{t("novelMerge.compose.include")}</Button>
            <Button disabled={!selectedSourceOrder.some(id => sourceInFinal.has(id))} onClick={() => apply(excludeCompositionOrigins(composition, selectedSources, new Set()))} size="xs" variant="default">{t("novelMerge.compose.exclude")}</Button>
          </>}
          label={t("novelMerge.compose.sourceA", { source: sourcePluginName })} name={sourceName}
          onSelectionChange={setSelectedSources} rows={sourceRows} selected={selectedSources} side="source"
        />
        <SelectionPane
          badge="B"
          footer={<>
            <Button disabled={!selectedTargetOrder.some(path => !targetInFinal.has(path))} onClick={() => apply(includeTargetChapters(composition, selectedTargetOrder, insertionKey))} size="xs">{t("novelMerge.compose.include")}</Button>
            <Button disabled={!selectedTargetOrder.some(path => targetInFinal.has(path))} onClick={() => apply(excludeCompositionOrigins(composition, new Set(), selectedTargets))} size="xs" variant="default">{t("novelMerge.compose.exclude")}</Button>
          </>}
          label={t("novelMerge.compose.sourceB", { source: targetPluginName })} name={targetName}
          onSelectionChange={setSelectedTargets} rows={targetRows} selected={selectedTargets} side="target"
        />
        <SelectionPane
          badge="✓" label={t("novelMerge.compose.final")} name={t("novelMerge.compose.finalHelp")}
          onSelectionChange={selection => {
            setSelectedFinal(selection);
            const index = composition.findIndex(entry => selection.has(entry.key));
            if (index >= 0) setPosition(String(Math.min(index + 1, composition.length - selection.size + 1)));
          }}
          rows={finalRows} scrollToKey={scrollToKey} selected={selectedFinal} side="final"
        >
          {selectedFinalEntries.length > 0 ? (
            <div className="norea-compose-final-actions">
              <div className="norea-compose-move-controls">
                <label className="norea-compose-position">
                  <span>{t("novelMerge.compose.movePosition")}</span>
                  <input aria-label={t("novelMerge.compose.movePosition")} inputMode="numeric" max={maxPosition} min={1} onChange={event => setPosition(event.currentTarget.value)} onKeyDown={event => { if (event.key === "Enter" && validPosition) move(positionNumber); }} step={1} type="number" value={position} />
                </label>
                <Button disabled={!validPosition} onClick={() => move(positionNumber)} size="xs" variant="default">{t("novelMerge.compose.move")}</Button>
                <IconButton disabled={firstSelectedIndex <= 0} label={t("novelMerge.compose.moveUp")} onClick={() => move(firstSelectedIndex)} size="sm"><ChevronUpIcon /></IconButton>
                <IconButton disabled={firstSelectedIndex >= composition.length - selectedFinalEntries.length} label={t("novelMerge.compose.moveDown")} onClick={() => move(firstSelectedIndex + 2)} size="sm"><ChevronDownIcon /></IconButton>
                <IconButton label={t("novelMerge.compose.removeSelected", { count: selectedFinalEntries.length })} onClick={() => { apply(composition.filter(entry => !selectedFinal.has(entry.key))); setSelectedFinal(new Set()); }} size="sm" tone="warning"><MinusIcon /></IconButton>
              </div>
              <details className="norea-compose-entry-options">
                <summary>{t("novelMerge.compose.entryOptions")}</summary>
                {hasSelectedPairs ? <div className="norea-compose-origin-actions">
                  <Button onClick={() => choosePrimary("source")} size="xs" variant="default">{t("novelMerge.compose.preferA")}</Button>
                  <Button onClick={() => choosePrimary("target")} size="xs" variant="default">{t("novelMerge.compose.preferB")}</Button>
                  <Button leftSection={<UnlinkIcon size="1rem" />} onClick={() => { apply(splitCompositionEntries(composition, selectedFinal)); setSelectedFinal(new Set()); }} size="xs" variant="subtle">{t("novelMerge.compose.split")}</Button>
                </div> : null}
                {singleSelected ? <TextInput
                  description={t("novelMerge.compose.customNameHelp")} label={t("novelMerge.compose.customName")}
                  maxLength={500} onBlur={saveName} onChange={event => setCustomName(event.currentTarget.value)}
                  onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}
                  placeholder={rowName({ ...singleSelected, name: undefined })} size="xs" value={customName}
                /> : null}
              </details>
            </div>
          ) : null}
        </SelectionPane>
      </div>
      <footer className="norea-merge-footer norea-compose-footer">
        <div className="norea-merge-footer-status">
          <strong>{t("novelMerge.compose.finalCount", { count: summary.total })}</strong>
          <span>{t("novelMerge.compose.summary", { paired: summary.paired, sourceOnly: summary.sourceOnly, targetOnly: summary.targetOnly, excluded: summary.excludedSource + summary.excludedTarget })}</span>
        </div>
        <Button disabled={!canContinue || composition.length === 0} onClick={onContinue}>{t("novelMerge.compose.review")}</Button>
      </footer>
      <span aria-live="polite" className="norea-compose-announcement" role="status">{announcement}</span>
    </div>
  );
}
