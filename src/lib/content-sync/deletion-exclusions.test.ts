import { beforeEach, expect, it, vi } from "vitest";
import { listNovelMigrations, readContentSyncCache, writeContentSyncCache } from "../../db/queries/content-sync";
import { readServerWorkDeletionExclusions, recordServerWorkDeletionExclusion, withServerWorkDeletionExclusions } from "./deletion-exclusions";

vi.mock("../../db/queries/content-sync", () => ({ listNovelMigrations: vi.fn(async () => []), isNovelMigrationSourceHeldInDb: vi.fn(async () => false), readContentSyncCache: vi.fn(), writeContentSyncCache: vi.fn() }));
const memory = new Map<string, string>();
beforeEach(() => {
  memory.clear(); vi.clearAllMocks();
  vi.mocked(listNovelMigrations).mockResolvedValue([]);
  vi.mocked(readContentSyncCache).mockImplementation(async key => memory.get(key) ?? null);
  vi.mocked(writeContentSyncCache).mockImplementation(async (key, value) => { memory.set(key, value); });
});

it("includes a deletion recorded before a new subscriber while its persistence is pending", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(writeContentSyncCache).mockImplementationOnce(async (key, value) => { await gate; memory.set(key, value); });
  const deletion = recordServerWorkDeletionExclusion("http://server", { pluginId: "source", novelId: "book" });
  await vi.waitFor(() => expect(writeContentSyncCache).toHaveBeenCalledOnce());
  const observed = withServerWorkDeletionExclusions("http://server/", async excluded => {
    await gate;
    return excluded.has("contents/source/book");
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  release();
  await deletion;
  expect(await observed).toBe(true);
});

it("preserves both work exclusions when deletion responses arrive together", async () => {
  await Promise.all(["one", "two"].map(novelId => recordServerWorkDeletionExclusion("http://server", { pluginId: "source", novelId })));
  expect(await readServerWorkDeletionExclusions("http://server")).toEqual(new Set(["contents/source/one", "contents/source/two"]));
});

it("includes pending and completed migration holds without removing existing deletions", async () => {
  vi.mocked(listNovelMigrations).mockResolvedValue([
    { source: { pluginId: "source", novelId: "pending" }, status: "pending" },
    { source: { pluginId: "source", novelId: "complete" }, status: "completed" },
  ] as never);
  memory.set("norea-content-work-deletions:http://server", JSON.stringify(["contents/source/deleted"]));
  expect(await readServerWorkDeletionExclusions("http://server")).toEqual(new Set([
    "contents/source/pending", "contents/source/complete", "contents/source/deleted",
  ]));
  expect(listNovelMigrations).toHaveBeenCalledWith("http://server", true);
});
