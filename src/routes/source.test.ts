import { describe, expect, it, vi } from "vitest";
import { FilterTypes, type Filters } from "../lib/plugins/filterTypes";
import { emptySourceFilterValues } from "../lib/plugins/source-filter-storage";
import type { Plugin } from "../lib/plugins/types";

vi.mock("../components/PdfReaderContent", () => ({
  PdfReaderContent: () => null,
}));

const { canLoadSourceListing } = await import("./source");

describe("canLoadSourceListing", () => {
  const plugin = { id: "newtoki-webtoon" } as Plugin;

  it("waits for filter state to initialize when an installed plugin loads", () => {
    expect(canLoadSourceListing(plugin, undefined, plugin.id, true)).toBe(false);
    expect(canLoadSourceListing(plugin, plugin, plugin.id, true)).toBe(true);
  });

  it("keeps empty-string picker defaults in the initialized filter payload", () => {
    const schema: Filters = {
      completion: {
        label: "Completion",
        options: [
          { label: "Incomplete", value: "" },
          { label: "Complete", value: "1" },
        ],
        type: FilterTypes.Picker,
        value: "",
      },
      type: {
        label: "Type",
        options: [
          { label: "General webtoon", value: "" },
          { label: "Adult webtoon", value: "1" },
        ],
        type: FilterTypes.Picker,
        value: "",
      },
    };

    expect(emptySourceFilterValues(schema)).toEqual({
      completion: { type: FilterTypes.Picker, value: "" },
      type: { type: FilterTypes.Picker, value: "" },
    });
  });
});
