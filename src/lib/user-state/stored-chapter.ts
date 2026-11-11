import { isChapterPayloadInventory, type ChapterPayloadInventory, type ChapterPayloadSnapshot } from "../chapter-content/inventory";

export const STORED_CHAPTER_PREFIX = "norea-stored:";

export function storedChapterNumber(value: string | null): string | null {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const number = Number(value);
  const canonical = String(number);
  return Number.isFinite(number) && /^\d+(?:\.\d+)?$/.test(canonical) ? canonical : null;
}

/** Ignore file timestamps and undeclared leftovers; bind all content the reader consumes. */
export async function storedChapterDigest(
  inventory: ChapterPayloadInventory & Partial<Pick<ChapterPayloadSnapshot, "mediaComplete">>,
): Promise<string | null> {
  if (!isChapterPayloadInventory(inventory) || !inventory.body || inventory.body.bytes <= 0) return null;
  const assets = new Map(inventory.storedAssets.map(asset => [asset.key, asset]));
  const declared = inventory.expectedAssetKeys === null
    ? inventory.mediaComplete === true && inventory.storedAssets.length === 0 ? [] : null
    : inventory.expectedAssetKeys.slice().sort();
  if (declared === null) return null;
  if (declared.some(key => !assets.has(key))) return null;
  if (!declared.length) return inventory.body.sha256;
  const content = JSON.stringify(["norea-stored-v1", [inventory.body.sha256, inventory.body.bytes],
    declared.map(key => { const asset = assets.get(key)!; return [key, asset.sha256, asset.bytes]; })]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** A storage number selects candidates; the same complete content proves identity. */
export function storedChapterPath(chapterNumber: string | null, contentSha256: string): string | null {
  const number = storedChapterNumber(chapterNumber);
  if (number === null || !/^[a-f0-9]{64}$/.test(contentSha256)) return null;
  return STORED_CHAPTER_PREFIX + contentSha256 + ":" + encodeURIComponent("norea-folder:" + number);
}

export function parseStoredChapterPath(path: string): { folderPath: string; chapterNumber: string; sha256: string } | null {
  if (!path.startsWith(STORED_CHAPTER_PREFIX)) return null;
  const match = /^norea-stored:([a-f0-9]{64}):(.+)$/.exec(path);
  if (!match) return null;
  let folderPath: string;
  try { folderPath = decodeURIComponent(match[2]!); } catch { return null; }
  if (!folderPath.startsWith("norea-folder:")) return null;
  const chapterNumber = storedChapterNumber(folderPath.slice("norea-folder:".length));
  if (chapterNumber === null || storedChapterPath(chapterNumber, match[1]!) !== path) return null;
  return { folderPath, chapterNumber, sha256: match[1]! };
}
