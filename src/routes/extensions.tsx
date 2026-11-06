import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Button,
  Indicator,
  Loader,
  PasswordInput,
  Skeleton,
  Stack,
  TextInput,
} from "@mantine/core";
import { ChipButton } from "../components/ChipButton";
import { IconButton } from "../components/IconButton";
import { PageFrame, PageHeader, StateView } from "../components/AppFrame";
import { PluginIcon } from "../components/browse/PluginIcon";
import { PluginSettingsDialog } from "../components/browse/PluginSettingsDialog";
import {
  RepositoriesDialog,
  repositoryLabel,
} from "../components/browse/RepositoriesDialog";
import {
  AVAILABLE_QUERY_KEY,
  addPluginRepository,
  findDifferentPluginVersions,
  findPluginUpdates,
  findPublisherOffers,
  hasPluginInputs,
  installedPluginPublisher,
  isMultiSourcePlugin,
  mergeCatalogEntries,
  refreshAvailablePlugins,
  sortPluginsByName,
  updatePlugins,
  useAvailablePlugins,
  useInstalledPlugins,
  useRepositories,
  type AvailableEntry,
  type PluginPublisherLookup,
  type PluginUpdate,
  type RepoFetchFailure,
} from "../components/browse/use-plugin-catalog";
import { showSettingsToast } from "../components/settings/settings-toast";
import { useConfirm } from "../components/ui/ConfirmDialog";
import {
  ChevronRightIcon,
  DownloadIcon,
  GithubIcon,
  ImportIcon,
  PlusIcon,
  RepositoryIcon,
  RetryIcon,
  SettingsIcon,
  TrashIcon,
} from "../components/ui/icons";
import { ListRow } from "../components/ui/ListRow";
import { OverflowMenu } from "../components/ui/OverflowMenu";
import { ResponsiveSheet, SheetActions } from "../components/ui/ResponsiveSheet";
import {
  removeRepository,
  reorderRepositories,
  setRepositoryEnabled,
  type PluginRepository,
} from "../db/queries/repository";
import {
  formatPluginLanguageForLocale,
  useTranslation,
  type AppLocale,
} from "../i18n";
import { usePageBackNavigation } from "../lib/android-back-navigation";
import { describeError } from "../lib/errors";
import {
  goBackInAppHistory,
  isOpenedFromMore,
} from "../lib/navigation-history";
import { pluginManager } from "../lib/plugins/manager";
import type { Plugin, PluginItem } from "../lib/plugins/types";
import { comparePluginVersions } from "../lib/plugins/version";
import { enqueueMainTask } from "../lib/tasks/main-tasks";
import { useBrowseStore } from "../store/browse";
import "../styles/browse.css";

const MAX_PLUGIN_SOURCE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PLUGIN_SOURCE_FILE_SIZE_LABEL = "5 MiB";
const SKELETON_ROWS = 4;

interface SourceInstanceForm {
  workTitle: string;
  repository: string;
  ref: string;
  workRoot: string;
  chapterFilePattern: string;
  chapterExcludePattern: string;
  token: string;
}

const DEFAULT_SOURCE_INSTANCE_FORM: SourceInstanceForm = {
  workTitle: "",
  repository: "",
  ref: "",
  workRoot: "",
  chapterFilePattern: "",
  chapterExcludePattern: "",
  token: "",
};

const SOURCE_INSTANCE_FIELDS = [
  ["workTitle", "browse.sourceInstance.workTitle", "browse.sourceInstance.workTitlePlaceholder"],
  ["repository", "browse.sourceInstance.repository", "browse.sourceInstance.repositoryPlaceholder"],
  ["ref", "browse.sourceInstance.ref", "browse.sourceInstance.refPlaceholder"],
  ["workRoot", "browse.sourceInstance.workRoot", "browse.sourceInstance.workRootPlaceholder"],
  ["chapterFilePattern", "browse.sourceInstance.chapterFiles", "browse.sourceInstance.chapterFilesPlaceholder"],
  ["chapterExcludePattern", "browse.sourceInstance.excludeFiles", "browse.sourceInstance.excludeFilesPlaceholder"],
] as const;

function sourceInstanceInputs(form: SourceInstanceForm): Record<string, string> {
  return Object.fromEntries(
    Object.entries(form).map(([key, value]) => [key, value.trim()]),
  );
}

function isSourceInstanceFormComplete(form: SourceInstanceForm): boolean {
  return [form.workTitle, form.repository, form.workRoot, form.chapterFilePattern].every(
    (value) => value.trim() !== "",
  );
}

function localPluginSourceUrl(file: File): string {
  const safeName = file.name.trim().replace(/[\r\n]/g, " ") || "plugin.js";
  return `local:${encodeURIComponent(safeName)}`;
}

function withPendingId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return new Set(ids).add(id);
}

function withoutPendingId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(ids);
  next.delete(id);
  return next;
}

function languageLabel(locale: AppLocale, lang: string): string {
  return formatPluginLanguageForLocale(locale, lang);
}

function pluginMeta(locale: AppLocale, item: PluginItem): string {
  return `${languageLabel(locale, item.lang)} · ${item.version}`;
}

export function extensionRowId(pluginId: string): string {
  return `norea-extension-${pluginId}`;
}

interface ExtensionRowProps {
  current?: boolean;
  id?: string;
  leading: ReactNode;
  subtitle: ReactNode;
  title: ReactNode;
  trailing: ReactNode;
}

