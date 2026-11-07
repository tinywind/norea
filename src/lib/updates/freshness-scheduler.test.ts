import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  candidates: [] as unknown[],
  recent: new Map<string, number>(),
  budget: { metered: false, powerSave: false, freeBytes: null },
  online: true,
  records: [] as { kind: string; status: string }[],
  check: vi.fn(),
  checkNovel: vi.fn(),
  novel: null as unknown,
  serverSource: null as unknown,
  lastCheckedAt: null as number | null,
}));
vi.mock("../../db/queries/novel-freshness", () => ({
  listCheckCandidates: vi.fn(async () => mocks.candidates),
  countRecentChecksBySource: async () => mocks.recent,
  getNovelFreshness: async () => ({ lastCheckedAt: mocks.lastCheckedAt }),
}));
vi.mock("../../db/queries/novel", () => ({ getNovelById: async () => mocks.novel }));
vi.mock("../content-sync/novel-source", () => ({ readServerNovelSource: async () => mocks.serverSource }));
vi.mock("../../i18n", () => ({ translate: (_locale: string, key: string) => key }));
vi.mock("../download-goals/budget", () => ({ readDownloadBudgetStatus: async () => mocks.budget }));
vi.mock("../network", () => ({ isNetworkOnline: () => mocks.online }));
vi.mock("../plugins/manager", () => ({
  pluginManager: { loadInstalledFromDb: async () => undefined, getPlugin: (id: string) => (id === "gone" ? undefined : { id }) },
}));
vi.mock("../tasks/scheduler", () => ({ taskScheduler: { getSnapshot: () => ({ records: mocks.records }), cancel: vi.fn() } }));
vi.mock("./check-library-updates", () => ({ checkForNewChapters: mocks.check, checkNovelForNewChapters: mocks.checkNovel }));

import { listCheckCandidates } from "../../db/queries/novel-freshness";
import { ACTIVE_NOVEL_WINDOW_SECONDS } from "../download-goals/goal-targets";
import { useDownloadGoalSettingsStore } from "../../store/download-goals";
import { useLibraryStore } from "../../store/library";
import { checkNovelIfStale, resetFreshnessChecksForTests, runDueChecks } from "./freshness-scheduler";

const candidate = (novelId: number, pluginId = "s") => ({
  novelId, pluginId, status: null, lastReadAt: 10, lastCheckedAt: null, consecutiveFailures: 0,
  totalChapters: 5, unreadChapters: 2, hasGoal: false,
});

beforeEach(() => {
  mocks.candidates = [candidate(1), candidate(2, "gone")];
  mocks.recent = new Map();
  mocks.budget = { metered: false, powerSave: false, freeBytes: null };
  mocks.online = true;
  mocks.records = [];
  mocks.check.mockReset().mockResolvedValue({});
  mocks.checkNovel.mockReset().mockReturnValue({ id: "task", promise: Promise.resolve({}) });
  mocks.novel = { id: 7, pluginId: "s", path: "/n", name: "N", isLocal: false, inLibrary: true };
  mocks.serverSource = null;
  mocks.lastCheckedAt = null;
  useLibraryStore.setState({ checkIntervalHours: 12 });
  useDownloadGoalSettingsStore.setState({ automaticGoal: { kind: "keep_ahead", count: 3 }, automaticOnMobileData: false });
  vi.mocked(listCheckCandidates).mockClear();
});

afterEach(() => { resetFreshnessChecksForTests(); });

it("checks the due novels whose source is installed", async () => {
  await runDueChecks(1_000_000);
  expect(mocks.check).toHaveBeenCalledWith(expect.objectContaining({ novelIds: [1] }));
});

it("does nothing when automatic checks are off, offline, already running or under a budget", async () => {
  useLibraryStore.setState({ checkIntervalHours: 0 });
  await runDueChecks(1_000_000);
  useLibraryStore.setState({ checkIntervalHours: 12 });
  mocks.online = false;
  await runDueChecks(1_000_000);
  mocks.online = true;
  mocks.records = [{ kind: "library.checkUpdates", status: "running" }];
  await runDueChecks(1_000_000);
  mocks.records = [];
  mocks.budget = { metered: true, powerSave: false, freeBytes: null };
  await runDueChecks(1_000_000);
  mocks.budget = { metered: false, powerSave: true, freeBytes: null };
  await runDueChecks(1_000_000);
  expect(mocks.check).not.toHaveBeenCalled();

  mocks.budget = { metered: true, powerSave: false, freeBytes: null };
  useDownloadGoalSettingsStore.setState({ automaticOnMobileData: true });
  await runDueChecks(1_000_000);
  expect(mocks.check).toHaveBeenCalledOnce();
});

it("waits for the next interval after the user cancels an automatic check", async () => {
  mocks.check.mockRejectedValueOnce(new DOMException("Task was cancelled.", "AbortError"));
  await runDueChecks(1_000_000);
  await runDueChecks(1_000_000 + 11 * 3_600_000);
  expect(mocks.check).toHaveBeenCalledOnce();
  await runDueChecks(1_000_000 + 12 * 3_600_000);
  expect(mocks.check).toHaveBeenCalledTimes(2);
});

it("checks a novel opened after 6 hours without a check, once within the source budget", async () => {
  const now = 100 * 3_600_000;
  const onStart = vi.fn();
  expect(await checkNovelIfStale(7, "title", new AbortController().signal, { nowMs: now, onStart })).toBe(true);
  expect(onStart).toHaveBeenCalledOnce();
  expect(mocks.checkNovel).toHaveBeenCalledWith({ id: "s" }, mocks.novel, { title: "title" });

  mocks.lastCheckedAt = now / 1000 - 5 * 3600;
  expect(await checkNovelIfStale(7, "title", new AbortController().signal, { nowMs: now })).toBe(false);
  mocks.lastCheckedAt = now / 1000 - 6 * 3600;
  mocks.recent = new Map([["s", 30]]);
  expect(await checkNovelIfStale(7, "title", new AbortController().signal, { nowMs: now })).toBe(false);
  expect(mocks.checkNovel).toHaveBeenCalledOnce();
});

it("checks a content-server work outside the library but never a browsed novel or a local work", async () => {
  mocks.novel = { id: 7, pluginId: "s", path: "/n", name: "N", isLocal: false, inLibrary: false };
  expect(await checkNovelIfStale(7, "title", new AbortController().signal)).toBe(false);
  mocks.serverSource = { serverUrl: "http://server", workId: "w" };
  expect(await checkNovelIfStale(7, "title", new AbortController().signal)).toBe(true);
  mocks.novel = { id: 7, pluginId: "local", path: "/n", name: "N", isLocal: true, inLibrary: true };
  expect(await checkNovelIfStale(7, "title", new AbortController().signal)).toBe(false);
  expect(mocks.checkNovel).toHaveBeenCalledOnce();
});

it("passes the current global automatic eligibility into check priority", async () => {
  const now = 20 * ACTIVE_NOVEL_WINDOW_SECONDS;
  await runDueChecks(now * 1000);
  expect(listCheckCandidates).toHaveBeenLastCalledWith(now - ACTIVE_NOVEL_WINDOW_SECONDS);
  useDownloadGoalSettingsStore.getState().setAutomaticGoal({ kind: "none" });
  await runDueChecks(now * 1000);
  expect(listCheckCandidates).toHaveBeenLastCalledWith(null);
});
