import { beforeEach, expect, it, vi } from "vitest";
import type Database from "@tauri-apps/plugin-sql";
vi.mock("./migration-feed-state", () => ({ listIncomingMigrations: vi.fn(async () => []) }));
vi.mock("./chapters", () => ({ fetchServerChapters: vi.fn(async () => []) }));
vi.mock("../../db/queries/content-sync", () => ({ listNovelMigrations: vi.fn(async () => []), isNovelMigrationSourceHeldInDb: vi.fn(async () => false), cacheServerChapters: vi.fn(), readContentSyncCache: vi.fn(async () => null), writeContentSyncCache: vi.fn() }));
vi.mock("./client", async original => ({ ...await original<typeof import("./client")>(), contentServerRequest: vi.fn() }));
vi.mock("./device", () => ({ registerContentDevice: vi.fn(async () => "device") }));
vi.mock("./novel-source", () => ({ rememberServerNovelSource: vi.fn() }));
vi.mock("../work-metadata", async original => ({ ...await original<typeof import("../work-metadata")>(), installStoredNovelMetadata: vi.fn(),
  availableNovelMetadataDirectory: vi.fn(async () => "contents/source/book"), readStoredNovelMetadata: vi.fn(async () => null),
}));
vi.mock("../../db/work-metadata", async original => ({
  ...await original<typeof import("../../db/work-metadata")>(),
  applyNovelMetadataToCache: vi.fn(), rememberStoredNovelMetadata: vi.fn(), scanStoredNovelChaptersToCache: vi.fn(),
}));
vi.mock("../../db/queries/novel", () => ({ findNovelBySource: vi.fn(async () => ({ id: 42 })) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("./works", async original => ({ ...await original<typeof import("./works")>(), recordInstalledWorkMetadata: vi.fn() }));
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { installStoredNovelMetadata, readStoredNovelMetadata, type NovelMetadataV1 } from "../work-metadata";
import { contentServerRequest } from "./client";
import { listAllServerWorks, listServerWorks, openServerNovel, refreshServerNovel, resolveServerNovelTarget, serverCoverSource, type ServerWorkSummary } from "./browse";
import { rememberServerNovelSource } from "./novel-source";
import { contentWorkId, recordInstalledWorkMetadata } from "./works";
import { findNovelBySource } from "../../db/queries/novel";
import { applyNovelMetadataToCache, rememberStoredNovelMetadata, scanStoredNovelChaptersToCache } from "../../db/work-metadata";
import { fetchServerChapters } from "./chapters";
import { cacheServerChapters, listNovelMigrations } from "../../db/queries/content-sync";
import { listIncomingMigrations, type IncomingMigration } from "./migration-feed-state";
import type { PendingNovelMigration } from "./novel-migration-types";
import { chapterCompositionCatalog, type ChapterCompositionV1 } from "../chapter-composition";
import { recordServerWorkDeletionExclusion } from "./deletion-exclusions";

const metadata: NovelMetadataV1 = {
  schemaVersion: 1, identity: { pluginId: "source", novelId: "book", novelPath: "/book" },
  novel: { name: "Book", author: null, artist: null, summary: null, status: null, rating: null, genres: null, isLocal: false },
  cover: null,
  chapters: {},
};
const installed = {
  metadata, directory: "contents/source/book", coverBytes: null,
  syncFile: { pluginId: "source", path: "/book", directory: "contents/source/book", fingerprint: "installed", revision: 1 },
};
const rawSelect = vi.fn();
const rawExecute = vi.fn();
const rawDb = { select: rawSelect, execute: rawExecute } as unknown as Database;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("window", new EventTarget());
  vi.mocked(installStoredNovelMetadata).mockReset().mockResolvedValue(installed);
  vi.mocked(listNovelMigrations).mockReset().mockResolvedValue([]);
  vi.mocked(listIncomingMigrations).mockReset().mockResolvedValue([]);
  vi.mocked(readStoredNovelMetadata).mockReset().mockResolvedValue(null);
  vi.mocked(fetchServerChapters).mockReset().mockResolvedValue([]);
  vi.mocked(findNovelBySource).mockReset().mockResolvedValue({ id: 42 } as Awaited<ReturnType<typeof findNovelBySource>>);
  vi.mocked(applyNovelMetadataToCache).mockReset().mockResolvedValue(42);
  vi.mocked(scanStoredNovelChaptersToCache).mockReset().mockResolvedValue(undefined);
  vi.mocked(rememberStoredNovelMetadata).mockReset().mockResolvedValue(undefined);
  rawSelect.mockReset().mockResolvedValue([]);
  rawExecute.mockReset().mockResolvedValue({ rowsAffected: 1 });
});

it.each(["response", "install"])("discards a server work deleted during its delayed %s", async phase => {
  const id = await contentWorkId(metadata.identity);
  vi.mocked(contentServerRequest).mockResolvedValue({ id, metadata, hasCover: false });
  const remove = () => recordServerWorkDeletionExclusion("http://server", metadata.identity);
  const commit = vi.fn();
  if (phase === "response") vi.mocked(fetchServerChapters).mockImplementationOnce(async () => { await remove(); return []; });
  vi.mocked(installStoredNovelMetadata).mockImplementationOnce(async (_metadata, _cover, guard) => {
    if (phase === "install") await remove();
    if (await guard?.(null) === false) return null;
    commit();
    return installed;
  });
  await expect(refreshServerNovel({ serverUrl: "http://server", workId: id }, true)).rejects.toMatchObject({ status: 410 });
  expect(commit).not.toHaveBeenCalled();
  expect(cacheServerChapters).not.toHaveBeenCalled();
  expect(rememberServerNovelSource).not.toHaveBeenCalled();
});

it("queries a bounded page without fetching synchronization history", async () => {
  vi.mocked(contentServerRequest).mockResolvedValue({ items: [], total: 0, hasMore: false });
  await listServerWorks("http://server", "device", "Book & title", "source", 40);
  expect(contentServerRequest).toHaveBeenCalledOnce();
  const path = vi.mocked(contentServerRequest).mock.calls[0]![1];
  expect(path).toBe("/catalog/works?q=Book+%26+title&offset=40&limit=40&source=source");
});

it("lists every matching work in pages of 100, deduplicating shifted pages", async () => {
  const summary = (id: string) => ({ id }) as never;
  vi.mocked(contentServerRequest)
    .mockResolvedValueOnce({ items: [summary("a"), summary("b")], total: 3, hasMore: true })
    .mockResolvedValueOnce({ items: [summary("b"), summary("c")], total: 3, hasMore: false });
  const progress: Array<[number, number]> = [];
  const works = await listAllServerWorks("http://server", "device", "Book", "", (loaded, total) => progress.push([loaded, total]));
  expect(works.map(work => work.id)).toEqual(["a", "b", "c"]);
  expect(vi.mocked(contentServerRequest).mock.calls.map(call => call[1])).toEqual([
    "/catalog/works?q=Book&offset=0&limit=100", "/catalog/works?q=Book&offset=2&limit=100",
  ]);
  expect(progress).toEqual([[2, 3], [3, 3]]);
});

it("installs only the selected work and retains its origin for later downloads", async () => {
  const id = await contentWorkId(metadata.identity);
  vi.mocked(contentServerRequest).mockResolvedValue({ id, metadata, hasCover: false });
  expect(await refreshServerNovel({ serverUrl: "http://server", workId: id })).toBe(42);
  expect(contentServerRequest).toHaveBeenCalledOnce();
  expect(contentServerRequest).toHaveBeenCalledWith("http://server", `/works/${id}`, "device");
  expect(installStoredNovelMetadata).toHaveBeenCalledWith(metadata, undefined, expect.any(Function));
  expect(recordInstalledWorkMetadata).toHaveBeenCalledWith("http://server", installed, false);
  expect(rememberServerNovelSource).toHaveBeenCalledWith(42, { serverUrl: "http://server", workId: id });
});

it("does not publish a work when its cover fails to download", async () => {
  const id = await contentWorkId(metadata.identity);
  vi.mocked(contentServerRequest).mockResolvedValue({ id, metadata, hasCover: true });
  vi.mocked(nativeFetch).mockResolvedValue(new Response(null, { status: 503 }));
  await expect(refreshServerNovel({ serverUrl: "http://server", workId: id })).rejects.toThrow("503");
  expect(installStoredNovelMetadata).not.toHaveBeenCalled();
  expect(rememberServerNovelSource).not.toHaveBeenCalled();
});

it("rejects a different work returned by the server before publishing files", async () => {
  vi.mocked(contentServerRequest).mockResolvedValue({ id: "wrong", metadata, hasCover: false });
  await expect(refreshServerNovel({ serverUrl: "http://server", workId: "requested" })).rejects.toThrow("identity");
  expect(installStoredNovelMetadata).not.toHaveBeenCalled();
});

it("detects an image MIME type when the response uses application/octet-stream", async () => {
  vi.mocked(nativeFetch).mockResolvedValue(new Response(new Uint8Array([255, 216, 255]), { headers: { "content-type": "application/octet-stream" } }));
  expect(await serverCoverSource("http://server", "device", "work")).toBe("data:image/jpeg;base64,/9j/");
});

it("opens an existing local work without overwriting edits or deleting locally known chapters", async () => {
  const id = await contentWorkId(metadata.identity);
  expect(await openServerNovel("http://server", { id, sequence: 1, identity: metadata.identity, novel: metadata.novel, hasCover: true, chapterCount: 1 })).toBe(42);
  expect(installStoredNovelMetadata).not.toHaveBeenCalled();
  expect(contentServerRequest).not.toHaveBeenCalled();
  expect(rememberServerNovelSource).toHaveBeenCalledWith(42, { serverUrl: "http://server", workId: id });
});

it("opens a concurrently indexed work without overwriting its metadata or acknowledging the stale server response", async () => {
  const id = await contentWorkId(metadata.identity);
  vi.mocked(findNovelBySource).mockResolvedValueOnce(null);
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ id, metadata, hasCover: false });
  rawSelect.mockResolvedValue([{ id: 42, sourceNovelId: "book" }]);
  const publish = vi.fn();
  vi.mocked(installStoredNovelMetadata).mockImplementationOnce(async (_metadata, _cover, guard) => {
    const current = { directory: "contents/source/book", metadata };
    if (await guard!(current, rawDb) === false) return null;
    publish();
    return installed;
  });
  await expect(openServerNovel("http://server", { id, sequence: 1, identity: metadata.identity, novel: metadata.novel, hasCover: false, chapterCount: 1 })).resolves.toBe(42);
  expect(publish).not.toHaveBeenCalled();
  expect(applyNovelMetadataToCache).not.toHaveBeenCalled();
  expect(scanStoredNovelChaptersToCache).not.toHaveBeenCalled();
  expect(recordInstalledWorkMetadata).not.toHaveBeenCalled();
  expect(cacheServerChapters).not.toHaveBeenCalled();
  expect(rememberServerNovelSource).toHaveBeenCalledWith(42, { serverUrl: "http://server", workId: id });
});

