import { describe, expect, it } from "vitest";
import { parseStoredChapterPath, storedChapterDigest, storedChapterNumber, storedChapterPath } from "./stored-chapter";
import type { ChapterPayloadInventory } from "../chapter-content/inventory";
import { parseUserStateCurrentItem } from "./current-types";
import { userStateEntityKey } from "./types";

const hash = "a".repeat(64);
const work = { pluginId: "source", sourceNovelId: "book", novelPath: "/book", name: "Book" };

describe("recovered stored chapter references", () => {
  const inventory = (): ChapterPayloadInventory => ({ body: { sha256: hash, bytes: 100 }, expectedAssetKeys: [], storedAssets: [] });

  it("keeps a text-only body identity and distinguishes different images in the same HTML template", async () => {
    expect(await storedChapterDigest(inventory())).toBe(hash);
    const media = { ...inventory(), expectedAssetKeys: ["media/0.jpg"], storedAssets: [{ key: "media/0.jpg", sha256: "b".repeat(64), bytes: 200 }] };
    const first = await storedChapterDigest(media);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(hash);
    expect(await storedChapterDigest({ ...media, storedAssets: [{ ...media.storedAssets[0]!, sha256: "c".repeat(64) }] })).not.toBe(first);
    expect(await storedChapterDigest({ ...media, storedAssets: [...media.storedAssets, { key: "media/orphan.jpg", sha256: "d".repeat(64), bytes: 12 }] })).toBe(first);
  });

  it("canonicalizes declared media independently of discovery order", async () => {
    const media = { ...inventory(), expectedAssetKeys: ["media/b.jpg", "media/a.jpg"], storedAssets: [
      { key: "media/b.jpg", sha256: "b".repeat(64), bytes: 20 }, { key: "media/a.jpg", sha256: "c".repeat(64), bytes: 30 },
    ] };
    expect(await storedChapterDigest(media)).toBe(await storedChapterDigest({ ...media,
      expectedAssetKeys: media.expectedAssetKeys.slice().reverse(), storedAssets: media.storedAssets.slice().reverse() }));
  });

  it("requires nonempty valid content and complete unambiguous media declarations", async () => {
    for (const invalid of [
      { ...inventory(), body: null }, { ...inventory(), body: { sha256: hash, bytes: 0 } },
      { ...inventory(), body: { sha256: "invalid", bytes: 100 } }, { ...inventory(), expectedAssetKeys: null },
      { ...inventory(), expectedAssetKeys: ["media/missing.jpg"] },
      { ...inventory(), expectedAssetKeys: ["media/one.jpg", "media/ONE.jpg"] },
    ]) expect(await storedChapterDigest(invalid)).toBeNull();
  });

  it("binds the canonical physical key and exact body digest within the stable work", () => {
    const path = storedChapterPath("019.0", hash)!;
    expect(path).toBe("norea-stored:" + hash + ":norea-folder%3A19");
    expect(parseStoredChapterPath(path)).toEqual({ folderPath: "norea-folder:19", chapterNumber: "19", sha256: hash });
    const entity = { kind: "reading" as const, work, chapter: { chapterPath: path } };
    expect(userStateEntityKey(entity)).not.toBe(userStateEntityKey({ ...entity, chapter: { chapterPath: storedChapterPath("20", hash)! } }));
    expect(userStateEntityKey(entity)).not.toBe(userStateEntityKey({ ...entity, chapter: { chapterPath: storedChapterPath("19", "b".repeat(64))! } }));
    expect(userStateEntityKey(entity)).not.toBe(userStateEntityKey({ ...entity, work: { ...work, sourceNovelId: "other" } }));
    expect(parseUserStateCurrentItem({ entity, value: { progress: 100, unread: false, readAt: null } }).entity).toEqual(entity);
  });

  it.each([null, "", " ", "1e2", "-1", "Infinity", "NaN", "1/2", "../19", "1." ])("rejects invalid storage key %s", value => {
    expect(storedChapterNumber(value)).toBeNull();
    expect(storedChapterPath(value, hash)).toBeNull();
  });

  it.each(["0", "0.5", "19", "1000"])("retains supported decimal storage key %s", value => {
    expect(parseStoredChapterPath(storedChapterPath(value, hash)!)?.chapterNumber).toBe(value);
  });

  it.each([
    "norea-folder:19", "local-folder:19", "norea-stored:bad:norea-folder%3A19",
    "norea-stored:" + hash + ":local-folder%3A19",
    "norea-stored:" + hash + ":norea-folder%3A019",
    "norea-stored:" + hash + ":norea-folder%3a19",
    "norea-stored:" + hash + ":norea-folder%253A19",
    "norea-stored:" + hash + ":norea-folder%3A..%2F19",
    "norea-stored:" + hash + ":%XX",
    "norea-stored:" + "A".repeat(64) + ":norea-folder%3A19",
  ])("rejects unverified or noncanonical wire path %s", chapterPath => {
    expect(parseStoredChapterPath(chapterPath)).toBeNull();
    expect(() => parseUserStateCurrentItem({
      entity: { kind: "reading", work, chapter: { chapterPath } }, value: { progress: 100, unread: false, readAt: null },
    })).toThrow("unresolved current chapter identity");
  });
});
