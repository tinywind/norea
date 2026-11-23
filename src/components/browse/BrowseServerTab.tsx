import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { Button, Loader } from "@mantine/core";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "../../i18n";
import { listServerCatalogFilters, listServerWorks, openServerNovel, type ServerWorkSummary } from "../../lib/content-sync/browse";
import { registerContentDevice } from "../../lib/content-sync/device";
import { describeError } from "../../lib/errors";
import { useServerWorkCategories } from "../../lib/content-sync/use-server-work-categories";
import { useLibraryNovelMembership } from "../../lib/use-library-novel-membership";
import { useContentSyncStore } from "../../store/content-sync";
import { EMPTY_CONTENT_SERVER_BROWSE_FILTERS, useContentServerBrowseStore } from "../../store/content-server-browse";
import { StateView } from "../AppFrame";
import { ContentServerCover } from "../ContentServerCover";
import { IconButton } from "../IconButton";
import { SearchBar } from "../SearchBar";
import { AddToLibraryIcon, CheckIcon, DownloadIcon, InLibraryIcon, RefreshIcon, SelectIcon } from "../ui/icons";
import { SelectionAction, SelectionBar } from "../ui/SelectionBar";
import { CoverGridSkeleton } from "./CoverGridSkeleton";
import { QuickAddCard } from "./QuickAddCard";
import { ServerBrowseFilters } from "./ServerBrowseFilters";
import { useQuickAddToLibrary, type QuickAddTarget } from "./use-quick-add";
import { useInstalledPlugins } from "./use-plugin-catalog";
import { downloadServerWorksOnce } from "./server-download-all";
import { useServerLibraryAdd } from "./use-server-library-add";
import { useServerWorkSelection } from "./use-server-work-selection";

interface BrowseServerTabProps {
  active: boolean;
  /** Where the selection header renders; the page swaps its own header for this slot while selecting. */
  selectionHeaderSlot?: HTMLElement | null;
  onSelectionModeChange?: (selecting: boolean) => void;
}

