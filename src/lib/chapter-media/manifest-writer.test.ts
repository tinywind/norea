import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAPTER_MEDIA_MANIFEST_PROGRESS_INTERVAL_MS,
  createChapterMediaManifestWriter,
} from "./manifest-writer";
import { type ChapterMediaManifestFile } from "./types";

function mediaFile(fileName: string, status: ChapterMediaManifestFile["status"]): ChapterMediaManifestFile {
  return {
    bytes: status === "stored" ? 3 : 0,
    fileName,
    path: `media/${fileName}`,
    sourceUrl: `https://source.test/${fileName}`,
    status,
    updatedAt: 1,
  };
}

describe("chapter media manifest writer", () => {
  let files: Map<string, ChapterMediaManifestFile>;
  let writes: ChapterMediaManifestFile[][];

  const createWriter = (write = async (snapshot: ChapterMediaManifestFile[]) => { writes.push(snapshot); }) =>
    createChapterMediaManifestWriter(() => [...files.values()], write);

  const store = (fileName: string): void => {
    files.set(fileName, mediaFile(fileName, "stored"));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    files = new Map(["0001.png", "0002.png", "0003.png"].map((name) => [name, mediaFile(name, "remote")]));
    writes = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes repeated progress without new assets at most once", async () => {
    const writer = createWriter();

    for (let round = 0; round < 10; round += 1) {
      await writer.progress();
      await vi.advanceTimersByTimeAsync(CHAPTER_MEDIA_MANIFEST_PROGRESS_INTERVAL_MS);
    }
    await writer.flush();

    expect(writes).toHaveLength(1);
  });

  it("does not rewrite an unchanged manifest when the download finishes", async () => {
    const writer = createWriter();

    await writer.flush();
    await writer.progress();
    await vi.advanceTimersByTimeAsync(CHAPTER_MEDIA_MANIFEST_PROGRESS_INTERVAL_MS * 3);
    await writer.flush();

    expect(writes).toHaveLength(1);
  });

  it("coalesces stored assets and writes them within the interval", async () => {
    const writer = createWriter();
    await writer.flush();

    store("0001.png");
    await writer.progress();
    store("0002.png");
    await writer.progress();
    expect(writes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(CHAPTER_MEDIA_MANIFEST_PROGRESS_INTERVAL_MS - 1);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(2);
    expect(writes[1]!.filter((file) => file.status === "stored").map((file) => file.fileName))
      .toEqual(["0001.png", "0002.png"]);

    await vi.advanceTimersByTimeAsync(CHAPTER_MEDIA_MANIFEST_PROGRESS_INTERVAL_MS);
    store("0003.png");
    await writer.progress();
    expect(writes).toHaveLength(3);
    expect(writes[2]!.every((file) => file.status === "stored")).toBe(true);
  });

  it("publishes only assets stored before each write starts and keeps writes in order", async () => {
    let releaseFirst!: () => void;
    const started: string[][] = [];
    const writer = createWriter(async (snapshot) => {
      started.push(snapshot.filter((file) => file.status === "stored").map((file) => file.fileName));
      if (started.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      writes.push(snapshot);
    });

    store("0001.png");
    const first = writer.flush();
    await vi.advanceTimersByTimeAsync(0);
    store("0002.png");
    const final = writer.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([["0001.png"]]);

    releaseFirst();
    await Promise.all([first, final]);
    expect(started).toEqual([["0001.png"], ["0001.png", "0002.png"]]);
    expect(writes).toHaveLength(2);
  });

  it("reports a deferred write failure immediately and keeps it terminal", async () => {
    const failure = new Error("disk full");
    let attempts = 0;
    const stopped = vi.fn();
    const writer = createChapterMediaManifestWriter(() => [...files.values()], async () => {
      attempts += 1;
      if (attempts > 1) throw failure;
    }, stopped);
    await writer.flush();
    store("0001.png");
    await writer.progress();
    await vi.advanceTimersByTimeAsync(CHAPTER_MEDIA_MANIFEST_PROGRESS_INTERVAL_MS);
    expect(stopped).toHaveBeenCalledWith(failure);
    await expect(writer.flush()).rejects.toBe(failure);
    expect(attempts).toBe(2);
  });

  it("retains a failed write without retrying it", async () => {
    const failure = new Error("storage unavailable");
    let failNext = true;
    const writer = createWriter(async (snapshot) => {
      if (failNext) {
        failNext = false;
        throw failure;
      }
      writes.push(snapshot);
    });

    await expect(writer.flush()).rejects.toBe(failure);
    store("0001.png");
    await expect(writer.progress()).rejects.toBe(failure);
    await expect(writer.flush()).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(CHAPTER_MEDIA_MANIFEST_PROGRESS_INTERVAL_MS * 2);
    expect(writes).toHaveLength(0);
    expect(failNext).toBe(false);
  });
});
