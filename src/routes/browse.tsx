import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Anchor,
  Badge,
  Box,
  Group,
  Loader,
  Modal,
  MultiSelect,
  PasswordInput,
  Stack,
  Tabs,
  Text,
  TextInput,
} from "@mantine/core";
import {
  CheckGlyph,
  ClockGlyph,
  DetailsGlyph,
  EditGlyph,
  ExternalLinkGlyph,
  PlusGlyph,
  RefreshGlyph,
  RepositoryGlyph,
  SettingsGlyph,
  TrashGlyph,
} from "../components/ActionGlyphs";
import { PageFrame, PageHeader, StateView } from "../components/AppFrame";
import {
  ConsoleChip,
  ConsolePanel,
} from "../components/ConsolePrimitives";
import { IconButton } from "../components/IconButton";
import { PluginSettingsEditor } from "../components/PluginSettingsEditor";
import { TextButton } from "../components/TextButton";
import {
  getCachedRepoIndex,
  setCachedRepoIndex,
} from "../db/queries/repo-index-cache";
import {
  formatPluginLanguageForLocale,
  useTranslation,
  type AppLocale,
} from "../i18n";
import {
  listRepositories,
  removeRepository,
  upsertRepository,
  type PluginRepository,
} from "../db/queries/repository";
import { isTauriRuntime } from "../lib/tauri-runtime";
import { enqueueMainTask } from "../lib/tasks/main-tasks";
import { enqueueOpenSiteTask } from "../lib/tasks/source-tasks";
import { PluginSearchSection } from "./global-search";
import { getPluginBaseUrl } from "../lib/plugins/base-url";
import { isValidPluginItem, pluginManager } from "../lib/plugins/manager";
import { clearSourceFilterStorage } from "../lib/plugins/source-filter-storage";
import type { Plugin, PluginItem } from "../lib/plugins/types";
import { useBrowseStore } from "../store/browse";

const REPO_QUERY_KEY = ["repository", "list"] as const;
const AVAILABLE_QUERY_KEY = ["plugin", "available"] as const;
const INSTALLED_QUERY_KEY = ["plugin", "installed"] as const;
const MAX_PLUGIN_SOURCE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PLUGIN_SOURCE_FILE_SIZE_LABEL = "5 MiB";

export type BrowseTab = "search" | "sources";

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

function localPluginSourceUrl(file: File): string {
  const safeName = file.name.trim().replace(/[\r\n]/g, " ") || "plugin.js";
  return `local:${encodeURIComponent(safeName)}`;
}

function isMultiSourcePlugin(item: PluginItem): boolean {
  return item.installMode === "multiSource";
}

function sourceInstanceFormFor(): SourceInstanceForm {
  return { ...DEFAULT_SOURCE_INSTANCE_FORM };
}

function sourceInstanceInputs(
  form: SourceInstanceForm,
): Record<string, string> {
  return {
    workTitle: form.workTitle.trim(),
    repository: form.repository.trim(),
    ref: form.ref.trim(),
    workRoot: form.workRoot.trim(),
    chapterFilePattern: form.chapterFilePattern.trim(),
    chapterExcludePattern: form.chapterExcludePattern.trim(),
    token: form.token.trim(),
  };
}

interface AvailableEntry {
  item: PluginItem;
  repoUrl: string;
}

interface RepoFetchFailure {
  repoUrl: string;
  message: string;
}

interface AvailableResult {
  entries: AvailableEntry[];
  failures: RepoFetchFailure[];
}

interface BrowsePageProps {
  active?: boolean;
  query?: string;
  tab?: BrowseTab;
}

interface LanguageOption {
  value: string;
  label: string;
}

