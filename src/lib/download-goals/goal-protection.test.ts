import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  novels: [{ id: 1, goal: { kind: "entire" } }],
  chapters: [10, 11, 12, 13].map(id => ({ id, isDownloaded: true, contentBytes: 5, mediaRepairNeeded: false, readAt: null })),
}));
vi.mock("../../db/queries/chapter", () => ({ listLibraryDownloadChapters: async () => mocks.chapters }));
vi.mock("../../db/queries/novel-download-goal", () => ({ listDownloadGoalNovels: async () => mocks.novels }));

import { useDownloadGoalSettingsStore } from "../../store/download-goals";
import { useReaderStore } from "../../store/reader";
import { listGoalProtectedChapterIds } from "./goal-protection";

beforeEach(() => {
  useDownloadGoalSettingsStore.setState({ automaticGoal: { kind: "keep_ahead", count: 1 } });
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