it("reindexes a work omitted by device restore from its preserved original files and opens it immediately", async () => {
  const id = await contentWorkId(metadata.identity);
  const original = {
    directory: "contents/source/book",
    metadata: { ...metadata, novel: { ...metadata.novel, name: "Preserved local title", summary: "Original local details" }, chapters: { "1": "Existing chapter" } },
  };
  vi.mocked(findNovelBySource).mockResolvedValueOnce(null);
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ id, metadata, hasCover: false });
  const publish = vi.fn();
  vi.mocked(installStoredNovelMetadata).mockImplementationOnce(async (_metadata, _cover, guard) => {
    if (await guard!(original, rawDb) === false) return null;
    publish();
    return installed;
  });
  const work = { id, sequence: 1, identity: metadata.identity, novel: metadata.novel, hasCover: false, chapterCount: 1 };
  await expect(openServerNovel("http://server", work)).resolves.toBe(42);
  expect(publish).not.toHaveBeenCalled();
  expect(applyNovelMetadataToCache).toHaveBeenCalledWith(rawDb, original.metadata, original.directory);
  expect(scanStoredNovelChaptersToCache).toHaveBeenCalledWith(rawDb, 42, original.directory);
  expect(rememberStoredNovelMetadata).toHaveBeenCalledWith(rawDb, original.directory, original.metadata);
  expect(rawExecute).toHaveBeenCalledWith("DELETE FROM work_metadata_dirty WHERE plugin_id=$1 AND path=$2", ["source", "/book"]);
  expect(recordInstalledWorkMetadata).not.toHaveBeenCalled();
  expect(cacheServerChapters).not.toHaveBeenCalled();
  expect(rememberServerNovelSource).toHaveBeenCalledWith(42, { serverUrl: "http://server", workId: id });
  // The next open reuses the recovered DB row instead of repeating the failed install.
  await expect(openServerNovel("http://server", work)).resolves.toBe(42);
  expect(installStoredNovelMetadata).toHaveBeenCalledOnce();
  expect(contentServerRequest).toHaveBeenCalledOnce();
});

