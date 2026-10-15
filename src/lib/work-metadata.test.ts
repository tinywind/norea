import { describe, expect, it } from "vitest";
import { parseNovelMetadata } from "./work-metadata";

export function metadataFixture() {
  return { schemaVersion: 1, identity: { pluginId: "source", novelPath: "/book?exact=1" },
    novel: { name: "Book", author: null, artist: null, summary: null, status: null, genres: null, rating: null, isLocal: false },
    cover: null, chapters: {} };
}

describe("portable work metadata", () => {
  it("preserves the source chapter catalog independently of downloaded files", () => {
    const chapters = { "1": "Opening: a question?", "2.5": "Interlude", "1000": "Latest chapter" };
    expect(parseNovelMetadata({ ...metadataFixture(), chapters })).toMatchObject({ chapters });
  });

  it.each([[[]], [{ "not-a-number": "Chapter" }], [{ "01": "Chapter" }], [{ "1": 123 }]])("rejects an invalid chapter catalog %j", (chapters) => {
    expect(() => parseNovelMetadata({ ...metadataFixture(), chapters })).toThrow();
  });

  it("restores minimal metadata and ignores unrelated fields and source cover URLs", () => {
    const parsed = parseNovelMetadata({
      identity: { pluginId: "source", novelPath: "/book?exact=1", sourceUrl: "https://removed.test" },
      novel: { name: "Book", cover: "https://removed.test/cover.jpg" },
      cover: { fileName: "cover.jpg", sourceUrl: "https://removed.test/cover.jpg" },
      updatedAt: 123, inLibrary: true,
    });
    expect(parsed).toEqual({
      schemaVersion: 1, identity: { pluginId: "source", novelPath: "/book?exact=1" },
      novel: { name: "Book", author: null, artist: null, summary: null, status: null, genres: null, rating: null, isLocal: false },
      cover: { fileName: "cover.jpg", contentType: "image/jpeg" },
      chapters: {},
    });
  });

  it("restores minimal metadata without optional properties", () => {
    const parsed = parseNovelMetadata({ identity: { pluginId: "source", novelPath: "/book" }, novel: { name: "Book" } });
    expect(parsed.identity.novelPath).toBe("/book");
    expect(parsed.cover).toBeNull();
    expect(parsed.novel.author).toBeNull();
  });
  it("rejects folder-derived work identities", () => {
    const input = metadataFixture(); input.identity.novelPath = "norea-folder:Book";
    expect(() => parseNovelMetadata(input)).toThrow();
  });
  it.each(["https://example.com/novel/1", "http://example.com/novel/1", "//example.com/novel/1"])("rejects base URLs in work identity %s", (novelPath) => {
    expect(() => parseNovelMetadata({ ...metadataFixture(), identity: { pluginId: "source", novelPath } })).toThrow();
  });
  it.each([-1, 5.1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid rating %s", (rating) => {
    const input = metadataFixture();
    expect(() => parseNovelMetadata({ ...input, novel: { ...input.novel, rating } })).toThrow();
  });
  it("retains fractional source rating and source status", () => {
    const input = metadataFixture();
    const novel = { ...input.novel, rating: 4.25, status: "Source-specific status" };
    expect(parseNovelMetadata({ ...input, novel }).novel).toEqual(novel);
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
