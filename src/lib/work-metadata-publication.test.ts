import { expect, it } from "vitest";
import { notifyWorkMetadataChanges, subscribeWorkMetadataChanges, withWorkMetadataRollback } from "./work-metadata";

it("notifies committed readers only after the publication transaction succeeds", async () => {
  const changes: unknown[] = [];
  const unsubscribe = subscribeWorkMetadataChanges(identity => { changes.push(identity); });
  try {
    await withWorkMetadataRollback(async () => {
      notifyWorkMetadataChanges({ pluginId: "source", novelPath: "/work" });
      expect(changes).toEqual([]);
    });
    expect(changes).toEqual([{ pluginId: "source", novelPath: "/work" }]);
  } finally { unsubscribe(); }
});

it("does not publish metadata changes from a rolled-back transaction", async () => {
  const changes: unknown[] = [];
  const unsubscribe = subscribeWorkMetadataChanges(identity => { changes.push(identity); });
  try {
    await expect(withWorkMetadataRollback(async () => {
      notifyWorkMetadataChanges({ pluginId: "source", novelPath: "/work" });
      throw new Error("Synchronization failed before commit");
    })).rejects.toThrow("Synchronization failed before commit");
    expect(changes).toEqual([]);
  } finally { unsubscribe(); }
});