it("rolls back preserved-file indexing when a work is deleted during chapter inspection", async () => {
  const id = await contentWorkId(metadata.identity);
  vi.mocked(findNovelBySource).mockResolvedValueOnce(null);
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ id, metadata, hasCover: false });
  vi.mocked(scanStoredNovelChaptersToCache).mockImplementationOnce(async () => {
    await recordServerWorkDeletionExclusion("http://server", metadata.identity);
  });
  const publish = vi.fn();
  vi.mocked(installStoredNovelMetadata).mockImplementationOnce(async (_metadata, _cover, guard) => {
    // Real installStoredNovelMetadata runs this guard in runDatabaseTransaction;
    // a thrown deletion error must escape so that transaction rolls back.
    if (await guard!({ directory: "contents/source/book", metadata }, rawDb) === false) return null;
    publish();
    return installed;
  });
  await expect(openServerNovel("http://server", { id, sequence: 1, identity: metadata.identity, novel: metadata.novel, hasCover: false, chapterCount: 1 })).rejects.toMatchObject({ status: 410 });
  expect(publish).not.toHaveBeenCalled();
  expect(rememberStoredNovelMetadata).not.toHaveBeenCalled();
  expect(rememberServerNovelSource).not.toHaveBeenCalled();
  expect(recordInstalledWorkMetadata).not.toHaveBeenCalled();
});