export function BrowseServerTab({ active, onSelectionModeChange, selectionHeaderSlot }: BrowseServerTabProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const server = useContentSyncStore(state => state.serverUrl);
  const deviceName = useContentSyncStore(state => state.deviceName);
  const isInLibrary = useLibraryNovelMembership();
  const quickAdd = useQuickAddToLibrary();
  const installed = useInstalledPlugins(active && !!server);
  const { categories, draft, query, source, statuses, tags, uncategorized } = useContentServerBrowseStore(
    state => state.filtersByServer[server] ?? EMPTY_CONTENT_SERVER_BROWSE_FILTERS,
  );
  const filter = useMemo(
    () => ({ categories, query, source, statuses, tags, uncategorized }),
    [categories, query, source, statuses, tags, uncategorized],
  );
  const setFilters = useContentServerBrowseStore(state => state.setFilters);
  const device = useQuery({
    meta: { errorPresentation: "inline" },
    queryKey: ["content-server", server, "device", deviceName],
    queryFn: () => registerContentDevice(server, deviceName),
    enabled: active && !!server, staleTime: 60_000, retry: false,
  });
  const enabled = active && !!server && !!device.data;
  const catalogFilters = useQuery({
    meta: { errorPresentation: "inline" },
    queryKey: ["content-server", server, "filters", query, source, statuses, categories, uncategorized, tags],
    queryFn: ({ signal }) => listServerCatalogFilters(server, device.data!, filter, signal),
    enabled,
    placeholderData: previous => previous,
    staleTime: 30_000,
  });
  const works = useInfiniteQuery({
    meta: { errorPresentation: "inline" },
    queryKey: ["content-server", server, "browse", query, source, statuses, categories, uncategorized, tags],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => listServerWorks(server, device.data!, filter, pageParam, signal),
    getNextPageParam: (last, _pages, offset) => last.hasMore ? offset + last.items.length : undefined,
    enabled, staleTime: 30_000,
  });
  const selection = useServerWorkSelection({ active, filter, server, token: device.data });
  const bulkAdd = useServerLibraryAdd(server);
  const open = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: (work: ServerWorkSummary) => openServerNovel(server, work),
    onSuccess: async (id) => {
      await queryClient.invalidateQueries({ queryKey: ["novel", "detail", id] });
      await queryClient.invalidateQueries({ queryKey: ["content-server", "novel-source", id] });
      await navigate({ to: "/novel", search: { id } });
    },
  });
  const pluginNames = useMemo(
    () => new Map((installed.data ?? []).map(plugin => [plugin.id, plugin.name])),
    [installed.data],
  );
  const error = device.error ?? catalogFilters.error ?? works.error ?? open.error;
  const items = works.data?.pages.flatMap(page => page.items) ?? [];
  const matchingTotal = works.data?.pages[0]?.total ?? 0;
  const categoriesOf = useServerWorkCategories(server, items.map(work => work.identity), active);
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ["content-server", server] }); };

  if (!server) {
    return (
      <StateView
        action={{ label: t("contentSync.openSettings"), onClick: () => { void navigate({ to: "/settings", search: { section: "backup" } }); } }}
        message={t("contentSync.configureHint")}
        title={t("contentSync.notConfigured")}
      />
    );
  }

  const selecting = selection.selectionMode;
  useEffect(() => {
    onSelectionModeChange?.(selecting);
  }, [onSelectionModeChange, selecting]);
  useEffect(() => () => onSelectionModeChange?.(false), [onSelectionModeChange]);

  const selectionHint = selection.gathering
    ? t("serverLibraryAdd.gathering", { loaded: selection.gathering.loaded, total: selection.gathering.total })
    : t("serverLibraryAdd.selectionHint");

  const selectedWorks = [...selection.selected.values()];
  const newWorks = selectedWorks.filter(work => !isInLibrary(work.identity.pluginId, work.identity.novelPath));
  const downloadAll = () => {
    if (newWorks.length > 0) {
      bulkAdd.request({ count: newWorks.length, downloadChaptersOf: selectedWorks, onStarted: selection.exit, works: newWorks });
      return;
    }
    selection.exit();
    void downloadServerWorksOnce(selectedWorks, null, t, queryClient, server);
  };

  const selectionBar = selection.selectionMode ? (
        <SelectionBar
          actions={
            <>
              <SelectionAction
                disabled={newWorks.length === 0 || !!selection.gathering}
                icon={AddToLibraryIcon}
                label={t("quickAdd.add")}
                onClick={() => bulkAdd.request({ count: newWorks.length, onStarted: selection.exit, works: newWorks })}
              />
              <SelectionAction
                disabled={selectedWorks.length === 0 || !!selection.gathering}
                icon={DownloadIcon}
                label={t("serverLibraryAdd.downloadAll")}
                onClick={downloadAll}
              />
            </>
          }
          allSelected={selection.allSelected}
          hint={selectionHint}
          label={t("library.selectedCount", { count: selection.selected.size })}
          onDeselectAll={selection.deselectAll}
          onExit={selection.exit}
          onSelectAll={selection.selectAll}
          selectAllDisabled={!enabled || matchingTotal === 0 || !!selection.gathering}
          selectAllPending={!!selection.gathering}
        />
  ) : null;

  return (
    <div className="norea-server-browse">
      {selectionBar ? (
        selectionHeaderSlot ? createPortal(selectionBar, selectionHeaderSlot) : selectionBar
      ) : (
        <div className="norea-server-browse-toolbar">
          <SearchBar value={draft} onChange={value => setFilters(server, { draft: value })} onSubmit={() => setFilters(server, { query: draft.trim() })} placeholder={t("contentSync.search")} />
          <div className="norea-browse-actions">
            <IconButton label={t("common.refresh")} loading={works.isRefetching} onClick={refresh} size="lg">
              <RefreshIcon />
            </IconButton>
            <IconButton disabled={!enabled || items.length === 0} label={t("library.selection.start")} onClick={() => selection.enter()} size="lg">
              <SelectIcon />
            </IconButton>
            <IconButton
              disabled={!enabled || matchingTotal === 0}
              label={t("serverLibraryAdd.addAll", { count: matchingTotal })}
              onClick={() => bulkAdd.request({ count: matchingTotal, works: filter })}
              size="lg"
            >
              <AddToLibraryIcon />
            </IconButton>
          </div>
        </div>
      )}
      <ServerBrowseFilters
        categories={catalogFilters.data?.categories ?? []}
        filter={filter}
        filtersLoading={catalogFilters.isLoading}
        onChange={next => setFilters(server, next)}
        sourceName={id => pluginNames.get(id) ?? id}
        sources={catalogFilters.data?.sources ?? []}
        statuses={catalogFilters.data?.statuses ?? []}
        tags={catalogFilters.data?.tags ?? []}
        uncategorizedCount={catalogFilters.data?.uncategorizedCount ?? 0}
      />
      {error ? (
        <StateView action={{ label: t("common.retry"), onClick: refresh }} color="danger"
          details={{ content: describeError(error), label: t("common.details") }} title={t("source.error")} />
      ) : null}
      {device.isLoading || works.isLoading ? <CoverGridSkeleton label={t("common.loading")} /> : null}
      {!error && enabled && !works.isLoading && items.length === 0 ? <StateView title={t("source.noResults")} /> : null}
      <div className="norea-source-grid">
        {items.map(work => {
          const inLibrary = isInLibrary(work.identity.pluginId, work.identity.novelPath);
          const target: QuickAddTarget = { kind: "server", server, work };
          const selected = selection.selected.has(work.id);
          const categories = categoriesOf(work.identity.pluginId, work.identity.novelPath).join(", ");
          const content = (
            <>
              <span className="norea-source-cover-frame">
                <ContentServerCover server={server} token={device.data!} work={work} />
                {inLibrary ? <span className="norea-source-library-mark" role="img" aria-label={t("novel.inLibrary")}><InLibraryIcon size="1rem" /></span> : null}
                {selection.selectionMode ? (
                  <span aria-hidden="true" className="norea-source-select-check" data-checked={selected ? "true" : undefined}>
                    {selected ? <CheckIcon size="1rem" /> : null}
                  </span>
                ) : null}
              </span>
              <span className="norea-source-card-title" title={work.novel.name}>{work.novel.name}</span>
              <span className="norea-source-card-meta">{t("contentSync.catalogCount", { count: work.chapterCount })}</span>
              {categories ? (
                <span aria-label={`${t("categories.title")}: ${categories}`} className="norea-source-card-categories" title={categories}>
                  {categories}
                </span>
              ) : null}
            </>
          );
          return selection.selectionMode ? (
            <div className="norea-quick-add-card" key={`${server}:${work.id}`}>
              <button aria-label={t("library.selection.selectNamed", { name: work.novel.name })} aria-pressed={selected}
                className="norea-source-card norea-state-layer"
                data-selected={selected ? "true" : undefined} onClick={() => selection.toggle(work)} type="button">
                {content}
              </button>
            </div>
          ) : (
            <QuickAddCard className="norea-source-card norea-state-layer" disabled={open.isPending} inLibrary={inLibrary} key={`${server}:${work.id}`}
              name={work.novel.name} onAdd={() => quickAdd.add(target)} onOpen={() => open.mutate(work)} onSelect={() => selection.enter(work)}
              pending={quickAdd.isPending(target)}>
              {content}
            </QuickAddCard>
          );
        })}
      </div>
      {open.isPending ? <div className="norea-search-progress" role="status"><Loader size="xs" />{t("common.loading")}</div> : null}
      {quickAdd.categorySheet}
      {bulkAdd.sheet}
      {works.hasNextPage ? (
        <Button className="norea-source-load-more" loading={works.isFetchingNextPage} onClick={() => { void works.fetchNextPage(); }} variant="default">
          {t("common.loadMore")}
        </Button>
      ) : null}
    </div>
  );
}
