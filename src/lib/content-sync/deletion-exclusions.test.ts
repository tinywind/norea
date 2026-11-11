import { beforeEach, expect, it, vi } from "vitest";
import { listIncomingMigrations } from "./migration-feed-state";
vi.mock("./migration-feed-state", () => ({ listIncomingMigrations: vi.fn(async () => []) }));
import { listNovelMigrations, readContentSyncCache, writeContentSyncCache } from "../../db/queries/content-sync";
import {
  readServerChapterDeletionExclusions,
  readServerWorkDeletionExclusions,
  recordServerWorkDeletionExclusion,
  setServerChapterDeletionExclusion,
  withServerWorkDeletionExclusions,
} from "./deletion-exclusions";

vi.mock("../../db/queries/content-sync", () => ({ listNovelMigrations: vi.fn(async () => []), isNovelMigrationSourceHeldInDb: vi.fn(async () => false), readContentSyncCache: vi.fn(), writeContentSyncCache: vi.fn() }));
const memory = new Map<string, string>();
beforeEach(() => {
  memory.clear(); vi.clearAllMocks();
  vi.mocked(listIncomingMigrations).mockResolvedValue([]);
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

it("holds active received sources and pending targets, but releases inactive migrations", async () => {
  const record = (from: string, to: string, status: string) => ({
    source: { pluginId: from, novelId: "work" }, target: { pluginId: to, novelId: "work" }, status,
    lineage: { sourceWork: { id: from }, targetWork: { id: to, identity: { pluginId: to, novelId: "work" } } },
  });
  vi.mocked(listIncomingMigrations).mockResolvedValue([
    record("source", "target", "blocked"), record("finished", "current", "completed"), record("restored", "unrelated", "inactive"),
  ] as never);
  expect(await readServerWorkDeletionExclusions("http://server")).toEqual(new Set([
    "contents/source/work", "contents/target/work", "contents/finished/work",
  ]));
  expect(listIncomingMigrations).toHaveBeenCalledWith("http://server", true);
});

it("holds the final target while an earlier incoming migration remains unresolved", async () => {
  const record = (from: string, to: string, status: string) => ({
    source: { pluginId: from, novelId: "work" }, target: { pluginId: to, novelId: "work" }, status,
    lineage: { sourceWork: { id: from }, targetWork: { id: to, identity: { pluginId: to, novelId: "work" } } },
  });
  vi.mocked(listIncomingMigrations).mockResolvedValue([record("a", "b", "failed"), record("b", "c", "completed")] as never);
  expect(await readServerWorkDeletionExclusions("http://server")).toEqual(new Set([
    "contents/a/work", "contents/b/work", "contents/c/work",
  ]));
});

it("persists an explicit deletion without copying unrelated received holds", async () => {
  const source = { pluginId: "source", novelId: "work" };
  vi.mocked(listIncomingMigrations).mockResolvedValue([{ source, target: source, status: "completed",
    lineage: { sourceWork: { id: "source" }, targetWork: { id: "target", identity: source } } }] as never);
  await recordServerWorkDeletionExclusion("http://server", { pluginId: "other", novelId: "work" });
  expect(JSON.parse(memory.get("norea-content-work-deletions:http://server")!)).toEqual(["contents/other/work"]);
  await recordServerWorkDeletionExclusion("http://server", source);
  vi.mocked(listIncomingMigrations).mockResolvedValue([]);
  expect(await readServerWorkDeletionExclusions("http://server")).toEqual(new Set(["contents/other/work", "contents/source/work"]));
});

it("preserves concurrent chapter deletion exclusions on the same server", async () => {
  await Promise.all([
    setServerChapterDeletionExclusion("http://server", { pluginId: "source", novelId: "book", novelPath: "/book", chapterPath: "/ch/1" }, "1", true),
    setServerChapterDeletionExclusion("http://server/", { pluginId: "source", novelId: "book", novelPath: "/book", chapterPath: "/prologue" }, null, true),
  ]);
  const excluded = await readServerChapterDeletionExclusions("http://server");
  expect(excluded).toEqual(new Set([
    '["source","book",["number",1]]',
    '["source","book",["path","/prologue"]]',
  ]));
});
