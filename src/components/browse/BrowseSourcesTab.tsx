import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button, Collapse, Loader, Skeleton, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  formatPluginLanguageForLocale,
  useTranslation,
  type AppLocale,
} from "../../i18n";
import { describeError } from "../../lib/errors";
import { getPluginBaseUrl } from "../../lib/plugins/base-url";
import { openPluginSite } from "../../lib/plugins/open-plugin-site";
import { clearPluginCookies } from "../../lib/plugin-cookies";
import type { Plugin } from "../../lib/plugins/types";
import { enqueueSourceTask } from "../../lib/tasks/source-tasks";
import { isTauriRuntime } from "../../lib/tauri-runtime";
import { useBrowseStore } from "../../store/browse";
import { StateView } from "../AppFrame";
import { ReaderSettingsPanel } from "../ReaderSettingsPanel";
import { IconButton } from "../IconButton";
import { useConfirm } from "../ui/ConfirmDialog";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ClearCookiesIcon,
  ExtensionsIcon,
  PinIcon,
  ReaderSettingsIcon,
  SettingsIcon,
  SourceIcon,
  UnpinIcon,
} from "../ui/icons";
import { ListRow } from "../ui/ListRow";
import { OverflowMenu, type OverflowMenuItem } from "../ui/OverflowMenu";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";
import { PluginIcon } from "./PluginIcon";
import { PluginSettingsDialog } from "./PluginSettingsDialog";
import {
  hasPluginInputs,
  sortPluginsByName,
  useInstalledPlugins,
} from "./use-plugin-catalog";

/** Above this many sources the tab offers a name filter. */
export const SOURCE_FILTER_THRESHOLD = 8;
const SKELETON_ROWS = 5;

function hasPluginSite(plugin: Plugin): boolean {
  try {
    getPluginBaseUrl(plugin);
    return true;
  } catch {
    return false;
  }
}

export interface SourceLanguageGroup {
  lang: string;
  plugins: Plugin[];
}

/**
 * Pinned sources first, then the rest grouped by language. The persisted
 * language filter hides whole groups; pinned sources follow it too.
 */
export function groupSources(
  plugins: readonly Plugin[],
  pinnedPluginIds: readonly string[],
  languageFilter: readonly string[],
  locale: AppLocale,
): { pinned: Plugin[]; groups: SourceLanguageGroup[] } {
  const visible = sortPluginsByName(plugins).filter(
    (plugin) => languageFilter.length === 0 || languageFilter.includes(plugin.lang),
  );
  const pinned = visible.filter((plugin) => pinnedPluginIds.includes(plugin.id));
  const byLanguage = new Map<string, Plugin[]>();
  for (const plugin of visible) {
    if (pinnedPluginIds.includes(plugin.id)) continue;
    byLanguage.set(plugin.lang, [...(byLanguage.get(plugin.lang) ?? []), plugin]);
  }
  const groups = [...byLanguage.entries()]
    .map(([lang, groupPlugins]) => ({ lang, plugins: groupPlugins }))
    .sort((a, b) =>
      formatPluginLanguageForLocale(locale, a.lang).localeCompare(
        formatPluginLanguageForLocale(locale, b.lang),
      ),
    );
  return { pinned, groups };
}

function SourceRowsSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label} role="status">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div className="norea-source-row norea-source-row-skeleton" key={index}>
          <Skeleton height="2.5rem" radius="sm" width="2.5rem" />
          <Skeleton height="0.875rem" radius="sm" width="45%" />
        </div>
      ))}
    </div>
  );
}

interface SourceRowProps {
  clearingCookies: boolean;
  locale: AppLocale;
  menuItems: readonly OverflowMenuItem[];
  onOpen: () => void;
  onTogglePinned: () => void;
  pinned: boolean;
  plugin: Plugin;
}

function SourceRow({ clearingCookies, locale, menuItems, onOpen, onTogglePinned, pinned, plugin }: SourceRowProps) {
  const { t } = useTranslation();

  return (
    <li className="norea-source-row">
      <ListRow
        className="norea-source-row-open"
        leading={<PluginIcon plugin={plugin} />}
        onClick={onOpen}
        subtitle={formatPluginLanguageForLocale(locale, plugin.lang)}
        title={plugin.name}
      />
      <span className="norea-source-row-trailing">
        <IconButton label={pinned ? t("browse.unpin") : t("browse.pin")} onClick={onTogglePinned} size="lg">
          {pinned ? <UnpinIcon /> : <PinIcon />}
        </IconButton>
        {clearingCookies ? (
          <span
            aria-label={t("browse.sources.clearingCookies", { name: plugin.name })}
            className="norea-extension-busy"
            role="status"
          >
            <Loader aria-hidden="true" size="xs" />
          </span>
        ) : (
          <OverflowMenu
            items={menuItems}
            label={t("browse.sources.rowActions", { name: plugin.name })}
          />
        )}
      </span>
    </li>
  );
}

