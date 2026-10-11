import { describe, expect, it } from "vitest";
import { parseNovelMetadata } from "./work-metadata";

export function metadataFixture() {
  return { schemaVersion: 1, identity: { pluginId: "source", novelPath: "/book?exact=1" },
    novel: { name: "Book", cover: null, author: null, artist: null, summary: null, status: null, genres: null, rating: null, isLocal: false },
    cover: null };
}

describe("portable work metadata", () => {
  it("retains exact source identities without chapter or timestamp fields", () => {
    expect(parseNovelMetadata(metadataFixture())).toEqual(metadataFixture());
  });
  it("rejects chapter lists, timestamps, and folder-derived work identities", () => {
    expect(() => parseNovelMetadata({ ...metadataFixture(), chapters: [] })).toThrow();
    expect(() => parseNovelMetadata({ ...metadataFixture(), updatedAt: 1 })).toThrow();
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
