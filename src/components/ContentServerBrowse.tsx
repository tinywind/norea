import { useEffect, useState } from "react";
import { Group, Loader, Select, Stack, Text } from "@mantine/core";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "../i18n";
import { listServerWorks, openServerNovel, type ServerSourceSummary, type ServerWorkSummary } from "../lib/content-sync/browse";
import { contentServerRequest } from "../lib/content-sync/client";
import { registerContentDevice } from "../lib/content-sync/device";
import { useLibraryNovelMembership } from "../lib/use-library-novel-membership";
import { useContentSyncStore } from "../store/content-sync";
import { LibraryAddedGlyph } from "./ActionGlyphs";
import { StateView } from "./AppFrame";
import { ConsolePanel, ConsoleSectionHeader } from "./ConsolePrimitives";
import { ContentServerCover } from "./ContentServerCover";
import { SearchBar } from "./SearchBar";
import { TextButton } from "./TextButton";

export function ContentServerBrowse({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const server = useContentSyncStore(state => state.serverUrl);
  const deviceName = useContentSyncStore(state => state.deviceName);
  const isInLibrary = useLibraryNovelMembership();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  useEffect(() => { setSource(""); setQuery(""); setDraft(""); }, [server]);
  const device = useQuery({
    queryKey: ["content-server", server, "device", deviceName],
    queryFn: () => registerContentDevice(server, deviceName),
    enabled: active && !!server, staleTime: 60_000, retry: false,
  });
  const enabled = active && !!server && !!device.data;
  const sources = useQuery({
    queryKey: ["content-server", server, "sources"],
    queryFn: ({ signal }) => contentServerRequest<{ items: ServerSourceSummary[] }>(server, "/catalog/sources", device.data!, "GET", undefined, signal),
    enabled, staleTime: 30_000,
  });
  const works = useInfiniteQuery({
    queryKey: ["content-server", server, "browse", query, source],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => listServerWorks(server, device.data!, query, source, pageParam, signal),
    getNextPageParam: (last, _pages, offset) => last.hasMore ? offset + last.items.length : undefined,
    enabled, staleTime: 30_000,
  });
  const open = useMutation({
    mutationFn: (work: ServerWorkSummary) => openServerNovel(server, work),
    onSuccess: async (id) => {
      await queryClient.invalidateQueries({ queryKey: ["novel", "detail", id] });
      await queryClient.invalidateQueries({ queryKey: ["content-server", "novel-source", id] });
      await navigate({ to: "/novel", search: { id } });
    },
  });
  const error = device.error ?? sources.error ?? works.error ?? open.error;
  const items = works.data?.pages.flatMap(page => page.items) ?? [];
  if (!server) return <StateView title={t("contentSync.notConfigured")} message={t("contentSync.configureHint")} />;
  return (
    <div className="norea-source-workbench">
      <aside className="norea-source-tools">
        <ConsolePanel title={t("contentSync.title")}>
          <Stack gap="sm" p="sm">
            <SearchBar value={draft} onChange={setDraft} onSubmit={() => setQuery(draft.trim())} placeholder={t("contentSync.search")} />
            <Select label={t("contentSync.sourceFilter")} value={source} allowDeselect={false}
              data={[{ value: "", label: t("contentSync.allSources") }, ...(sources.data?.items ?? []).map(item => ({ value: item.id, label: `${item.id} (${item.workCount})` }))]}
              onChange={value => setSource(value ?? "")} />
            <Text size="sm" c="dimmed">{t("contentSync.browseHint")}</Text>
            <TextButton onClick={() => { void queryClient.invalidateQueries({ queryKey: ["content-server", server] }); }}>{t("common.refresh")}</TextButton>
          </Stack>
        </ConsolePanel>
      </aside>
      <section className="norea-source-results-panel">
        <ConsoleSectionHeader title={query || t("contentSync.catalog")} count={t("contentSync.workCount", { count: works.data?.pages[0]?.total ?? 0 })} />
        {error ? <StateView color="red" title={t("source.error")} message={error.message} /> : null}
        {device.isLoading || works.isLoading ? <Group p="md"><Loader size="sm" /><Text>{t("common.loading")}</Text></Group> : null}
        {!error && enabled && !works.isLoading && items.length === 0 ? <StateView title={t("source.noResults")} /> : null}
        <div className="norea-source-grid">
          {items.map(work => (
            <button type="button" className="norea-source-card" key={work.id} disabled={open.isPending} onClick={() => open.mutate(work)}>
              <span className="norea-source-cover-frame">
                <ContentServerCover server={server} token={device.data!} work={work} />
                {isInLibrary(work.identity.pluginId, work.identity.novelPath) ? <span className="norea-source-library-mark" role="img" aria-label={t("novel.inLibrary")}><LibraryAddedGlyph /></span> : null}
              </span>
              <span className="norea-source-card-title" title={work.novel.name}>{work.novel.name}</span>
              <span className="norea-source-card-path">{t("contentSync.catalogCount", { count: work.chapterCount })}</span>
            </button>
          ))}
        </div>
        {open.isPending ? <Group p="sm"><Loader size="sm" /><Text>{t("common.loading")}</Text></Group> : null}
        {works.hasNextPage ? <div className="norea-source-load-more"><TextButton loading={works.isFetchingNextPage} onClick={() => { void works.fetchNextPage(); }}>{t("common.loadMore")}</TextButton></div> : null}
      </section>
    </div>
  );
}
