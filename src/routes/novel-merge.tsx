import { useEffect, useMemo, useRef, useState } from "react";
import { Group, Loader, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { notifications } from "@mantine/notifications";
import { PageFrame, StateView } from "../components/AppFrame";
import { IconButton } from "../components/IconButton";
import {
  MergeChooseStep,
  mergeTargetKey,
  type MergeTargetCandidate,
} from "../components/novel-merge/MergeChooseStep";
import { MergeConfirmStep } from "../components/novel-merge/MergeConfirmStep";
import { MergeMapStep } from "../components/novel-merge/MergeMapStep";
import { summarizeNovelMergeDecisions } from "../components/novel-merge/merge-map-rows";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { BackIcon } from "../components/ui/icons";
import { listChaptersByNovel } from "../db/queries/chapter";
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
  findNovelMergeCopyConflicts,
  matchNovelMergeChapters,
  type NovelMergeChapterMatching,
} from "../lib/novel-merge-matching";
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


interface SelectedMergeTarget extends MergeTargetCandidate {
  novel: SourceNovel;
  matching: NovelMergeChapterMatching;
}

type MergeStep = "choose" | "map" | "confirm";

const MERGE_STEPS: readonly { id: MergeStep; label: TranslationKey }[] = [
  { id: "choose", label: "novelMerge.step.choose" },
  { id: "map", label: "novelMerge.step.map" },
  { id: "confirm", label: "novelMerge.step.confirm" },
];

