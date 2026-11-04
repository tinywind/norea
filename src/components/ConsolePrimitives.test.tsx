import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../i18n", () => ({
  useTranslation: () => ({ locale: "en", t: (key: string) => key }),
}));

import { ConsoleCover, isBlankCoverImage, rememberLoadedCoverSource } from "./ConsolePrimitives";

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

describe("ConsoleCover image", () => {
  it("keeps the title fallback under a cover until the image has loaded", () => {
    const html = renderToStaticMarkup(<ConsoleCover alt="Moonlit Archive" src="https://source.test/cover.jpg" />);
    expect(html.indexOf("norea-console-cover-fallback-title")).toBeGreaterThan(-1);
    expect(html.indexOf("norea-console-cover-fallback-title")).toBeLessThan(html.indexOf("<img"));
  });

  it("draws a remounted cover that was already shown without the title placeholder", () => {
    const src = "http://norea-media.localhost/contents/demo/remounted/cover.jpg?v=1";
    rememberLoadedCoverSource(src);
    const html = renderToStaticMarkup(<ConsoleCover alt="Moonlit Archive" src={src} />);
    expect(html).not.toContain("norea-console-cover-fallback-title");
    expect(html).toContain('decoding="sync"');
    expect(html).toContain('loading="eager"');
  });

  it("forgets the least recently shown covers past the bound", () => {
    const oldest = "http://norea-media.localhost/contents/demo/oldest/cover.jpg?v=1";
    const touched = "http://norea-media.localhost/contents/demo/touched/cover.jpg?v=1";
    rememberLoadedCoverSource(oldest);
    rememberLoadedCoverSource(touched);
    for (let index = 0; index < 999; index++) {
      if (index === 500) rememberLoadedCoverSource(touched);
      rememberLoadedCoverSource(`http://norea-media.localhost/contents/demo/${index}/cover.jpg?v=1`);
    }
    const render = (src: string) => renderToStaticMarkup(<ConsoleCover alt="Moonlit Archive" src={src} />);
    expect(render(oldest)).toContain("norea-console-cover-fallback-title");
    expect(render(touched)).not.toContain("norea-console-cover-fallback-title");
  });

  it("bounds remembered data URL covers by their total length", () => {
    const largeCover = (index: number) => `data:image/png;base64,${String(index).padStart(8, "0")}${"A".repeat(4 * 1024 * 1024)}`;
    for (let index = 0; index < 5; index++) rememberLoadedCoverSource(largeCover(index));
    const render = (src: string) => renderToStaticMarkup(<ConsoleCover alt="Moonlit Archive" src={src} />);
    expect(render(largeCover(0))).toContain("norea-console-cover-fallback-title");
    expect(render(largeCover(4))).not.toContain("norea-console-cover-fallback-title");
  });

  it("treats a 1x1 placeholder pixel as a missing cover", () => {
    expect(isBlankCoverImage({ naturalHeight: 1, naturalWidth: 1 })).toBe(true);
    expect(isBlankCoverImage({ naturalHeight: 0, naturalWidth: 0 })).toBe(true);
    expect(isBlankCoverImage({ naturalHeight: 300, naturalWidth: 200 })).toBe(false);
  });
});
