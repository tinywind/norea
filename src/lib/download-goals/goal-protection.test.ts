import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  novels: [{ id: 1, goal: { kind: "entire" } }],
  chapters: [10, 11, 12, 13].map(id => ({ id, isDownloaded: true, contentBytes: 5, mediaRepairNeeded: false, readAt: null })),
  listDownloadGoalNovels: vi.fn(),
}));
vi.mock("../../db/queries/chapter", () => ({ listLibraryDownloadChapters: async () => mocks.chapters }));
vi.mock("../../db/queries/novel-download-goal", () => ({
  listDownloadGoalNovels: (...args: unknown[]) => mocks.listDownloadGoalNovels(...args),
}));

import { useDownloadGoalSettingsStore } from "../../store/download-goals";
import { useReaderStore } from "../../store/reader";
import { listGoalProtectedChapterIds } from "./goal-protection";

beforeEach(() => {
  mocks.listDownloadGoalNovels.mockReset().mockImplementation(async () => mocks.novels);
  useDownloadGoalSettingsStore.setState({
    automaticGoal: { kind: "keep_ahead", count: 1 },
    automaticActiveWindow: 14,
  });
  useReaderStore.setState({ lastReadChapterByNovel: { 1: 11 } });
});

it("protects the global range rather than a retained positive per-work goal", async () => {
  expect(await listGoalProtectedChapterIds([1])).toEqual(new Set([12]));
});

it("protects every covered chapter from cleanup under the global entire policy", async () => {
  useDownloadGoalSettingsStore.getState().setAutomaticGoal({ kind: "entire" });
  expect(await listGoalProtectedChapterIds([1])).toEqual(new Set([10, 11, 12, 13]));
});

it("adds no global goal protection while the global policy is off", async () => {
  useDownloadGoalSettingsStore.getState().setAutomaticGoal({ kind: "none" });
  expect(await listGoalProtectedChapterIds([1])).toEqual(new Set());
});

it("shares the configured active window (including unlimited) with automatic download targeting", async () => {
  useDownloadGoalSettingsStore.getState().setAutomaticActiveWindow("unlimited");
  await listGoalProtectedChapterIds([1]);
  expect(mocks.listDownloadGoalNovels).toHaveBeenCalledWith({ kind: "all" }, [1]);

  useDownloadGoalSettingsStore.getState().setAutomaticActiveWindow(30);
  await listGoalProtectedChapterIds([1]);
  expect(mocks.listDownloadGoalNovels).toHaveBeenLastCalledWith(
    { kind: "since", seconds: expect.any(Number) },
    [1],
  );
});
