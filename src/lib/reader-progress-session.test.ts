import { describe, expect, it } from "vitest";
import {
  getReaderContentPhaseKey,
  isReaderProgressPersistenceReady,
} from "./reader-progress-session";

describe("reader progress persistence readiness", () => {
  const finalHtml = "<p>Complete chapter</p>";

  it.each([
    {
      name: "a chapter that is still downloading",
      state: {
        activeContent: finalHtml,
        chapterId: 7,
        isDownloaded: false,
        requestedChapterId: 7,
        storedContent: finalHtml,
      },
    },
    {
      name: "partial content that differs from the stored final body",
      state: {
        activeContent: "<p>Partial</p>",
        chapterId: 7,
        isDownloaded: true,
        requestedChapterId: 7,
        storedContent: finalHtml,
      },
    },
    {
      name: "a late completion event for a chapter already left",
      state: {
        activeContent: finalHtml,
        chapterId: 7,
        isDownloaded: true,
        requestedChapterId: 8,
        storedContent: finalHtml,
      },
    },
    {
      name: "missing stored content",
      state: {
        activeContent: finalHtml,
        chapterId: 7,
        isDownloaded: true,
        requestedChapterId: 7,
        storedContent: null,
      },
    },
  ])("rejects progress from $name", ({ state }) => {
    expect(isReaderProgressPersistenceReady(state)).toBe(false);
  });

  it("accepts progress only for the active chapter's fully stored content", () => {
    expect(
      isReaderProgressPersistenceReady({
        activeContent: finalHtml,
        chapterId: 7,
        isDownloaded: true,
        requestedChapterId: 7,
        storedContent: finalHtml,
      }),
    ).toBe(true);
  });

  it("changes the reader phase key when final content becomes writable", () => {
    expect(getReaderContentPhaseKey(7, false)).toBe("7:partial");
    expect(getReaderContentPhaseKey(7, true)).toBe("7:stored");
  });
});
