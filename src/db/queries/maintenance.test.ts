import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../client";
import { clearDownloadedChapterContent } from "./maintenance";

const mockedGetDb = vi.mocked(getDb);
let mockExecute: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockExecute = vi.fn();
  mockedGetDb.mockResolvedValue({
    execute: mockExecute,
  } as never);
});

describe("clearDownloadedChapterContent", () => {
  it("clears only non-local downloaded chapter content", async () => {
    mockExecute.mockResolvedValueOnce({ rowsAffected: 3 });

    const result = await clearDownloadedChapterContent();

    const [sql] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("content = NULL");
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
