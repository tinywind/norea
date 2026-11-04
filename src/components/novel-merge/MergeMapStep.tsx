import { useMemo, useState } from "react";
import { Button, Switch, Text, TextInput } from "@mantine/core";
import { SegmentedToggle } from "../SegmentedToggle";
import { useMediaQuery } from "@mantine/hooks";
import type { ChapterListRow } from "../../db/queries/chapter";
import type { NovelMergeChapterDecision } from "../../db/queries/novel-merge";
import { useTranslation, type TranslationKey } from "../../i18n";
import type {
  NovelMergeAmbiguityReason,
  NovelMergeChapterMatching,
  NovelMergeCopyConflict,
} from "../../lib/novel-merge-matching";
import type { ChapterItem } from "../../lib/plugins/types";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, MinusIcon, SearchIcon, WarningIcon } from "../ui/icons";
import { ListRow } from "../ui/ListRow";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";
import {
  buildMergeMapRows,
  mergeMapSourceOrder,
  nextUndecidedSourceChapterId,
  sourceChapterRowKey,
  type MergeMapRow,
  type MergeMapSection,
  type NovelMergeDecisionMap,
} from "./merge-map-rows";
import { MergeVirtualRows } from "./MergeVirtualRows";

const HEADER_ROW_REM = 3;
const CHAPTER_ROW_REM = 4;
const CONFLICT_ROW_REM = 6.5;
const TARGET_ROW_REM = 3.75;

const SECTION_LABEL_KEYS: Record<MergeMapSection, TranslationKey> = {
  ambiguous: "novelMerge.map.section.ambiguous",
  conflicts: "novelMerge.map.section.conflicts",
  matched: "novelMerge.map.section.matched",
  unmatched: "novelMerge.map.section.unmatched",
};

const REASON_LABEL_KEYS: Record<NovelMergeAmbiguityReason, TranslationKey> = {
  missingNumber: "novelMerge.map.reason.missingNumber",
  repeatedNumber: "novelMerge.map.reason.repeatedNumber",
  titleMismatch: "novelMerge.map.reason.titleMismatch",
};

type Translate = ReturnType<typeof useTranslation>["t"];

export function sourceChapterLabel(t: Translate, chapter: ChapterListRow): string {
  return t("novelMerge.chapterLabel", {
    name: chapter.name,
    number: chapter.chapterNumber ?? String(chapter.position),
  });
}

export function targetChapterLabel(t: Translate, chapter: ChapterItem): string {
  return t("novelMerge.chapterLabel", {
    name: chapter.name,
    number: chapter.chapterNumber,
  });
}

function rowHeightRem(row: MergeMapRow): number {
  if (row.kind === "header") return HEADER_ROW_REM;
  return row.kind === "conflict" ? CONFLICT_ROW_REM : CHAPTER_ROW_REM;
}

function targetRowHeightRem(): number {
  return TARGET_ROW_REM;
}

interface MergeTargetPickerProps {
  decision: NovelMergeChapterDecision | undefined;
  mappedCountByPath: ReadonlyMap<string, number>;
  onClear: () => void;
  onExclude: () => void;
  onMap: (targetChapterPath: string) => void;
  source: ChapterListRow;
  suggestedPaths: readonly string[];
  targetChapters: readonly ChapterItem[];
}