function makeLanguageOptions(
  plugins: readonly PluginItem[],
  selectedLanguages: readonly string[],
  locale: AppLocale,
): LanguageOption[] {
  const languages = [
    ...selectedLanguages.filter(isNonEmptyString),
    ...plugins.map((p) => p.lang).filter(isNonEmptyString),
  ];
  return [...new Set(languages)]
    .sort((a, b) =>
      formatPluginLanguageForLocale(locale, a).localeCompare(
        formatPluginLanguageForLocale(locale, b),
      ),
    )
    .map((lang) => ({
      value: lang,
      label: `${formatPluginLanguageForLocale(locale, lang)} (${lang})`,
    }));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function filterByLanguage<T extends PluginItem>(
  plugins: readonly T[],
  languages: readonly string[],
): T[] {
  if (languages.length === 0) return [...plugins];
  return plugins.filter(
    (plugin) =>
      isNonEmptyString(plugin.lang) && languages.includes(plugin.lang),
  );
}

function debugRepositoryFlow(message: string, data?: unknown): void {
  console.debug("[browse:repository]", message, data);
}

function sortByName<T extends PluginItem>(plugins: readonly T[]): T[] {
  return [...plugins].sort((a, b) =>
    (a.name ?? a.id).localeCompare(b.name ?? b.id),
  );
}

function sortEntriesByName(entries: readonly AvailableEntry[]): AvailableEntry[] {
  return [...entries].sort((a, b) =>
    (a.item.name ?? a.item.id).localeCompare(b.item.name ?? b.item.id),
  );
}

/**
 * Cache-first index loader.
 *
 * `forceRefresh=false` (default Browse mount, query refetch):
 *   Per repo, return the cached items if any. If no cache row
 *   exists yet for a repo (first-ever load), do a single network
 *   fetch + write the cache so it's instant from then on. Already-
 *   cached repos NEVER hit the network on tab open.
 *
 * `forceRefresh=true` (the Refresh button):
 *   Always re-fetch from network and overwrite the cache.
 */
async function fetchAllAvailable(
  repos: readonly PluginRepository[],
  forceRefresh: boolean,
): Promise<AvailableResult> {
  debugRepositoryFlow("available fetch start", {
    forceRefresh,
    repositoryCount: repos.length,
  });
  const entries: AvailableEntry[] = [];
  const failures: RepoFetchFailure[] = [];
  for (const repo of repos) {
    try {
      debugRepositoryFlow("available repo start", {
        repoId: repo.id,
        repoUrl: repo.url,
        forceRefresh,
      });
      let items: PluginItem[] | null = null;
      if (!forceRefresh) {
        const cached = await getCachedRepoIndex(repo.url);
        if (cached) {
          items = cached.items.filter(isValidPluginItem);
          debugRepositoryFlow("available repo cache hit", {
            repoId: repo.id,
            repoUrl: repo.url,
            itemCount: items.length,
          });
        } else {
          debugRepositoryFlow("available repo cache miss", {
            repoId: repo.id,
            repoUrl: repo.url,
          });
        }
      }
      if (items === null) {
        debugRepositoryFlow("available repo network fetch start", {
          repoId: repo.id,
          repoUrl: repo.url,
        });
        items = await pluginManager.fetchRepository(repo.url);
        debugRepositoryFlow("available repo network fetch complete", {
          repoId: repo.id,
          repoUrl: repo.url,
          itemCount: items.length,
        });
        await setCachedRepoIndex(repo.url, items);
        debugRepositoryFlow("available repo cache write complete", {
          repoId: repo.id,
          repoUrl: repo.url,
        });
      }
      for (const item of items) {
        entries.push({ item, repoUrl: repo.url });
      }
      debugRepositoryFlow("available repo complete", {
        repoId: repo.id,
        repoUrl: repo.url,
        itemCount: items.length,
      });
    } catch (error) {
      console.warn("[browse:repository] available repo failed", {
        repoId: repo.id,
        repoUrl: repo.url,
        error,
      });
      failures.push({
        repoUrl: repo.url,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  debugRepositoryFlow("available fetch complete", {
    entryCount: entries.length,
    failureCount: failures.length,
  });
  return { entries, failures };
}

export function BrowsePage({
  active = true,
  query: q = "",
  tab = "search",
}: BrowsePageProps) {
  const { locale, t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const repos = useQuery({
    queryKey: REPO_QUERY_KEY,
    queryFn: listRepositories,
  });

  const installed = useQuery({
    queryKey: INSTALLED_QUERY_KEY,
    queryFn: async () => {
      if (isTauriRuntime()) {
        await pluginManager.loadInstalledFromDb();
      }
      return pluginManager.list();
    },
    staleTime: 0,
  });

  const forceRefreshNextRef = useRef(false);

  const available = useQuery({
    queryKey: AVAILABLE_QUERY_KEY,
    queryFn: async () => {
      const force = forceRefreshNextRef.current;
      forceRefreshNextRef.current = false;
      if (!force) return fetchAllAvailable(repos.data ?? [], force);
      return enqueueMainTask({
        kind: "repository.refreshIndex",
        title: t("browse.repositoryIndex"),
        run: () => fetchAllAvailable(repos.data ?? [], force),
      }).promise;
    },
    enabled: !!repos.data && repos.data.length > 0,
  });

  const pendingRepoUrl = useBrowseStore((s) => s.pendingRepoUrl);
  const clearPendingRepoUrl = useBrowseStore(
    (s) => s.clearPendingRepoUrl,
  );
  const pluginLanguageFilter = useBrowseStore(
    (s) => s.pluginLanguageFilter,
  );
  const setPluginLanguageFilter = useBrowseStore(
    (s) => s.setPluginLanguageFilter,
  );
  const pinnedPluginIds = useBrowseStore((s) => s.pinnedPluginIds);
  const togglePinnedPlugin = useBrowseStore((s) => s.togglePinnedPlugin);
  const lastUsedPluginId = useBrowseStore((s) => s.lastUsedPluginId);
  const setLastUsedPluginId = useBrowseStore(
    (s) => s.setLastUsedPluginId,
  );

  const [addOpen, setAddOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [settingsPlugin, setSettingsPlugin] = useState<Plugin | null>(null);
  const [sourceTemplate, setSourceTemplate] = useState<PluginItem | null>(null);
  const [sourceForm, setSourceForm] = useState<SourceInstanceForm>(
    DEFAULT_SOURCE_INSTANCE_FORM,
  );

  const navigateToSource = (pluginId: string) =>
    navigate({
      to: "/source",
      search: { pluginId, query: "" },
    });

  const installedPlugins = installed.data ?? [];
  const activeRepository = repos.data?.[0] ?? null;
  const hasRepository = activeRepository !== null;
  const repositoryDialogTitle = hasRepository
    ? t("browse.changeRepository")
    : t("browse.setRepository");
  const availableEntries = hasRepository
    ? (available.data?.entries ?? [])
    : [];
  const languageOptions = useMemo(
    () =>
      makeLanguageOptions(
        [
          ...installedPlugins,
          ...availableEntries.map((entry) => entry.item),
        ],
        pluginLanguageFilter,
        locale,
      ),
    [availableEntries, installedPlugins, pluginLanguageFilter, locale],
  );
  const filteredInstalledPlugins = useMemo(
    () => filterByLanguage(installedPlugins, pluginLanguageFilter),
    [installedPlugins, pluginLanguageFilter],
  );
  const installedIds = useMemo(
    () => new Set(installed.data?.map((p) => p.id) ?? []),
    [installed.data],
  );
  const filteredAvailableEntries = useMemo(
    () =>
      sortEntriesByName(
        availableEntries.filter(
          ({ item }) =>
            (!installedIds.has(item.id) || isMultiSourcePlugin(item)) &&
            (pluginLanguageFilter.length === 0 ||
              pluginLanguageFilter.includes(item.lang)),
        ),
      ),
    [availableEntries, installedIds, pluginLanguageFilter],
  );
  const availableFailures = hasRepository
    ? (available.data?.failures ?? [])
    : [];

  // Deep-link entry: pre-fill the URL and open the modal.
  useEffect(() => {
    if (pendingRepoUrl !== null) {
      setUrl(pendingRepoUrl);
      setAddOpen(true);
      clearPendingRepoUrl();
    }
  }, [pendingRepoUrl, clearPendingRepoUrl]);

  const addRepoMutation = useMutation({
    mutationFn: async () => {
      const trimmed = url.trim();
      debugRepositoryFlow("add mutation start", {
        rawUrl: url,
        trimmedUrl: trimmed,
      });
      if (trimmed === "") {
        debugRepositoryFlow("add mutation skipped: empty url");
        return;
      }
      await enqueueMainTask({
        kind: "repository.add",
        title: repositoryDialogTitle,
        subject: { url: trimmed },
        run: async () => {
          await upsertRepository({ url: trimmed });
          debugRepositoryFlow("upsert mutation complete", { url: trimmed });
        },
      }).promise;
    },
    onSuccess: () => {
      debugRepositoryFlow("add mutation success: invalidate queries");
      clearSourceFilterStorage();
      setPluginLanguageFilter([]);
      queryClient.setQueryData<AvailableResult>(AVAILABLE_QUERY_KEY, {
        entries: [],
        failures: [],
      });
      queryClient.invalidateQueries({ queryKey: ["repository"] });
      queryClient.invalidateQueries({ queryKey: AVAILABLE_QUERY_KEY });
      setUrl("");
      setAddOpen(false);
    },
    onError: (error) => {
      console.error("[browse:repository] add mutation failed", {
        url,
        error,
      });
    },
  });

  const removeRepoMutation = useMutation({
    mutationFn: async (id: number) => {
      const repository = repos.data?.find((item) => item.id === id) ?? null;
      debugRepositoryFlow("remove mutation start", {
        id,
        repository,
        repositoryCount: repos.data?.length ?? null,
      });
      await enqueueMainTask({
        kind: "repository.remove",
        title: t("browse.changeRepository"),
        run: async () => {
          await removeRepository(id);
          debugRepositoryFlow("remove mutation complete", { id });
        },
      }).promise;
    },
    onSuccess: () => {
      debugRepositoryFlow("remove mutation success: invalidate queries");
      clearSourceFilterStorage();
      setPluginLanguageFilter([]);
      queryClient.setQueryData<AvailableResult>(AVAILABLE_QUERY_KEY, {
        entries: [],
        failures: [],
      });
      queryClient.invalidateQueries({ queryKey: ["repository"] });
      queryClient.invalidateQueries({ queryKey: AVAILABLE_QUERY_KEY });
    },
    onError: (error, id) => {
      console.error("[browse:repository] remove mutation failed", {
        id,
        error,
      });
    },
  });

  const installMutation = useMutation({
    mutationFn: async (item: PluginItem): Promise<Plugin> =>
      enqueueMainTask({
        kind: "plugin.install",
        title: t("tasks.task.installPlugin", { name: item.name }),
        subject: { pluginId: item.id, url: item.url },
        run: () => pluginManager.installPlugin(item),
      }).promise,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plugin"] });
    },
  });

  const installSourceMutation = useMutation({
    mutationFn: async ({
      item,
      form,
    }: {
      item: PluginItem;
      form: SourceInstanceForm;
    }): Promise<Plugin> =>
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plugin"] });
      setSourceTemplate(null);
      setSourceForm(DEFAULT_SOURCE_INSTANCE_FORM);
    },
  });

  const uploadPluginMutation = useMutation({
    mutationFn: async (file: File): Promise<Plugin> => {
      if (!file.name.toLowerCase().endsWith(".js")) {
        throw new Error(t("browse.localPlugin.invalidFile"));
      }
      if (file.size > MAX_PLUGIN_SOURCE_FILE_BYTES) {
        throw new Error(
          t("browse.localPlugin.fileTooLarge", {
            maxSize: MAX_PLUGIN_SOURCE_FILE_SIZE_LABEL,
          }),
        );
      }
      return enqueueMainTask({
        kind: "plugin.install",
        title: t("tasks.task.installPlugin", { name: file.name }),
        subject: { url: localPluginSourceUrl(file) },
        run: async () => {
          const source = await file.text();
          return pluginManager.installPluginFromSource(
            source,
            localPluginSourceUrl(file),
          );
        },
      }).promise;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plugin"] });
    },
  });

  const uninstallMutation = useMutation({
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
      if (lastUsedPluginId === id) {
        setLastUsedPluginId(null);
      }
      if (pinnedPluginIds.includes(id)) {
        togglePinnedPlugin(id);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plugin"] });
    },
  });

  return (
    <PageFrame size="wide" className="lnr-browse-page">
      <PageHeader
        title={
          <span className="lnr-browse-title-inline">
            <span>{t("browse.title")}</span>
            <span className="lnr-browse-title-description">
              {t("browse.description")}
            </span>
          </span>
        }
      />

      <Tabs
        value={tab}
        onChange={(value) => {
          const nextTab: BrowseTab = value === "sources" ? "sources" : "search";
          void navigate({
            to: "/browse",
            search: { q, tab: nextTab },
            replace: true,
          });
        }}
        keepMounted
        className="lnr-browse-tabs"
      >
        <Tabs.List grow className="lnr-browse-tab-list">
          <Tabs.Tab
            value="search"
            rightSection={
              <Badge size="xs">{installedPlugins.length}</Badge>
            }
          >
            {t("browse.tab.search")}
          </Tabs.Tab>
          <Tabs.Tab
            value="sources"
            rightSection={
              <Badge size="xs">{installedPlugins.length}</Badge>
            }
          >
            {t("browse.tab.sources")}
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="search" className="lnr-browse-tab-panel">
          <div className="lnr-browse-tab-stack">
            <ConsolePanel className="lnr-browse-search-panel">
              <PluginSearchSection
                installedPlugins={installedPlugins}
                query={q}
                onSearch={(nextQuery) => {
                  void navigate({
                    to: "/browse",
                    search: { q: nextQuery, tab: "search" },
                  });
                }}
              />
            </ConsolePanel>
          </div>
        </Tabs.Panel>

        <Tabs.Panel value="sources" className="lnr-browse-tab-panel">
          <div className="lnr-browse-tab-stack">
            <PluginSettingsSection
              languageOptions={languageOptions}
              selectedLanguages={pluginLanguageFilter}
              onLanguageChange={setPluginLanguageFilter}
            />

            <RepositoriesSection
              query={repos}
              onAdd={() => {
                addRepoMutation.reset();
                setUrl("");
                setAddOpen(true);
              }}
              onEdit={() => {
                addRepoMutation.reset();
                setUrl(activeRepository?.url ?? "");
                setAddOpen(true);
              }}
              onRefresh={() => {
                forceRefreshNextRef.current = true;
                void queryClient.invalidateQueries({
                  queryKey: AVAILABLE_QUERY_KEY,
                });
              }}
              refreshing={available.isFetching}
              onRemove={(id) => {
                debugRepositoryFlow("remove clicked", { id });
                removeRepoMutation.mutate(id);
              }}
              removing={removeRepoMutation.isPending}
            />

            <LocalPluginSection
              error={uploadPluginMutation.error}
              onInstallFile={(file) => uploadPluginMutation.mutate(file)}
              uploading={uploadPluginMutation.isPending}
            />

            <InstalledSection
              plugins={filteredInstalledPlugins}
              locale={locale}
              onUninstall={(id) => uninstallMutation.mutate(id)}
              uninstalling={uninstallMutation.isPending}
              lastUsedPluginId={lastUsedPluginId}
              onOpenSettings={setSettingsPlugin}
              onOpenSource={(plugin) => {
                setLastUsedPluginId(plugin.id);
                void navigateToSource(plugin.id);
              }}
            />

            <AvailableSection
              query={available}
              entries={filteredAvailableEntries}
              locale={locale}
              hasRepository={hasRepository}
              installedIds={installedIds}
              onInstall={(item) => {
                if (isMultiSourcePlugin(item)) {
                  installSourceMutation.reset();
                  setSourceForm(sourceInstanceFormFor());
                  setSourceTemplate(item);
                } else {
                  installMutation.mutate(item);
                }
              }}
              installing={
                installMutation.isPending || installSourceMutation.isPending
              }
              failures={availableFailures}
            />

          </div>
        </Tabs.Panel>
      </Tabs>

      <Modal
        opened={active && addOpen}
        onClose={() => {
          setAddOpen(false);
          addRepoMutation.reset();
        }}
        title={repositoryDialogTitle}
      >
        <Stack gap="sm">
          <TextInput
            label={t("browse.repositoryUrl")}
            placeholder="https://example.com/plugins.json"
            value={url}
            onChange={(event) => setUrl(event.currentTarget.value)}
            autoFocus
          />
          {addRepoMutation.error && (
            <StateView
              color="red"
              title={t("common.saveFailed")}
              message={
                addRepoMutation.error instanceof Error
                  ? addRepoMutation.error.message
                  : String(addRepoMutation.error)
              }
            />
          )}
          <Group justify="flex-end">
            <TextButton
              variant="subtle"
              onClick={() => {
                setAddOpen(false);
                addRepoMutation.reset();
              }}
            >
              {t("common.cancel")}
            </TextButton>
            <TextButton
              loading={addRepoMutation.isPending}
              disabled={url.trim() === ""}
              onClick={() => {
                debugRepositoryFlow("add save clicked", {
                  url,
                  disabled: url.trim() === "",
                });
                addRepoMutation.mutate();
              }}
            >
              {t("common.save")}
            </TextButton>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={active && sourceTemplate !== null}
        onClose={() => {
          setSourceTemplate(null);
          installSourceMutation.reset();
        }}
        size="lg"
        title={t("browse.sourceInstance.title")}
      >
        <Stack gap="sm">
          <TextInput
            label={t("browse.sourceInstance.workTitle")}
            placeholder="My novel"
            value={sourceForm.workTitle}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setSourceForm((current) => ({
                ...current,
                workTitle: value,
              }));
            }}
            autoFocus
          />
          <TextInput
            label={t("browse.sourceInstance.repository")}
            placeholder="owner/repo"
            value={sourceForm.repository}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setSourceForm((current) => ({
                ...current,
                repository: value,
              }));
            }}
          />
          <TextInput
            label={t("browse.sourceInstance.ref")}
            placeholder="main"
            value={sourceForm.ref}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setSourceForm((current) => ({
                ...current,
                ref: value,
              }));
            }}
          />
          <TextInput
            label={t("browse.sourceInstance.workRoot")}
            placeholder="works/my-novel/manuscripts"
            value={sourceForm.workRoot}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setSourceForm((current) => ({
                ...current,
                workRoot: value,
              }));
            }}
          />
          <TextInput
            label={t("browse.sourceInstance.chapterFiles")}
            placeholder="regex:^arc-[0-9]{3}/ch-[0-9]+\\.md$"
            value={sourceForm.chapterFilePattern}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setSourceForm((current) => ({
                ...current,
                chapterFilePattern: value,
              }));
            }}
          />
          <TextInput
            label={t("browse.sourceInstance.excludeFiles")}
            placeholder="README.md,draft-*,regex:^legacy/"
            value={sourceForm.chapterExcludePattern}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setSourceForm((current) => ({
                ...current,
                chapterExcludePattern: value,
              }));
            }}
          />
          <PasswordInput
            label={t("browse.sourceInstance.token")}
            placeholder="Optional personal access token"
            value={sourceForm.token}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setSourceForm((current) => ({
                ...current,
                token: value,
              }));
            }}
          />
          {installSourceMutation.error && (
            <StateView
              color="red"
              title={t("common.saveFailed")}
              message={
                installSourceMutation.error instanceof Error
                  ? installSourceMutation.error.message
                  : String(installSourceMutation.error)
              }
            />
          )}
          <Group justify="flex-end">
            <TextButton
              variant="subtle"
              onClick={() => {
                setSourceTemplate(null);
                installSourceMutation.reset();
              }}
            >
              {t("common.cancel")}
            </TextButton>
            <TextButton
              loading={installSourceMutation.isPending}
              disabled={
                sourceTemplate === null ||
                sourceForm.workTitle.trim() === "" ||
                sourceForm.repository.trim() === "" ||
                sourceForm.workRoot.trim() === "" ||
                sourceForm.chapterFilePattern.trim() === ""
              }
              onClick={() => {
                if (sourceTemplate) {
                  installSourceMutation.mutate({
                    item: sourceTemplate,
                    form: sourceForm,
                  });
                }
              }}
            >
              {t("browse.addSource")}
            </TextButton>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={active && settingsPlugin !== null}
        onClose={() => setSettingsPlugin(null)}
        size="lg"
        title={
          settingsPlugin
            ? t("pluginSettings.title", { name: settingsPlugin.name })
            : t("pluginSettings.title", { name: "" })
        }
      >
        {settingsPlugin ? (
          <PluginSettingsEditor
            key={settingsPlugin.id}
            plugin={settingsPlugin}
            onSaved={() => setSettingsPlugin(null)}
          />
        ) : null}
      </Modal>
    </PageFrame>
  );
}

