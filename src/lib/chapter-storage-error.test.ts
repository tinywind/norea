import { expect, it } from "vitest";
import { ChapterStorageError, withChapterStorageOperation } from "./chapter-storage-error";

it("classifies local read failures while preserving the original cause", async () => {
  const cause = new Error("Database unavailable");
  await expect(withChapterStorageOperation("Read novel", async () => {throw cause;})).rejects.toMatchObject({code:"chapter-storage-failed", cause});
});
it("keeps cancellations and already classified storage failures intact", async () => {
  for(const error of [new DOMException("Cancelled","AbortError"), new ChapterStorageError("Read",new Error("Unreadable"))]) {
    await expect(withChapterStorageOperation("Read",async()=>{throw error;})).rejects.toBe(error);
  }
});
