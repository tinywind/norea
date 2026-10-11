import type { CatalogEntry } from "../lib/content-sync/native";
import type { WorkCatalogEntry } from "../lib/content-sync/works";

export interface ServerCatalogWork {
  key: string;
  identity: WorkCatalogEntry["metadata"]["identity"];
  name: string;
  sequence: number;
  chapters: CatalogEntry[];
}

export function groupServerCatalog(
  works: WorkCatalogEntry[],
  chapters: CatalogEntry[],
  search: string,
): ServerCatalogWork[] {
  const groups = new Map<string, ServerCatalogWork>();
  const keyFor = (identity: ServerCatalogWork["identity"]) =>
    JSON.stringify([identity.pluginId, identity.novelPath]);
  for (const work of works) {
    const key = keyFor(work.metadata.identity);
    groups.set(key, { key, identity: work.metadata.identity, name: work.metadata.novel.name, sequence: work.sequence, chapters: [] });
  }
  for (const chapter of chapters) {
    const key = keyFor(chapter.manifest.identity);
    let group = groups.get(key);
    if (!group) {
      group = { key, identity: chapter.manifest.identity, name: chapter.manifest.novel.name, sequence: chapter.sequence, chapters: [] };
      groups.set(key, group);
    }
    group.chapters.push(chapter);
  }
  const query = search.trim().toLocaleLowerCase();
  return [...groups.values()].flatMap((group) => {
    if (group.name.toLocaleLowerCase().includes(query)) return [group];
    const matching = group.chapters.filter((chapter) => chapter.manifest.chapter.name.toLocaleLowerCase().includes(query));
    return matching.length ? [{ ...group, chapters: matching }] : [];
  });
}