interface RepositoriesSectionProps {
  query: ReturnType<typeof useQuery<PluginRepository[]>>;
  onAdd: () => void;
  onEdit: () => void;
  onRefresh: () => void;
  onRemove: (id: number) => void;
  refreshing: boolean;
  removing: boolean;
}

interface LocalPluginSectionProps {
  error: unknown;
  onInstallFile: (file: File) => void;
  uploading: boolean;
}

interface PluginSettingsSectionProps {
  languageOptions: readonly LanguageOption[];
  selectedLanguages: string[];
  onLanguageChange: (languages: string[]) => void;
}

function PluginSettingsSection({
  languageOptions,
  selectedLanguages,
  onLanguageChange,
}: PluginSettingsSectionProps) {
  const { t } = useTranslation();

  return (
    <ConsolePanel className="lnr-browse-panel lnr-browse-filter-panel">
      <div className="lnr-browse-filter-title-row">
        <span className="lnr-browse-filter-title">
          {t("browse.pluginFilters.title")}
        </span>
        <MultiSelect
          className="lnr-browse-language-input"
          aria-label={t("browse.pluginLanguages.label")}
          data={languageOptions}
          value={selectedLanguages}
          onChange={onLanguageChange}
          placeholder={t("browse.pluginLanguages.placeholder")}
          searchable
          clearable
        />
      </div>
    </ConsolePanel>
  );
}

