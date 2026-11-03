import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  candidates: [] as unknown[],
  recent: new Map<string, number>(),
  budget: { metered: false, powerSave: false, freeBytes: null },
  online: true,
  records: [] as { kind: string; status: string }[],
  check: vi.fn(),
}));
vi.mock("../../db/queries/novel-freshness", () => ({
  listCheckCandidates: async () => mocks.candidates,
  countRecentChecksBySource: async () => mocks.recent,
}));
vi.mock("../../i18n", () => ({ translate: (_locale: string, key: string) => key }));
vi.mock("../download-goals/budget", () => ({ readDownloadBudgetStatus: async () => mocks.budget }));
vi.mock("../network", () => ({ isNetworkOnline: () => mocks.online }));
vi.mock("../plugins/manager", () => ({
  pluginManager: { loadInstalledFromDb: async () => undefined, getPlugin: (id: string) => (id === "gone" ? undefined : { id }) },
}));
vi.mock("../tasks/scheduler", () => ({ taskScheduler: { getSnapshot: () => ({ records: mocks.records }) } }));
vi.mock("./check-library-updates", () => ({ checkForNewChapters: mocks.check }));

import { useDownloadGoalSettingsStore } from "../../store/download-goals";
import { useLibraryStore } from "../../store/library";
import { resetFreshnessChecksForTests, runDueChecks } from "./freshness-scheduler";

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
  useLibraryStore.setState({ checkIntervalHours: 12 });
  useDownloadGoalSettingsStore.setState({ automaticOnMobileData: false });
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
