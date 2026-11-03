import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  novels: [] as unknown[],
  chapters: new Map<number, unknown[]>(),
  excluded: new Map<number, number[]>(),
  failed: [] as { chapterId: number }[],
  plugins: new Set(["source"]),
  queued: new Set<number>(),
}));
vi.mock("../../db/queries/chapter", () => ({
  hasStoredChapterContent: (row: { isDownloaded: boolean; contentBytes: number }) => row.isDownloaded || row.contentBytes > 0,
  listLibraryDownloadChapters: async (novelId: number) => mocks.chapters.get(novelId) ?? [],
}));
vi.mock("../../db/queries/novel-download-goal", () => ({
  listDownloadGoalNovels: async () => mocks.novels,
  listDownloadGoalExcludedChapterIds: async (novelId: number) => mocks.excluded.get(novelId) ?? [],
}));
vi.mock("../plugins/manager", () => ({
  pluginManager: { loadInstalledFromDb: async () => undefined, getPlugin: (id: string) => mocks.plugins.has(id) ? { id } : undefined },
}));
vi.mock("../tasks/chapter-download", () => ({ isChapterDownloadQueued: (id: number) => mocks.queued.has(id) }));
vi.mock("../tasks/chapter-download-failures", () => ({ getChapterDownloadFailureSnapshot: () => mocks.failed }));

import { useDownloadGoalSettingsStore } from "../../store/download-goals";
import { useReaderStore } from "../../store/reader";
import { describeDownloadGoalOfflineStates } from "./goal-offline-state";

const row = (id: number, extra: Record<string, unknown> = {}) => ({
  id, isDownloaded: false, contentBytes: 0, mediaRepairNeeded: false, readAt: null, isDownloadQueued: false, ...extra,
});
const stored = { isDownloaded: true, contentBytes: 5 };
const novel = (id: number, extra: Record<string, unknown> = {}) =>
  ({ id, pluginId: "source", path: `/${id}`, name: `N${id}`, lastReadAt: 1, goal: null, ...extra });

beforeEach(() => {
  useDownloadGoalSettingsStore.setState({ defaultKeepAhead: 1 });
  useReaderStore.setState({ lastReadChapterByNovel: { 1: 10, 2: 20, 3: 30, 4: 40, 5: 50 } });
  mocks.novels = [novel(1), novel(2), novel(3), novel(4, { goal: { kind: "entire" } }), novel(5, { pluginId: "gone" }), novel(6)];
  mocks.chapters = new Map([
    [1, [row(10), row(11, stored)]],
    [2, [row(20), row(21, { isDownloadQueued: true })]],
    [3, [row(30), row(31)]],
    [4, [row(40, stored), row(41, { ...stored, mediaRepairNeeded: true })]],
    [6, [row(60, stored), row(61)]],
  ]);
  mocks.excluded = new Map([[6, [61]]]);
  mocks.failed = [{ chapterId: 31 }];
});

it("reports ready, downloading and attention per goal novel", async () => {
  expect(Object.fromEntries(await describeDownloadGoalOfflineStates())).toEqual({
    1: "ready", 2: "downloading", 3: "attention", 4: "attention", 5: "attention", 6: "ready",
  });
});