function RepositoriesSection({
  query,
  onAdd,
  onEdit,
  onRefresh,
  onRemove,
  refreshing,
  removing,
}: RepositoriesSectionProps) {
  const { t } = useTranslation();
  const repository = query.data?.[0] ?? null;

  return (
    <ConsolePanel
      className="lnr-browse-panel lnr-browse-repository-panel"
      title={t("browse.repository.title")}
    >
      <Stack gap="sm" p="sm">
        {query.isLoading ? (
          <StateView
            title={
              <Group gap="sm">
                <Loader size="sm" />
                {t("common.loading")}
              </Group>
            }
          />
        ) : query.error ? (
          <StateView
            color="red"
            title={t("library.databaseError")}
            message={
              query.error instanceof Error
                ? query.error.message
                : String(query.error)
            }
          />
        ) : repository ? (
          <div key={repository.id} className="lnr-browse-repo-row">
            <Group justify="space-between" align="center" wrap="nowrap">
              <span
                className="lnr-icon-state"
                role="img"
                aria-label={t("browse.repository.badge")}
                title={t("browse.repository.badge")}
              >
                <RepositoryGlyph />
              </span>
              <Box style={{ minWidth: 0, flex: "1 1 auto" }}>
                <Text size="sm" fw={500} truncate>
                  {repository.name ?? repository.url}
                </Text>
                {repository.name ? (
                  <Text size="xs" c="dimmed" truncate>
                    {repository.url}
                  </Text>
                ) : null}
              </Box>
              <span className="lnr-browse-repository-actions">
                <IconButton
                  label={t("common.refresh")}
                  size="lg"
                  variant="subtle"
                  loading={refreshing}
                  onClick={onRefresh}
                >
                  <RefreshGlyph />
                </IconButton>
                <IconButton
                  label={t("common.edit")}
                  size="lg"
                  variant="subtle"
                  onClick={onEdit}
                >
                  <EditGlyph />
                </IconButton>
                <IconButton
                  label={t("common.remove")}
                  size="lg"
                  tone="danger"
                  variant="subtle"
                  loading={removing}
                  onClick={() => onRemove(repository.id)}
                >
                  <TrashGlyph />
                </IconButton>
              </span>
            </Group>
          </div>
        ) : (
          <div className="lnr-browse-repo-row">
            <Group justify="space-between" align="center" wrap="nowrap">
              <span
                className="lnr-icon-state"
                role="img"
                aria-label={t("browse.repository.badge")}
                title={t("browse.repository.badge")}
              >
                <RepositoryGlyph />
              </span>
              <Box style={{ minWidth: 0, flex: "1 1 auto" }}>
                <Text size="sm" fw={500} truncate>
                  {t("browse.repository.emptyTitle")}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {t("browse.repository.emptyMessage")}
                </Text>
              </Box>
              <span className="lnr-browse-repository-actions">
                <IconButton
                  label={t("browse.setRepository")}
                  size="lg"
                  variant="light"
                  onClick={onAdd}
                >
                  <PlusGlyph />
                </IconButton>
              </span>
            </Group>
          </div>
        )}
      </Stack>
    </ConsolePanel>
  );
}

