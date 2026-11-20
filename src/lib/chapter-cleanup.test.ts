import { describe, expect, it } from "vitest";
import type { ChapterPayloadSnapshot } from "./chapter-content/inventory";
import type { ServerChapterInventory } from "./content-sync/chapter-inventory";
import { chapterCleanupInventorySkip } from "./chapter-cleanup";

function localSnapshot(overrides: Partial<ChapterPayloadSnapshot> = {}): ChapterPayloadSnapshot {
  return {
    body: { sha256: "a".repeat(64), bytes: 120 },
    expectedAssetKeys: [],
    storedAssets: [],
    fingerprint: "f".repeat(64),
    mediaComplete: true,
    payloadBytes: 120,
    contentBytes: 120,
    mediaBytes: 0,
    ...overrides,
  };
}

function serverInventory(overrides: Partial<ServerChapterInventory> = {}): ServerChapterInventory {
  return {
    serverUrl: "http://server",
    id: "server-chapter-1",
    revision: "rev-1",
    identity: { pluginId: "source", novelId: "book", novelPath: "/book", chapterPath: "/ch/1" },
    inventory: {
      body: { sha256: "a".repeat(64), bytes: 120 },
      expectedAssetKeys: [],
      storedAssets: [],
    },
    ...overrides,
  };
}

describe("chapterCleanupInventorySkip", () => {
  it("treats text/PDF chapters with no media manifest on either side as comparable and covered", () => {
    const local = localSnapshot({ expectedAssetKeys: null, mediaComplete: true, mediaBytes: 0, storedAssets: [] });
    const remote = serverInventory({
      noMediaDeclared: true,
      inventory: { body: { sha256: "a".repeat(64), bytes: 120 }, expectedAssetKeys: null, storedAssets: [] },
    });

    expect(chapterCleanupInventorySkip("server-coverage", local, remote)).toBeNull();
    expect(chapterCleanupInventorySkip("server-contains-local", local, remote)).toBeNull();
  });

  it("still fails closed as not-comparable when either side has an unreadable or undeclared manifest mismatch", () => {
    const local = localSnapshot({ expectedAssetKeys: null, mediaComplete: true, mediaBytes: 0, storedAssets: [] });
    const remoteWithoutNoMediaProof = serverInventory({
      noMediaDeclared: false,
      inventory: { body: { sha256: "a".repeat(64), bytes: 120 }, expectedAssetKeys: null, storedAssets: [] },
    });
    expect(chapterCleanupInventorySkip("server-coverage", local, remoteWithoutNoMediaProof)).toBe("not-comparable");
    expect(chapterCleanupInventorySkip("server-contains-local", local, remoteWithoutNoMediaProof)).toBe("not-comparable");

    const localIncomplete = localSnapshot({ expectedAssetKeys: null, mediaComplete: false, mediaBytes: 0, storedAssets: [] });
    const remoteText = serverInventory({
      noMediaDeclared: true,
      inventory: { body: { sha256: "a".repeat(64), bytes: 120 }, expectedAssetKeys: null, storedAssets: [] },
    });
    expect(chapterCleanupInventorySkip("server-coverage", localIncomplete, remoteText)).toBe("not-comparable");
  });

  it("allows server-complete mode whenever local has payload bytes and server has a body", () => {
    const local = localSnapshot();
    const remote = serverInventory({
      inventory: { body: { sha256: "b".repeat(64), bytes: 200 }, expectedAssetKeys: null, storedAssets: [] },
    });

    expect(chapterCleanupInventorySkip("server-complete", local, remote)).toBeNull();
    expect(chapterCleanupInventorySkip("server-complete", local, null)).toBe("server-missing");
    expect(chapterCleanupInventorySkip("server-complete", localSnapshot({ payloadBytes: 0 }), remote)).toBe("no-payload");
  });
});
