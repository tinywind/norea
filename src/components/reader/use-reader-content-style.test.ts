import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  padding: 16,
  customCss: "",
};

function style(options: {
  isPagedReader: boolean;
  viewportWidth: number;
  pageColumnsPerSpread?: number;
  customCss?: string;
}) {
  return useReaderContentStyle({
    appearance: { ...appearance, customCss: options.customCss ?? "" },
    viewportWidth: options.viewportWidth,
    viewportHeightPx: 900,
    pageColumnsPerSpread: options.pageColumnsPerSpread ?? 1,
    isPagedReader: options.isPagedReader,
    removeExtraParagraphSpacing: false,
  }).contentBoxStyle as Record<string, unknown>;
}

beforeEach(() => {
  vi.stubGlobal("document", { documentElement: {} });
  vi.stubGlobal("window", {
    getComputedStyle: () => ({ fontSize: "16px" }),
    innerWidth: 1600,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reader line length", () => {
  it("caps the scroll column at 40rem plus the page padding and centers it", () => {
    const box = style({ isPagedReader: false, viewportWidth: 1600 });
    expect(box.maxWidth).toBe("calc(40rem + 32px)");
    expect(box.margin).toBe("0 auto");
    expect(box.padding).toBe("16px 16px");
  });

  it("widens paged inline padding so one column stays within the cap", () => {
    const box = style({ isPagedReader: true, viewportWidth: 1600 });
    expect(box.padding).toBe("16px 480px");
    expect(box.columnWidth).toBe("640px");
    expect(box.columnGap).toBe("960px");
  });

  it("caps each column of a two-page spread", () => {
    const box = style({ isPagedReader: true, viewportWidth: 2000, pageColumnsPerSpread: 2 });
    expect(box.padding).toBe("16px 180px");
    expect(box.columnWidth).toBe("640px");
  });

  it("keeps the configured padding on narrow screens and with custom CSS", () => {
    expect(style({ isPagedReader: true, viewportWidth: 600 }).padding).toBe("16px 16px");
    expect(style({ isPagedReader: true, viewportWidth: 1600, customCss: ".reader-content{}" }).padding).toBe(
      "16px 16px",
    );
  });
});
