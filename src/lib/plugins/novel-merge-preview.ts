import { enqueueSourceTask } from "../tasks/source-tasks";
import type { ScraperExecutorId } from "../tasks/scraper-queue";
import type { TaskHandle } from "../tasks/scheduler";
import { isKnownChapterContentType } from "../chapter-content";
import {
  NovelStatus,
  type NovelItem,
  type Plugin,
  type SourceNovel,
} from "./types";

const OPTIONAL_NOVEL_STRING_FIELDS = [
  "artist",
  "author",
  "cover",
  "genres",
  "summary",
] as const;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function validateNovelMergeTargetPreview(value: unknown): SourceNovel {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    value.name.trim() === "" ||
    typeof value.path !== "string" ||
    value.path.trim() === ""
  ) {
    throw new NovelMergePreviewValidationError(
      "Target preview is missing its novel name or path.",
    );
  }
  if (!Array.isArray(value.chapters)) {
    throw new NovelMergePreviewValidationError(
      "Target preview did not return a chapter list.",
    );
  }
  for (const field of OPTIONAL_NOVEL_STRING_FIELDS) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new NovelMergePreviewValidationError(
        `Target preview field '${field}' must be a string.`,
      );
    }
  }
  if (
    value.status !== undefined &&
    !Object.values(NovelStatus).includes(value.status as NovelStatus)
  ) {
    throw new NovelMergePreviewValidationError(
      "Target preview field 'status' is unsupported.",
    );
  }
  if (
    value.totalPages !== undefined &&
    (typeof value.totalPages !== "number" ||
      !Number.isFinite(value.totalPages))
  ) {
    throw new NovelMergePreviewValidationError(
      "Target preview field 'totalPages' must be finite.",
    );
  }

  const chapterPaths = new Set<string>();
  const chapterNumbers = new Set<number>();
  for (const [index, chapter] of value.chapters.entries()) {
    if (
      !isRecord(chapter) ||
      typeof chapter.name !== "string" ||
      chapter.name.trim() === "" ||
      typeof chapter.path !== "string" ||
      chapter.path.trim() === ""
    ) {
      throw new NovelMergePreviewValidationError(
        `Target preview chapter ${index + 1} has no name or path.`,
      );
    }
    if (
      typeof chapter.chapterNumber !== "number" ||
      !Number.isFinite(chapter.chapterNumber)
    ) {
      throw new NovelMergePreviewValidationError(
        `Target preview chapter ${index + 1} must have a finite chapterNumber.`,
      );
    }
    if (
      chapter.contentType !== undefined &&
      !isKnownChapterContentType(chapter.contentType)
    ) {
      throw new NovelMergePreviewValidationError(
        `Target preview chapter ${index + 1} has an unsupported contentType.`,
      );
    }
    if (
      (chapter.page !== undefined && typeof chapter.page !== "string") ||
      (chapter.releaseTime !== undefined &&
        typeof chapter.releaseTime !== "string")
    ) {
      throw new NovelMergePreviewValidationError(
        `Target preview chapter ${index + 1} has invalid optional metadata.`,
      );
    }
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

  return value as unknown as SourceNovel;
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
