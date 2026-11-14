import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDownloadedChapterContent,
  clearLibraryMembership,
  clearReadingProgress,
  clearUpdatesTab,
} from "./maintenance";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("maintenance queries", () => {
  it("routes clearDownloadedChapterContent through db_maintenance_clear_downloaded_chapter_content", async () => {
    mockedInvoke.mockResolvedValueOnce({
      value: { rowsAffected: 3 },
      effects: {},
    });

    const result = await clearDownloadedChapterContent();

    expect(mockedInvoke).toHaveBeenCalledWith(
      "db_maintenance_clear_downloaded_chapter_content",
    );
    expect(result).toEqual({ rowsAffected: 3 });
  });

  it("routes clearLibraryMembership through db_maintenance_clear_library_membership", async () => {
    mockedInvoke.mockResolvedValueOnce({
      value: { rowsAffected: 4 },
      effects: { userStatePriority: "normal", userStateLedgerChanged: true },
    });

    const result = await clearLibraryMembership();

    expect(mockedInvoke).toHaveBeenCalledWith(
      "db_maintenance_clear_library_membership",
    );
    expect(result).toEqual({ rowsAffected: 4 });
  });

  it("routes clearUpdatesTab through db_maintenance_clear_updates_tab", async () => {
    mockedInvoke.mockResolvedValueOnce({
      value: { rowsAffected: 2 },
      effects: {},
    });

    const result = await clearUpdatesTab();

    expect(mockedInvoke).toHaveBeenCalledWith(
      "db_maintenance_clear_updates_tab",
    );
    expect(result).toEqual({ rowsAffected: 2 });
  });

  it("routes clearReadingProgress through db_maintenance_clear_reading_progress", async () => {
    mockedInvoke.mockResolvedValueOnce({
      value: { rowsAffected: 5 },
      effects: {},
    });

    const result = await clearReadingProgress();

    expect(mockedInvoke).toHaveBeenCalledWith(
      "db_maintenance_clear_reading_progress",
    );
    expect(result).toEqual({ rowsAffected: 5 });
  });
});