/** A static management row; its only controls are the trailing actions. */
function ExtensionRow({ current, id, leading, subtitle, title, trailing }: ExtensionRowProps) {
  return (
    <li className="norea-extension-row" data-current={current ? "true" : undefined} id={id}>
      <span className="norea-list-item-leading">{leading}</span>
      <span className="norea-list-item-text">
        <span className="norea-list-item-title">{title}</span>
        <span className="norea-list-item-subtitle">{subtitle}</span>
      </span>
      <span className="norea-extension-row-trailing">{trailing}</span>
    </li>
  );
}

function ExtensionRowsSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="norea-extension-list" role="status">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div className="norea-extension-row" key={index}>
          <Skeleton height="2.5rem" radius="sm" width="2.5rem" />
          <div className="norea-extension-skeleton-text">
            <Skeleton height="0.875rem" radius="sm" width="40%" />
            <Skeleton height="0.75rem" radius="sm" width="25%" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ExtensionSection({
  actions,
  children,
  id,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  id: string;
  title: string;
}) {
  return (
    <section aria-labelledby={id} className="norea-extension-section">
      <div className="norea-extension-section-header">
        <h2 className="norea-extension-section-title" id={id}>
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

interface ExtensionsPageProps {
  /** An installed plugin to bring into view, for "Manage in Extensions". */
  focusPluginId?: string;
}

export function ExtensionsPage({ focusPluginId }: ExtensionsPageProps) {
  const { locale, t } = useTranslation();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const currentHref = useRouterState({ select: (state) => state.location.href });
  const openedFromMore = useRouterState({
    select: (state) => isOpenedFromMore(state.location.state),
  });
  const repositoryFormId = useId();
  const sourceFormId = useId();
  const repos = useRepositories(true);
  const installed = useInstalledPlugins(true);
  const available = useAvailablePlugins(repos.data, true);

  const pendingRepoUrl = useBrowseStore((s) => s.pendingRepoUrl);
  const clearPendingRepoUrl = useBrowseStore((s) => s.clearPendingRepoUrl);
  const pluginLanguageFilter = useBrowseStore((s) => s.pluginLanguageFilter);
  const setPluginLanguageFilter = useBrowseStore((s) => s.setPluginLanguageFilter);
  const pinnedPluginIds = useBrowseStore((s) => s.pinnedPluginIds);
  const togglePinnedPlugin = useBrowseStore((s) => s.togglePinnedPlugin);
  const lastUsedPluginId = useBrowseStore((s) => s.lastUsedPluginId);
  const setLastUsedPluginId = useBrowseStore((s) => s.setLastUsedPluginId);

  const [repositoryListOpen, setRepositoryListOpen] = useState(false);
  const [repositoryDialogOpen, setRepositoryDialogOpen] = useState(false);
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [refreshingRepoUrl, setRefreshingRepoUrl] = useState<string | null>(null);
  const [settingsPlugin, setSettingsPlugin] = useState<Plugin | null>(null);
  const [sourceTemplate, setSourceTemplate] = useState<AvailableEntry | null>(null);
  const [sourceForm, setSourceForm] = useState<SourceInstanceForm>(DEFAULT_SOURCE_INSTANCE_FORM);
  const [availableFilter, setAvailableFilter] = useState("");
  const [installingPluginIds, setInstallingPluginIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [uninstallingPluginIds, setUninstallingPluginIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [updatingPluginIds, setUpdatingPluginIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [failedUpdates, setFailedUpdates] = useState<ReadonlyMap<string, unknown>>(
    () => new Map(),
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const repositories = useMemo(() => repos.data ?? [], [repos.data]);
  const enabledRepositories = useMemo(
    () => repositories.filter((repository) => repository.enabled),
    [repositories],
  );
  const repositoryLabels = useMemo(
    () => new Map(repositories.map((repository) => [repository.url, repositoryLabel(repository)])),
    [repositories],
  );
  const installedPlugins = useMemo(() => sortPluginsByName(installed.data ?? []), [installed.data]);
  const installedById = useMemo(
    () => new Map(installedPlugins.map((plugin) => [plugin.id, plugin])),
    [installedPlugins],
  );
  const availableEntries = useMemo(
    () => (enabledRepositories.length > 0 ? (available.data?.entries ?? []) : []),
    [available.data, enabledRepositories.length],
  );
  const failures = enabledRepositories.length > 0 ? (available.data?.failures ?? []) : [];
  const updates = useMemo(
    () => findPluginUpdates(installedPlugins, availableEntries, installedPluginPublisher),
    [availableEntries, installedPlugins],
  );
  const differentVersions = useMemo(
    () =>
      new Map(
        findDifferentPluginVersions(installedPlugins, availableEntries, installedPluginPublisher)
          .map(({ item, plugin }) => [plugin.id, item.version]),
      ),
    [availableEntries, installedPlugins],
  );
  const publisherOffers = useMemo(
    () => findPublisherOffers(installedPlugins, availableEntries, installedPluginPublisher),
    [availableEntries, installedPlugins],
  );
  const installableEntries = useMemo(
    () =>
      mergeCatalogEntries(availableEntries)
        .filter(({ item }) => isMultiSourcePlugin(item) || !installedById.has(item.id))
        .sort((a, b) => a.item.name.localeCompare(b.item.name)),
    [availableEntries, installedById],
  );
  useEffect(() => {
    if (!available.isFetching) setRefreshingRepoUrl(null);
  }, [available.isFetching]);

  const availableLanguages = useMemo(
    () =>
      [...new Set([...pluginLanguageFilter, ...installableEntries.map(({ item }) => item.lang)])]
        .filter((lang) => lang !== "")
        .sort((a, b) => languageLabel(locale, a).localeCompare(languageLabel(locale, b))),
    [installableEntries, locale, pluginLanguageFilter],
  );
  const filterText = availableFilter.trim().toLocaleLowerCase();
  const visibleEntries = installableEntries.filter(
    ({ item }) =>
      (pluginLanguageFilter.length === 0 || pluginLanguageFilter.includes(item.lang)) &&
      (filterText === "" || item.name.toLocaleLowerCase().includes(filterText)),
  );
  const githubSourceTemplate =
    installableEntries.find(({ item }) => isMultiSourcePlugin(item)) ?? null;

  useEffect(() => {
    if (pendingRepoUrl === null) return;
    setRepositoryUrl(pendingRepoUrl);
    setRepositoryDialogOpen(true);
    clearPendingRepoUrl();
  }, [pendingRepoUrl, clearPendingRepoUrl]);

  const focusedPluginLoaded = focusPluginId !== undefined && installedById.has(focusPluginId);
  useEffect(() => {
    if (!focusPluginId || !focusedPluginLoaded) return;
    document.getElementById(extensionRowId(focusPluginId))?.scrollIntoView({ block: "center" });
  }, [focusPluginId, focusedPluginLoaded]);

  const goBack = useCallback((): boolean => {
    if (goBackInAppHistory(currentHref, ["/browse/extensions"])) return true;
    if (openedFromMore) {
      void navigate({ to: "/more", replace: true });
    } else {
      void navigate({ to: "/browse", search: { q: "", tab: "search" }, replace: true });
    }
    return true;
  }, [currentHref, navigate, openedFromMore]);
  usePageBackNavigation(goBack);

  const reloadRepositories = () => {
    void queryClient.invalidateQueries({ queryKey: ["repository"] });
    void queryClient.invalidateQueries({ queryKey: AVAILABLE_QUERY_KEY });
  };

  const saveRepository = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: async (url: string) => {
      const { added } = await enqueueMainTask({
        kind: "repository.add",
        title: t("extensions.repositories.add"),
        subject: { url },
        run: () => addPluginRepository(url),
      }).promise;
      if (!added) throw new Error(t("extensions.repositories.duplicate"));
    },
    onSuccess: () => {
      reloadRepositories();
      setRepositoryUrl("");
      setRepositoryDialogOpen(false);
    },
  });

  const removeRepositoryMutation = useMutation({
    meta: { errorPresentation: "toast" },
    mutationFn: async (id: number) => {
      await enqueueMainTask({
        kind: "repository.remove",
        title: t("extensions.repositories.remove"),
        run: () => removeRepository(id),
      }).promise;
    },
    onSuccess: reloadRepositories,
  });

  const editRepositories = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: (edit: () => Promise<void>) => edit(),
    onSettled: reloadRepositories,
  });
  const toggleRepository = (target: PluginRepository, enabled: boolean) =>
    editRepositories.mutate(() => setRepositoryEnabled(target.id, enabled));
  const moveRepository = (target: PluginRepository, offset: -1 | 1) => {
    const ids = repositories.map((repository) => repository.id);
    const from = ids.indexOf(target.id);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to]!, ids[from]!];
    editRepositories.mutate(() => reorderRepositories(ids));
  };
  const removingRepositoryUrl = removeRepositoryMutation.isPending
    ? repositories.find(({ id }) => id === removeRepositoryMutation.variables)?.url
    : undefined;
  const repositoryStatus = useMemo(() => {
    const pluginCounts = new Map<string, number>();
    for (const { repoUrl } of availableEntries) {
      pluginCounts.set(repoUrl, (pluginCounts.get(repoUrl) ?? 0) + 1);
    }
    const busyUrls = new Set<string>();
    if (refreshingRepoUrl !== null) busyUrls.add(refreshingRepoUrl);
    if (removingRepositoryUrl !== undefined) busyUrls.add(removingRepositoryUrl);
    return {
      pluginCounts,
      failures: new Map(failures.map((failure) => [failure.repoUrl, failure.message])),
      busyUrls,
    };
  }, [availableEntries, failures, refreshingRepoUrl, removingRepositoryUrl]);
  const refreshRepository = (target: PluginRepository) => {
    setRefreshingRepoUrl(target.url);
    refreshAvailablePlugins(queryClient, target.url);
  };

  const install = useMutation({
    mutationFn: ({ item, repoUrl }: AvailableEntry): Promise<Plugin> =>
      enqueueMainTask({
        kind: "plugin.install",
        title: t("tasks.task.installPlugin", { name: item.name }),
        subject: { pluginId: item.id, url: item.url },
        run: () => pluginManager.installPlugin(item, repoUrl),
      }).promise,
    onMutate: ({ item }) => setInstallingPluginIds((ids) => withPendingId(ids, item.id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["plugin"] }),
    onSettled: (_plugin, _error, { item }) =>
      setInstallingPluginIds((ids) => withoutPendingId(ids, item.id)),
  });

  const switchPublisher = useMutation({
    meta: { errorPresentation: "toast" },
    mutationFn: ({ item, plugin, repoUrl }: PluginUpdate): Promise<Plugin> =>
      enqueueMainTask({
        kind: "plugin.install",
        title: t("extensions.updateAction", { name: plugin.name }),
        subject: { pluginId: plugin.id, url: item.url },
        run: () => pluginManager.updatePlugin(plugin.id, item, repoUrl),
      }).promise,
    onMutate: ({ plugin }) => setUpdatingPluginIds((ids) => withPendingId(ids, plugin.id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["plugin"] }),
    onSettled: (_plugin, _error, { plugin }) =>
      setUpdatingPluginIds((ids) => withoutPendingId(ids, plugin.id)),
  });

  const update = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: (targets: readonly PluginUpdate[]) =>
      updatePlugins(targets, async ({ item, plugin, repoUrl }) => {
        try {
          await enqueueMainTask({
            kind: "plugin.install",
            title: t("extensions.updateAction", { name: plugin.name }),
            subject: { pluginId: plugin.id, url: item.url },
            run: () => pluginManager.updatePlugin(plugin.id, item, repoUrl),
          }).promise;
          void queryClient.invalidateQueries({ queryKey: ["plugin"] });
        } finally {
          setUpdatingPluginIds((ids) => withoutPendingId(ids, plugin.id));
        }
      }),
    onMutate: (targets) => {
      setUpdatingPluginIds((ids) => new Set([...ids, ...targets.map(({ plugin }) => plugin.id)]));
      setFailedUpdates((current) => {
        const next = new Map(current);
        for (const { plugin } of targets) next.delete(plugin.id);
        return next;
      });
    },
    onSuccess: (outcomes) => {
      const failed = outcomes.filter((outcome) => outcome.error !== undefined);
      setFailedUpdates((current) => {
        const next = new Map(current);
        for (const { error, plugin } of failed) next.set(plugin.id, error);
        return next;
      });
      if (outcomes.length > 1 && failed.length === 0) {
        showSettingsToast("ok", t("extensions.updatedAll", { count: outcomes.length }));
      }
    },
  });

  const installSource = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: ({ entry, form }: { entry: AvailableEntry; form: SourceInstanceForm }): Promise<Plugin> =>
      enqueueMainTask({
        kind: "plugin.install",
        title: t("tasks.task.installPlugin", { name: form.workTitle }),
        subject: { pluginId: entry.item.id, url: entry.item.url },
        run: () =>
          pluginManager.installPluginInstance(
            entry.item,
            { name: form.workTitle, inputs: sourceInstanceInputs(form) },
            entry.repoUrl,
          ),
      }).promise,
    onMutate: ({ entry }) => setInstallingPluginIds((ids) => withPendingId(ids, entry.item.id)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["plugin"] });
      setSourceTemplate(null);
      setSourceForm(DEFAULT_SOURCE_INSTANCE_FORM);
    },
    onSettled: (_plugin, _error, { entry }) =>
      setInstallingPluginIds((ids) => withoutPendingId(ids, entry.item.id)),
  });

  const installFromFile = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: async (file: File): Promise<Plugin> => {
      if (!file.name.toLowerCase().endsWith(".js")) {
        throw new Error(t("browse.localPlugin.invalidFile"));
      }
      if (file.size > MAX_PLUGIN_SOURCE_FILE_BYTES) {
        throw new Error(
          t("browse.localPlugin.fileTooLarge", { maxSize: MAX_PLUGIN_SOURCE_FILE_SIZE_LABEL }),
        );
      }
      return enqueueMainTask({
        kind: "plugin.install",
        title: t("tasks.task.installPlugin", { name: file.name }),
        subject: { url: localPluginSourceUrl(file) },
        run: async () =>
          pluginManager.installPluginFromSource(await file.text(), localPluginSourceUrl(file)),
      }).promise;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["plugin"] }),
  });

  const uninstall = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      await enqueueMainTask({
        kind: "plugin.uninstall",
        title: t("tasks.task.uninstallPlugin", { name: id }),
        subject: { pluginId: id },
        run: async () => {
          await pluginManager.uninstallPlugin(id);
        },
      }).promise;
    },
    onMutate: (id) => {
      setUninstallingPluginIds((ids) => withPendingId(ids, id));
      if (lastUsedPluginId === id) setLastUsedPluginId(null);
      if (pinnedPluginIds.includes(id)) togglePinnedPlugin(id);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["plugin"] }),
    onSettled: (_result, _error, id) =>
      setUninstallingPluginIds((ids) => withoutPendingId(ids, id)),
  });

  const openRepositoryDialog = () => {
    saveRepository.reset();
    setRepositoryUrl("");
    setRepositoryDialogOpen(true);
  };
  const closeRepositoryDialog = () => {
    setRepositoryDialogOpen(false);
    saveRepository.reset();
  };
  const openSourceForm = (entry: AvailableEntry) => {
    installSource.reset();
    setSourceForm(DEFAULT_SOURCE_INSTANCE_FORM);
    setSourceTemplate(entry);
  };
  const closeSourceForm = () => {
    setSourceTemplate(null);
    installSource.reset();
  };
  const closeRepositoryList = () => {
    setRepositoryListOpen(false);
    editRepositories.reset();
  };

  const confirmRemoveRepository = async (target: PluginRepository) => {
    const confirmed = await confirm({
      title: t("browse.removeRepositoryConfirm.title"),
      message: t("browse.removeRepositoryConfirm.message", { url: target.url }),
      confirmLabel: t("common.remove"),
      danger: true,
    });
    if (confirmed) removeRepositoryMutation.mutate(target.id);
  };

  const confirmUninstall = async (plugin: Plugin) => {
    const confirmed = await confirm({
      title: t("browse.uninstallConfirm.title", { name: plugin.name }),
      message: t("browse.uninstallConfirm.message"),
      confirmLabel: t("browse.uninstall"),
      danger: true,
    });
    if (confirmed) uninstall.mutate(plugin.id);
  };

  return (
    <div className="norea-extensions-page">
      <PageHeader
        actions={
          <>
            <OverflowMenu
              items={[
                {
                  disabled: installFromFile.isPending,
                  icon: ImportIcon,
                  label: t("extensions.installFromFile"),
                  onClick: () => fileInputRef.current?.click(),
                },
                {
                  disabled: githubSourceTemplate === null,
                  icon: GithubIcon,
                  label: t("browse.sourceInstance.title"),
                  onClick: () => {
                    if (githubSourceTemplate) openSourceForm(githubSourceTemplate);
                  },
                },
              ]}
              label={t("common.more")}
            />
            <input
              accept=".js,text/javascript,application/javascript"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0] ?? null;
                event.currentTarget.value = "";
                if (file) installFromFile.mutate(file);
              }}
              ref={fileInputRef}
              tabIndex={-1}
              type="file"
            />
          </>
        }
        onBack={goBack}
        title={t("extensions.title")}
      />

      <PageFrame className="norea-extensions-frame" size="wide">
        {installFromFile.isPending ? (
          <div className="norea-extension-progress" role="status">
            <Loader size="xs" />
            {t("extensions.installingFile")}
          </div>
        ) : installFromFile.error ? (
          <StateView
            color="danger"
            details={{ content: describeError(installFromFile.error), label: t("common.details") }}
            title={t("browse.localPlugin.installFailed")}
          />
        ) : null}

        <RepositoryCard
          error={repos.error}
          loading={repos.isLoading}
          onOpen={() => {
            if (repositories.length === 0) openRepositoryDialog();
            else setRepositoryListOpen(true);
          }}
          onRetry={() => void repos.refetch()}
          repositories={repositories}
        />

        {updates.length > 0 ? (
          <UpdatesSection
            failedUpdates={failedUpdates}
            onUpdate={(target) => update.mutate([target])}
            onUpdateAll={() => update.mutate(updates)}
            updates={updates}
            updatingPluginIds={updatingPluginIds}
          />
        ) : null}

        <InstalledSection
          differentVersions={differentVersions}
          focusPluginId={focusPluginId}
          loading={installed.isLoading}
          locale={locale}
          onOpenSettings={setSettingsPlugin}
          onSwitchPublisher={(target) => switchPublisher.mutate(target)}
          onUninstall={(plugin) => void confirmUninstall(plugin)}
          plugins={installedPlugins}
          publisherOf={installedPluginPublisher}
          publisherOffers={publisherOffers}
          repositoryLabels={repositoryLabels}
          switchingPluginIds={updatingPluginIds}
          uninstallingPluginIds={uninstallingPluginIds}
        />

        <AvailableSection
          entries={visibleEntries}
          failures={failures}
          filter={availableFilter}
          enabledRepositoryCount={enabledRepositories.length}
          repositoryCount={repositories.length}
          repositoryLabels={repositoryLabels}
          installableCount={installableEntries.length}
          installingPluginIds={installingPluginIds}
          languages={availableLanguages}
          listedCount={availableEntries.length}
          loading={available.isLoading || (available.isFetching && availableEntries.length === 0)}
          locale={locale}
          onClearFilters={() => {
            setAvailableFilter("");
            setPluginLanguageFilter([]);
          }}
          onFilterChange={setAvailableFilter}
          onInstall={(entry) => {
            if (isMultiSourcePlugin(entry.item)) openSourceForm(entry);
            else install.mutate(entry);
          }}
          onLanguagesChange={setPluginLanguageFilter}
          onOpenRepositories={() => setRepositoryListOpen(true)}
          onRetry={() => refreshAvailablePlugins(queryClient)}
          onSetRepository={openRepositoryDialog}
          onSetUpSources={() => void navigate({ to: "/setup" })}
          selectedLanguages={pluginLanguageFilter}
        />
      </PageFrame>

      <RepositoriesDialog
        error={editRepositories.error}
        onAdd={openRepositoryDialog}
        onClose={closeRepositoryList}
        onMove={moveRepository}
        onRefresh={refreshRepository}
        onRemove={(target) => void confirmRemoveRepository(target)}
        onToggle={toggleRepository}
        opened={repositoryListOpen}
        repositories={repositories}
        status={repositoryStatus}
      />

      <ResponsiveSheet
        footer={
          <SheetActions>
            <Button onClick={closeRepositoryDialog} variant="default">
              {t("common.cancel")}
            </Button>
            <Button
              disabled={repositoryUrl.trim() === ""}
              form={repositoryFormId}
              loading={saveRepository.isPending}
              type="submit"
            >
              {t("extensions.repositories.addAction")}
            </Button>
          </SheetActions>
        }
        // The add dialog also opens from the repository list.
        nested
        opened={repositoryDialogOpen}
        onClose={closeRepositoryDialog}
        title={t("extensions.repositories.add")}
      >
        <form
          id={repositoryFormId}
          onSubmit={(event) => {
            event.preventDefault();
            const url = repositoryUrl.trim();
            if (url) saveRepository.mutate(url);
          }}
        >
          <Stack gap="sm">
            <TextInput
              autoFocus
              label={t("browse.repositoryUrl")}
              onChange={(event) => setRepositoryUrl(event.currentTarget.value)}
              placeholder={t("browse.repositoryUrlPlaceholder")}
              value={repositoryUrl}
            />
            {saveRepository.error ? (
              <StateView
                color="danger"
                details={{ content: describeError(saveRepository.error), label: t("common.details") }}
                title={t("common.saveFailed")}
              />
            ) : null}
          </Stack>
        </form>
      </ResponsiveSheet>

      <ResponsiveSheet
        footer={
          <SheetActions>
            <Button onClick={closeSourceForm} variant="default">
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!isSourceInstanceFormComplete(sourceForm)}
              form={sourceFormId}
              loading={installSource.isPending}
              type="submit"
            >
              {t("browse.addSource")}
            </Button>
          </SheetActions>
        }
        fullScreenOnPhone
        opened={sourceTemplate !== null}
        onClose={closeSourceForm}
        title={t("browse.sourceInstance.title")}
      >
        <form
          id={sourceFormId}
          onSubmit={(event) => {
            event.preventDefault();
            if (sourceTemplate && isSourceInstanceFormComplete(sourceForm)) {
              installSource.mutate({ entry: sourceTemplate, form: sourceForm });
            }
          }}
        >
          <Stack gap="sm">
            {SOURCE_INSTANCE_FIELDS.map(([field, label, placeholder], index) => (
              <TextInput
                autoFocus={index === 0}
                key={field}
                label={t(label)}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setSourceForm((current) => ({ ...current, [field]: value }));
                }}
                placeholder={t(placeholder)}
                value={sourceForm[field]}
              />
            ))}
            <PasswordInput
              label={t("browse.sourceInstance.token")}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setSourceForm((current) => ({ ...current, token: value }));
              }}
              placeholder={t("browse.sourceInstance.tokenPlaceholder")}
              value={sourceForm.token}
            />
            {installSource.error ? (
              <StateView
                color="danger"
                details={{ content: describeError(installSource.error), label: t("common.details") }}
                title={t("common.saveFailed")}
              />
            ) : null}
          </Stack>
        </form>
      </ResponsiveSheet>

      <PluginSettingsDialog onClose={() => setSettingsPlugin(null)} plugin={settingsPlugin} />
    </div>
  );
}