it("does not report preserved-file recovery as successful when original chapter inspection fails", async () => {
  const id = await contentWorkId(metadata.identity);
  vi.mocked(findNovelBySource).mockResolvedValueOnce(null);
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ id, metadata, hasCover: false });
  vi.mocked(scanStoredNovelChaptersToCache).mockRejectedValueOnce(new Error("Storage permission unavailable"));
  vi.mocked(installStoredNovelMetadata).mockImplementationOnce(async (_metadata, _cover, guard) => {
    if (await guard!({ directory: "contents/source/book", metadata }, rawDb) === false) return null;
    return installed;
  });
  await expect(openServerNovel("http://server", { id, sequence: 1, identity: metadata.identity, novel: metadata.novel, hasCover: false, chapterCount: 1 })).rejects.toThrow("Storage permission unavailable");
  expect(rememberStoredNovelMetadata).not.toHaveBeenCalled();
  expect(rememberServerNovelSource).not.toHaveBeenCalled();
  expect(recordInstalledWorkMetadata).not.toHaveBeenCalled();
});

it("continues normal installation when neither the work index nor original files exist", async () => {
  const id = await contentWorkId(metadata.identity);
  vi.mocked(findNovelBySource).mockResolvedValueOnce(null);
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ id, metadata, hasCover: false });
  vi.mocked(installStoredNovelMetadata).mockImplementationOnce(async (_metadata, _cover, guard) => {
    if (await guard!(null, rawDb) === false) return null;
    return installed;
  });
  await expect(openServerNovel("http://server", { id, sequence: 1, identity: metadata.identity, novel: metadata.novel, hasCover: false, chapterCount: 1 })).resolves.toBe(42);
  expect(applyNovelMetadataToCache).not.toHaveBeenCalled();
  expect(recordInstalledWorkMetadata).toHaveBeenCalledWith("http://server", installed, false);
  expect(cacheServerChapters).toHaveBeenCalledWith(42, []);
});

