import { load } from "cheerio";
import type { ChapterPayloadSnapshot } from "../chapter-content/inventory";
import { readStoredChapterContentFile } from "../chapter-content/storage-platform";

/** Missing media declarations need proof that the captured body owns all of its content. */
export async function verifyMigrationBodyOnlyInventory(
  contentFile: string,
  inventory: ChapterPayloadSnapshot,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!inventory.mediaComplete || !inventory.body || inventory.body.bytes <= 0
    || inventory.expectedAssetKeys !== null || inventory.storedAssets.length !== 0 || inventory.mediaBytes !== 0) return false;
  signal?.throwIfAborted();
  // A PDF package stores its embedded media in the body itself.
  if (contentFile.endsWith(".pdf")) return true;
  const body = await readStoredChapterContentFile(contentFile);
  signal?.throwIfAborted();
  if (typeof body !== "string") return false;
  const bytes = new TextEncoder().encode(body);
  if (bytes.byteLength !== inventory.body.bytes) return false;
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  signal?.throwIfAborted();
  if (digest !== inventory.body.sha256) return false;
  const $ = load(body, null, false);
  if ($("img, picture, source, video, audio, svg, image, object, embed, iframe, canvas, script, link, base, [src], [srcset], [poster], [background]").length) return false;
  const styles = [...$("style").toArray().map(element => $(element).text()), ...$("[style]").toArray().map(element => $(element).attr("style") ?? "")];
  // Escapes and comments can conceal resource functions; uncertain styles remain held.
  return styles.every(style => !/\\|\/\*|@import|\b(?:url|image|image-set|expression)\s*\(/i.test(style));
}