function LocalPluginSection({
  error,
  onInstallFile,
  uploading,
}: LocalPluginSectionProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <ConsolePanel
      className="lnr-browse-panel"
      title={t("browse.localPlugin.title")}
    >
      <Stack gap="sm" p="sm">
        <input
          ref={inputRef}
          type="file"
          accept=".js,text/javascript,application/javascript"
          style={{ display: "none" }}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0] ?? null;
            event.currentTarget.value = "";
            if (file) onInstallFile(file);
          }}
        />
        <div className="lnr-browse-repo-row">
          <Group justify="space-between" align="center" wrap="nowrap">
            <span
              className="lnr-icon-state"
              role="img"
              aria-label={t("browse.localPlugin.badge")}
              title={t("browse.localPlugin.badge")}
            >
              <PlusGlyph />
            </span>
            <Box style={{ minWidth: 0, flex: "1 1 auto" }}>
              <Text size="sm" fw={500} truncate>
                {t("browse.localPlugin.heading")}
              </Text>
              <Text size="xs" c="dimmed">
                {t("browse.localPlugin.description")}
              </Text>
            </Box>
            <TextButton
              loading={uploading}
              variant="light"
              onClick={() => inputRef.current?.click()}
            >
              {t("browse.localPlugin.upload")}
            </TextButton>
          </Group>
        </div>
        {error ? (
          <StateView
            color="red"
            title={t("browse.localPlugin.installFailed")}
            message={error instanceof Error ? error.message : String(error)}
          />
        ) : null}
      </Stack>
    </ConsolePanel>
  );
}

