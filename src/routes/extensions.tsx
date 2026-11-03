import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Button,
  Group,
  Loader,
  Modal,
  PasswordInput,
  Skeleton,
  Stack,
  TextInput,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { PageFrame, StateView } from "../components/AppFrame";
import { IconButton } from "../components/IconButton";
import { PluginIcon } from "../components/browse/PluginIcon";
import { PluginSettingsDialog } from "../components/browse/PluginSettingsDialog";
import {
  AVAILABLE_QUERY_KEY,
  findPluginUpdates,
  hasPluginInputs,
  isMultiSourcePlugin,
  refreshAvailablePlugins,
  sortPluginsByName,
  useAvailablePlugins,
  useInstalledPlugins,
  useRepositories,
  type AvailableEntry,
  type AvailableResult,
  type PluginUpdate,
  type RepoFetchFailure,
} from "../components/browse/use-plugin-catalog";
import { useConfirm } from "../components/ui/ConfirmDialog";
import {
  BackIcon,
  CheckIcon,
  GithubIcon,
  ImportIcon,
  RefreshIcon,
  RepositoryIcon,
  SettingsIcon,
  TrashIcon,
} from "../components/ui/icons";
import { ListRow } from "../components/ui/ListRow";
import { OverflowMenu } from "../components/ui/OverflowMenu";
import {
  removeRepository,
  upsertRepository,
  type PluginRepository,
} from "../db/queries/repository";
import {
  formatPluginLanguageForLocale,
  useTranslation,
  type AppLocale,
} from "../i18n";
import {
  useOverlayBackNavigation,
  usePageBackNavigation,
} from "../lib/android-back-navigation";
import { describeError } from "../lib/errors";
import {
  findPreviousAppHistoryEntry,
  trimAppNavigationHistoryTo,
} from "../lib/navigation-history";
import { pluginManager } from "../lib/plugins/manager";
import { clearSourceFilterStorage } from "../lib/plugins/source-filter-storage";
import type { Plugin, PluginItem } from "../lib/plugins/types";
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
  const desktop = useMediaQuery("(min-width: 768px)", undefined, {
    getInitialValueInEffect: false,
  });
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

  const [repositoryDialogOpen, setRepositoryDialogOpen] = useState(false);
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [settingsPlugin, setSettingsPlugin] = useState<Plugin | null>(null);
  const [sourceTemplate, setSourceTemplate] = useState<PluginItem | null>(null);
  const [sourceForm, setSourceForm] = useState<SourceInstanceForm>(DEFAULT_SOURCE_INSTANCE_FORM);
  const [availableFilter, setAvailableFilter] = useState("");
  const [installingPluginIds, setInstallingPluginIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [uninstallingPluginIds, setUninstallingPluginIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const repository = repos.data?.[0] ?? null;
  const installedPlugins = useMemo(() => sortPluginsByName(installed.data ?? []), [installed.data]);
  const installedById = useMemo(
    () => new Map(installedPlugins.map((plugin) => [plugin.id, plugin])),
    [installedPlugins],
  );
  const availableEntries = useMemo(
    () => (repository ? (available.data?.entries ?? []) : []),
    [available.data, repository],
  );
  const failures = repository ? (available.data?.failures ?? []) : [];
  const updates = useMemo(
    () => findPluginUpdates(installedPlugins, availableEntries),
    [availableEntries, installedPlugins],
  );
  const installableEntries = useMemo(
    () =>
      availableEntries
        .filter(({ item }) => isMultiSourcePlugin(item) || !installedById.has(item.id))
        .sort((a, b) => a.item.name.localeCompare(b.item.name)),
    [availableEntries, installedById],
  );
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
    installableEntries.find(({ item }) => isMultiSourcePlugin(item))?.item ?? null;

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
    const target = findPreviousAppHistoryEntry(currentHref, ["/browse/extensions"]);
    if (target) {
      trimAppNavigationHistoryTo(target);
      window.history.go(-target.steps);
      return true;
    }
    void navigate({ to: "/browse", search: { q: "", tab: "sources" }, replace: true });
    return true;
  }, [currentHref, navigate]);
  usePageBackNavigation(goBack);

  const resetRepositoryState = () => {
    clearSourceFilterStorage();
    setPluginLanguageFilter([]);
    queryClient.setQueryData<AvailableResult>(AVAILABLE_QUERY_KEY, { entries: [], failures: [] });
    void queryClient.invalidateQueries({ queryKey: ["repository"] });
    void queryClient.invalidateQueries({ queryKey: AVAILABLE_QUERY_KEY });
  };

  const saveRepository = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: async (url: string) => {
      await enqueueMainTask({
        kind: "repository.add",
        title: repository ? t("browse.changeRepository") : t("browse.setRepository"),
        subject: { url },
        run: () => upsertRepository({ url }),
      }).promise;
    },
    onSuccess: () => {
      resetRepositoryState();
      setRepositoryUrl("");
      setRepositoryDialogOpen(false);
    },
  });

  const removeRepositoryMutation = useMutation({
    meta: { errorPresentation: "toast" },
    mutationFn: async (id: number) => {
      await enqueueMainTask({
        kind: "repository.remove",
        title: t("browse.changeRepository"),
        run: () => removeRepository(id),
      }).promise;
    },
    onSuccess: resetRepositoryState,
  });

  const install = useMutation({
    mutationFn: (item: PluginItem): Promise<Plugin> =>
      enqueueMainTask({
        kind: "plugin.install",
        title: t("tasks.task.installPlugin", { name: item.name }),
        subject: { pluginId: item.id, url: item.url },
        run: () => pluginManager.installPlugin(item),
      }).promise,
    onMutate: (item) => setInstallingPluginIds((ids) => withPendingId(ids, item.id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["plugin"] }),
    onSettled: (_plugin, _error, item) =>
      setInstallingPluginIds((ids) => withoutPendingId(ids, item.id)),
  });

  const installSource = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: ({ item, form }: { item: PluginItem; form: SourceInstanceForm }): Promise<Plugin> =>
      enqueueMainTask({
        kind: "plugin.install",
        title: t("tasks.task.installPlugin", { name: form.workTitle }),
        subject: { pluginId: item.id, url: item.url },
        run: () =>
          pluginManager.installPluginInstance(item, {
            name: form.workTitle,
            inputs: sourceInstanceInputs(form),
          }),
      }).promise,
    onMutate: ({ item }) => setInstallingPluginIds((ids) => withPendingId(ids, item.id)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["plugin"] });
      setSourceTemplate(null);
      setSourceForm(DEFAULT_SOURCE_INSTANCE_FORM);
    },
    onSettled: (_plugin, _error, { item }) =>
      setInstallingPluginIds((ids) => withoutPendingId(ids, item.id)),
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
    setRepositoryUrl(repository?.url ?? "");
    setRepositoryDialogOpen(true);
  };
  const closeRepositoryDialog = () => {
    setRepositoryDialogOpen(false);
    saveRepository.reset();
  };
  const openSourceForm = (item: PluginItem) => {
    installSource.reset();
    setSourceForm(DEFAULT_SOURCE_INSTANCE_FORM);
    setSourceTemplate(item);
  };
  const closeSourceForm = () => {
    setSourceTemplate(null);
    installSource.reset();
  };
  useOverlayBackNavigation(repositoryDialogOpen, closeRepositoryDialog);
  useOverlayBackNavigation(sourceTemplate !== null, closeSourceForm);

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
      <header className="norea-browse-app-bar">
        <IconButton label={t("common.back")} onClick={goBack} size="lg">
          <BackIcon />
        </IconButton>
        <h1 className="norea-browse-app-bar-title">{t("extensions.title")}</h1>
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
      </header>

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
          onEdit={openRepositoryDialog}
          onRefresh={() => refreshAvailablePlugins(queryClient)}
          onRemove={(target) => void confirmRemoveRepository(target)}
          onRetry={() => void repos.refetch()}
          refreshing={available.isFetching}
          removing={removeRepositoryMutation.isPending}
          repository={repository}
        />

        {updates.length > 0 ? (
          <UpdatesSection
            installingPluginIds={installingPluginIds}
            onUpdate={(item) => install.mutate(item)}
            updates={updates}
          />
        ) : null}

        <InstalledSection
          focusPluginId={focusPluginId}
          loading={installed.isLoading}
          locale={locale}
          onOpenSettings={setSettingsPlugin}
          onUninstall={(plugin) => void confirmUninstall(plugin)}
          plugins={installedPlugins}
          uninstallingPluginIds={uninstallingPluginIds}
        />

        <AvailableSection
          entries={visibleEntries}
          failures={failures}
          filter={availableFilter}
          hasRepository={repository !== null}
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
          onInstall={(item) => {
            if (isMultiSourcePlugin(item)) openSourceForm(item);
            else install.mutate(item);
          }}
          onLanguagesChange={setPluginLanguageFilter}
          onRetry={() => refreshAvailablePlugins(queryClient)}
          onSetRepository={openRepositoryDialog}
          onSetUpSources={() => void navigate({ to: "/setup" })}
          selectedLanguages={pluginLanguageFilter}
        />
      </PageFrame>

      <Modal
        opened={repositoryDialogOpen}
        onClose={closeRepositoryDialog}
        title={repository ? t("browse.changeRepository") : t("browse.setRepository")}
      >
        <form
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
            <Group gap="xs" justify="flex-end">
              <Button onClick={closeRepositoryDialog} variant="default">
                {t("common.cancel")}
              </Button>
              <Button
                disabled={repositoryUrl.trim() === ""}
                loading={saveRepository.isPending}
                type="submit"
              >
                {t("common.save")}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      <Modal
        fullScreen={!desktop}
        opened={sourceTemplate !== null}
        onClose={closeSourceForm}
        size="lg"
        title={t("browse.sourceInstance.title")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (sourceTemplate && isSourceInstanceFormComplete(sourceForm)) {
              installSource.mutate({ item: sourceTemplate, form: sourceForm });
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
            <Group gap="xs" justify="flex-end">
              <Button onClick={closeSourceForm} variant="default">
                {t("common.cancel")}
              </Button>
              <Button
                disabled={!isSourceInstanceFormComplete(sourceForm)}
                loading={installSource.isPending}
                type="submit"
              >
                {t("browse.addSource")}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      <PluginSettingsDialog onClose={() => setSettingsPlugin(null)} plugin={settingsPlugin} />
    </div>
  );
}