it("reads server covers with a caller signal on WebViews without AbortSignal.any", async () => {
  const original = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;
  Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true });
  try {
    vi.mocked(nativeFetch).mockResolvedValue(new Response(new Uint8Array([255, 216, 255]), { headers: { "content-type": "image/jpeg" } }));
    await expect(serverCoverSource("http://server", "device", "work", new AbortController().signal))
      .resolves.toBe("data:image/jpeg;base64,/9j/");
  } finally {
    Object.defineProperty(AbortSignal, "any", original);
  }
});

const migratedMetadata: NovelMetadataV1 = {
  ...metadata,
  identity: { pluginId: "target-source", novelId: "target-book", novelPath: "/target-book" },
  novel: { ...metadata.novel, name: "Current target title" },
  chapters: { "1": "Current chapter" },
};
const selectedWork = (): Promise<ServerWorkSummary> => contentWorkId(metadata.identity).then(id => ({
  id, sequence: 1, identity: metadata.identity, novel: metadata.novel, hasCover: false, chapterCount: 1,
}));
const completedMigration = (
  source = metadata.identity, target = migratedMetadata.identity, operationId = "legacy-migration",
): PendingNovelMigration => ({
  version: 1, serverUrl: "http://server", operationId, source, target,
  targetLocalNovelId: 900, status: "completed", createdAt: 1, updatedAt: 2, attempts: 1,
  chapters: [{
    sourceChapterPath: "/old/chapter/1", sourceChapterNumber: "1",
    targetChapterPath: "/target/chapter/1", targetChapterNumber: "346378", decision: "copy-source",
  }],
  request: {
    operationId, source: { revision: "saved-source-revision", chapters: [] },
    target: { id: "saved-target-id", revision: "saved-target-revision" }, mappings: [],
  },
});

async function prepareMigratedOpen(current?: NovelMetadataV1, received = migratedMetadata) {
  const job = completedMigration();
  const target = {
    id: 900, sourceNovelId: migratedMetadata.identity.novelId, pluginId: migratedMetadata.identity.pluginId,
    path: migratedMetadata.identity.novelPath, inLibrary: true, isLocal: false,
  } as NonNullable<Awaited<ReturnType<typeof findNovelBySource>>>;
  vi.mocked(listNovelMigrations).mockResolvedValue([job]);
  vi.mocked(findNovelBySource).mockImplementation(async (pluginId, path) =>
    pluginId === target.pluginId && path === target.path ? target : null);
  rawSelect.mockResolvedValue([{ id: target.id, sourceNovelId: target.sourceNovelId }]);
  const targetId = await contentWorkId(migratedMetadata.identity);
  vi.mocked(contentServerRequest).mockResolvedValue({ id: targetId, metadata: received, hasCover: false });
  if (current) vi.mocked(readStoredNovelMetadata).mockResolvedValue({ metadata: current, directory: "contents/target-source/target-book" });
  const committed = vi.fn();
  vi.mocked(installStoredNovelMetadata).mockImplementation(async (input, _cover, guard) => {
    await guard?.(current ? { metadata: current, directory: "contents/target-source/target-book" } : null, rawDb);
    committed();
    return { ...installed, metadata: input };
  });
  return { target, targetId, job, committed, work: await selectedWork() };
}

