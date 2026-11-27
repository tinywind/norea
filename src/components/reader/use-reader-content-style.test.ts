import { describe, expect, it, vi } from "vitest";
import { useReaderContentStyle } from "./use-reader-content-style";

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useMemo: <T,>(factory: () => T) => factory(),
}));

const appearance = {
  textColor: "#111111",
  textSize: 16,
  lineHeight: 1.5,
  textAlign: "left" as const,
  fontFamily: "",
  paddingHorizontal: 20,
  paddingVertical: 8,
};

function style(options: {
  isPagedReader: boolean;
  viewportWidth: number;
  pageColumnsPerSpread?: number;
  paddingHorizontal?: number;
  paddingVertical?: number;
}) {
  return useReaderContentStyle({
    appearance: {
      ...appearance,
      paddingHorizontal: options.paddingHorizontal ?? appearance.paddingHorizontal,
      paddingVertical: options.paddingVertical ?? appearance.paddingVertical,
    },
    viewportWidth: options.viewportWidth,
    viewportHeightPx: 900,
    pageColumnsPerSpread: options.pageColumnsPerSpread ?? 1,
    isPagedReader: options.isPagedReader,
    removeExtraParagraphSpacing: false,
  }).contentBoxStyle as Record<string, unknown>;
}

describe("reader page padding", () => {
  it.each([600, 1600])("uses the configured padding across the full %ipx scrolling viewport", (viewportWidth) => {
    const box = style({ isPagedReader: false, viewportWidth });
    expect(box.width).toBe("100%");
    expect(box.maxWidth).toBeUndefined();
    expect(box.padding).toBe("8px 20px");
  });

  it.each<[number, number, string]>([
    [600, 1, "560px"],
    [1600, 1, "1560px"],
    [2000, 2, "960px"],
    [1601, 2, "760.5px"],
  ])("uses the available width of a %ipx spread with %i columns", (viewportWidth, pageColumnsPerSpread, width) => {
    const box = style({ isPagedReader: true, viewportWidth, pageColumnsPerSpread });
    expect(box.padding).toBe("8px 20px");
    expect(box.columnWidth).toBe(width);
    expect(box.columnGap).toBe("40px");
    expect(box["--norea-reader-page-media-max-height"]).toBe("884px");
  });

  it("changes only the selected axis and supports edge-to-edge pages", () => {
    const page = { isPagedReader: true, viewportWidth: 1600, pageColumnsPerSpread: 2 };
    const noSides = style({ ...page, paddingHorizontal: 0 });
    expect(noSides.padding).toBe("8px 0px");
    expect(noSides.columnWidth).toBe("800px");
    expect(noSides.columnGap).toBe("0px");
    expect(noSides["--norea-reader-page-media-max-height"]).toBe("884px");

    const noTopOrBottom = style({ ...page, paddingVertical: 0 });
    expect(noTopOrBottom.padding).toBe("0px 20px");
    expect(noTopOrBottom.columnWidth).toBe("760px");
    expect(noTopOrBottom["--norea-reader-page-media-max-height"]).toBe("900px");
  });
});
