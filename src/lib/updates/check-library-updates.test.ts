import { beforeEach, expect, it, vi } from "vitest";

const scheduler = vi.hoisted(() => ({
  cancel: vi.fn(() => true),
  getTaskByDedupeKey: vi.fn<(key: string) => { id: string } | undefined>(),
}));

vi.mock("../../db/client", () => ({ getDb: vi.fn() }));
vi.mock("../../db/queries/chapter", () => ({ listLibraryUpdatesPage: vi.fn() }));
vi.mock("../plugins/manager", () => ({ pluginManager: {} }));
vi.mock("../plugins/sync-novel", () => ({ syncNovelFromSource: vi.fn() }));
vi.mock("../tasks/source-tasks", () => ({ enqueueSourceTask: vi.fn() }));
vi.mock("../tasks/scheduler", () => ({ taskScheduler: scheduler }));

import { cancelLibraryUpdateCheck } from "./check-library-updates";

beforeEach(() => {
  scheduler.cancel.mockClear();
  scheduler.getTaskByDedupeKey.mockReset();
});

it("cancels the latest library update check task", () => {
  scheduler.getTaskByDedupeKey.mockReturnValue({ id: "task-7" });
  expect(cancelLibraryUpdateCheck()).toBe(true);
  expect(scheduler.getTaskByDedupeKey).toHaveBeenCalledWith("library.checkUpdates");
  expect(scheduler.cancel).toHaveBeenCalledWith("task-7");
});

it("does nothing when no check has run", () => {
  expect(cancelLibraryUpdateCheck()).toBe(false);
  expect(scheduler.cancel).not.toHaveBeenCalled();
});