it("reuses a completed legacy migration target and refreshes its current metadata without replaying stale chapter numbers", async () => {
  const { work, targetId, job } = await prepareMigratedOpen();
  const chapters = [{
    id: "current-chapter", chapterPath: "/target/chapter/1", chapterNumber: "1",
    name: "Current chapter", position: 1, page: "1", contentType: "html" as const, complete: true,
  }];
  vi.mocked(fetchServerChapters).mockResolvedValue(chapters);
  expect(job.targetMetadata).toBeUndefined();
  expect(job.request?.chapterDecisions).toBeUndefined();
  await expect(openServerNovel("http://server", work)).resolves.toBe(900);
  expect(listNovelMigrations).toHaveBeenCalledWith("http://server", true);
  expect(listIncomingMigrations).toHaveBeenCalledWith("http://server", true);
  expect(findNovelBySource).toHaveBeenCalledWith("target-source", "/target-book");
  expect(findNovelBySource).not.toHaveBeenCalledWith("source", "/book");
  expect(contentServerRequest).toHaveBeenCalledExactlyOnceWith("http://server", "/works/" + targetId, "device");
  expect(installStoredNovelMetadata).toHaveBeenCalledWith(migratedMetadata, undefined, expect.any(Function));
  expect(cacheServerChapters).toHaveBeenCalledWith(900, chapters);
  expect(rememberServerNovelSource).toHaveBeenCalledWith(900, { serverUrl: "http://server", workId: targetId });
  expect(nativeFetch).not.toHaveBeenCalled();
  expect(job.chapters[0]!.targetChapterNumber).toBe("346378");
});

it("preserves a migrated target's manual order, exclusions, names and storage numbers while refreshing source metadata", async () => {
  const composition: ChapterCompositionV1 = {
    version: 1, updatedAt: 20,
    entries: [1, 2, 3].map(number => ({
      id: "entry-" + number, path: "/target/chapter/" + number, storageChapterNumber: String(number),
      sources: [{
        ...migratedMetadata.identity, chapterPath: "/target/chapter/" + number,
        sourceChapterId: "source-" + number, chapterNumber: String(346377 + number),
        name: "Source " + number, position: number, page: "1", contentType: "html", releaseTime: null,
      }],
      primarySource: 0,
      user: { included: number !== 3, order: number === 3 ? 0 : 3 - number, name: "My " + number, chapterNumber: number === 3 ? null : String(3 - number) },
    })),
  };
  const current = { ...migratedMetadata, chapterComposition: composition, chapters: chapterCompositionCatalog(composition) };
  const remoteComposition = structuredClone(composition);
  remoteComposition.updatedAt = 999;
  remoteComposition.entries[0]!.user.name = "Unrelated remote title";
  const received = { ...migratedMetadata, chapterComposition: remoteComposition, chapters: chapterCompositionCatalog(remoteComposition) };
  const { work } = await prepareMigratedOpen(current, received);
  await expect(openServerNovel("http://server", work)).resolves.toBe(900);
  const input = vi.mocked(installStoredNovelMetadata).mock.calls[0]![0];
  expect(input.chapterComposition).toEqual(composition);
  expect(input.chapters).toEqual({ "1": "My 1", "2": "My 2" });
  expect(input.chapterComposition!.entries[0]).toMatchObject({
    storageChapterNumber: "1", sources: [{ chapterNumber: "346378" }],
    user: { order: 2, chapterNumber: "2", name: "My 1" },
  });
  expect(input.novel.name).toBe("Current target title");
});

it("follows an exact completed outgoing and incoming migration chain to its final target", async () => {
  const finalIdentity = { pluginId: "final-source", novelId: "final-book", novelPath: "/final-book" };
  vi.mocked(listNovelMigrations).mockResolvedValue([completedMigration()]);
  vi.mocked(listIncomingMigrations).mockResolvedValue([{
    operationId: "next-migration", source: migratedMetadata.identity, target: finalIdentity,
    status: "completed", lineage: { active: true },
  } as IncomingMigration]);
  vi.mocked(findNovelBySource).mockResolvedValue({ id: 902, sourceNovelId: "final-book", isLocal: false } as never);
  const target = await resolveServerNovelTarget("http://server", await selectedWork());
  expect(target).toMatchObject({ migrated: true, identity: finalIdentity, novel: { id: 902 } });
  expect(target.source.workId).toBe(await contentWorkId(finalIdentity));
  expect(contentServerRequest).not.toHaveBeenCalled();
});