interface RepositoryCardProps {
  error: unknown;
  loading: boolean;
  onEdit: () => void;
  onRefresh: () => void;
  onRemove: (repository: PluginRepository) => void;
  onRetry: () => void;
  refreshing: boolean;
  removing: boolean;
  repository: PluginRepository | null;
}

function RepositoryCard({
  error,
  loading,
  onEdit,
  onRefresh,
  onRemove,
  onRetry,
  refreshing,
  removing,
  repository,
}: RepositoryCardProps) {
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

  return (
    <div className="norea-extension-repository">
      <ListRow
        leading={<RepositoryIcon />}
        onClick={onEdit}
        subtitle={
          repository
            ? t("browse.repository.title")
            : t("browse.repository.emptyMessage")
        }
        title={
          repository
            ? (repository.name ?? repository.url)
            : t("browse.repository.emptyTitle")
        }
      />
      {repository ? (
        <span className="norea-extension-row-trailing">
          {refreshing || removing ? (
            <span
              aria-label={refreshing ? t("browse.fetchingRepositoryIndex") : t("extensions.removingRepository")}
              className="norea-extension-busy"
              role="status"
            >
              <Loader aria-hidden="true" size="xs" />
            </span>
          ) : (
            <OverflowMenu
              items={[
                { icon: RefreshIcon, label: t("common.refresh"), onClick: onRefresh },
                {
                  danger: true,
                  icon: TrashIcon,
                  label: t("common.remove"),
                  onClick: () => onRemove(repository),
                },
              ]}
              label={t("extensions.repositoryActions")}
            />
          )}
        </span>
      ) : null}
    </div>
  );
}

