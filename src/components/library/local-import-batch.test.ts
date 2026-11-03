import { expect, it } from "vitest";
import {
  beginLocalImport,
  getLocalImportResultCounts,
  isLocalImportBusy,
  replaceLocalImportItem,
  startLocalImportBatch,
  updateLocalImportBatch,
} from "./local-import-batch";
import type { LocalImportReviewItem } from "./local-import-review";

const item = (id: string, status: LocalImportReviewItem["status"]) =>
  ({ file: new File([""], `${id}.txt`), id, status }) as LocalImportReviewItem;

it("ignores a late analysis or import result for an older batch", () => {
  const current = { ...startLocalImportBatch(2), items: [item("new", "ready")], phase: "review" as const };
  const late = updateLocalImportBatch(current, 1, (older) => ({
    ...older,
    items: [item("old", "imported")],
    phase: "result",
  }));
  expect(late).toBe(current);
  expect(updateLocalImportBatch(null, 1, (older) => older)).toBeNull();
  expect(updateLocalImportBatch(current, 2, (batch) => ({ ...batch, phase: "result" }))?.phase).toBe("result");
});

it("imports only ready files and counts imported, skipped and failed files", () => {
  const reviewed = {
    ...startLocalImportBatch(1),
    items: [item("a", "ready"), item("b", "ready"), item("c", "duplicate"), item("d", "unsupported")],
    phase: "review" as const,
  };
  const importing = beginLocalImport(reviewed);
  expect(isLocalImportBusy(importing)).toBe(true);
  expect(importing.items.map((entry) => entry.status)).toEqual(["importing", "importing", "duplicate", "unsupported"]);

  const done = replaceLocalImportItem(replaceLocalImportItem(importing, item("a", "imported")), item("b", "error"));
  expect(getLocalImportResultCounts({ ...done, phase: "result" })).toEqual({ failed: 1, imported: 1, skipped: 2 });
  expect(isLocalImportBusy({ ...done, phase: "result" })).toBe(false);
  expect(isLocalImportBusy(startLocalImportBatch(3))).toBe(true);
});