interface RepositoryCardProps {
  error: unknown;
  loading: boolean;
  onOpen: () => void;
  onRetry: () => void;
  repositories: readonly PluginRepository[];
}

function RepositoryCard({ error, loading, onOpen, onRetry, repositories }: RepositoryCardProps) {
  const { t } = useTranslation();

  if (loading) return <ExtensionRowsSkeleton label={t("common.loading")} />;
  if (error) {
    return (
      <StateView
        action={{ label: t("common.retry"), onClick: onRetry }}
        color="danger"
        details={{ content: describeError(error), label: t("common.details") }}
        title={t("library.databaseError")}
      />
    );
  }

  const enabled = repositories.filter((repository) => repository.enabled).length;
  return (
    <div className="norea-extension-repository">
      <ListRow
        leading={<RepositoryIcon />}
        onClick={onOpen}
        subtitle={
          repositories.length === 0
            ? t("browse.repository.emptyMessage")
            : enabled < repositories.length
              ? t("extensions.repositories.enabledCount", { count: enabled })
              : repositories.map(repositoryLabel).join(", ")
        }
        title={
          repositories.length === 0
            ? t("browse.repository.emptyTitle")
            : t("extensions.repositories.count", { count: repositories.length })
        }
        trailing={repositories.length === 0 ? undefined : <ChevronRightIcon />}
      />
    </div>
  );
}

