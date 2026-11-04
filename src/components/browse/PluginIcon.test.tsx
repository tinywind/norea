import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PluginIcon, pluginMonogram, pluginMonogramTone } from "./PluginIcon";

describe("PluginIcon", () => {
  it("shows the repository icon when the plugin has one", () => {
    const html = renderToStaticMarkup(
      <PluginIcon plugin={{ iconUrl: "https://example.com/icon.png", name: "Novel Fire" }} />,
    );
    expect(html).toContain('src="https://example.com/icon.png"');
    expect(html).not.toContain("data-monogram");
  });

  it("falls back to a tinted two-letter monogram", () => {
    const html = renderToStaticMarkup(<PluginIcon plugin={{ iconUrl: "", name: "Novel Fire" }} />);
    expect(html).toContain(`data-monogram="${pluginMonogramTone("Novel Fire")}"`);
    expect(html).toContain(">NF<");
  });

  it("builds monograms from word initials or the start of a single word", () => {
    expect(pluginMonogram("Royal Road")).toBe("RR");
    expect(pluginMonogram("novelupdates")).toBe("No");
    expect(pluginMonogram("노벨피아")).toBe("노벨");
    expect(pluginMonogram("  ")).toBe("?");
  });

  it("keeps the same tone for the same name and spreads different names", () => {
    expect(pluginMonogramTone("Novel Fire")).toBe(pluginMonogramTone("Novel Fire"));
    const tones = new Set(
      ["Novel Fire", "Royal Road", "NovelUpdates", "Kakuyomu", "Syosetu", "Wuxiaworld"].map(
        pluginMonogramTone,
      ),
    );
    expect(tones.size).toBeGreaterThan(1);
  });

  it("styles every monogram tone with a soft palette pair and no border", () => {
    const css = readFileSync(new URL("../../styles/browse.css", import.meta.url), "utf8");
    const base = /\.norea-plugin-icon \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(base).not.toMatch(/\bborder:/);
    expect(base).toContain("var(--norea-weight-medium)");
    for (const tone of ["accent", "info", "ok", "warn"]) {
      expect(css).toContain(`.norea-plugin-icon[data-monogram="${tone}"]`);
      expect(css).toContain(`var(--norea-color-on-${tone}-soft)`);
    }
  });
});