interface InstalledSectionProps {
  plugins: Plugin[];
  locale: AppLocale;
  onUninstall: (id: string) => void;
  uninstalling: boolean;
  lastUsedPluginId: string | null;
  onOpenSource: (plugin: Plugin) => void;
  onOpenSettings: (plugin: Plugin) => void;
}

/**
 * Open the plugin's base URL in the in-app browser overlay. The
 * persistent scraper WebView owns browser cache and cookies, and
 * plugin-owned fetches prepare this origin before requesting data.
 */
function openSite(plugin: Plugin, title: string): void {
  const url = getPluginBaseUrl(plugin);
  console.debug("[site-browser] open site clicked", { url });
  void enqueueOpenSiteTask(plugin, url, title).promise.catch(
    () => undefined,
  );
}

function hasPluginInputs(plugin: Plugin): boolean {
  return (
    Object.keys(plugin.pluginInputs ?? {}).length > 0 ||
    Object.keys(plugin.pluginSettings ?? {}).length > 0
  );
}

interface PluginRowProps {
  plugin: Plugin;
  locale: AppLocale;
  lastUsed: boolean;
  onOpenSource: (plugin: Plugin) => void;
  onOpenSettings: (plugin: Plugin) => void;
  onUninstall: (id: string) => void;
  uninstalling: boolean;
}