interface UpdatesSectionProps {
  /** Errors from the last update attempt, by installed plugin id. */
  failedUpdates: ReadonlyMap<string, unknown>;
  onUpdate: (update: PluginUpdate) => void;
  onUpdateAll: () => void;
  updates: readonly PluginUpdate[];
  updatingPluginIds: ReadonlySet<string>;
}

export function UpdatesSection({
  failedUpdates,
  onUpdate,
  onUpdateAll,
  updates,
  updatingPluginIds,
}: UpdatesSectionProps) {
  const { t } = useTranslation();
  const failed = updates.filter(({ plugin }) => failedUpdates.has(plugin.id));

  return (
    <ExtensionSection
      actions={
        updates.length > 1 ? (
          <Indicator label={updates.length} offset={6} size={16}>
            <IconButton
              disabled={updates.every(({ plugin }) => updatingPluginIds.has(plugin.id))}
              label={t("extensions.updateAll", { count: updates.length })}
              onClick={onUpdateAll}
              size="lg"
            >
              <DownloadIcon />
            </IconButton>
          </Indicator>
        ) : undefined
      }
      id="norea-extensions-updates"
      title={t("extensions.updates.title", { count: updates.length })}
    >
      <ul className="norea-extension-list">
        {updates.map((pluginUpdate) => {
          const { item, plugin } = pluginUpdate;
          return (
            <ExtensionRow
              key={plugin.id}
              leading={<PluginIcon plugin={plugin} />}
              subtitle={
                failedUpdates.has(plugin.id)
                  ? `${plugin.version} → ${item.version} · ${t("extensions.updateFailed")}`
                  : `${plugin.version} → ${item.version}`
              }
              title={plugin.name}
              trailing={
                <IconButton
                  label={t("extensions.updateAction", { name: plugin.name })}
                  loading={updatingPluginIds.has(plugin.id)}
                  onClick={() => onUpdate(pluginUpdate)}
                  size="lg"
                >
                  {failedUpdates.has(plugin.id) ? <RetryIcon /> : <DownloadIcon />}
                </IconButton>
              }
            />
          );
        })}
      </ul>
      {failed.length > 0 ? (
        <StateView
          color="danger"
          details={{
            content: failed
              .map(({ plugin }) => `${plugin.name}: ${describeError(failedUpdates.get(plugin.id))}`)
              .join("\n"),
            label: t("common.details"),
          }}
          message={t("extensions.updateFailedMessage")}
          title={t("extensions.updateFailedTitle", { count: failed.length })}
        />
      ) : null}
    </ExtensionSection>
  );
}