interface UpdatesSectionProps {
  installingPluginIds: ReadonlySet<string>;
  onUpdate: (item: PluginItem) => void;
  updates: readonly PluginUpdate[];
}

export function UpdatesSection({ installingPluginIds, onUpdate, updates }: UpdatesSectionProps) {
  const { t } = useTranslation();

  return (
    <ExtensionSection
      id="norea-extensions-updates"
      title={t("extensions.updates.title", { count: updates.length })}
    >
      <ul className="norea-extension-list">
        {updates.map(({ item, plugin }) => (
          <ExtensionRow
            key={plugin.id}
            leading={<PluginIcon plugin={plugin} />}
            subtitle={`${plugin.version} → ${item.version}`}
            title={plugin.name}
            trailing={
              <Button
                aria-label={t("extensions.updateAction", { name: plugin.name })}
                loading={installingPluginIds.has(item.id)}
                onClick={() => onUpdate(item)}
                size="compact-sm"
                variant="light"
              >
                {t("extensions.update")}
              </Button>
            }
          />
        ))}
      </ul>
    </ExtensionSection>
  );
}

interface InstalledSectionProps {
  focusPluginId?: string;
  loading: boolean;
  locale: AppLocale;
  onOpenSettings: (plugin: Plugin) => void;
  onUninstall: (plugin: Plugin) => void;
  plugins: readonly Plugin[];
  uninstallingPluginIds: ReadonlySet<string>;
}

