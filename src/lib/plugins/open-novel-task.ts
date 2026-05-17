import type { TaskHandle, TaskPriority, TaskSubject } from "../tasks/scheduler";
import { enqueueSourceTask } from "../tasks/source-tasks";
import type { ScraperExecutorId } from "../tasks/scraper-queue";
import {
  importNovelFromSource,
  type ImportNovelFromSourceOptions,
} from "./import-novel";
import { pluginManager, type PluginManager } from "./manager";
import type { NovelItem, Plugin } from "./types";

type OpenNovelPluginManager = Pick<PluginManager, "getPluginForExecutor">;

export interface OpenNovelFromSourceTaskOptions {
  plugin: Pick<Plugin, "id" | "name">;
  item: NovelItem;
  title: string;
  priority?: Exclude<TaskPriority, "background">;
  subject?: TaskSubject;
  dedupeKey?: string;
  importOptions?: ImportNovelFromSourceOptions;
  manager?: OpenNovelPluginManager;
}

export function enqueueOpenNovelFromSourceTask({
  dedupeKey,
  importOptions,
  item,
  manager = pluginManager,
  plugin,
  priority = "interactive",
  subject,
  title,
}: OpenNovelFromSourceTaskOptions): TaskHandle<number> {
  return enqueueSourceTask<number>({
    plugin,
    kind: "source.openNovel",
    priority,
    title,
    subject: {
      ...subject,
      novelName: item.name,
      path: item.path,
      pluginId: plugin.id,
    },
    dedupeKey: dedupeKey ?? `source.openNovel:${plugin.id}:${item.path}`,
    run: (context) => {
      const executor: ScraperExecutorId = context.executor ?? "immediate";
      const runtimePlugin = manager.getPluginForExecutor(plugin.id, executor);
      return importNovelFromSource(runtimePlugin, item, importOptions);
    },
  });
}