interface InstalledSectionProps {
  /** Repository versions that are lower or cannot be ordered, by plugin id. */
  differentVersions: ReadonlyMap<string, string>;
  focusPluginId?: string;
  loading: boolean;
  locale: AppLocale;
  onOpenSettings: (plugin: Plugin) => void;
  onSwitchPublisher: (target: PluginUpdate) => void;
  onUninstall: (plugin: Plugin) => void;
  plugins: readonly Plugin[];
  publisherOf: PluginPublisherLookup;
  /** Repositories other than the publisher that offer a plugin, by plugin id. */
  publisherOffers: ReadonlyMap<string, readonly AvailableEntry[]>;
  repositoryLabels: ReadonlyMap<string, string>;
  switchingPluginIds: ReadonlySet<string>;
  uninstallingPluginIds: ReadonlySet<string>;
}

export function InstalledSection({
  differentVersions,
  focusPluginId,
  loading,
  locale,
  onOpenSettings,
  onSwitchPublisher,
  onUninstall,
  plugins,
  publisherOf,
  publisherOffers,
  repositoryLabels,
  switchingPluginIds,
  uninstallingPluginIds,
}: InstalledSectionProps) {
  const { t } = useTranslation();
  const labelOf = (repoUrl: string) => repositoryLabels.get(repoUrl) ?? repoUrl;
  const subtitleOf = (plugin: Plugin): string => {
    const parts = [pluginMeta(locale, plugin)];
    const offers = publisherOffers.get(plugin.id) ?? [];
    if (publisherOf(plugin.id) === null) {
      if (offers.length > 0) parts.push(t("extensions.publisher.unknown"));
    } else {
      const different = differentVersions.get(plugin.id);
      if (different !== undefined) {
        parts.push(t("extensions.differentVersion", { version: different }));
      }
      const newer = offers.find(({ item }) => comparePluginVersions(item.version, plugin.version) === "newer");
      if (newer) {
        parts.push(t("extensions.publisher.alsoAvailable", {
          repository: labelOf(newer.repoUrl),
          version: newer.item.version,
        }));
      }
    }
    return parts.join(" · ");
  };

  return (
    <ExtensionSection
      id="norea-extensions-installed"
      title={t("extensions.installed.title", { count: plugins.length })}
    >
      {loading ? (
        <ExtensionRowsSkeleton label={t("common.loading")} />
      ) : plugins.length === 0 ? (
        <StateView
          title={t("browse.noInstalledPlugins.title")}
          message={t("browse.noInstalledPlugins.message")}
        />
      ) : (
        <ul className="norea-extension-list">
          {plugins.map((plugin) => (
            <ExtensionRow
              current={plugin.id === focusPluginId}
              id={extensionRowId(plugin.id)}
              key={plugin.id}
              leading={<PluginIcon plugin={plugin} />}
              subtitle={subtitleOf(plugin)}
              title={plugin.name}
              trailing={
                uninstallingPluginIds.has(plugin.id) || switchingPluginIds.has(plugin.id) ? (
                  <span
                    aria-label={
                      uninstallingPluginIds.has(plugin.id)
                        ? t("extensions.uninstalling", { name: plugin.name })
                        : t("extensions.updateAction", { name: plugin.name })
                    }
                    className="norea-extension-busy"
                    role="status"
                  >
                    <Loader aria-hidden="true" size="xs" />
                  </span>
                ) : (
                  <>
                    {publisherOf(plugin.id) === null && publisherOffers.has(plugin.id) ? (
                      <OverflowMenu
                        items={publisherOffers.get(plugin.id)!.map((offer) => ({
                          icon: RepositoryIcon,
                          label: t("extensions.publisher.useRepository", {
                            repository: labelOf(offer.repoUrl),
                            version: offer.item.version,
                          }),
                          onClick: () => onSwitchPublisher({ ...offer, plugin }),
                        }))}
                        label={t("extensions.publisher.choose")}
                        trigger={
                          <IconButton
                            label={`${t("extensions.publisher.choose")}: ${plugin.name}`}
                            size="lg"
                          >
                            <RepositoryIcon />
                          </IconButton>
                        }
                      />
                    ) : null}
                  <OverflowMenu
                    items={[
                      ...(hasPluginInputs(plugin)
                        ? [{ icon: SettingsIcon, label: t("common.settings"), onClick: () => onOpenSettings(plugin) }]
                        : []),
                      ...(publisherOf(plugin.id) === null
                        ? []
                        : (publisherOffers.get(plugin.id) ?? []).map((offer) => ({
                            icon: RepositoryIcon,
                            label: t("extensions.publisher.switch", {
                              repository: labelOf(offer.repoUrl),
                              version: offer.item.version,
                            }),
                            onClick: () => onSwitchPublisher({ ...offer, plugin }),
                          }))),
                      {
                        danger: true,
                        icon: TrashIcon,
                        label: t("browse.uninstall"),
                        onClick: () => onUninstall(plugin),
                      },
                    ]}
                    label={t("extensions.rowActions", { name: plugin.name })}
                  />
                  </>
                )
              }
            />
          ))}
        </ul>
      )}
    </ExtensionSection>
  );
}