export function InstalledSection({
  focusPluginId,
  loading,
  locale,
  onOpenSettings,
  onUninstall,
  plugins,
  uninstallingPluginIds,
}: InstalledSectionProps) {
  const { t } = useTranslation();

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
              subtitle={pluginMeta(locale, plugin)}
              title={plugin.name}
              trailing={
                uninstallingPluginIds.has(plugin.id) ? (
                  <span
                    aria-label={t("extensions.uninstalling", { name: plugin.name })}
                    className="norea-extension-busy"
                    role="status"
                  >
                    <Loader aria-hidden="true" size="xs" />
                  </span>
                ) : (
                  <OverflowMenu
                    items={[
                      ...(hasPluginInputs(plugin)
                        ? [{ icon: SettingsIcon, label: t("common.settings"), onClick: () => onOpenSettings(plugin) }]
                        : []),
                      {
                        danger: true,
                        icon: TrashIcon,
                        label: t("browse.uninstall"),
                        onClick: () => onUninstall(plugin),
                      },
                    ]}
                    label={t("extensions.rowActions", { name: plugin.name })}
                  />
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
  entries: readonly AvailableEntry[];
  failures: readonly RepoFetchFailure[];
  filter: string;
  hasRepository: boolean;
  installableCount: number;
  installingPluginIds: ReadonlySet<string>;
  languages: readonly string[];
  /** Plugins the repository lists, installed or not. */
  listedCount: number;
  loading: boolean;
  locale: AppLocale;
  onClearFilters: () => void;
  onFilterChange: (filter: string) => void;
  onInstall: (item: PluginItem) => void;
  onLanguagesChange: (languages: string[]) => void;
  onRetry: () => void;
  onSetRepository: () => void;
  onSetUpSources: () => void;
  selectedLanguages: readonly string[];
}

export function AvailableSection({
  entries,
  failures,
  filter,
  hasRepository,
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
  onRetry,
  onSetRepository,
  onSetUpSources,
  selectedLanguages,
}: AvailableSectionProps) {
  const { t } = useTranslation();
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
            <Button
              aria-pressed={selectedLanguages.length === 0}
              leftSection={selectedLanguages.length === 0 ? <CheckIcon size="1rem" /> : undefined}
              onClick={() => onLanguagesChange([])}
              radius="xl"
              size="compact-sm"
              variant={selectedLanguages.length === 0 ? "light" : "default"}
            >
              {t("common.all")}
            </Button>
            {languages.map((lang) => {
              const active = selectedLanguages.includes(lang);
              return (
                <Button
                  aria-pressed={active}
                  key={lang}
                  leftSection={active ? <CheckIcon size="1rem" /> : undefined}
                  onClick={() => toggleLanguage(lang)}
                  radius="xl"
                  size="compact-sm"
                  variant={active ? "light" : "default"}
                >
                  {languageLabel(locale, lang)}
                </Button>
              );
            })}
          </div>
        </div>
      ) : null}

      {failures.map((failure) => (
        <StateView
          action={{ label: t("common.retry"), onClick: onRetry }}
          color="danger"
          details={{ content: failure.message, label: t("common.details") }}
          key={failure.repoUrl}
          title={t("browse.repositoryFetchError")}
        />
      ))}

      {!hasRepository ? (
        <StateView
          action={{ label: t("browse.setRepository"), onClick: onSetRepository }}
          message={t("browse.noAvailablePlugins.noRepository")}
          secondaryAction={{ label: t("setup.entry"), onClick: onSetUpSources }}
          title={t("browse.noAvailablePlugins.title")}
        />
      ) : loading ? (
        <ExtensionRowsSkeleton label={t("browse.fetchingRepositoryIndex")} />
      ) : entries.length > 0 ? (
        <ul className="norea-extension-list">
          {entries.map(({ item, repoUrl }) => {
            const label = isMultiSourcePlugin(item) ? t("browse.addSource") : t("common.install");
            return (
              <ExtensionRow
                key={`${repoUrl}::${item.id}`}
                leading={<PluginIcon plugin={item} />}
                subtitle={
                  isMultiSourcePlugin(item)
                    ? languageLabel(locale, item.lang)
                    : pluginMeta(locale, item)
                }
                title={item.name}
                trailing={
                  <Button
                    aria-label={`${label}: ${item.name}`}
                    loading={installingPluginIds.has(item.id)}
                    onClick={() => onInstall(item)}
                    size="compact-sm"
                    variant="light"
                  >
                    {label}
                  </Button>
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
