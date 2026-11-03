import type { TaskEvent, TaskRecord } from "../tasks/task-types";

const SAMPLE_LIMIT = 20;
/** Server-lane transfers are timed apart from any source. */
export const SERVER_LANE_ETA_KEY = "content-server";

/** Recent chapter download durations, per source id or the server lane; kept in memory only. */
const samples = new Map<string, number[]>();

function sampleKey(task: TaskRecord): string | null {
  if (task.chapterDownloadPhase === "server-download") return SERVER_LANE_ETA_KEY;
  return task.source?.id ?? null;
}

export function recordChapterDownloadDuration({ task, previousStatus }: TaskEvent): void {
  if (task.kind !== "chapter.download" || task.status !== "succeeded" || previousStatus !== "running") return;
  if (task.startedAt === undefined || task.finishedAt === undefined) return;
  const key = sampleKey(task);
  const duration = task.finishedAt - task.startedAt;
  if (key === null || !Number.isFinite(duration) || duration < 0) return;
  const recent = samples.get(key) ?? [];
  recent.push(duration);
  if (recent.length > SAMPLE_LIMIT) recent.shift();
  samples.set(key, recent);
}

export function averageChapterDurationMs(key: string): number | null {
  const recent = samples.get(key);
  if (!recent?.length) return null;
  return recent.reduce((total, duration) => total + duration, 0) / recent.length;
}

/**
 * Time until a novel's queued chapter downloads finish: its last position in each
 * source's serial order times that source's average chapter time plus cooldown.
 * Null until the source has a measured chapter.
 */
export function estimateNovelDownloadMs(
  novelId: number,
  records: readonly TaskRecord[],
  cooldownMs: number,
): number | null {
  const lastPositionBySource = new Map<string, number>();
  for (const record of records) {
    if (record.kind !== "chapter.download" || record.subject?.novelId !== novelId || !record.source) continue;
    if (record.status !== "queued" && record.status !== "running") continue;
    const position = (record.status === "running" ? 0 : record.queueIndex ?? 0) + 1;
    lastPositionBySource.set(record.source.id, Math.max(lastPositionBySource.get(record.source.id) ?? 0, position));
  }
  let longest: number | null = null;
  for (const [sourceId, position] of lastPositionBySource) {
    const average = averageChapterDurationMs(sourceId);
    if (average === null) return null;
    longest = Math.max(longest ?? 0, position * (average + cooldownMs));
  }
  return longest;
}

/** How a novel's running download reaches its chapters right now. */
export function novelDownloadRoute(novelId: number, records: readonly TaskRecord[]): "source" | "server" | "vpn" | null {
  let route: "source" | "server" | "vpn" | null = null;
  for (const record of records) {
    if (record.kind !== "chapter.download" || record.status !== "running" || record.subject?.novelId !== novelId) continue;
    if (record.vpnWorker) return "vpn";
    if (record.chapterDownloadPhase === "server-lookup" || record.chapterDownloadPhase === "server-download") route = "server";
    else route ??= "source";
  }
  return route;
}

export function resetDownloadEtaForTests(): void {
  samples.clear();
}
