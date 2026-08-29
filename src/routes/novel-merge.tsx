import {
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { notifications } from "@mantine/notifications";
import { PageFrame, PageSection, StateView } from "../components/AppFrame";
import { BackIconButton } from "../components/BackIconButton";
import { ConsoleCover } from "../components/ConsolePrimitives";
import { SearchBar } from "../components/SearchBar";
import { SourceNovelCover } from "../components/SourceNovelCover";
import { TextButton } from "../components/TextButton";
import {
  listChaptersByNovel,
  type ChapterListRow,
} from "../db/queries/chapter";
import { getNovelById } from "../db/queries/novel";
import { useTranslation } from "../i18n";
import { usePageBackNavigation } from "../lib/android-back-navigation";
import {
  useNovelCoverSource,
  type NovelCoverSourceInput,
} from "../lib/use-novel-cover-source";
import {
  globalSearch,
  type GlobalSearchResult,
} from "../lib/plugins/global-search";
import { pluginManager } from "../lib/plugins/manager";
import {
  enqueueNovelMergeTargetPreviewTask,
  NovelMergePreviewValidationError,
} from "../lib/plugins/novel-merge-preview";
import type {
  ChapterItem,
  NovelItem,
  SourceNovel,
} from "../lib/plugins/types";
import {
  taskScheduler,
  type TaskHandle,
} from "../lib/tasks/scheduler";
import {
  executeNovelMerge,
  type NovelMergeChapterDecision,
} from "../lib/novel-merge";
import { getSourceRequestTimeoutMs, useBrowseStore } from "../store/browse";
import { useReaderStore } from "../store/reader";
import { isTauriRuntime } from "../lib/tauri-runtime";
import { novelMergeRoute } from "../router";
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

interface MergeTargetCandidate {
  item: NovelItem;
  pluginId: string;
  pluginName: string;
}

interface SelectedMergeTarget extends MergeTargetCandidate {
  novel: SourceNovel;
}

interface NovelSummaryCardProps {
  chapterCount: number;
  cover: ReactNode;
  label: string;
  name: string;
  sourceName: string;
}

function NovelSummaryCard({
  chapterCount,
  cover,
  label,
  name,
  sourceName,
}: NovelSummaryCardProps) {
  const { t } = useTranslation();

  return (
    <article className="lnr-novel-merge-summary-card">
      {cover}
      <div className="lnr-novel-merge-summary-copy">
        <Text className="lnr-novel-merge-summary-label">{label}</Text>
        <Title className="lnr-novel-merge-summary-title" order={3}>
          {name}
        </Title>
        <Text size="xs" c="dimmed">
          {sourceName}
        </Text>
        <Text size="xs" c="dimmed">
          {t("novel.chaptersCount", { count: chapterCount })}
        </Text>
      </div>
    </article>
  );
}

function StoredNovelCover({ novel }: { novel: NovelCoverSourceInput }) {
  const source = useNovelCoverSource(novel);
  return <ConsoleCover alt={novel.name} height={108} src={source} width={74} />;
}

function sourceChapterLabel(chapter: ChapterListRow): string {
  const number = chapter.chapterNumber ?? String(chapter.position);
  return `#${number} - ${chapter.name}`;
}

function targetChapterLabel(chapter: ChapterItem): string {
  return `#${chapter.chapterNumber} - ${chapter.name}`;
}

interface DecisionWorkbenchProps {
  activeSourceChapterId: number | null;
  artifactSourceChapterIdByTargetPath: Readonly<Record<string, number>>;
  decisionsBySourceChapterId: Readonly<
    Record<number, NovelMergeChapterDecision | undefined>
  >;
  onActiveSourceChapterChange: (chapterId: number) => void;
  onArtifactSourceChapterChange: (
    targetPath: string,
    sourceChapterId: number | null,
  ) => void;
  onDecisionChange: (
    sourceChapterId: number,
    decision: NovelMergeChapterDecision | null,
  ) => void;
  sourceChapters: readonly ChapterListRow[];
  targetChapters: readonly ChapterItem[];
}

function DecisionWorkbench({
  activeSourceChapterId,
  artifactSourceChapterIdByTargetPath,
  decisionsBySourceChapterId,
  onActiveSourceChapterChange,
  onArtifactSourceChapterChange,
  onDecisionChange,
  sourceChapters,
  targetChapters,
}: DecisionWorkbenchProps) {
  const { t } = useTranslation();
  const sourceById = useMemo(
    () => new Map(sourceChapters.map((chapter) => [chapter.id, chapter])),
    [sourceChapters],
  );
  const targetByPath = useMemo(
    () => new Map(targetChapters.map((chapter) => [chapter.path, chapter])),
    [targetChapters],
  );
  const mappedSourceIdsByTargetPath = useMemo(() => {
    const mapped = new Map<string, number[]>();
    for (const chapter of sourceChapters) {
      const decision = decisionsBySourceChapterId[chapter.id];
      if (decision?.kind !== "map") continue;
      mapped.set(decision.targetChapterPath, [
        ...(mapped.get(decision.targetChapterPath) ?? []),
        chapter.id,
      ]);
    }
    return mapped;
  }, [decisionsBySourceChapterId, sourceChapters]);
  const activeSourceChapter =
    activeSourceChapterId === null
      ? null
      : (sourceById.get(activeSourceChapterId) ?? null);
  const activeDecision = activeSourceChapter
    ? decisionsBySourceChapterId[activeSourceChapter.id]
    : undefined;
  const activeTarget =
    activeDecision?.kind === "map"
      ? targetByPath.get(activeDecision.targetChapterPath)
      : undefined;

  return (
    <div className="lnr-novel-merge-workbench">
      <section className="lnr-novel-merge-chapter-column">
        <header className="lnr-novel-merge-column-header">
          <Text fw={700}>{t("novelMerge.sourceChapters")}</Text>
          <Text size="xs" c="dimmed">
            {t("novel.chaptersCount", { count: sourceChapters.length })}
          </Text>
        </header>
        <div className="lnr-novel-merge-chapter-list">
          {sourceChapters.length === 0 ? (
            <Text className="lnr-novel-merge-empty" size="sm" c="dimmed">
              {t("novel.noChapters")}
            </Text>
          ) : (
            sourceChapters.map((chapter) => {
              const decision = decisionsBySourceChapterId[chapter.id];
              const mappedTarget =
                decision?.kind === "map"
                  ? targetByPath.get(decision.targetChapterPath)
                  : undefined;
              const decisionLabel =
                decision?.kind === "exclude"
                  ? t("novelMerge.decision.excluded")
                  : mappedTarget
                    ? t("novelMerge.decision.mappedTo", {
                        name: mappedTarget.name,
                      })
                    : t("novelMerge.decision.undecided");

              return (
                <button
                  aria-pressed={activeSourceChapterId === chapter.id}
                  className="lnr-novel-merge-chapter-button"
                  data-active={
                    activeSourceChapterId === chapter.id ? "true" : undefined
                  }
                  data-decided={decision ? "true" : undefined}
                  key={chapter.id}
                  onClick={() => onActiveSourceChapterChange(chapter.id)}
                  type="button"
                >
                  <span className="lnr-novel-merge-chapter-name">
                    {sourceChapterLabel(chapter)}
                  </span>
                  <span className="lnr-novel-merge-chapter-status">
                    {chapter.isDownloaded
                      ? t("novelMerge.decision.downloadedStatus", {
                          decision: decisionLabel,
                        })
                      : decisionLabel}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </section>

      <section className="lnr-novel-merge-decision-column">
        <header className="lnr-novel-merge-column-header">
          <Text fw={700}>{t("novelMerge.decision.title")}</Text>
        </header>
        {activeSourceChapter ? (
          <Stack gap="sm" className="lnr-novel-merge-decision-card">
            <Text fw={700}>{sourceChapterLabel(activeSourceChapter)}</Text>
            <Text size="sm" c="dimmed">
              {activeDecision?.kind === "exclude"
                ? t("novelMerge.decision.excludedDescription")
                : activeTarget
                  ? t("novelMerge.decision.mappedDescription", {
                      name: targetChapterLabel(activeTarget),
                    })
                  : t("novelMerge.decision.chooseTarget")}
            </Text>
            <Group gap="xs" wrap="wrap">
              <TextButton
                active={activeDecision?.kind === "exclude"}
                onClick={() =>
                  onDecisionChange(activeSourceChapter.id, {
                    kind: "exclude",
                    sourceChapterId: activeSourceChapter.id,
                  })
                }
                size="sm"
                tone="warning"
              >
                {t("novelMerge.decision.exclude")}
              </TextButton>
              {activeDecision ? (
                <TextButton
                  onClick={() =>
                    onDecisionChange(activeSourceChapter.id, null)
                  }
                  size="sm"
                >
                  {t("novelMerge.decision.clear")}
                </TextButton>
              ) : null}
            </Group>
          </Stack>
        ) : (
          <Text className="lnr-novel-merge-empty" size="sm" c="dimmed">
            {t("novelMerge.decision.selectSource")}
          </Text>
        )}
      </section>

      <section className="lnr-novel-merge-chapter-column">
        <header className="lnr-novel-merge-column-header">
          <Text fw={700}>{t("novelMerge.targetChapters")}</Text>
          <Text size="xs" c="dimmed">
            {t("novel.chaptersCount", { count: targetChapters.length })}
          </Text>
        </header>
        <div className="lnr-novel-merge-chapter-list">
          {targetChapters.length === 0 ? (
            <Text className="lnr-novel-merge-empty" size="sm" c="dimmed">
              {t("novelMerge.targetNoChapters")}
            </Text>
          ) : (
            targetChapters.map((chapter, index) => {
              const mappedSourceIds =
                mappedSourceIdsByTargetPath.get(chapter.path) ?? [];
              const downloadedMappedSources = mappedSourceIds
                .map((sourceId) => sourceById.get(sourceId))
                .filter(
                  (source): source is ChapterListRow =>
                    source?.isDownloaded === true,
                );
              const active =
                activeDecision?.kind === "map" &&
                activeDecision.targetChapterPath === chapter.path;

              return (
                <div
                  className="lnr-novel-merge-target-row"
                  data-active={active ? "true" : undefined}
                  key={`${chapter.path}:${index}`}
                >
                  <button
                    className="lnr-novel-merge-chapter-button"
                    disabled={!activeSourceChapter}
                    onClick={() => {
                      if (!activeSourceChapter) return;
                      onDecisionChange(activeSourceChapter.id, {
                        kind: "map",
                        sourceChapterId: activeSourceChapter.id,
                        targetChapterPath: chapter.path,
                      });
                    }}
                    type="button"
                  >
                    <span className="lnr-novel-merge-chapter-name">
                      {targetChapterLabel(chapter)}
                    </span>
                    <span className="lnr-novel-merge-chapter-status">
                      {mappedSourceIds.length > 0
                        ? t("novelMerge.mappedSourceCount", {
                            count: mappedSourceIds.length,
                          })
                        : t("novelMerge.targetAvailable")}
                    </span>
                  </button>
                  {downloadedMappedSources.length > 1 ? (
                    <label className="lnr-novel-merge-artifact-field">
                      <span>{t("novelMerge.artifact.label")}</span>
                      <select
                        aria-label={t("novelMerge.artifact.labelFor", {
                          name: chapter.name,
                        })}
                        onChange={(event) =>
                          onArtifactSourceChapterChange(
                            chapter.path,
                            event.currentTarget.value
                              ? Number(event.currentTarget.value)
                              : null,
                          )
                        }
                        value={
                          artifactSourceChapterIdByTargetPath[chapter.path] ?? ""
                        }
                      >
                        <option value="">
                          {t("novelMerge.artifact.placeholder")}
                        </option>
                        {downloadedMappedSources.map((source) => (
                          <option key={source.id} value={source.id}>
                            {sourceChapterLabel(source)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function NovelMergePage() {
  const { t } = useTranslation();
  const { sourceNovelId } = novelMergeRoute.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sourceWorkConcurrency = useBrowseStore(
    (state) => state.sourceWorkConcurrency,
  );
  const initializedSearchRef = useRef(false);
  const searchAbortRef = useRef<AbortController | null>(null);
  const previewTaskRef = useRef<TaskHandle<SourceNovel> | null>(null);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<GlobalSearchResult[]>([]);
  const [selectedTarget, setSelectedTarget] =
    useState<SelectedMergeTarget | null>(null);
  const [activeSourceChapterId, setActiveSourceChapterId] = useState<
    number | null
  >(null);
  const [decisionsBySourceChapterId, setDecisionsBySourceChapterId] = useState<
    Record<number, NovelMergeChapterDecision | undefined>
  >({});
  const [artifactSourceChapterIdByTargetPath, setArtifactSourceChapterIdByTargetPath] =
    useState<Record<string, number>>({});
  const [confirmationOpen, setConfirmationOpen] = useState(false);

  const sourceNovelQuery = useQuery({
    enabled: sourceNovelId > 0,
    queryKey: ["novel", "detail", sourceNovelId] as const,
    queryFn: () => getNovelById(sourceNovelId),
  });
  const sourceChaptersQuery = useQuery({
    enabled: sourceNovelId > 0,
    queryKey: ["novel", "detail", sourceNovelId, "chapters"] as const,
    queryFn: () => listChaptersByNovel(sourceNovelId),
  });
  const installedPluginsQuery = useQuery({
    queryKey: INSTALLED_PLUGINS_QUERY_KEY,
    queryFn: async () => {
      if (isTauriRuntime()) await pluginManager.loadInstalledFromDb();
      return pluginManager.list();
    },
    staleTime: 0,
  });
  const sourceNovel = sourceNovelQuery.data ?? null;
  const sourceChapters = sourceChaptersQuery.data ?? [];
  const targetPlugins = useMemo(
    () =>
      (installedPluginsQuery.data ?? [])
        .filter((plugin) => plugin.id !== sourceNovel?.pluginId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [installedPluginsQuery.data, sourceNovel?.pluginId],
  );

  useEffect(() => {
    if (!sourceNovel || initializedSearchRef.current) return;
    initializedSearchRef.current = true;
    setSearchText(sourceNovel.name);
  }, [sourceNovel]);

  useEffect(
    () => () => {
      searchAbortRef.current?.abort();
      const previewTask = previewTaskRef.current;
      if (previewTask) taskScheduler.cancel(previewTask.id);
    },
    [],
  );

  const searchTargets = useMutation({
    mutationFn: async (query: string) => {
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      return globalSearch(pluginManager, query, {
        concurrency: sourceWorkConcurrency,
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
    onSuccess: (results) =>
      setSearchResults(
        [...results].sort((a, b) => a.pluginName.localeCompare(b.pluginName)),
      ),
  });

  const previewTarget = useMutation({
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
      setSelectedTarget(target);
      setDecisionsBySourceChapterId({});
      setArtifactSourceChapterIdByTargetPath({});
      setActiveSourceChapterId(sourceChapters[0]?.id ?? null);
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
  const validation = useMemo(
    () =>
      validateNovelMergeDecisions({
        artifactSourceChapterIdByTargetPath,
        decisions: orderedDecisions,
        sourceChapters,
        targetChapterPaths:
          selectedTarget?.novel.chapters.map((chapter) => chapter.path) ?? [],
      }),
    [
      artifactSourceChapterIdByTargetPath,
      orderedDecisions,
      selectedTarget?.novel.chapters,
      sourceChapters,
    ],
  );
  const decidedCount =
    sourceChapters.length - validation.undecidedSourceChapterIds.length;
  const artifactSelectionsForMerge = useMemo(() => {
    const downloadedSourceIds = new Set(
      sourceChapters
        .filter((chapter) => chapter.isDownloaded)
        .map((chapter) => chapter.id),
    );
    const downloadedSourceIdsByTargetPath = new Map<string, Set<number>>();
    for (const decision of orderedDecisions) {
      if (
        decision.kind !== "map" ||
        !downloadedSourceIds.has(decision.sourceChapterId)
      ) {
        continue;
      }
      const mappedIds =
        downloadedSourceIdsByTargetPath.get(decision.targetChapterPath) ??
        new Set<number>();
      mappedIds.add(decision.sourceChapterId);
      downloadedSourceIdsByTargetPath.set(
        decision.targetChapterPath,
        mappedIds,
      );
    }
    return Object.fromEntries(
      Object.entries(artifactSourceChapterIdByTargetPath).filter(
        ([targetPath, sourceChapterId]) => {
          const mappedIds = downloadedSourceIdsByTargetPath.get(targetPath);
          return (
            mappedIds !== undefined &&
            mappedIds.size > 1 &&
            mappedIds.has(sourceChapterId)
          );
        },
      ),
    );
  }, [
    artifactSourceChapterIdByTargetPath,
    orderedDecisions,
    sourceChapters,
  ]);

  const mergeNovel = useMutation({
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
      setConfirmationOpen(false);
      if (result.cleanupWarnings.length > 0) {
        console.warn("[novel-merge] cleanup warnings", result.cleanupWarnings);
        notifications.show({
          color: "yellow",
          title: t("novelMerge.cleanupWarning.title"),
          message: t("novelMerge.cleanupWarning.description"),
        });
      }
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

  function goBack(): boolean {
    if (mergeNovel.isPending) return true;
    if (confirmationOpen) {
      setConfirmationOpen(false);
      return true;
    }
    if (selectedTarget) {
      setSelectedTarget(null);
      setDecisionsBySourceChapterId({});
      setArtifactSourceChapterIdByTargetPath({});
      previewTarget.reset();
      return true;
    }
    backToSourceNovel();
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

  function changeDecision(
    sourceChapterId: number,
    decision: NovelMergeChapterDecision | null,
  ): void {
    const previousDecision = decisionsBySourceChapterId[sourceChapterId];
    setDecisionsBySourceChapterId((current) => {
      const next = { ...current };
      if (decision) next[sourceChapterId] = decision;
      else delete next[sourceChapterId];
      return next;
    });
    if (previousDecision?.kind === "map") {
      setArtifactSourceChapterIdByTargetPath((current) => {
        if (
          current[previousDecision.targetChapterPath] !== sourceChapterId
        ) {
          return current;
        }
        const next = { ...current };
        delete next[previousDecision.targetChapterPath];
        return next;
      });
    }
  }

  function changeArtifactSourceChapter(
    targetPath: string,
    sourceChapterId: number | null,
  ): void {
    setArtifactSourceChapterIdByTargetPath((current) => {
      const next = { ...current };
      if (sourceChapterId === null) delete next[targetPath];
      else next[targetPath] = sourceChapterId;
      return next;
    });
  }

  if (sourceNovelId <= 0) {
    return (
      <PageFrame className="lnr-novel-merge-page" size="wide">
        <StateView
          color="orange"
          title={t("novelMerge.missingSource")}
          message={t("novelMerge.missingSourceDescription")}
        />
      </PageFrame>
    );
  }

  if (sourceNovelQuery.isPending || sourceChaptersQuery.isPending) {
    return (
      <PageFrame className="lnr-novel-merge-page" size="wide">
        <Group justify="center" gap="sm" className="lnr-novel-merge-loading">
          <Loader size="sm" />
          <Text>{t("novelMerge.loadingSource")}</Text>
        </Group>
      </PageFrame>
    );
  }

  if (sourceNovelQuery.isError || sourceChaptersQuery.isError) {
    const error = sourceNovelQuery.error ?? sourceChaptersQuery.error;
    return (
      <PageFrame className="lnr-novel-merge-page" size="wide">
        <StateView
          color="red"
          title={t("novelMerge.loadSourceFailed")}
          message={describeError(error)}
          action={{ label: t("common.back"), onClick: backToSourceNovel }}
        />
      </PageFrame>
    );
  }

  if (!sourceNovel) {
    return (
      <PageFrame className="lnr-novel-merge-page" size="wide">
        <StateView
          color="orange"
          title={t("novelMerge.sourceNotFound")}
          message={t("novel.notFoundMessage", { id: sourceNovelId })}
          action={{ label: t("common.back"), onClick: backToSourceNovel }}
        />
      </PageFrame>
    );
  }

  if (sourceNovel.isLocal) {
    return (
      <PageFrame className="lnr-novel-merge-page" size="wide">
        <StateView
          color="orange"
          title={t("novelMerge.localSourceBlocked")}
          message={t("novelMerge.localSourceBlockedDescription")}
          action={{ label: t("common.back"), onClick: backToSourceNovel }}
        />
      </PageFrame>
    );
  }

  if (!sourceNovel.inLibrary) {
    return (
      <PageFrame className="lnr-novel-merge-page" size="wide">
        <StateView
          color="orange"
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
  const previewingKey = previewTarget.variables
    ? `${previewTarget.variables.pluginId}:${previewTarget.variables.item.path}`
    : null;

  return (
    <PageFrame className="lnr-novel-merge-page" size="wide">
      <header className="lnr-novel-merge-header">
        <BackIconButton onClick={() => goBack()} />
        <div>
          <Text className="lnr-page-kicker">{t("novelMerge.eyebrow")}</Text>
          <Title className="lnr-page-title" order={1}>
            {t("novelMerge.title")}
          </Title>
          <Text className="lnr-page-description" mt="xs">
            {t("novelMerge.description")}
          </Text>
        </div>
      </header>

      {selectedTarget ? (
        <>
          <PageSection className="lnr-novel-merge-overview">
            <NovelSummaryCard
              chapterCount={sourceChapters.length}
              cover={<StoredNovelCover novel={sourceNovel} />}
              label={t("novelMerge.sourceNovel")}
              name={sourceNovel.name}
              sourceName={sourceName}
            />
            <div className="lnr-novel-merge-direction" aria-hidden="true">
              &rarr;
            </div>
            <NovelSummaryCard
              chapterCount={selectedTarget.novel.chapters.length}
              cover={
                <SourceNovelCover
                  height={108}
                  item={{
                    ...selectedTarget.item,
                    cover:
                      selectedTarget.novel.cover ?? selectedTarget.item.cover,
                  }}
                  plugin={pluginManager.getPlugin(selectedTarget.pluginId)}
                  width={74}
                />
              }
              label={t("novelMerge.targetNovel")}
              name={selectedTarget.novel.name}
              sourceName={selectedTarget.pluginName}
            />
            <TextButton onClick={() => goBack()} size="sm">
              {t("novelMerge.changeTarget")}
            </TextButton>
          </PageSection>

          <PageSection className="lnr-novel-merge-decision-section">
            <Group justify="space-between" align="flex-start" wrap="wrap">
              <div>
                <Title order={2} size="h3">
                  {t("novelMerge.decisions.title")}
                </Title>
                <Text size="sm" c="dimmed" mt={4}>
                  {t("novelMerge.decisions.description")}
                </Text>
              </div>
              <div className="lnr-novel-merge-progress" role="status">
                {t("novelMerge.decisions.progress", {
                  decided: decidedCount,
                  total: sourceChapters.length,
                })}
              </div>
            </Group>

            <DecisionWorkbench
              activeSourceChapterId={activeSourceChapterId}
              artifactSourceChapterIdByTargetPath={
                artifactSourceChapterIdByTargetPath
              }
              decisionsBySourceChapterId={decisionsBySourceChapterId}
              onActiveSourceChapterChange={setActiveSourceChapterId}
              onArtifactSourceChapterChange={changeArtifactSourceChapter}
              onDecisionChange={changeDecision}
              sourceChapters={sourceChapters}
              targetChapters={selectedTarget.novel.chapters}
            />

            {validation.undecidedSourceChapterIds.length > 0 ? (
              <Alert color="yellow" variant="light">
                {t("novelMerge.decisions.undecided", {
                  count: validation.undecidedSourceChapterIds.length,
                })}
              </Alert>
            ) : null}
            {validation.artifactChoiceRequiredTargetPaths.length > 0 ? (
              <Alert color="yellow" variant="light">
                {t("novelMerge.artifact.required", {
                  count: validation.artifactChoiceRequiredTargetPaths.length,
                })}
              </Alert>
            ) : null}
            {mergeNovel.isError ? (
              <Alert color="red" title={t("novelMerge.mergeFailed")}>
                {describeError(mergeNovel.error)}
              </Alert>
            ) : null}

            <Group justify="flex-end" gap="sm" wrap="wrap">
              <TextButton onClick={() => goBack()}>
                {t("common.cancel")}
              </TextButton>
              <TextButton
                disabled={!validation.canConfirm || mergeNovel.isPending}
                onClick={() => setConfirmationOpen(true)}
                tone="accent"
              >
                {t("novelMerge.reviewMerge")}
              </TextButton>
            </Group>
          </PageSection>
        </>
      ) : (
        <>
          <PageSection className="lnr-novel-merge-source-summary">
            <NovelSummaryCard
              chapterCount={sourceChapters.length}
              cover={<StoredNovelCover novel={sourceNovel} />}
              label={t("novelMerge.sourceNovel")}
              name={sourceNovel.name}
              sourceName={sourceName}
            />
          </PageSection>

          <PageSection className="lnr-novel-merge-target-search">
            <Title order={2} size="h3">
              {t("novelMerge.findTarget.title")}
            </Title>
            <Text size="sm" c="dimmed">
              {t("novelMerge.findTarget.description", { source: sourceName })}
            </Text>
            {installedPluginsQuery.isError ? (
              <Alert color="red" title={t("common.loadFailed")}>
                {describeError(installedPluginsQuery.error)}
              </Alert>
            ) : targetPlugins.length === 0 && !installedPluginsQuery.isPending ? (
              <Alert color="yellow">
                {t("novelMerge.findTarget.noPlugins")}
              </Alert>
            ) : (
              <SearchBar
                onChange={setSearchText}
                onSubmit={submitSearch}
                placeholder={t("novelMerge.findTarget.placeholder")}
                value={searchText}
              />
            )}

            {searchTargets.isPending ? (
              <Group gap="sm" className="lnr-novel-merge-search-state">
                <Loader size="sm" />
                <Text size="sm">{t("novelMerge.findTarget.searching")}</Text>
              </Group>
            ) : null}
            {searchTargets.isError ? (
              <Alert color="red" title={t("novelMerge.findTarget.searchFailed")}>
                {describeError(searchTargets.error)}
              </Alert>
            ) : null}
            {previewTarget.isError ? (
              <Alert color="red" title={t("novelMerge.findTarget.previewFailed")}>
                {previewTarget.error instanceof NovelMergePreviewValidationError
                  ? t("novelMerge.findTarget.previewInvalid")
                  : describeError(previewTarget.error)}
              </Alert>
            ) : null}

            <div className="lnr-novel-merge-search-results">
              {searchResults.map((result) => (
                <section className="lnr-novel-merge-source-results" key={result.pluginId}>
                  <Group justify="space-between" gap="sm" wrap="nowrap">
                    <Text fw={700}>{result.pluginName}</Text>
                    <Text size="xs" c="dimmed">
                      {t("novelMerge.findTarget.resultCount", {
                        count: result.novels.length,
                      })}
                    </Text>
                  </Group>
                  {result.error ? (
                    <Alert color="red" variant="light">
                      {result.error}
                    </Alert>
                  ) : result.novels.length === 0 ? (
                    <Text size="sm" c="dimmed">
                      {t("novelMerge.findTarget.noResultsFromSource")}
                    </Text>
                  ) : (
                    <div className="lnr-novel-merge-result-grid">
                      {result.novels.map((item, index) => {
                        const key = `${result.pluginId}:${item.path}`;
                        const previewing =
                          previewTarget.isPending && previewingKey === key;
                        return (
                          <button
                            className="lnr-novel-merge-result-card"
                            disabled={previewTarget.isPending}
                            key={`${key}:${index}`}
                            onClick={() =>
                              previewTarget.mutate({
                                item,
                                pluginId: result.pluginId,
                                pluginName: result.pluginName,
                              })
                            }
                            type="button"
                          >
                            <SourceNovelCover
                              height={108}
                              item={item}
                              plugin={pluginManager.getPlugin(result.pluginId)}
                              width={74}
                            />
                            <span className="lnr-novel-merge-result-name">
                              {item.name}
                            </span>
                            <span className="lnr-novel-merge-result-action">
                              {previewing ? (
                                <Loader size="xs" />
                              ) : (
                                t("novelMerge.findTarget.preview")
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </section>
              ))}
            </div>

            {!searchTargets.isPending &&
            searchResults.length > 0 &&
            searchResults.every(
              (result) => result.error || result.novels.length === 0,
            ) ? (
              <Text size="sm" c="dimmed">
                {t("novelMerge.findTarget.noResults")}
              </Text>
            ) : null}
          </PageSection>
        </>
      )}

      <Modal
        centered
        closeOnClickOutside={!mergeNovel.isPending}
        closeOnEscape={!mergeNovel.isPending}
        onClose={() => {
          if (!mergeNovel.isPending) setConfirmationOpen(false);
        }}
        opened={confirmationOpen}
        title={t("novelMerge.confirmation.title")}
      >
        <Stack gap="md">
          <Text size="sm">
            {t("novelMerge.confirmation.description", {
              source: sourceNovel.name,
              target: selectedTarget?.novel.name ?? "",
            })}
          </Text>
          <Alert color="orange" variant="light">
            {t("novelMerge.confirmation.warning")}
          </Alert>
          {mergeNovel.isError ? (
            <Alert color="red">{describeError(mergeNovel.error)}</Alert>
          ) : null}
          <Group justify="flex-end" gap="sm">
            <TextButton
              disabled={mergeNovel.isPending}
              onClick={() => setConfirmationOpen(false)}
            >
              {t("common.cancel")}
            </TextButton>
            <TextButton
              disabled={!validation.canConfirm || mergeNovel.isPending}
              loading={mergeNovel.isPending}
              onClick={() => mergeNovel.mutate()}
              tone="warning"
            >
              {mergeNovel.isPending
                ? t("novelMerge.merging")
                : t("novelMerge.confirmation.confirm")}
            </TextButton>
          </Group>
        </Stack>
      </Modal>
    </PageFrame>
  );
}