function MergeTargetPicker({
  decision,
  mappedCountByPath,
  onClear,
  onExclude,
  onMap,
  source,
  suggestedPaths,
  targetChapters,
}: MergeTargetPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      normalizedQuery === ""
        ? targetChapters
        : targetChapters.filter(
            (chapter) =>
              chapter.name.toLowerCase().includes(normalizedQuery) ||
              String(chapter.chapterNumber).startsWith(normalizedQuery),
          ),
    [normalizedQuery, targetChapters],
  );
  const mappedPath = decision?.kind === "map" ? decision.targetChapterPath : null;
  const sameNumberPath = targetChapters.find(
    (chapter) => String(chapter.chapterNumber) === String(Number(source.chapterNumber)),
  )?.path;
  const scrollToKey = mappedPath ?? suggestedPaths[0] ?? sameNumberPath ?? null;
  const suggested = new Set(suggestedPaths);

  return (
    <div className="norea-merge-picker">
      <div className="norea-merge-picker-actions">
        <Button
          aria-pressed={decision?.kind === "exclude"}
          color="warn"
          onClick={onExclude}
          size="xs"
          variant={decision?.kind === "exclude" ? "light" : "default"}
        >
          {t("novelMerge.map.exclude")}
        </Button>
        <Button disabled={!decision} onClick={onClear} size="xs" variant="default">
          {t("novelMerge.map.clearMapping")}
        </Button>
      </div>
      {targetChapters.length === 0 ? (
        <Text c="dimmed" size="sm">
          {t("novelMerge.targetNoChapters")}
        </Text>
      ) : (
        <>
          <TextInput
            aria-label={t("novelMerge.map.searchTargets")}
            leftSection={<SearchIcon size="1.125rem" />}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t("novelMerge.map.searchTargets")}
            type="search"
            value={query}
          />
          {filtered.length === 0 ? (
            <Text c="dimmed" size="sm">
              {t("novelMerge.map.noTargetMatches")}
            </Text>
          ) : (
            <MergeVirtualRows
              aria-label={t("novelMerge.map.targetChapters")}
              className="norea-merge-picker-list"
              itemKey={(chapter) => chapter.path}
              items={filtered}
              renderItem={(chapter) => {
                const selected = chapter.path === mappedPath;
                const mappedCount = mappedCountByPath.get(chapter.path) ?? 0;
                return (
                  <ListRow
                    aria-pressed={selected}
                    className="norea-merge-target-row"
                    onClick={() => onMap(chapter.path)}
                    selected={selected}
                    subtitle={
                      suggested.has(chapter.path)
                        ? t("novelMerge.map.suggested")
                        : mappedCount > 0
                          ? t("novelMerge.mappedSourceCount", { count: mappedCount })
                          : undefined
                    }
                    title={targetChapterLabel(t, chapter)}
                    trailing={selected ? <CheckIcon /> : undefined}
                  />
                );
              }}
              rowHeightRem={targetRowHeightRem}
              scrollToKey={scrollToKey}
            />
          )}
        </>
      )}
    </div>
  );
}

interface MergeMapStepProps {
  canContinue: boolean;
  conflicts: readonly NovelMergeCopyConflict[];
  copyChoices: Readonly<Record<string, number>>;
  decisions: NovelMergeDecisionMap;
  matching: NovelMergeChapterMatching;
  onContinue: () => void;
  onCopyChoiceChange: (targetChapterPath: string, sourceChapterId: number) => void;
  onDecisionChange: (
    sourceChapterId: number,
    decision: NovelMergeChapterDecision | null,
  ) => void;
  onExcludeRemaining: () => void;
  sourceChapters: readonly ChapterListRow[];
  targetChapters: readonly ChapterItem[];
}

