import type { TaskKind, TaskRecord, TaskSpec } from "./task-types";

interface ExecutorCandidate {
  record: Pick<TaskRecord, "kind" | "priority">;
  spec: Pick<TaskSpec<unknown>, "requiresForegroundExecutor">;
}

export function isOpenSiteSourceKind(kind: TaskKind): boolean {
  return kind === "source.openSite";
}

function isImmediateBrowseSourceKind(kind: TaskKind): boolean {
  return (
    kind === "source.openNovel" ||
    kind === "source.previewNovel" ||
    kind === "source.mergeNovel" ||
    kind === "source.listPopular" ||
    kind === "source.listLatest" ||
    kind === "source.search"
  );
}

function isUiResponsiveSourceKind(kind: TaskKind): boolean {
  return (
    isOpenSiteSourceKind(kind) ||
    isImmediateBrowseSourceKind(kind) ||
    kind === "source.clearCookies" ||
    kind === "source.globalSearch" ||
    kind === "source.refreshNovel"
  );
}

export function isUiInteraction(entry: ExecutorCandidate): boolean {
  return (
    entry.record.priority === "interactive" ||
    (entry.record.priority === "user" && isUiResponsiveSourceKind(entry.record.kind))
  );
}

export function usesSearchExecutor(entry: ExecutorCandidate): boolean {
  return entry.record.kind === "source.globalSearch" && isUiInteraction(entry);
}

export function isInterruptibleDownloadKind(kind: TaskKind): boolean {
  return kind === "chapter.download" || kind === "chapter.repairMedia";
}

export function shouldUseImmediateExecutor(entry: ExecutorCandidate): boolean {
  if (entry.spec.requiresForegroundExecutor) return true;
  if (isOpenSiteSourceKind(entry.record.kind)) return true;
  return isUiInteraction(entry) && !usesSearchExecutor(entry);
}

export function canUsePoolExecutorForImmediateInteraction(entry: ExecutorCandidate): boolean {
  return (
    entry.spec.requiresForegroundExecutor !== true &&
    !isOpenSiteSourceKind(entry.record.kind) &&
    !usesSearchExecutor(entry) &&
    isUiInteraction(entry)
  );
}
