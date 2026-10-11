import { describe, expect, it } from "vitest";
import { parseNovelMetadata } from "./work-metadata";

export function metadataFixture() {
  return { schemaVersion: 1, identity: { pluginId: "source", novelPath: "/book?exact=1" },
    novel: { name: "Book", cover: null, author: null, artist: null, summary: null, status: null, genres: null, isLocal: false },
    chapters: [{ path: "/chapter?exact=2", name: "First", chapterNumber: "1", position: 1, page: "1", contentType: "html", releaseTime: null, directory: "1-First" }],
    cover: null, updatedAt: 1000 };
}

describe("portable work metadata", () => {
  it("retains exact source identities and undownloaded chapters", () => {
    expect(parseNovelMetadata(metadataFixture())).toEqual(metadataFixture());
  });
  it.each(["../escape", "C:\\escape", "nested/chapter", ".", "CON", "bad.", "novel.json", "cover.png", "cover"])("rejects unsafe directory %s", (directory) => {
    const input = metadataFixture(); input.chapters[0]!.directory = directory;
    expect(() => parseNovelMetadata(input)).toThrow();
  });
  it("rejects duplicate chapter identities and directory aliases", () => {
    const input = metadataFixture(); input.chapters.push({ ...input.chapters[0]! });
    expect(() => parseNovelMetadata(input)).toThrow();
    input.chapters[1]!.path = "/other"; input.chapters[1]!.directory = "1-FIRST";
    expect(() => parseNovelMetadata(input)).toThrow();
  });
  it("rejects personal fields rather than transporting them", () => {
    expect(() => parseNovelMetadata({ ...metadataFixture(), inLibrary: true })).toThrow();
  });
  it("rejects invalid unicode, oversized identities and document cover types", () => {
    const input = metadataFixture(); input.identity.novelPath = "\ud800";
    expect(() => parseNovelMetadata(input)).toThrow();
    input.identity.novelPath = "a".repeat(4097);
    expect(() => parseNovelMetadata(input)).toThrow();
    expect(() => parseNovelMetadata({ ...metadataFixture(), cover: { fileName: "cover.json", sourceUrl: "/cover", contentType: "image/png" } })).toThrow();
    expect(() => parseNovelMetadata({ ...metadataFixture(), cover: { fileName: "cover.png", sourceUrl: "/cover", contentType: "text/html" } })).toThrow();
  });
});