export function MergeMapStep({
  canContinue,
  conflicts,
  copyChoices,
  decisions,
  matching,
  onContinue,
  onCopyChoiceChange,
  onDecisionChange,
  onExcludeRemaining,
  sourceChapters,
  targetChapters,
}: MergeMapStepProps) {
  const { t } = useTranslation();
  const twoPanes = useMediaQuery("(min-width: 992px)", undefined, {
    getInitialValueInEffect: false,
  });
  const [undecidedOnly, setUndecidedOnly] = useState(false);
  const [matchedExpanded, setMatchedExpanded] = useState(false);
  const order = useMemo(() => mergeMapSourceOrder(matching), [matching]);
  const [activeId, setActiveId] = useState<number | null>(() =>
    nextUndecidedSourceChapterId(order, decisions, null),
  );
  const [sheetOpen, setSheetOpen] = useState(false);

  const sourceById = useMemo(
    () => new Map(sourceChapters.map((chapter) => [chapter.id, chapter])),
    [sourceChapters],
  );
  const targetByPath = useMemo(
    () => new Map(targetChapters.map((chapter) => [chapter.path, chapter])),
    [targetChapters],
  );
  const suggestionsBySourceId = useMemo(() => {
    const suggestions = new Map<number, string[]>();
    for (const item of matching.ambiguous) {
      suggestions.set(item.sourceChapterId, item.candidateTargetPaths);
    }
    for (const item of matching.matched) {
      suggestions.set(item.sourceChapterId, [item.targetChapterPath]);
    }
    return suggestions;
  }, [matching]);
  const mappedCountByPath = useMemo(() => {
    const counts = new Map<string, number>();
    for (const decision of Object.values(decisions)) {
      if (decision?.kind !== "map") continue;
      counts.set(
        decision.targetChapterPath,
        (counts.get(decision.targetChapterPath) ?? 0) + 1,
      );
    }
    return counts;
  }, [decisions]);
  const rows = useMemo(
    () =>
      buildMergeMapRows({
        conflicts,
        copyChoices,
        decisions,
        matchedExpanded,
        matching,
        undecidedOnly,
      }),
    [conflicts, copyChoices, decisions, matchedExpanded, matching, undecidedOnly],
  );
  const undecidedCount = order.filter((id) => decisions[id] === undefined).length;
  const unresolvedConflictCount = conflicts.filter((conflict) => {
    const choice = copyChoices[conflict.targetChapterPath];
    return choice === undefined || !conflict.sourceChapterIds.includes(choice);
  }).length;
  const activeSource = activeId === null ? null : (sourceById.get(activeId) ?? null);

  function focusRow(sourceChapterId: number | null): void {
    setActiveId(sourceChapterId);
    if (sourceChapterId === null) {
      setSheetOpen(false);
      return;
    }
    const inMatched = matching.matched.some(
      (item) => item.sourceChapterId === sourceChapterId,
    );
    if (inMatched) setMatchedExpanded(true);
  }

  function decide(decision: NovelMergeChapterDecision | null): void {
    if (!activeSource) return;
    onDecisionChange(activeSource.id, decision);
    if (!decision) return;
    const next = nextUndecidedSourceChapterId(
      order,
      { ...decisions, [activeSource.id]: decision },
      activeSource.id,
    );
    if (next === null) {
      if (!twoPanes) setSheetOpen(false);
      return;
    }
    focusRow(next);
  }

  function reviewNext(): void {
    const next = nextUndecidedSourceChapterId(order, decisions, activeId);
    focusRow(next);
    if (next !== null && !twoPanes) setSheetOpen(true);
  }

  function chapterStatus(chapter: ChapterListRow, reason?: NovelMergeAmbiguityReason): string {
    const decision = decisions[chapter.id];
    const target =
      decision?.kind === "map" ? targetByPath.get(decision.targetChapterPath) : undefined;
    const status =
      decision?.kind === "exclude"
        ? t("novelMerge.map.excluded")
        : target
          ? t("novelMerge.map.mappedTo", { name: targetChapterLabel(t, target) })
          : reason
            ? t(REASON_LABEL_KEYS[reason])
            : t("novelMerge.map.chooseTarget");
    return chapter.isDownloaded
      ? t("novelMerge.map.downloadedStatus", { status })
      : status;
  }

  function renderRow(row: MergeMapRow) {
    if (row.kind === "header") {
      const label = t(SECTION_LABEL_KEYS[row.section], { count: row.count });
      if (row.section === "matched" && !undecidedOnly) {
        const Chevron = matchedExpanded ? ChevronDownIcon : ChevronRightIcon;
        return (
          <button
            aria-expanded={matchedExpanded}
            className="norea-merge-section-header norea-merge-section-toggle norea-state-layer"
            onClick={() => setMatchedExpanded((current) => !current)}
            type="button"
          >
            <span>{label}</span>
            <Chevron aria-hidden="true" />
          </button>
        );
      }
      return (
        <h3 className="norea-merge-section-header" data-section={row.section}>
          {label}
        </h3>
      );
    }

    if (row.kind === "conflict") {
      const target = targetByPath.get(row.conflict.targetChapterPath);
      const choice = copyChoices[row.conflict.targetChapterPath];
      const resolved =
        choice !== undefined && row.conflict.sourceChapterIds.includes(choice);
      const options = row.conflict.sourceChapterIds.flatMap((id) => {
        const chapter = sourceById.get(id);
        return chapter ? [{ label: sourceChapterLabel(t, chapter), value: String(id) }] : [];
      });
      const targetLabel = target ? targetChapterLabel(t, target) : row.conflict.targetChapterPath;
      return (
        <div
          className="norea-merge-conflict-row"
          data-resolved={resolved ? "true" : undefined}
        >
          <Text className="norea-merge-conflict-title" size="sm">
            {resolved ? null : <WarningIcon className="norea-merge-row-status" />}
            <span className="norea-merge-conflict-label">
              {t("novelMerge.conflict.title", {
                count: row.conflict.sourceChapterIds.length,
                target: targetLabel,
              })}
            </span>
          </Text>
          <div className="norea-merge-conflict-choice">
            <Text c="dimmed" component="span" size="xs">
              {t("novelMerge.conflict.keep")}
            </Text>
            <SegmentedToggle
              aria-label={t("novelMerge.conflict.keepFor", { target: targetLabel })}
              data={options}
              fullWidth
              onChange={(value) =>
                onCopyChoiceChange(row.conflict.targetChapterPath, Number(value))
              }
              value={resolved ? String(choice) : ""}
            />
          </div>
        </div>
      );
    }

    const chapter = sourceById.get(row.sourceChapterId);
    if (!chapter) return null;
    const active = row.sourceChapterId === activeId;
    const decision = decisions[chapter.id];
    // Each row carries its decision as an icon beside the status text, never as a color edge alone.
    const StatusIcon = decision === undefined ? WarningIcon : decision.kind === "exclude" ? MinusIcon : CheckIcon;
    return (
      <ListRow
        aria-haspopup={twoPanes ? undefined : "dialog"}
        aria-pressed={twoPanes ? active : undefined}
        className="norea-merge-source-row"
        data-undecided={decision === undefined ? "true" : undefined}
        leading={<StatusIcon className="norea-merge-row-status" />}
        onClick={() => {
          setActiveId(chapter.id);
          if (!twoPanes) setSheetOpen(true);
        }}
        selected={twoPanes && active}
        subtitle={chapterStatus(chapter, row.reason)}
        title={sourceChapterLabel(t, chapter)}
      />
    );
  }

  const picker = activeSource ? (
    <MergeTargetPicker
      decision={decisions[activeSource.id]}
      key={activeSource.id}
      mappedCountByPath={mappedCountByPath}
      onClear={() => decide(null)}
      onExclude={() =>
        decide({ kind: "exclude", sourceChapterId: activeSource.id })
      }
      onMap={(targetChapterPath) =>
        decide({
          kind: "map",
          sourceChapterId: activeSource.id,
          targetChapterPath,
        })
      }
      source={activeSource}
      suggestedPaths={suggestionsBySourceId.get(activeSource.id) ?? []}
      targetChapters={targetChapters}
    />
  ) : null;

  const sourceList =
    rows.length === 0 ? (
      <Text c="dimmed" className="norea-merge-empty" size="sm">
        {sourceChapters.length === 0
          ? t("novel.noChapters")
          : t("novelMerge.map.allDecided")}
      </Text>
    ) : (
      <MergeVirtualRows
        aria-label={t("novelMerge.map.sourceChapters")}
        className="norea-merge-source-list"
        itemKey={(row) => row.key}
        items={rows}
        renderItem={renderRow}
        rowHeightRem={rowHeightRem}
        scrollToKey={activeId === null ? null : sourceChapterRowKey(activeId)}
      />
    );

  return (
    <div className="norea-merge-map">
      <div className="norea-merge-toolbar">
        <Switch
          checked={undecidedOnly}
          label={t("novelMerge.map.undecidedOnly")}
          onChange={(event) => setUndecidedOnly(event.currentTarget.checked)}
        />
        <Text c="dimmed" role="status" size="sm">
          {t("novelMerge.map.progress", {
            decided: order.length - undecidedCount,
            total: order.length,
          })}
        </Text>
        {undecidedCount > 0 ? (
          <Button color="warn" onClick={onExcludeRemaining} size="xs" variant="subtle">
            {t("novelMerge.map.excludeRemaining", { count: undecidedCount })}
          </Button>
        ) : null}
      </div>

      {twoPanes ? (
        <div className="norea-merge-panes">
          <section
            aria-label={t("novelMerge.map.sourceChapters")}
            className="norea-merge-pane"
          >
            {sourceList}
          </section>
          <section
            aria-label={t("novelMerge.map.targetChapters")}
            className="norea-merge-pane"
          >
            {activeSource ? (
              <>
                <Text className="norea-merge-pane-title" fw="var(--norea-weight-bold)" size="sm">
                  {t("novelMerge.map.targetFor", {
                    name: sourceChapterLabel(t, activeSource),
                  })}
                </Text>
                {picker}
              </>
            ) : (
              <Text c="dimmed" className="norea-merge-empty" size="sm">
                {t("novelMerge.map.selectSource")}
              </Text>
            )}
          </section>
        </div>
      ) : (
        <>
          {sourceList}
          <ResponsiveSheet
            fullScreenOnPhone
            onClose={() => setSheetOpen(false)}
            opened={sheetOpen && activeSource !== null}
            title={
              activeSource
                ? t("novelMerge.map.targetFor", {
                    name: sourceChapterLabel(t, activeSource),
                  })
                : ""
            }
          >
            {picker}
          </ResponsiveSheet>
        </>
      )}

      <footer className="norea-merge-footer">
        <Text c="dimmed" className="norea-merge-footer-status" size="sm">
          {undecidedCount > 0
            ? t("novelMerge.map.undecidedRemaining", { count: undecidedCount })
            : unresolvedConflictCount > 0
              ? t("novelMerge.map.copyChoicesRemaining", {
                  count: unresolvedConflictCount,
                })
              : null}
        </Text>
        {undecidedCount > 0 ? (
          <Button onClick={reviewNext} variant="default">
            {t("novelMerge.map.reviewNext")}
          </Button>
        ) : null}
        <Button disabled={!canContinue} onClick={onContinue}>
          {t("novelMerge.continue")}
        </Button>
      </footer>
    </div>
  );
}
