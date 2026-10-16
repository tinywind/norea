import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import type { ServerSourceSummary, ServerWorkPage } from "./browse";
import type { ServerChapterPage } from "./chapters";
import type { ServerNovelSource } from "./novel-source";
import type { WorkCatalogEntry } from "./works";

export async function removeDeletedServerWorkFromQueries(queryClient: QueryClient, source: ServerNovelSource, entry: WorkCatalogEntry): Promise<void> {
  const { serverUrl, workId } = source;
  const browseKey = ["content-server", serverUrl, "browse"];
  const sourcesKey = ["content-server", serverUrl, "sources"];
  const chaptersKey = ["content-server", serverUrl, "managed-chapters", workId];
  const availabilityKey = ["content-server", "novel-chapters", serverUrl, workId];
  const presenceKey = ["content-server", "manage-work", serverUrl, entry.metadata.identity.pluginId, entry.metadata.identity.novelPath];
  const coverKey = ["content-server", serverUrl, "cover", workId];
  const keys: QueryKey[] = [browseKey, sourcesKey, chaptersKey, availabilityKey, presenceKey, coverKey];
  await Promise.all(keys.map(queryKey => queryClient.cancelQueries({ queryKey })));
  queryClient.setQueriesData<InfiniteData<ServerWorkPage, number>>({ queryKey: browseKey }, data => {
    if (!data || !data.pages.some(page => page.items.some(work => work.id === workId))) return data;
    const pages = data.pages.map(page => ({
      ...page,
      items: page.items.filter(work => work.id !== workId),
      total: Math.max(0, page.total - 1),
    }));
    let offset = 0;
    const pageParams = pages.map(page => { const current = offset; offset += page.items.length; return current; });
    return { ...data, pages, pageParams };
  });
  queryClient.setQueryData<{ items: ServerSourceSummary[] }>(sourcesKey, data => data ? {
    items: data.items.map(item => item.id === entry.metadata.identity.pluginId ? { ...item, workCount: Math.max(0, item.workCount - 1) } : item)
      .filter(item => item.workCount > 0),
  } : data);
  queryClient.setQueriesData<ServerChapterPage>({ queryKey: chaptersKey }, { items: [], total: 0, hasMore: false });
  queryClient.setQueryData(availabilityKey, { paths: new Set<string>(), numbers: new Set<number>() });
  queryClient.setQueryData(presenceKey, null);
  queryClient.removeQueries({ queryKey: coverKey });
  for (const queryKey of [browseKey, sourcesKey]) void queryClient.invalidateQueries({ queryKey });
}
