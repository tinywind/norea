import type { NovelDetailRecord } from "../../db/queries/novel";
import { pluginManager } from "../plugins/manager";
import { syncNovelFromSource } from "../plugins/sync-novel";
import type { Plugin } from "../plugins/types";
import { enqueueSourceTask } from "./source-tasks";

export function enqueueFullNovelRefresh(
  plugin: Plugin,
  novel: Pick<NovelDetailRecord, "id" | "pluginId" | "name" | "path" | "cover">,
  title: string,
) {
  return enqueueSourceTask({
    plugin,
    kind: "source.refreshNovel",
    priority: "user",
    title,
    subject: { novelId: novel.id, novelName: novel.name, path: novel.path },
    dedupeKey: `source.refreshNovel:full:${novel.pluginId}:${novel.path}`,
    run: (context) => syncNovelFromSource(
      pluginManager.getPluginForExecutor(novel.pluginId, context.executor ?? "immediate"),
      { cover: novel.cover ?? undefined, name: novel.name, path: novel.path },
      { chapterRefreshMode: "full", novelId: novel.id, preserveMissingMetadata: true, refreshCover: true, signal: context.signal },
    ),
  });
}
