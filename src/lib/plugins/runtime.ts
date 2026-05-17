import type { ScraperExecutorId } from "../tasks/scraper-queue";
import type {
  ChapterBinaryResource,
  NovelItem,
  Plugin,
  PluginItem,
  PluginPopularOptions,
  SourceNovel,
  SourcePage,
} from "./types";

export interface PluginRuntimeCompileRequest {
  source: string;
  item: PluginItem;
  executor: ScraperExecutorId;
  overrideIdentity?: boolean;
}

export type PluginRuntimeCompiler = (
  request: PluginRuntimeCompileRequest,
) => Plugin;

export interface PluginRuntimeHandle {
  readonly item: PluginItem;
  readonly sourceHash: string;
  getRuntime(executor: ScraperExecutorId): Plugin;
  loadedExecutors(): ScraperExecutorId[];
}

export interface PluginRuntimeHandleOptions {
  item: PluginItem;
  source: string;
  compiler: PluginRuntimeCompiler;
  initialRuntime?: Plugin;
}

export function hashPluginSource(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createPluginRuntimeHandle({
  compiler,
  initialRuntime,
  item,
  source,
}: PluginRuntimeHandleOptions): PluginRuntimeHandle {
  const runtimes = new Map<ScraperExecutorId, Plugin>();
  if (initialRuntime) {
    runtimes.set("immediate", initialRuntime);
  }

  return {
    item,
    sourceHash: hashPluginSource(source),
    getRuntime(executor) {
      const cached = runtimes.get(executor);
      if (cached) return cached;

      const runtime = compiler({
        source,
        item,
        executor,
        overrideIdentity: true,
      });
      runtimes.set(executor, runtime);
      return runtime;
    },
    loadedExecutors() {
      return [...runtimes.keys()];
    },
  };
}

function immediateRuntime(handle: PluginRuntimeHandle): Plugin {
  return handle.getRuntime("immediate");
}

function bindOptionalMethod<
  TArgs extends unknown[],
  TResult,
>(
  handle: PluginRuntimeHandle,
  select: (plugin: Plugin) => ((...args: TArgs) => TResult) | undefined,
): ((...args: TArgs) => TResult) | undefined {
  const plugin = immediateRuntime(handle);
  const method = select(plugin);
  return method ? method.bind(plugin) : undefined;
}

export function createLazyPluginProxy(
  handle: PluginRuntimeHandle,
): Plugin {
  const plugin = {
    ...handle.item,
    getBaseUrl: () => immediateRuntime(handle).getBaseUrl(),
    popularNovels: async (
      pageNo: number,
      options?: PluginPopularOptions,
    ): Promise<NovelItem[]> => {
      const runtime = immediateRuntime(handle);
      return runtime.popularNovels(pageNo, options);
    },
    parseNovel: async (novelPath: string): Promise<SourceNovel> => {
      const runtime = immediateRuntime(handle);
      return runtime.parseNovel(novelPath);
    },
    parseNovelSince: async (
      novelPath: string,
      sinceChapterNumber: number,
    ): Promise<SourceNovel> => {
      const runtime = immediateRuntime(handle);
      return runtime.parseNovelSince(novelPath, sinceChapterNumber);
    },
    parseChapter: async (chapterPath: string): Promise<string> => {
      const runtime = immediateRuntime(handle);
      return runtime.parseChapter(chapterPath);
    },
    searchNovels: async (
      searchTerm: string,
      pageNo: number,
    ): Promise<NovelItem[]> => {
      const runtime = immediateRuntime(handle);
      return runtime.searchNovels(searchTerm, pageNo);
    },
  } satisfies Plugin;

  Object.defineProperties(plugin, {
    customJS: {
      get: () => immediateRuntime(handle).customJS,
    },
    customCSS: {
      get: () => immediateRuntime(handle).customCSS,
    },
    filters: {
      get: () => immediateRuntime(handle).filters,
    },
    hasUpdate: {
      get: () => immediateRuntime(handle).hasUpdate,
    },
    hasSettings: {
      get: () => immediateRuntime(handle).hasSettings,
    },
    imageRequestInit: {
      get: () => immediateRuntime(handle).imageRequestInit,
    },
    parseChapterResource: {
      get: () =>
        bindOptionalMethod<[string], Promise<ChapterBinaryResource>>(
          handle,
          (runtime) => runtime.parseChapterResource,
        ),
    },
    parsePage: {
      get: () =>
        bindOptionalMethod<[string, string], Promise<SourcePage>>(
          handle,
          (runtime) => runtime.parsePage,
        ),
    },
    pluginInputs: {
      get: () => immediateRuntime(handle).pluginInputs,
    },
    pluginSettings: {
      get: () => immediateRuntime(handle).pluginSettings,
    },
    resolveUrl: {
      get: () =>
        bindOptionalMethod<[string, boolean?], string>(
          handle,
          (runtime) => runtime.resolveUrl,
        ),
    },
    webStorageUtilized: {
      get: () => immediateRuntime(handle).webStorageUtilized,
    },
  });

  return plugin;
}
