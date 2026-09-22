import {
  findLocalNovelByPath,
  type LocalNovelImportResult,
} from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import {
  analyzeLocalImportFile,
  LocalImportError,
  type LocalImportAnalysis,
  type LocalImportFormat,
} from "../../lib/local-import";
import { type TranslateFn } from "./LibraryFilters";
type LocalImportReviewStatus =
  | "ready"
  | "duplicate"
  | "unsupported"
  | "error"
  | "importing"
  | "imported";

export interface LocalImportReviewItem {
  analysis?: LocalImportAnalysis;
  duplicateKind?: "library" | "selection";
  error?: string;
  existingNovelId?: number;
  file: File;
  format?: LocalImportFormat;
  id: string;
  importedChapterCount?: number;
  importedNovelId?: number;
  status: LocalImportReviewStatus;
}

export interface LocalImportItemResult {
  error?: string;
  itemId: string;
  result?: LocalNovelImportResult;
  status: "error" | "imported";
}

export async function analyzeLocalImportReviewItem(
  file: File,
  index: number,
): Promise<LocalImportReviewItem> {
  const id = `${file.name}:${file.size}:${file.lastModified}:${index}`;

  try {
    const analysis = await analyzeLocalImportFile(file);
    const existingNovel = await findLocalNovelByPath(analysis.pathKey);

    return {
      analysis,
      duplicateKind: existingNovel ? "library" : undefined,
      existingNovelId: existingNovel?.id,
      file,
      format: analysis.format,
      id,
      status: existingNovel ? "duplicate" : "ready",
    };
  } catch (error) {
    return {
      error: getLocalImportErrorMessage(error),
      file,
      id,
      status: isUnsupportedLocalImportError(error) ? "unsupported" : "error",
    };
  }
}

export function markSelectedLocalImportDuplicates(
  items: readonly LocalImportReviewItem[],
): LocalImportReviewItem[] {
  const seenPathKeys = new Set<string>();

  return items.map((item) => {
    if (item.status !== "ready" || !item.analysis) return item;
    if (seenPathKeys.has(item.analysis.pathKey)) {
      return {
        ...item,
        duplicateKind: "selection",
        status: "duplicate",
      };
    }

    seenPathKeys.add(item.analysis.pathKey);
    return item;
  });
}

export function createManualLocalNovelPath(): string {
  const id =
    globalThis.crypto && "randomUUID" in globalThis.crypto
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `local:manual:${id}`;
}

export function getLocalImportErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnsupportedLocalImportError(error: unknown): boolean {
  return (
    error instanceof LocalImportError &&
    error.message.startsWith("Unsupported local import format:")
  );
}

export function getLocalImportStatusLabel(
  status: LocalImportReviewStatus,
  t: TranslateFn,
): string {
  switch (status) {
    case "ready":
      return t("library.localImport.status.ready");
    case "duplicate":
      return t("library.localImport.status.duplicate");
    case "unsupported":
      return t("library.localImport.status.unsupported");
    case "error":
      return t("library.localImport.status.error");
    case "importing":
      return t("library.localImport.status.importing");
    case "imported":
      return t("library.localImport.status.imported");
  }
}

export function getLocalImportStatusDetail(
  item: LocalImportReviewItem,
  t: TranslateFn,
): string | null {
  if (item.status === "duplicate") {
    return item.duplicateKind === "selection"
      ? t("library.localImport.duplicateSelected")
      : t("library.localImport.duplicateLibrary");
  }

  if (item.status === "unsupported" || item.status === "error") {
    return item.error ?? t("library.localImport.error");
  }

  if (item.status === "imported") {
    return t("library.localImport.importedDetail", {
      count: item.importedChapterCount ?? 0,
    });
  }

  return null;
}

export function getLocalImportSummary(
  items: readonly LocalImportReviewItem[],
  t: TranslateFn,
): string {
  if (items.length === 0) return t("library.localImport.empty");

  const ready = items.filter((item) => item.status === "ready").length;
  const imported = items.filter((item) => item.status === "imported").length;
  const blocked = items.filter(
    (item) =>
      item.status === "duplicate" ||
      item.status === "unsupported" ||
      item.status === "error",
  ).length;

  return t("library.localImport.summary", {
    blocked,
    imported,
    ready,
    total: items.length,
  });
}

export function formatLocalImportFileSize(
  bytes: number,
  locale: ReturnType<typeof useTranslation>["locale"],
): string {
  if (bytes < 1024) {
    return `${new Intl.NumberFormat(locale).format(bytes)} B`;
  }

  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: value >= 10 ? 0 : 1,
  }).format(value)} ${units[unitIndex]}`;
}
