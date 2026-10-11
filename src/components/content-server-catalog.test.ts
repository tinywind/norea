import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../lib/content-sync/native";
import type { WorkCatalogEntry } from "../lib/content-sync/works";
import { groupServerCatalog } from "./content-server-catalog";

function work(pluginId: string, novelPath: string, name = "Same title"): WorkCatalogEntry {
  return {
    id: `${pluginId}:${novelPath}`, sequence: 1, hasCover: true,
    metadata: {
      schemaVersion: 1, identity: { pluginId, novelPath }, updatedAt: 1,
      novel: { name, cover: null, author: null, artist: null, summary: null, status: null, genres: null, isLocal: false },
      chapters: [], cover: null,
    },
  };
}

function chapter(pluginId: string, novelPath: string, name: string): CatalogEntry {
  return {
    id: name, revision: "revision", zipSha256: "digest", zipBytes: 1, deleted: false, sequence: 1,
    manifest: {
      packageVersion: 1, identity: { pluginId, novelPath, chapterPath: name },
      novel: { name: "Old title", isLocal: false },
      chapter: { name, position: 1, contentType: "text", page: "1" }, bodyPath: "chapter.txt", files: [],
    },
  };
}

describe("groupServerCatalog", () => {
  it("keeps metadata-only works and matches chapters by full identity instead of title", () => {
    const result = groupServerCatalog(
      [work("first", "/a"), work("second", "/a"), work("first", "/b")],
      [chapter("second", "/a", "Opening")], "",
    );
    expect(result.map(item => [item.identity.pluginId, item.identity.novelPath, item.chapters.length])).toEqual([
      ["first", "/a", 0], ["second", "/a", 1], ["first", "/b", 0],
    ]);
  });

  it("preserves legacy chapters, including deleted entries", () => {
    const legacy = { ...chapter("legacy", "/novel", "Lost chapter"), deleted: true };
    const result = groupServerCatalog([], [legacy], "");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Old title");
    expect(result[0].chapters).toEqual([legacy]);
  });

  it("searches metadata titles and chapter names without mutating the catalog", () => {
    const works = [work("source", "/novel", "New title"), work("source", "/empty", "Empty work")];
    const chapters = [chapter("source", "/novel", "Opening"), chapter("source", "/novel", "Ending")];
    expect(groupServerCatalog(works, chapters, " new TITLE ")[0].chapters).toHaveLength(2);
    expect(groupServerCatalog(works, chapters, "ending")[0].chapters.map(item => item.id)).toEqual(["Ending"]);
    expect(groupServerCatalog(works, chapters, "empty")[0].chapters).toEqual([]);
    expect(groupServerCatalog(works, chapters, "missing")).toEqual([]);
    expect(chapters).toHaveLength(2);
  });
});
