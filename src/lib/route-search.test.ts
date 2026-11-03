import { describe, expect, it } from "vitest";
import { parseDownloadsSearch } from "./route-search";

describe("parseDownloadsSearch", () => {
  it("keeps the queue and storage views", () => {
    expect(parseDownloadsSearch({ view: "queue" })).toEqual({ view: "queue" });
    expect(parseDownloadsSearch({ view: "storage" })).toEqual({ view: "storage" });
  });

  it.each([{}, { view: "tasks" }, { view: "STORAGE" }, { view: 1 }, { view: ["storage"] }])(
    "falls back to the queue view for %j",
    (search) => {
      expect(parseDownloadsSearch(search)).toEqual({ view: "queue" });
    },
  );
});