function PluginRow({
  plugin,
  locale,
  lastUsed,
  onOpenSource,
  onOpenSettings,
  onUninstall,
  uninstalling,
}: PluginRowProps) {
  const { t } = useTranslation();

  return (
    <div key={plugin.id} className="lnr-browse-plugin-row">
      <Group justify="space-between" align="center" wrap="nowrap" gap="sm">
        <Box style={{ minWidth: 0, flex: "1 1 auto" }}>
          <Group gap="xs" wrap="wrap">
            <Text
              size="sm"
              fw={600}
              truncate
              style={{ maxWidth: "min(100%, 28rem)" }}
            >
              {plugin.name}
            </Text>
            <ConsoleChip>
              {formatPluginLanguageForLocale(locale, plugin.lang)}
            </ConsoleChip>
            <ConsoleChip>
              v{plugin.version}
            </ConsoleChip>
            {lastUsed ? (
              <span
                className="lnr-icon-state"
                data-tone="accent"
                role="img"
                aria-label={t("browse.lastUsed")}
                title={t("browse.lastUsed")}
              >
                <ClockGlyph />
              </span>
            ) : null}
          </Group>
          <Anchor
            size="xs"
            c="dimmed"
            truncate
            onClick={(event) => {
              event.preventDefault();
              openSite(plugin, t("tasks.task.openSite", { source: plugin.name }));
            }}
            title={t("common.openSiteInApp")}
          >
            {getPluginBaseUrl(plugin)}
          </Anchor>
        </Box>
        <Group className="lnr-action-strip" gap={4} wrap="nowrap" justify="flex-end">
          {hasPluginInputs(plugin) ? (
            <IconButton
              label={`${t("common.settings")}: ${plugin.name}`}
              size="lg"
              variant="subtle"
              disabled={uninstalling}
              title={t("common.settings")}
              onClick={() => onOpenSettings(plugin)}
            >
              <SettingsGlyph />
            </IconButton>
          ) : null}
          <IconButton
            label={`${t("common.source")}: ${plugin.name}`}
            size="lg"
            variant="subtle"
            disabled={uninstalling}
            title={t("common.source")}
            onClick={() => onOpenSource(plugin)}
          >
            <DetailsGlyph />
          </IconButton>
          <IconButton
            label={`${t("common.openSite")}: ${plugin.name}`}
            size="lg"
            variant="default"
            disabled={uninstalling}
            title={t("common.openSite")}
            onClick={() =>
              openSite(plugin, t("tasks.task.openSite", { source: plugin.name }))
            }
          >
            <ExternalLinkGlyph />
          </IconButton>
          <IconButton
            label={`${t("browse.uninstall")}: ${plugin.name}`}
            size="lg"
            tone="danger"
            variant="subtle"
            loading={uninstalling}
            title={t("browse.uninstall")}
            onClick={() => onUninstall(plugin.id)}
          >
            <TrashGlyph />
          </IconButton>
        </Group>
      </Group>
    </div>
  );
}

