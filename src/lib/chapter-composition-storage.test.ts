import { beforeEach, expect, it, vi } from "vitest";
import type { ChapterCompositionEntry, ChapterCompositionV1 } from "./chapter-composition";
import { assertChapterCompositionStorageOwnership, type ChapterCompositionPreparedCopy } from "./chapter-composition-storage";

const mocks = vi.hoisted(() => ({ read: vi.fn(), operation: vi.fn() }));
vi.mock("./tauri-runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("./work-metadata", () => ({ readStoredNovelMetadata: mocks.read, workMetadataOperation: mocks.operation }));

const novel = { id: 1, pluginId: "source", sourceNovelId: "book", path: "/book" };
function row(): ChapterCompositionEntry {
  return { id: "local-uuid", path: "/chapter/1", storageChapterNumber: "1", primarySource: 0,
    sources: [{ pluginId: "source", novelId: "book", novelPath: "/book", chapterPath: "/chapter/1",
      chapterNumber: "1", name: "Source", position: 1, page: "1", contentType: "html", releaseTime: null }],
    user: { included: true, order: 1, name: null, chapterNumber: "1" } };
}
function doc(entry: ChapterCompositionEntry): ChapterCompositionV1 { return { version: 1, updatedAt: 1, entries: [entry] }; }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.operation.mockResolvedValue({ paths: ["contents/source/book/1/content.html"] });
  mocks.read.mockResolvedValue({ metadata: { identity: { pluginId: "source", novelId: "book", novelPath: "/book" }, chapterComposition: doc(row()) } });
});

it("adopts a canonical UUID only for the same original provider row and proven body", async () => {
  const incoming = row(); incoming.id = "other-device-uuid"; incoming.user.name = "My title";
  await expect(assertChapterCompositionStorageOwnership({ novel, composition: doc(incoming), previousComposition: doc(row()),
    existing: [{ path: "/chapter/1", chapterNumber: "1", position: 1 }] })).resolves.toBeUndefined();
});

it.each(["source", "path", "synthetic"])("retains the ownership rejection for an unrelated %s despite the same numeric directory", async mode => {
  const original = row(); const incoming = row(); incoming.id = "other-device-uuid";
  if (mode === "source") incoming.sources[0].chapterPath = "/other/chapter";
  if (mode === "path") incoming.path = "/another/path";
  if (mode === "synthetic") {
    original.path = incoming.path = "norea-composed:entry";
    mocks.read.mockResolvedValue({ metadata: { identity: { pluginId: "source", novelId: "book", novelPath: "/book" }, chapterComposition: doc(original) } });
  }
  await expect(assertChapterCompositionStorageOwnership({ novel, composition: doc(incoming), previousComposition: doc(original),
    existing: [{ path: original.path, chapterNumber: "1", position: 1 }] })).rejects.toThrow("source ownership");
});

it.each(["same", "different"])("requires the exact %s entry ID for a prepared native copy", async mode => {
  const incoming = row(); incoming.path = "norea-composed:entry";
  incoming.sources[0] = { ...incoming.sources[0], pluginId: "other-source", novelId: "other-book", chapterPath: "/other/1" };
  mocks.read.mockResolvedValue(null);
  const proof: ChapterCompositionPreparedCopy = { entry: structuredClone(incoming), transfer: {
    entryId: "native-row", sourceRelativeDir: "contents/other-source/other-book/1", targetRelativeDir: "contents/source/book/1",
    contentFile: "contents/source/book/1/content.html", contentBytes: 20, mediaBytes: 0, outcome: "copiedSource", replacedTarget: false,
  } };
  if (mode === "different") proof.entry.id = "different-proof";
  const result = assertChapterCompositionStorageOwnership({ novel, composition: doc(incoming), previousComposition: null, existing: [], preparedCopies: [proof] });
  if (mode === "same") await expect(result).resolves.toBeUndefined();
  else await expect(result).rejects.toThrow("source ownership");
});