interface AvailableSectionProps {
  enabledRepositoryCount: number;
  entries: readonly AvailableEntry[];
  failures: readonly RepoFetchFailure[];
  filter: string;
  installableCount: number;
  installingPluginIds: ReadonlySet<string>;
  languages: readonly string[];
  /** Plugins the repository lists, installed or not. */
  listedCount: number;
  loading: boolean;
  locale: AppLocale;
  onClearFilters: () => void;
  onFilterChange: (filter: string) => void;
  onInstall: (entry: AvailableEntry) => void;
  onLanguagesChange: (languages: string[]) => void;
  onOpenRepositories: () => void;
  onRetry: () => void;
  onSetRepository: () => void;
  onSetUpSources: () => void;
  repositoryCount: number;
  repositoryLabels: ReadonlyMap<string, string>;
  selectedLanguages: readonly string[];
}

export function AvailableSection({
  enabledRepositoryCount,
  entries,
  failures,
  filter,
  installableCount,
  installingPluginIds,
  languages,
  listedCount,
  loading,
  locale,
  onClearFilters,
  onFilterChange,
  onInstall,
  onLanguagesChange,
  onOpenRepositories,
  onRetry,
  onSetRepository,
  onSetUpSources,
  repositoryCount,
  repositoryLabels,
  selectedLanguages,
}: AvailableSectionProps) {
  const { t } = useTranslation();
  const hasRepository = enabledRepositoryCount > 0;
  const labelOf = (repoUrl: string) =>
    enabledRepositoryCount > 1 ? (repositoryLabels.get(repoUrl) ?? repoUrl) : null;
  const toggleLanguage = (lang: string) =>
    onLanguagesChange(
      selectedLanguages.includes(lang)
        ? selectedLanguages.filter((selected) => selected !== lang)
        : [...selectedLanguages, lang],
    );

  return (
    <ExtensionSection
      id="norea-extensions-available"
      title={t("extensions.available.title", { count: installableCount })}
    >
      {hasRepository && installableCount > 0 ? (
        <div className="norea-extension-filters">
          <TextInput
            aria-label={t("extensions.available.filter")}
            onChange={(event) => onFilterChange(event.currentTarget.value)}
            placeholder={t("extensions.available.filter")}
            value={filter}
          />
          <div
            aria-label={t("browse.pluginLanguages.label")}
            className="norea-browse-chips"
            role="group"
          >
            <ChipButton onClick={() => onLanguagesChange([])} selected={selectedLanguages.length === 0}>
              {t("common.all")}
            </ChipButton>
            {languages.map((lang) => (
              <ChipButton key={lang} onClick={() => toggleLanguage(lang)} selected={selectedLanguages.includes(lang)}>
                {languageLabel(locale, lang)}
              </ChipButton>
            ))}
          </div>
        </div>
      ) : null}

      {failures.map((failure) => (
        <StateView
          action={{ label: t("common.retry"), onClick: onRetry }}
          color="danger"
          details={{ content: failure.message, label: t("common.details") }}
          key={failure.repoUrl}
          message={labelOf(failure.repoUrl) ?? undefined}
          title={t("browse.repositoryFetchError")}
        />
      ))}

      {repositoryCount === 0 ? (
        <StateView
          action={{ label: t("extensions.repositories.add"), onClick: onSetRepository }}
          message={t("browse.noAvailablePlugins.noRepository")}
          secondaryAction={{ label: t("setup.entry"), onClick: onSetUpSources }}
          title={t("browse.noAvailablePlugins.title")}
        />
      ) : !hasRepository ? (
        <StateView
          action={{ label: t("extensions.repositories.title"), onClick: onOpenRepositories }}
          message={t("extensions.repositories.allOff")}
          title={t("browse.noAvailablePlugins.title")}
        />
      ) : loading ? (
        <ExtensionRowsSkeleton label={t("browse.fetchingRepositoryIndex")} />
      ) : entries.length > 0 ? (
        <ul className="norea-extension-list">
          {entries.map((entry) => {
            const { item, repoUrl } = entry;
            const label = isMultiSourcePlugin(item)
              ? t("extensions.addSourceAction", { name: item.name })
              : t("extensions.installAction", { name: item.name });
            const repository = labelOf(repoUrl);
            const meta = isMultiSourcePlugin(item)
              ? languageLabel(locale, item.lang)
              : pluginMeta(locale, item);
            return (
              <ExtensionRow
                key={`${repoUrl}::${item.id}`}
                leading={<PluginIcon plugin={item} />}
                subtitle={repository ? `${meta} · ${repository}` : meta}
                title={item.name}
                trailing={
                  <IconButton
                    label={label}
                    loading={installingPluginIds.has(item.id)}
                    onClick={() => onInstall(entry)}
                    size="lg"
                  >
                    {isMultiSourcePlugin(item) ? <PlusIcon /> : <DownloadIcon />}
                  </IconButton>
                }
              />
            );
          })}
        </ul>
      ) : installableCount > 0 ? (
        <StateView
          action={{ label: t("extensions.available.clearFilters"), onClick: onClearFilters }}
          message={t("extensions.available.noMatchesMessage")}
          title={t("common.noMatches")}
        />
      ) : listedCount > 0 ? (
        <StateView title={t("extensions.available.allInstalled")} />
      ) : failures.length === 0 ? (
        <StateView
          message={t("browse.noAvailablePlugins.empty")}
          title={t("browse.noAvailablePlugins.title")}
        />
      ) : null}
    </ExtensionSection>
  );
}