function InstalledSection({
  plugins,
  locale,
  onUninstall,
  uninstalling,
  lastUsedPluginId,
  onOpenSource,
  onOpenSettings,
}: InstalledSectionProps) {
  const { t } = useTranslation();
  const sortedPlugins = sortByName(plugins);

  return (
    <ConsolePanel
      className="lnr-browse-panel"
      title={t("browse.installedSources.title")}
    >
      <Stack gap="sm" p="sm">
        {plugins.length > 0 ? (
          <Stack gap={6}>
            {sortedPlugins.map((plugin) => (
              <PluginRow
                key={plugin.id}
                plugin={plugin}
                locale={locale}
                lastUsed={plugin.id === lastUsedPluginId}
                onOpenSource={onOpenSource}
                onOpenSettings={onOpenSettings}
                onUninstall={onUninstall}
                uninstalling={uninstalling}
              />
            ))}
          </Stack>
        ) : (
          <StateView
            color="blue"
            title={t("browse.noInstalledPlugins.title")}
            message={t("browse.noInstalledPlugins.message")}
          />
        )}
      </Stack>
    </ConsolePanel>
  );
}

interface AvailableSectionProps {
  query: ReturnType<typeof useQuery<AvailableResult>>;
  entries: readonly AvailableEntry[];
  locale: AppLocale;
  hasRepository: boolean;
  installedIds: ReadonlySet<string>;
  onInstall: (item: PluginItem) => void;
  installing: boolean;
  failures: readonly RepoFetchFailure[];
}

function AvailableSection({
  query,
  entries,
  locale,
  hasRepository,
  installedIds,
  onInstall,
  installing,
  failures,
}: AvailableSectionProps) {
  const { t } = useTranslation();

  return (
    <ConsolePanel
      className="lnr-browse-panel"
      title={t("browse.availableSourcePlugins.title")}
    >
      <Stack gap="sm" p="sm">
        {failures.length > 0 && (
          <Stack gap={4}>
            {failures.map((failure) => (
              <StateView
                key={failure.repoUrl}
                color="red"
                title={t("browse.couldNotFetchRepo", {
                  url: failure.repoUrl,
                })}
                message={failure.message}
              />
            ))}
          </Stack>
        )}
        {query.isLoading || query.isFetching ? (
          <StateView
            title={
              <Group gap="sm">
                <Loader size="sm" />
                {t("browse.fetchingRepositoryIndex")}
              </Group>
            }
          />
        ) : query.error ? (
          <StateView
            color="red"
            title={t("browse.repositoryFetchError")}
            message={
              query.error instanceof Error
                ? query.error.message
                : String(query.error)
            }
          />
        ) : entries.length > 0 ? (
          <Stack gap={6}>
            {entries.map(({ item, repoUrl }) => {
              const isInstalled = installedIds.has(item.id);
              return (
                <AvailablePluginRow
                  key={`${repoUrl}::${item.id}`}
                  item={item}
                  locale={locale}
                  repoUrl={repoUrl}
                  isInstalled={isInstalled}
                  installing={installing}
                  onInstall={onInstall}
                />
              );
            })}
          </Stack>
        ) : (
          <StateView
            color="blue"
            title={t("browse.noAvailablePlugins.title")}
            message={
              !hasRepository
                ? t("browse.noAvailablePlugins.noRepository")
                : failures.length > 0
                  ? t("browse.noAvailablePlugins.failure")
                  : t("browse.noAvailablePlugins.empty")
            }
          />
        )}
      </Stack>
    </ConsolePanel>
  );
}

interface AvailablePluginRowProps {
  item: PluginItem;
  locale: AppLocale;
  repoUrl: string;
  isInstalled: boolean;
  installing: boolean;
  onInstall: (item: PluginItem) => void;
}

function AvailablePluginRow({
  item,
  locale,
  repoUrl,
  isInstalled,
  installing,
  onInstall,
}: AvailablePluginRowProps) {
  const { t } = useTranslation();
  const multiSource = isMultiSourcePlugin(item);
  const disabled = isInstalled && !multiSource;
  const actionLabel = multiSource
    ? t("browse.addSource")
    : isInstalled
      ? t("common.installed")
      : t("common.install");

  return (
    <div className="lnr-browse-plugin-row">
      <Group justify="space-between" align="center" wrap="nowrap" gap="sm">
        <Box style={{ minWidth: 0, flex: "1 1 auto" }}>
          <Group gap="xs" wrap="wrap">
            <Text
              size="sm"
              fw={600}
              truncate
              style={{ maxWidth: "min(100%, 28rem)" }}
            >
              {item.name}
            </Text>
            <ConsoleChip>
              {formatPluginLanguageForLocale(locale, item.lang)}
            </ConsoleChip>
            <ConsoleChip>
              v{item.version}
            </ConsoleChip>
            {isInstalled ? (
              <span
                className="lnr-icon-state"
                data-tone="success"
                role="img"
                aria-label={t("common.installed")}
                title={t("common.installed")}
              >
                <CheckGlyph />
              </span>
            ) : null}
          </Group>
          <Text size="xs" c="dimmed" truncate>
            {t("browse.repositoryLabel", { url: repoUrl })}
          </Text>
        </Box>
        <Group className="lnr-action-strip" gap={4} wrap="nowrap" justify="flex-end">
          <IconButton
            label={`${actionLabel}: ${item.name}`}
            size="lg"
            variant="light"
            disabled={disabled}
            loading={installing && !disabled}
            title={actionLabel}
            onClick={() => onInstall(item)}
          >
            {disabled ? <CheckGlyph /> : <PlusGlyph />}
          </IconButton>
        </Group>
      </Group>
    </div>
  );
}
