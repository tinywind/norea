import { enqueueSourceTask } from "../tasks/source-tasks";
import type { ScraperExecutorId } from "../tasks/scraper-queue";
import type { TaskHandle } from "../tasks/scheduler";
import {
  assertValidSourceChapterItem,
  assertValidSourceNovelMetadata,
} from "./return-contracts";
import type { NovelItem, Plugin, SourceNovel } from "./types";

interface NovelMergePreviewPluginManager {
  getPlugin: (
    id: string,
  ) => Pick<Plugin, "getBaseUrl" | "id" | "name"> | undefined;
  getPluginForExecutor: (
    id: string,
    executor: ScraperExecutorId,
  ) => Pick<Plugin, "parseNovel">;
}

interface EnqueueNovelMergeTargetPreviewOptions {
  item: NovelItem;
  manager: NovelMergePreviewPluginManager;
  pluginId: string;
  title: string;
}

export class NovelMergePreviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NovelMergePreviewValidationError";
  }
}

const createPreviewError = (message: string) =>
  new NovelMergePreviewValidationError(message);

export function validateNovelMergeTargetPreview(value: unknown): SourceNovel {
  assertValidSourceNovelMetadata(value, "Target preview", createPreviewError, {
    invalidStatus: () =>
      "Target preview field 'status' must be a valid NovelStatus.",
  });

  const chapterPaths = new Set<string>();
  const chapterNumbers = new Set<number>();
  for (const [index, chapter] of value.chapters.entries()) {
    assertValidSourceChapterItem(chapter, index, "Target preview", createPreviewError, {
      invalidChapterNumber: (_label, idx) =>
        `Target preview chapter ${idx + 1} must have a finite chapterNumber.`,
      invalidContentType: (_label, idx) =>
        `Target preview chapter ${idx + 1} has an unsupported contentType.`,
    });
    if (chapterPaths.has(chapter.path)) {
      throw new NovelMergePreviewValidationError(
        `Target preview returned duplicate chapter path '${chapter.path}'.`,
      );
    }
    if (chapterNumbers.has(chapter.chapterNumber)) {
      throw new NovelMergePreviewValidationError(
        `Target preview returned duplicate chapterNumber '${chapter.chapterNumber}'.`,
      );
    }
    chapterPaths.add(chapter.path);
    chapterNumbers.add(chapter.chapterNumber);
  }

  return value as SourceNovel;
}

export function enqueueNovelMergeTargetPreviewTask({
  item,
  manager,
  pluginId,
  title,
}: EnqueueNovelMergeTargetPreviewOptions): TaskHandle<SourceNovel> {
  const plugin = manager.getPlugin(pluginId);
  if (!plugin) {
    throw new Error(`Plugin '${pluginId}' is not installed.`);
  }

  return enqueueSourceTask<SourceNovel>({
    plugin,
    kind: "source.previewNovel",
    priority: "interactive",
    title,
    subject: { novelName: item.name, novelPath: item.path },
    dedupeKey: `source.novelMergePreview:${pluginId}:${item.path}`,
    run: async ({ executor }) =>
      validateNovelMergeTargetPreview(
        await manager
          .getPluginForExecutor(pluginId, executor ?? "immediate")
          .parseNovel(item.path),
      ),
  });
}
