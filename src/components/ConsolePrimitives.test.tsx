import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../i18n", () => ({
  useTranslation: () => ({ locale: "en", t: (key: string) => key }),
}));

import { ConsoleCover } from "./ConsolePrimitives";

function coverStyle(title: string): string {
  const html = renderToStaticMarkup(<ConsoleCover alt={title} src={null} />);
  return /class="norea-console-cover" data-fit="cover" style="([^"]*)"/.exec(html)?.[1] ?? "";
}

describe("ConsoleCover fallback", () => {
  it("renders the title over a theme gradient instead of random hues", () => {
    const html = renderToStaticMarkup(<ConsoleCover alt="Moonlit Archive" src={null} />);
    expect(html).toContain('<span class="norea-console-cover-fallback-title">Moonlit Archive</span>');
    const style = coverStyle("Moonlit Archive");
    expect(style).toMatch(/--norea-console-cover-angle:\d+deg/);
    expect(style).toMatch(/--norea-console-cover-accent-stop:\d+%/);
    expect(style).not.toMatch(/hsla?\(|stripe|glow/);
  });

  it("varies the gradient per title and keeps it stable for the same title", () => {
    expect(coverStyle("Moonlit Archive")).toBe(coverStyle("Moonlit Archive"));
    const titles = Array.from({ length: 16 }, (_, index) => `Volume ${index}`);
    expect(new Set(titles.map(coverStyle)).size).toBeGreaterThan(1);
  });
});