function initialDecisions(
  matching: NovelMergeChapterMatching,
): Record<number, NovelMergeChapterDecision> {
  return Object.fromEntries(
    matching.matched.map((match) => [
      match.sourceChapterId,
      { kind: "map", ...match } satisfies NovelMergeChapterDecision,
    ]),
  );
}

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
  const [decisionsBySourceChapterId, setDecisionsBySourceChapterId] = useState<
    Record<number, NovelMergeChapterDecision | undefined>
  >({});
  const [artifactSourceChapterIdByTargetPath, setArtifactSourceChapterIdByTargetPath] =
    useState<Record<string, number>>({});
  const [decisionsEdited, setDecisionsEdited] = useState(false);

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
      (installedPluginsQuery.data ?? [])
        .filter((plugin) => plugin.id !== sourceNovel?.pluginId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [installedPluginsQuery.data, sourceNovel?.pluginId],
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
        onResult: (result) =>
          setSearchResults((current) =>
            [...current, result].sort((a, b) => a.pluginName.localeCompare(b.pluginName)),
          ),
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
    mutationFn: async (candidate: MergeTargetCandidate) => {
      const task = enqueueNovelMergeTargetPreviewTask({
        item: candidate.item,
        manager: pluginManager,
        pluginId: candidate.pluginId,
        title: t("novelMerge.tasks.preview", { name: candidate.item.name }),
      });
      previewTaskRef.current = task;
      try {
        return { ...candidate, novel: await task.promise };
      } finally {
        if (previewTaskRef.current?.id === task.id) {
          previewTaskRef.current = null;
        }
      }
    },
    onSuccess: (target) => {
      const matching = matchNovelMergeChapters(sourceChapters, target.novel.chapters);
      setSelectedTarget({ ...target, matching });
      setDecisionsBySourceChapterId(initialDecisions(matching));
      setArtifactSourceChapterIdByTargetPath({});
      setDecisionsEdited(false);
      setStep("map");
    },
  });

  const orderedDecisions = useMemo(
    () =>
      sourceChapters.flatMap((chapter) => {
        const decision = decisionsBySourceChapterId[chapter.id];
        return decision ? [decision] : [];
      }),
    [decisionsBySourceChapterId, sourceChapters],
  );
  const copyConflicts = useMemo(
    () => findNovelMergeCopyConflicts(sourceChapters, orderedDecisions),
    [orderedDecisions, sourceChapters],
  );
  const artifactSelectionsForMerge = useMemo(() => {
    const conflictSourceIds = new Map(
      copyConflicts.map((conflict) => [
        conflict.targetChapterPath,
        conflict.sourceChapterIds,
      ]),
    );
    return Object.fromEntries(
      Object.entries(artifactSourceChapterIdByTargetPath).filter(
        ([targetPath, sourceChapterId]) =>
          conflictSourceIds.get(targetPath)?.includes(sourceChapterId) === true,
      ),
    );
  }, [artifactSourceChapterIdByTargetPath, copyConflicts]);
  const validation = useMemo(
    () =>
      validateNovelMergeDecisions({
        artifactSourceChapterIdByTargetPath: artifactSelectionsForMerge,
        decisions: orderedDecisions,
        sourceChapters,
        targetChapterPaths:
          selectedTarget?.novel.chapters.map((chapter) => chapter.path) ?? [],
      }),
    [
      artifactSelectionsForMerge,
      orderedDecisions,
      selectedTarget?.novel.chapters,
      sourceChapters,
    ],
  );
  const summary = useMemo(
    () =>
      summarizeNovelMergeDecisions(
        sourceChapters,
        decisionsBySourceChapterId,
        copyConflicts,
      ),
    [copyConflicts, decisionsBySourceChapterId, sourceChapters],
  );

  const mergeNovel = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: async () => {
      if (!selectedTarget || !validation.canConfirm) {
        throw new Error(t("novelMerge.confirmation.incomplete"));
      }
      const result = await executeNovelMerge({
        artifactSourceChapterIdByTargetPath: artifactSelectionsForMerge,
        decisions: orderedDecisions,
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
        color: "ok",
        message: t("novelMerge.success", { target: targetName }),
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
      setDecisionsEdited(false);
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

  function backToSourceNovel(): void {
    void navigate({
      replace: true,
      search: { id: sourceNovelId },
      to: "/novel",
    });
  }

  function confirmDiscardDecisions(
    title: string,
    confirmLabel: string,
  ): Promise<boolean> {
    if (!decisionsEdited || !selectedTarget) return Promise.resolve(true);
    return confirm({
      confirmLabel,
      danger: true,
      message: t("novelMerge.discard.message", { target: selectedTarget.novel.name }),
      title,
    });
  }

  async function leaveFlow(): Promise<void> {
    const leave = await confirmDiscardDecisions(
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
    const change = await confirmDiscardDecisions(
      t("novelMerge.discard.changeTitle"),
      t("novelMerge.discard.change"),
    );
    if (change) previewTarget.mutate(candidate);
  }

  function changeDecision(
    sourceChapterId: number,
    decision: NovelMergeChapterDecision | null,
  ): void {
    setDecisionsEdited(true);
    setDecisionsBySourceChapterId((current) => {
      const next = { ...current };
      if (decision) next[sourceChapterId] = decision;
      else delete next[sourceChapterId];
      return next;
    });
  }

  function excludeRemaining(): void {
    setDecisionsEdited(true);
    setDecisionsBySourceChapterId((current) => {
      const next = { ...current };
      for (const chapter of sourceChapters) {
        next[chapter.id] ??= { kind: "exclude", sourceChapterId: chapter.id };
      }
      return next;
    });
  }

  function changeArtifactSourceChapter(
    targetPath: string,
    sourceChapterId: number,
  ): void {
    setDecisionsEdited(true);
    setArtifactSourceChapterIdByTargetPath((current) => ({
      ...current,
      [targetPath]: sourceChapterId,
    }));
  }

  if (sourceNovelId <= 0) {
    return (
      <PageFrame className="norea-novel-merge-page" size="wide">
        <StateView
          color="warn"
          title={t("novelMerge.missingSource")}
          message={t("novelMerge.missingSourceDescription")}
        />
      </PageFrame>
    );
  }

  if (sourceNovelQuery.isPending || sourceChaptersQuery.isPending) {
    return (
      <PageFrame className="norea-novel-merge-page" size="wide">
        <Group justify="center" gap="sm" className="norea-novel-merge-loading">
          <Loader size="sm" />
          <Text>{t("novelMerge.loadingSource")}</Text>
        </Group>
      </PageFrame>
    );
  }

  if (sourceNovelQuery.isError || sourceChaptersQuery.isError) {
    const error = sourceNovelQuery.error ?? sourceChaptersQuery.error;
    return (
      <PageFrame className="norea-novel-merge-page" size="wide">
        <StateView
          color="danger"
          title={t("novelMerge.loadSourceFailed")}
          message={describeError(error)}
          action={{ label: t("common.back"), onClick: backToSourceNovel }}
        />
      </PageFrame>
    );
  }

  if (!sourceNovel) {
    return (
      <PageFrame className="norea-novel-merge-page" size="wide">
        <StateView
          color="warn"
          title={t("novelMerge.sourceNotFound")}
          message={t("novel.notFoundMessage", { id: sourceNovelId })}
          action={{ label: t("common.back"), onClick: backToSourceNovel }}
        />
      </PageFrame>
    );
  }

  if (sourceNovel.isLocal) {
    return (
      <PageFrame className="norea-novel-merge-page" size="wide">
        <StateView
          color="warn"
          title={t("novelMerge.localSourceBlocked")}
          message={t("novelMerge.localSourceBlockedDescription")}
          action={{ label: t("common.back"), onClick: backToSourceNovel }}
        />
      </PageFrame>
    );
  }

  if (!sourceNovel.inLibrary) {
    return (
      <PageFrame className="norea-novel-merge-page" size="wide">
        <StateView
          color="warn"
          title={t("novelMerge.librarySourceRequired")}
          message={t("novelMerge.librarySourceRequiredDescription")}
          action={{ label: t("common.back"), onClick: backToSourceNovel }}
        />
      </PageFrame>
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
      <header className="norea-merge-app-bar">
        <IconButton
          disabled={mergeNovel.isPending}
          label={t("common.back")}
          onClick={() => goBack()}
          size="lg"
        >
          <BackIcon />
        </IconButton>
        <h1 className="norea-merge-app-bar-title">
          {t("novelMerge.title", { name: sourceNovel.name })}
        </h1>
        <span className="norea-merge-step-count">
          {t("novelMerge.step.count", {
            current: stepIndex + 1,
            total: MERGE_STEPS.length,
          })}
        </span>
      </header>
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
          canContinue={validation.canConfirm}
          conflicts={copyConflicts}
          copyChoices={artifactSourceChapterIdByTargetPath}
          decisions={decisionsBySourceChapterId}
          matching={selectedTarget.matching}
          onContinue={() => setStep("confirm")}
          onCopyChoiceChange={changeArtifactSourceChapter}
          onDecisionChange={changeDecision}
          onExcludeRemaining={excludeRemaining}
          sourceChapters={sourceChapters}
          targetChapters={selectedTarget.novel.chapters}
        />
      ) : (
        <MergeConfirmStep
          error={mergeNovel.isError ? describeError(mergeNovel.error) : null}
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
