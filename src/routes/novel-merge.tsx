import { useEffect, useMemo, useRef, useState } from "react";
import { Group, Loader, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { notifications } from "@mantine/notifications";
import { PageFrame, PageHeader, StateView } from "../components/AppFrame";
import {
  MergeChooseStep,
  mergeTargetKey,
  type MergeTargetCandidate,
} from "../components/novel-merge/MergeChooseStep";
import { MergeConfirmStep } from "../components/novel-merge/MergeConfirmStep";
import { MergeMapStep } from "../components/novel-merge/MergeMapStep";
import { createInitialComposition, refreshCompositionCatalog, summarizeComposition } from "../components/novel-merge/merge-composition-editor";
import type { NovelMergeDecisionSummary } from "../components/novel-merge/merge-map-rows";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { listChaptersByNovel, type ChapterListRow } from "../db/queries/chapter";
import { getNovelById } from "../db/queries/novel";
import { useTranslation, type TranslationKey } from "../i18n";
import { usePageBackNavigation } from "../lib/android-back-navigation";
import {
  globalSearch,
  type GlobalSearchResult,
} from "../lib/plugins/global-search";
import { pluginManager } from "../lib/plugins/manager";
import {
  enqueueNovelMergeTargetPreviewTask,
  NovelMergePreviewValidationError,
} from "../lib/plugins/novel-merge-preview";
import type { SourceNovel } from "../lib/plugins/types";
import {
  taskScheduler,
  type TaskHandle,
} from "../lib/tasks/scheduler";
import {
  executeNovelMerge,
  type NovelMergeChapterDecision,
} from "../lib/novel-merge";
import {
  matchNovelMergeChapters,
  type NovelMergeChapterMatching,
} from "../lib/novel-merge-matching";
import {
  resolveNovelMergeTargetPreview,
  validateNovelMergeComposition,
  type NovelMergeCompositionEntry,
} from "../lib/novel-merge-composition";
import { getSourceRequestTimeoutMs } from "../store/browse";
import { useReaderStore } from "../store/reader";
import { describeError } from "../lib/errors";
import { isTauriRuntime } from "../lib/tauri-runtime";
import "../styles/novel-merge.css";

export type { NovelMergeChapterDecision } from "../lib/novel-merge";

const INSTALLED_PLUGINS_QUERY_KEY = ["plugin", "installed"] as const;

export interface NovelMergeDecisionSourceChapter {
  id: number;
  isDownloaded: boolean;
}

interface ValidateNovelMergeDecisionsOptions {
  artifactSourceChapterIdByTargetPath: Readonly<Record<string, number>>;
  decisions: readonly NovelMergeChapterDecision[];
  sourceChapters: readonly NovelMergeDecisionSourceChapter[];
  targetChapterPaths: readonly string[];
}

export interface NovelMergeDecisionValidation {
  artifactChoiceRequiredTargetPaths: string[];
  canConfirm: boolean;
  duplicateSourceChapterIds: number[];
  invalidArtifactChoiceTargetPaths: string[];
  undecidedSourceChapterIds: number[];
  unknownSourceChapterIds: number[];
  unknownTargetPathSourceChapterIds: number[];
}

export function validateNovelMergeDecisions({
  artifactSourceChapterIdByTargetPath,
  decisions,
  sourceChapters,
  targetChapterPaths,
}: ValidateNovelMergeDecisionsOptions): NovelMergeDecisionValidation {
  const sourceById = new Map(
    sourceChapters.map((chapter) => [chapter.id, chapter]),
  );
  const targetPathSet = new Set(targetChapterPaths);
  const decisionCountBySourceId = new Map<number, number>();
  const unknownSourceChapterIds = new Set<number>();
  const unknownTargetPathSourceChapterIds = new Set<number>();
  const downloadedSourcesByTargetPath = new Map<string, Set<number>>();

  for (const decision of decisions) {
    const source = sourceById.get(decision.sourceChapterId);
    if (!source) {
      unknownSourceChapterIds.add(decision.sourceChapterId);
      continue;
    }
    decisionCountBySourceId.set(
      decision.sourceChapterId,
      (decisionCountBySourceId.get(decision.sourceChapterId) ?? 0) + 1,
    );
    if (decision.kind !== "map") continue;
    if (!targetPathSet.has(decision.targetChapterPath)) {
      unknownTargetPathSourceChapterIds.add(decision.sourceChapterId);
      continue;
    }
    if (!source.isDownloaded) continue;
    const mappedSources =
      downloadedSourcesByTargetPath.get(decision.targetChapterPath) ??
      new Set<number>();
    mappedSources.add(source.id);
    downloadedSourcesByTargetPath.set(
      decision.targetChapterPath,
      mappedSources,
    );
  }

  const undecidedSourceChapterIds = sourceChapters
    .filter((chapter) => !decisionCountBySourceId.has(chapter.id))
    .map((chapter) => chapter.id);
  const duplicateSourceChapterIds = [...decisionCountBySourceId]
    .filter(([, count]) => count > 1)
    .map(([chapterId]) => chapterId)
    .sort((a, b) => a - b);
  const artifactChoiceRequiredTargetPaths = [...downloadedSourcesByTargetPath]
    .filter(
      ([targetPath, sourceIds]) =>
        sourceIds.size > 1 &&
        artifactSourceChapterIdByTargetPath[targetPath] === undefined,
    )
    .map(([targetPath]) => targetPath)
    .sort((a, b) => a.localeCompare(b));
  const invalidArtifactChoiceTargetPaths = Object.entries(
    artifactSourceChapterIdByTargetPath,
  )
    .filter(
      ([targetPath, sourceChapterId]) =>
        !downloadedSourcesByTargetPath
          .get(targetPath)
          ?.has(sourceChapterId),
    )
    .map(([targetPath]) => targetPath)
    .sort((a, b) => a.localeCompare(b));

  const validation = {
    artifactChoiceRequiredTargetPaths,
    duplicateSourceChapterIds,
    invalidArtifactChoiceTargetPaths,
    undecidedSourceChapterIds,
    unknownSourceChapterIds: [...unknownSourceChapterIds].sort((a, b) => a - b),
    unknownTargetPathSourceChapterIds: [
      ...unknownTargetPathSourceChapterIds,
    ].sort((a, b) => a - b),
  };

  return {
    ...validation,
    canConfirm: Object.values(validation).every((items) => items.length === 0),
  };
}


/** A plugin may provide multiple work IDs. Exclude only the exact source work. */
export function filterMergeTargetSearchResult(
  source: { pluginId: string; path: string } | null,
  result: GlobalSearchResult,
): GlobalSearchResult {
  return source?.pluginId === result.pluginId
    ? { ...result, novels: result.novels.filter(item => item.path !== source.path) }
    : result;
}

interface SelectedMergeTarget extends MergeTargetCandidate {
  novel: SourceNovel;
  matching: NovelMergeChapterMatching;
  sourceChapters: ChapterListRow[];
}

type MergeStep = "choose" | "map" | "confirm";

const MERGE_STEPS: readonly { id: MergeStep; label: TranslationKey }[] = [
  { id: "choose", label: "novelMerge.step.choose" },
  { id: "map", label: "novelMerge.step.map" },
  { id: "confirm", label: "novelMerge.step.confirm" },
];

interface NovelMergePageProps {
  sourceNovelId: number;
}

export function NovelMergePage({ sourceNovelId }: NovelMergePageProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const initializedSearchRef = useRef(false);
  const searchAbortRef = useRef<AbortController | null>(null);
  const previewTaskRef = useRef<TaskHandle<SourceNovel> | null>(null);
  const [step, setStep] = useState<MergeStep>("choose");
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<GlobalSearchResult[]>([]);
  const [selectedTarget, setSelectedTarget] =
    useState<SelectedMergeTarget | null>(null);
  const [composition, setComposition] = useState<NovelMergeCompositionEntry[]>([]);
  const [compositionEdited, setCompositionEdited] = useState(false);

  const sourceNovelQuery = useQuery({
    meta: { errorPresentation: "inline" },
    enabled: sourceNovelId > 0,
    queryKey: ["novel", "detail", sourceNovelId] as const,
    queryFn: () => getNovelById(sourceNovelId),
  });
  const sourceChaptersQuery = useQuery({
    meta: { errorPresentation: "inline" },
    enabled: sourceNovelId > 0,
    queryKey: ["novel", "detail", sourceNovelId, "chapters"] as const,
    queryFn: () => listChaptersByNovel(sourceNovelId),
  });
  const installedPluginsQuery = useQuery({
    meta: { errorPresentation: "inline" },
    queryKey: INSTALLED_PLUGINS_QUERY_KEY,
    queryFn: async () => {
      if (isTauriRuntime()) await pluginManager.loadInstalledFromDb();
      return pluginManager.list();
    },
    staleTime: 0,
  });
  const sourceNovel = sourceNovelQuery.data ?? null;
  const sourceChapters = useMemo(
    () => sourceChaptersQuery.data ?? [],
    [sourceChaptersQuery.data],
  );
  const targetPlugins = useMemo(
    () =>
      [...(installedPluginsQuery.data ?? [])]
        .sort((a, b) => a.name.localeCompare(b.name)),
    [installedPluginsQuery.data],
  );

  useEffect(
    () => () => {
      searchAbortRef.current?.abort();
      const previewTask = previewTaskRef.current;
      if (previewTask) taskScheduler.cancel(previewTask.id);
    },
    [],
  );

  const searchTargets = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: async (query: string) => {
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      return globalSearch(pluginManager, query, {
        onResult: (result) => {
          setSearchResults((current) =>
            [...current, filterMergeTargetSearchResult(sourceNovel, result)]
              .sort((a, b) => a.pluginName.localeCompare(b.pluginName)),
          );
        },
        plugins: targetPlugins,
        signal: controller.signal,
        timeoutMs: getSourceRequestTimeoutMs(),
        taskTitle: (plugin) =>
          t("novelMerge.tasks.search", {
            query,
            source: plugin.name,
          }),
      });
    },
    onMutate: () => setSearchResults([]),
  });

  useEffect(() => {
    if (
      !sourceNovel ||
      initializedSearchRef.current ||
      !installedPluginsQuery.isSuccess ||
      targetPlugins.length === 0
    ) {
      return;
    }
    initializedSearchRef.current = true;
    setSearchText(sourceNovel.name);
    searchTargets.mutate(sourceNovel.name);
  }, [installedPluginsQuery.isSuccess, searchTargets.mutate, sourceNovel, targetPlugins.length]);

  const previewTarget = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: async (candidate: MergeTargetCandidate & { preserveComposition?: boolean }) => {
      if (sourceNovel?.pluginId === candidate.pluginId && sourceNovel.path === candidate.item.path) {
        throw new Error("The target must have a different work identity.");
      }
      const task = enqueueNovelMergeTargetPreviewTask({
        item: candidate.item,
        manager: pluginManager,
        pluginId: candidate.pluginId,
        title: t("novelMerge.tasks.preview", { name: candidate.item.name }),
      });
      previewTaskRef.current = task;
      try {
        const detail = await task.promise;
        const novel = await resolveNovelMergeTargetPreview(candidate.pluginId, { ...detail, path: candidate.item.path });
        if (sourceNovel?.pluginId === candidate.pluginId &&
          sourceNovel.sourceNovelId && sourceNovel.sourceNovelId === novel.novelId) {
          throw new Error("The source and target have the same work identity.");
        }
        const sourceChapters = await listChaptersByNovel(sourceNovelId);
        return { ...candidate, novel, sourceChapters };
      } finally {
        if (previewTaskRef.current?.id === task.id) {
          previewTaskRef.current = null;
        }
      }
    },
    onSuccess: (target) => {
      const matching = matchNovelMergeChapters(target.sourceChapters, target.novel.chapters);
      if (target.preserveComposition && selectedTarget) {
        setComposition(current => refreshCompositionCatalog({
          composition: current,
          previousSourceChapterIds: selectedTarget.sourceChapters.map(chapter => chapter.id),
          previousTargetChapterPaths: selectedTarget.novel.chapters.map(chapter => chapter.path),
          sourceChapterIds: target.sourceChapters.map(chapter => chapter.id),
          targetChapterPaths: target.novel.chapters.map(chapter => chapter.path),
        }));
        setCompositionEdited(true);
        notifications.show({ message: t("novelMerge.catalog.reloaded") });
      } else {
        setComposition(createInitialComposition(target.sourceChapters, target.novel.chapters, matching));
        setCompositionEdited(false);
      }
      setSelectedTarget({ ...target, matching });
      mergeNovel.reset();
      setStep("map");
    },
  });

  const reviewedSourceChapters = selectedTarget?.sourceChapters ?? sourceChapters;
  const canConfirm = useMemo(() => {
    if (!selectedTarget) return false;
    try {
      validateNovelMergeComposition(composition, reviewedSourceChapters, selectedTarget.novel.chapters);
      return true;
    } catch {
      return false;
    }
  }, [composition, selectedTarget, reviewedSourceChapters]);
  const compositionSummary = useMemo(
    () => summarizeComposition(composition, reviewedSourceChapters, selectedTarget?.novel.chapters ?? []),
    [composition, selectedTarget?.novel.chapters, reviewedSourceChapters],
  );
  const summary = useMemo((): NovelMergeDecisionSummary => {
    const includedSources = new Set(composition.flatMap(entry => entry.sourceChapterIds));
    const retained = reviewedSourceChapters.filter(chapter => includedSources.has(chapter.id));
    const excluded = reviewedSourceChapters.filter(chapter => !includedSources.has(chapter.id));
    const keptBodies = new Set(composition.filter(entry => entry.primary === "source").map(entry => entry.sourceChapterIds[0]));
    const downloads = reviewedSourceChapters.filter(chapter => chapter.isDownloaded || chapter.contentBytes > 0);
    const hasReadingState = (chapter: (typeof reviewedSourceChapters)[number]) => !chapter.unread || chapter.progress > 0;
    return {
      copyChoices: 0,
      downloadsMoved: downloads.filter(chapter => keptBodies.has(chapter.id)).length,
      downloadsRemoved: downloads.filter(chapter => !keptBodies.has(chapter.id)).length,
      excluded: excluded.length,
      mapped: retained.length,
      readDropped: excluded.filter(hasReadingState).length,
      readMoved: retained.filter(hasReadingState).length,
    };
  }, [composition, reviewedSourceChapters]);

  const mergeNovel = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: async () => {
      if (!selectedTarget || !canConfirm) {
        throw new Error(t("novelMerge.confirmation.incomplete"));
      }
      const result = await executeNovelMerge({
        composition,
        reviewedChapterCatalog: {
          sourceChapterIds: reviewedSourceChapters.map(chapter => chapter.id),
          targetChapterPaths: selectedTarget.novel.chapters.map(chapter => chapter.path),
        },
        sourceNovelId,
        target: {
          item: selectedTarget.item,
          pluginId: selectedTarget.pluginId,
        },
      });
      useReaderStore.getState().mergeNovelReaderState({
        chapterIdMap: result.chapterIdMap,
        preferredLastReadChapterId: result.preferredLastReadChapterId,
        sourceNovelId,
        targetNovelId: result.targetNovelId,
      });
      return result;
    },
    onSuccess: (result) => {
      const targetName = selectedTarget?.novel.name ?? "";
      notifications.show({
        color: result.contentSyncPending ? "warn" : "ok",
        message: t(result.contentSyncPending ? "novelMerge.serverPending" : "novelMerge.success", { target: targetName }),
      });
      if (result.cleanupWarnings.length > 0) {
        console.warn("[novel-merge] cleanup warnings", result.cleanupWarnings);
        notifications.show({
          color: "warn",
          title: t("novelMerge.cleanupWarning.title"),
          message: t("novelMerge.cleanupWarning.outcome", {
            count: result.cleanupWarnings.length,
            source: sourceNovel?.name ?? "",
          }),
        });
      }
      setCompositionEdited(false);
      void queryClient.invalidateQueries({ queryKey: ["novel"] });
      void queryClient.invalidateQueries({ queryKey: ["chapter"] });
      void queryClient.invalidateQueries({ queryKey: ["category"] });
      void queryClient.invalidateQueries({ queryKey: ["download-cache"] });
      void navigate({
        replace: true,
        search: { id: result.targetNovelId },
        to: "/novel",
      });
    },
  });

  const catalogChanged = mergeNovel.isError && describeError(mergeNovel.error).includes("NOVEL_MERGE_CATALOG_CHANGED");

  function backToSourceNovel(): void {
    void navigate({
      replace: true,
      search: { id: sourceNovelId },
      to: "/novel",
    });
  }

  function confirmDiscardComposition(
    title: string,
    confirmLabel: string,
  ): Promise<boolean> {
    if (!compositionEdited || !selectedTarget) return Promise.resolve(true);
    return confirm({
      confirmLabel,
      danger: true,
      message: t("novelMerge.discard.message", { target: selectedTarget.novel.name }),
      title,
    });
  }

  async function leaveFlow(): Promise<void> {
    const leave = await confirmDiscardComposition(
      t("novelMerge.discard.leaveTitle"),
      t("novelMerge.discard.leave"),
    );
    if (leave) backToSourceNovel();
  }

  function goBack(): boolean {
    if (mergeNovel.isPending) return true;
    if (step === "confirm") {
      mergeNovel.reset();
      setStep("map");
      return true;
    }
    if (step === "map") {
      setStep("choose");
      return true;
    }
    void leaveFlow();
    return true;
  }

  usePageBackNavigation(goBack);

  function submitSearch(): void {
    const query = searchText.trim();
    if (
      !query ||
      searchTargets.isPending ||
      previewTarget.isPending ||
      targetPlugins.length === 0
    ) {
      return;
    }
    previewTarget.reset();
    searchTargets.mutate(query);
  }

  async function pickTarget(candidate: MergeTargetCandidate): Promise<void> {
    if (previewTarget.isPending) return;
    if (selectedTarget && mergeTargetKey(selectedTarget) === mergeTargetKey(candidate)) {
      setStep("map");
      return;
    }
    const change = await confirmDiscardComposition(
      t("novelMerge.discard.changeTitle"),
      t("novelMerge.discard.change"),
    );
    if (change) previewTarget.mutate(candidate);
  }

  function changeComposition(entries: NovelMergeCompositionEntry[]): void {
    setCompositionEdited(true);
    setComposition(entries);
  }

  if (sourceNovelId <= 0) {
    return (
      <div className="norea-novel-merge-page">
        <PageHeader onBack={backToSourceNovel} />
        <PageFrame size="wide">
          <StateView
            color="warn"
            title={t("novelMerge.missingSource")}
            message={t("novelMerge.missingSourceDescription")}
          />
        </PageFrame>
      </div>
    );
  }

  if (sourceNovelQuery.isPending || sourceChaptersQuery.isPending) {
    return (
      <div className="norea-novel-merge-page">
        <PageHeader onBack={backToSourceNovel} />
        <PageFrame size="wide">
          <Group justify="center" gap="sm" className="norea-novel-merge-loading">
            <Loader size="sm" />
            <Text>{t("novelMerge.loadingSource")}</Text>
          </Group>
        </PageFrame>
      </div>
    );
  }

  if (sourceNovelQuery.isError || sourceChaptersQuery.isError) {
    const error = sourceNovelQuery.error ?? sourceChaptersQuery.error;
    return (
      <div className="norea-novel-merge-page">
        <PageHeader onBack={backToSourceNovel} />
        <PageFrame size="wide">
          <StateView
            color="danger"
            title={t("novelMerge.loadSourceFailed")}
            message={describeError(error)}
            action={{ label: t("common.back"), onClick: backToSourceNovel }}
          />
        </PageFrame>
      </div>
    );
  }

  if (!sourceNovel) {
    return (
      <div className="norea-novel-merge-page">
        <PageHeader onBack={backToSourceNovel} />
        <PageFrame size="wide">
          <StateView
            color="warn"
            title={t("novelMerge.sourceNotFound")}
            message={t("novel.notFoundMessage", { id: sourceNovelId })}
            action={{ label: t("common.back"), onClick: backToSourceNovel }}
          />
        </PageFrame>
      </div>
    );
  }

  if (sourceNovel.isLocal) {
    return (
      <div className="norea-novel-merge-page">
        <PageHeader onBack={backToSourceNovel} />
        <PageFrame size="wide">
          <StateView
            color="warn"
            title={t("novelMerge.localSourceBlocked")}
            message={t("novelMerge.localSourceBlockedDescription")}
            action={{ label: t("common.back"), onClick: backToSourceNovel }}
          />
        </PageFrame>
      </div>
    );
  }

  if (!sourceNovel.inLibrary) {
    return (
      <div className="norea-novel-merge-page">
        <PageHeader onBack={backToSourceNovel} />
        <PageFrame size="wide">
          <StateView
            color="warn"
            title={t("novelMerge.librarySourceRequired")}
            message={t("novelMerge.librarySourceRequiredDescription")}
            action={{ label: t("common.back"), onClick: backToSourceNovel }}
          />
        </PageFrame>
      </div>
    );
  }

  const sourceName =
    sourceNovel.pluginName ??
    pluginManager.getPlugin(sourceNovel.pluginId)?.name ??
    sourceNovel.pluginId;
  const previewingKey =
    previewTarget.isPending && previewTarget.variables
      ? mergeTargetKey(previewTarget.variables)
      : null;
  const stepIndex = MERGE_STEPS.findIndex((entry) => entry.id === step);

  return (
    <div className="norea-novel-merge-page" data-step={step}>
      <PageHeader
        actions={
          <span className="norea-app-bar-meta">
            {t("novelMerge.step.count", {
              current: stepIndex + 1,
              total: MERGE_STEPS.length,
            })}
          </span>
        }
        backDisabled={mergeNovel.isPending}
        onBack={() => goBack()}
        title={t("novelMerge.title", { name: sourceNovel.name })}
      />
      <ol aria-label={t("novelMerge.step.label")} className="norea-merge-steps">
        {MERGE_STEPS.map((entry, index) => (
          <li
            aria-current={entry.id === step ? "step" : undefined}
            data-done={index < stepIndex ? "true" : undefined}
            key={entry.id}
          >
            {t(entry.label)}
          </li>
        ))}
      </ol>

      {step === "choose" || !selectedTarget ? (
        <MergeChooseStep
          noTargetPlugins={
            installedPluginsQuery.isSuccess && targetPlugins.length === 0
          }
          onCancelSearch={() => searchAbortRef.current?.abort()}
          onContinue={() => setStep("map")}
          onPick={(candidate) => void pickTarget(candidate)}
          onSearch={submitSearch}
          onSearchTextChange={setSearchText}
          pluginsError={
            installedPluginsQuery.isError
              ? describeError(installedPluginsQuery.error)
              : null
          }
          previewError={
            previewTarget.isError
              ? previewTarget.error instanceof NovelMergePreviewValidationError
                ? t("novelMerge.findTarget.previewInvalid")
                : describeError(previewTarget.error)
              : null
          }
          previewingKey={previewingKey}
          results={searchResults}
          searchError={
            searchTargets.isError ? describeError(searchTargets.error) : null
          }
          searchSettled={searchTargets.isSuccess}
          searchText={searchText}
          searching={searchTargets.isPending}
          selectedKey={selectedTarget ? mergeTargetKey(selectedTarget) : null}
          sourceName={sourceName}
        />
      ) : step === "map" ? (
        <MergeMapStep
          canContinue={canConfirm}
          composition={composition}
          matching={selectedTarget.matching}
          onCompositionChange={changeComposition}
          onContinue={() => setStep("confirm")}
          sourceChapters={reviewedSourceChapters}
          sourceName={sourceNovel.name}
          sourcePluginName={sourceName}
          targetChapters={selectedTarget.novel.chapters}
          targetName={selectedTarget.novel.name}
          targetPluginName={selectedTarget.pluginName}
        />
      ) : (
        <MergeConfirmStep
          compositionSummary={compositionSummary}
          error={catalogChanged
            ? [t("novelMerge.catalog.changed"), previewTarget.isError ? describeError(previewTarget.error) : null].filter(Boolean).join("\n")
            : mergeNovel.isError ? describeError(mergeNovel.error) : null}
          onReloadCatalog={catalogChanged ? () => {
            if (!previewTarget.isPending) previewTarget.mutate({ ...selectedTarget, preserveComposition: true });
          } : undefined}
          reloadingCatalog={previewTarget.isPending}
          onConfirm={() => {
            if (!mergeNovel.isPending) mergeNovel.mutate();
          }}
          pending={mergeNovel.isPending}
          sourceName={sourceNovel.name}
          sourcePluginName={sourceName}
          summary={summary}
          targetName={selectedTarget.novel.name}
          targetPluginName={selectedTarget.pluginName}
        />
      )}
    </div>
  );
}
