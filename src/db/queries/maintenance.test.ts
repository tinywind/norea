import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client", () => ({
  getDb: vi.fn(),
  runDatabaseTransaction: vi.fn(),
}));

import { getDb, runDatabaseTransaction } from "../client";
import { clearDownloadedChapterContent, clearLibraryMembership } from "./maintenance";

const mockedGetDb = vi.mocked(getDb);
let mockExecute: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockExecute = vi.fn();
  mockedGetDb.mockResolvedValue({
    execute: mockExecute,
    select: vi.fn().mockResolvedValue([]),
  } as never);
  vi.mocked(runDatabaseTransaction).mockImplementation(async run => run(await getDb()));
});

describe("clearDownloadedChapterContent", () => {
  it("clears only non-local downloaded chapter content", async () => {
    mockExecute.mockResolvedValueOnce({ rowsAffected: 3 });

    const result = await clearDownloadedChapterContent();

    const [sql] = mockExecute.mock.calls[0]!;
    expect(sql).not.toContain("content = NULL");
    expect(sql).toContain("content_bytes = 0");
    expect(sql).toContain("media_bytes = 0");
    expect(sql).toContain("media_repair_needed = 0");
    expect(sql).toContain("media_bytes_checked_at = NULL");
    expect(sql).toContain("is_downloaded = 0");
    expect(sql).toContain("EXISTS");
    expect(sql).toContain("n.is_local = 0");
    expect(result.rowsAffected).toBe(3);
  });
});

describe("clearLibraryMembership", () => {
  it("ends the download goals of library novels before clearing membership", async () => {
    mockExecute.mockResolvedValueOnce({ rowsAffected: 2 }).mockResolvedValueOnce({ rowsAffected: 4 });

    const result = await clearLibraryMembership();

    expect(mockExecute.mock.calls[0]![0]).toBe(
      "DELETE FROM novel_download_goal WHERE novel_id IN (SELECT id FROM novel WHERE in_library = 1)");
    expect(mockExecute.mock.calls[1]![0]).toContain("in_library = 0");
    expect(result.rowsAffected).toBe(4);
  });
});