/** The sources list above the global search: pinned sources, then the others in one accordion. */
export function BrowseSourcesTab({ active }: { active: boolean }) {
  const { locale, t } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const installed = useInstalledPlugins(active);
  const pinnedPluginIds = useBrowseStore((s) => s.pinnedPluginIds);
  const togglePinnedPlugin = useBrowseStore((s) => s.togglePinnedPlugin);
  const pluginLanguageFilter = useBrowseStore((s) => s.pluginLanguageFilter);
  const setPluginLanguageFilter = useBrowseStore((s) => s.setPluginLanguageFilter);
  const setLastUsedPluginId = useBrowseStore((s) => s.setLastUsedPluginId);
  const [filter, setFilter] = useState("");
  const [collapsedLanguages, setCollapsedLanguages] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Until toggled, the other sources are open only when nothing is pinned.
  const [othersExpanded, setOthersExpanded] = useState<boolean | null>(null);
  const [settingsPlugin, setSettingsPlugin] = useState<Plugin | null>(null);
  // The plugin stays set after closing so the sheet keeps its content through the exit transition.
  const [readerSettings, setReaderSettings] = useState<{ opened: boolean; plugin: Plugin } | null>(
    null,
  );
  const canClearCookies = isTauriRuntime();

  const plugins = useMemo(() => installed.data ?? [], [installed.data]);
  const filterText = filter.trim().toLocaleLowerCase();
  const { pinned, groups } = useMemo(
    () =>
      groupSources(
        plugins.filter(
          (plugin) => filterText === "" || plugin.name.toLocaleLowerCase().includes(filterText),
        ),
        pinnedPluginIds,
        pluginLanguageFilter,
        locale,
      ),
    [filterText, locale, pinnedPluginIds, pluginLanguageFilter, plugins],
  );

  const clearCookies = useMutation({
    mutationFn: async (plugin: Plugin): Promise<number> => {
      const pluginUrl = getPluginBaseUrl(plugin);
      return enqueueSourceTask({
        plugin,
        kind: "source.clearCookies",
        priority: "user",
        title: t("tasks.task.clearCookies", { name: plugin.name }),
        subject: { url: pluginUrl },
        dedupeKey: `source.clearCookies:${plugin.id}`,
        run: ({ executor }) => {
          if (!executor) {
            throw new Error("Plugin cookie clearing requires a scraper executor");
          }
          return clearPluginCookies(plugin.id, pluginUrl, executor);
        },
      }).promise;
    },
    onSuccess: (count, plugin) => {
      notifications.show({
        color: "ok",
        title: t("browse.cookies.clearedTitle"),
        message: t("browse.cookies.cleared", { count, name: plugin.name }),
      });
    },
  });

  const openSource = (plugin: Plugin) => {
    setLastUsedPluginId(plugin.id);
    void navigate({ to: "/source", search: { pluginId: plugin.id, query: "" } });
  };
  const openExtensions = (pluginId?: string) => {
    void navigate({ to: "/browse/extensions", search: pluginId ? { plugin: pluginId } : {} });
  };
  const confirmClearCookies = async (plugin: Plugin) => {
    const confirmed = await confirm({
      title: t("browse.cookies.confirmTitle", { name: plugin.name }),
      message: t("browse.cookies.confirmMessage", { name: plugin.name }),
      confirmLabel: t("browse.cookies.clear"),
      danger: true,
    });
    if (confirmed) clearCookies.mutate(plugin);
  };

  const menuItemsFor = (plugin: Plugin): OverflowMenuItem[] => {
    return [
      ...(hasPluginInputs(plugin)
        ? [{ icon: SettingsIcon, label: t("common.settings"), onClick: () => setSettingsPlugin(plugin) }]
        : []),
      ...(hasPluginSite(plugin)
        ? [{
            icon: SourceIcon,
            label: t("common.openSite"),
            onClick: () => openPluginSite(plugin, t("tasks.task.openSite", { source: plugin.name })),
          }]
        : []),
      {
        icon: ReaderSettingsIcon,
        label: t("source.readerSettings"),
        onClick: () => setReaderSettings({ opened: true, plugin }),
      },
      ...(canClearCookies
        ? [{
            disabled: clearCookies.isPending,
            icon: ClearCookiesIcon,
            label: t("browse.cookies.clear"),
            onClick: () => void confirmClearCookies(plugin),
          }]
        : []),
      {
        icon: ExtensionsIcon,
        label: t("browse.sources.manage"),
        onClick: () => openExtensions(plugin.id),
      },
    ];
  };

  const renderRows = (rows: readonly Plugin[]) => (
    <ul className="norea-source-list">
      {rows.map((plugin) => (
        <SourceRow
          clearingCookies={clearCookies.isPending && clearCookies.variables?.id === plugin.id}
          key={plugin.id}
          locale={locale}
          menuItems={menuItemsFor(plugin)}
          onOpen={() => openSource(plugin)}
          onTogglePinned={() => togglePinnedPlugin(plugin.id)}
          pinned={pinnedPluginIds.includes(plugin.id)}
          plugin={plugin}
        />
      ))}
    </ul>
  );

  if (installed.isLoading) return <SourceRowsSkeleton label={t("common.loading")} />;
  if (installed.error) {
    return (
      <StateView
        action={{ label: t("common.retry"), onClick: () => void installed.refetch() }}
        color="danger"
        details={{ content: describeError(installed.error), label: t("common.details") }}
        title={t("browse.sources.loadFailed")}
      />
    );
  }
  // The global search under the list explains how to install the first source.
  if (plugins.length === 0) return null;

  const nothingVisible = pinned.length === 0 && groups.length === 0;
  const pinnedCount = plugins.filter((plugin) => pinnedPluginIds.includes(plugin.id)).length;
  const othersCount = plugins.length - pinnedCount;
  const othersOpen = othersExpanded ?? pinnedCount === 0;
  const languageHidden =
    pluginLanguageFilter.length > 0 &&
    plugins.some((plugin) => !pluginLanguageFilter.includes(plugin.lang));

  return (
    <div className="norea-browse-sources">
      {plugins.length > SOURCE_FILTER_THRESHOLD ? (
        <TextInput
          aria-label={t("browse.sources.filter")}
          onChange={(event) => setFilter(event.currentTarget.value)}
          placeholder={t("browse.sources.filter")}
          value={filter}
        />
      ) : null}

      {nothingVisible ? (
        filterText !== "" ? (
          <StateView
            action={{ label: t("common.clear"), onClick: () => setFilter("") }}
            title={t("browse.sources.noMatch", { query: filter.trim() })}
          />
        ) : (
          <StateView
            action={{
              label: t("browse.sources.showAllLanguages"),
              onClick: () => setPluginLanguageFilter([]),
            }}
            message={t("browse.sources.languageHidden.message")}
            title={t("browse.sources.languageHidden.title")}
          />
        )
      ) : null}

      {pinned.length > 0 ? (
        <section aria-labelledby="norea-sources-pinned" className="norea-source-group">
          <h2 className="norea-source-group-title" id="norea-sources-pinned">
            {t("common.pinned")}
          </h2>
          {renderRows(pinned)}
        </section>
      ) : null}

      {othersCount > 0 ? (
        <section className="norea-source-group">
          <h2 className="norea-source-group-title">
            <button
              aria-controls="norea-sources-others"
              aria-expanded={othersOpen}
              className="norea-source-group-toggle norea-state-layer"
              onClick={() => setOthersExpanded(!othersOpen)}
              type="button"
            >
              <span>{t("browse.sources.others")}</span>
              <span className="norea-source-group-count">{othersCount}</span>
              {othersOpen ? <ChevronDownIcon size="1.125rem" /> : <ChevronRightIcon size="1.125rem" />}
            </button>
          </h2>
          <Collapse expanded={othersOpen} id="norea-sources-others" keepMountedMode="display-none">
            <div className="norea-browse-sources">
              {groups.map(({ lang, plugins: groupPlugins }) => {
                const collapsed = collapsedLanguages.has(lang);
                const panelId = `norea-sources-lang-${lang}`;
                return (
                  <section className="norea-source-group" key={lang}>
                    <h3 className="norea-source-group-title">
                      <button
                        aria-controls={panelId}
                        aria-expanded={!collapsed}
                        className="norea-source-group-toggle norea-state-layer"
                        onClick={() =>
                          setCollapsedLanguages((current) => {
                            const next = new Set(current);
                            if (next.has(lang)) next.delete(lang);
                            else next.add(lang);
                            return next;
                          })
                        }
                        type="button"
                      >
                        <span>{formatPluginLanguageForLocale(locale, lang)}</span>
                        <span className="norea-source-group-count">{groupPlugins.length}</span>
                        {collapsed ? <ChevronRightIcon size="1.125rem" /> : <ChevronDownIcon size="1.125rem" />}
                      </button>
                    </h3>
                    <Collapse expanded={!collapsed} id={panelId} keepMountedMode="display-none">
                      {renderRows(groupPlugins)}
                    </Collapse>
                  </section>
                );
              })}

              {languageHidden && !nothingVisible ? (
                <Button
                  className="norea-source-show-all"
                  onClick={() => setPluginLanguageFilter([])}
                  variant="subtle"
                >
                  {t("browse.sources.showAllLanguages")}
                </Button>
              ) : null}
            </div>
          </Collapse>
        </section>
      ) : null}

      <PluginSettingsDialog onClose={() => setSettingsPlugin(null)} plugin={settingsPlugin} />
      {readerSettings ? (
        <ResponsiveSheet
          desktopVariant="side"
          fullScreenOnPhone
          opened={readerSettings.opened}
          onClose={() => setReaderSettings({ ...readerSettings, opened: false })}
          title={t("readerSettings.source.title", { name: readerSettings.plugin.name })}
        >
          <ReaderSettingsPanel
            target={{
              kind: "source",
              sourceId: readerSettings.plugin.id,
              label: readerSettings.plugin.name,
            }}
          />
        </ResponsiveSheet>
      ) : null}
    </div>
  );
}