it.each(["pending", "failed", "blocked"] as const)("does not redirect an unfinished %s migration", async status => {
  vi.mocked(listNovelMigrations).mockResolvedValue([{ ...completedMigration(), status }]);
  const target = await resolveServerNovelTarget("http://server", await selectedWork());
  expect(target.migrated).toBe(false);
  expect(target.identity).toEqual(metadata.identity);
});

it("honors a saved revocation instead of reviving an older completed outgoing redirect", async () => {
  const job = completedMigration();
  vi.mocked(listNovelMigrations).mockResolvedValue([job]);
  vi.mocked(listIncomingMigrations).mockResolvedValue([{
    operationId: job.operationId, source: job.source, target: job.target,
    status: "inactive", lineage: { active: false },
  } as IncomingMigration]);
  expect((await resolveServerNovelTarget("http://server", await selectedWork())).migrated).toBe(false);
  expect(contentServerRequest).not.toHaveBeenCalled();
});

it.each(["branch", "cycle"] as const)("rejects a saved %s before refreshing any work", async kind => {
  const other = { pluginId: "other-source", novelId: "other-book", novelPath: "/other-book" };
  vi.mocked(listNovelMigrations).mockResolvedValue([
    completedMigration(),
    kind === "branch" ? completedMigration(metadata.identity, other, "second") : completedMigration(migratedMetadata.identity, metadata.identity, "second"),
  ]);
  await expect(openServerNovel("http://server", await selectedWork())).rejects.toThrow(kind === "branch" ? "conflicting targets" : "cycle");
  expect(installStoredNovelMetadata).not.toHaveBeenCalled();
  expect(contentServerRequest).not.toHaveBeenCalled();
});

it("does not substitute a work with a different stable source ID even when its path is the same", async () => {
  vi.mocked(listNovelMigrations).mockResolvedValue([completedMigration({ ...metadata.identity, novelId: "another-book" })]);
  expect((await resolveServerNovelTarget("http://server", await selectedWork())).migrated).toBe(false);
});

it("rejects a reused local target row before fetching metadata", async () => {
  const { work } = await prepareMigratedOpen();
  vi.mocked(findNovelBySource).mockResolvedValue({ id: 900, sourceNovelId: "different-work", isLocal: false } as never);
  await expect(openServerNovel("http://server", work)).rejects.toThrow("no longer matches");
  expect(contentServerRequest).not.toHaveBeenCalled();
  expect(installStoredNovelMetadata).not.toHaveBeenCalled();
});

it("stops before publishing when the resolved local target changes during the request", async () => {
  const { work, committed } = await prepareMigratedOpen();
  rawSelect.mockResolvedValue([{ id: 999, sourceNovelId: migratedMetadata.identity.novelId }]);
  await expect(openServerNovel("http://server", work)).rejects.toThrow("local migration target changed");
  expect(committed).not.toHaveBeenCalled();
  expect(cacheServerChapters).not.toHaveBeenCalled();
  expect(rememberServerNovelSource).not.toHaveBeenCalled();
});

it("honors a reconciliation revocation through its explicit legacy operation binding", async () => {
  const { job, work } = await prepareMigratedOpen();
  vi.mocked(listIncomingMigrations).mockResolvedValue([{
    operationId: "new-reconciliation", source: job.source, target: job.target,
    status: "inactive", lineage: { active: false, legacyOperationId: job.operationId },
  } as IncomingMigration]);
  const target = await resolveServerNovelTarget("http://server", work);
  expect(target.migrated).toBe(false);
  expect(target.identity).toEqual(metadata.identity);
  expect(contentServerRequest).not.toHaveBeenCalled();
});

it("does not infer a legacy revocation from shared work identities without an operation binding", async () => {
  const { job, work } = await prepareMigratedOpen();
  vi.mocked(listIncomingMigrations).mockResolvedValue([{
    operationId: "unrelated-revocation", source: job.source, target: job.target,
    status: "inactive", lineage: { active: false, legacyOperationId: "another-legacy-operation" },
  } as IncomingMigration]);
  expect((await resolveServerNovelTarget("http://server", work)).migrated).toBe(true);
});
