import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { readStoredChapterContentFile } from "../chapter-content/storage-platform";
import type { ChapterPayloadSnapshot } from "../chapter-content/inventory";
import { verifyMigrationBodyOnlyInventory } from "./migration-inventory";

vi.mock("../chapter-content/storage-platform", () => ({ readStoredChapterContentFile: vi.fn() }));
const contentFile = "contents/source/work/1/content.html";
function snapshot(body: string): ChapterPayloadSnapshot {
  const bytes = new TextEncoder().encode(body).byteLength;
  return { body: { sha256: createHash("sha256").update(body).digest("hex"), bytes }, expectedAssetKeys: null, storedAssets: [],
    fingerprint: "body-fingerprint", payloadBytes: bytes, contentBytes: bytes, mediaBytes: 0, mediaComplete: true };
}
beforeEach(() => vi.clearAllMocks());

it("accepts a verified text-only HTML body without changing its missing declarations", async () => {
  const body = '<style>p { color: black }</style><p style="text-indent: 1em">A complete paragraph.</p>';
  const inventory = snapshot(body);
  vi.mocked(readStoredChapterContentFile).mockResolvedValue(body);
  expect(await verifyMigrationBodyOnlyInventory(contentFile, inventory)).toBe(true);
  expect(inventory.expectedAssetKeys).toBeNull();
});

it.each([
  '<img src="https://media.test/page.jpg">',
  '<picture><source srcset="page.jpg"></picture>',
  '<svg><image href="page.jpg"/></svg>',
  '<object data="page.pdf"></object>',
  '<iframe src="chapter.html"></iframe>',
  '<style>p { background: url(page.jpg) }</style>',
  '<p style="background: u&#114;l(page.jpg)">Text</p>',
  '<style>@import "chapter.css";</style>',
  '<style>p { background: u\\72l(page.jpg) }</style>',
  '<style>p { background: u/**/rl(page.jpg) }</style>',
])("rejects a body with unresolved media or uncertain resource styles: %s", async body => {
  vi.mocked(readStoredChapterContentFile).mockResolvedValue(body);
  expect(await verifyMigrationBodyOnlyInventory(contentFile, snapshot(body))).toBe(false);
});

it("does not approve a body changed after its inventory was captured", async () => {
  vi.mocked(readStoredChapterContentFile).mockResolvedValue("<p>Hall</p>");
  expect(await verifyMigrationBodyOnlyInventory(contentFile, snapshot("<p>Hell</p>"))).toBe(false);
});

it("does not treat unknown or incomplete asset inventories as text-only", async () => {
  const body = "<p>Text</p>";
  vi.mocked(readStoredChapterContentFile).mockResolvedValue(body);
  expect(await verifyMigrationBodyOnlyInventory(contentFile, { ...snapshot(body), mediaComplete: false })).toBe(false);
  expect(await verifyMigrationBodyOnlyInventory(contentFile, { ...snapshot(body), mediaBytes: 8 })).toBe(false);
  expect(await verifyMigrationBodyOnlyInventory(contentFile, { ...snapshot(body), storedAssets: [{ key: "media/one.png", sha256: "b".repeat(64), bytes: 8 }] })).toBe(false);
  expect(readStoredChapterContentFile).not.toHaveBeenCalled();
});

it("keeps a complete PDF as a single body rather than decoding it as HTML", async () => {
  expect(await verifyMigrationBodyOnlyInventory("contents/source/work/1/content.pdf", snapshot("%PDF-1.7"))).toBe(true);
  expect(readStoredChapterContentFile).not.toHaveBeenCalled();
});
