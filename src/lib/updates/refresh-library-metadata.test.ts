import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ targets: vi.fn(), plugin: vi.fn(), sync: vi.fn(), enqueue: vi.fn() }));
vi.mock("../../db/queries/novel", () => ({ listLibraryNovelRefreshTargets: mocks.targets }));
vi.mock("../plugins/manager", () => ({ pluginManager: { getPlugin: mocks.plugin, getPluginForExecutor: mocks.plugin } }));
vi.mock("../plugins/sync-novel", () => ({ syncNovelFromSource: mocks.sync }));
vi.mock("../tasks/source-tasks", () => ({ enqueueSourceTask: mocks.enqueue }));
vi.mock("../tasks/scheduler", () => ({ taskScheduler: { enqueueMain: mocks.enqueue } }));
vi.mock("./update-index-events", () => ({ markUpdatesIndexDirty: vi.fn() }));

import { refreshLibraryMetadata } from "./refresh-library-metadata";

it("refreshes web covers for all works selected by an explicit library metadata update", async () => {
  const novels = [
    { id: 1, name: "First", path: "/first", cover: "/cover.jpg", pluginId: "demo", isLocal: false },
    { id: 2, name: "Second", path: "/second", cover: null, pluginId: "demo", isLocal: false },
  ];
  mocks.targets.mockResolvedValue(novels);
  mocks.plugin.mockReturnValue({ id: "demo" });
  mocks.sync.mockResolvedValue({ changed: false });
  mocks.enqueue.mockImplementation(options => ({
    promise: options.run({ signal: new AbortController().signal, executor: "background", setProgress: vi.fn(), setDetail: vi.fn() }),
  }));

  await expect(refreshLibraryMetadata()).resolves.toMatchObject({ checkedNovels: 2, failures: [] });
  expect(mocks.sync).toHaveBeenCalledTimes(2);
  for (const novel of novels) {
    expect(mocks.sync).toHaveBeenCalledWith(
      { id: "demo" },
      expect.objectContaining({ path: novel.path }),
      expect.objectContaining({ novelId: novel.id, refreshCover: true }),
    );
  }
});
