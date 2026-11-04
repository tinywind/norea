import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesDir = new URL("./", import.meta.url);
const sheet = (name: string) => readFileSync(new URL(name, stylesDir), "utf8");
const tokens = readFileSync(new URL("../theme/tokens.css", import.meta.url), "utf8");

interface Rule {
  selectors: string[];
  body: string;
}

function rules(source: string): Rule[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1].split(",").map((selector) => selector.trim().replace(/\s+/g, " ")).filter(Boolean),
    body: match[2],
  }));
}

function declaration(body: string, property: string): string | undefined {
  return new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`).exec(body)?.[1]?.trim().replace(/\s+/g, " ");
}

const allRules = readdirSync(stylesDir)
  .filter((name) => name.endsWith(".css"))
  .flatMap((name) => rules(sheet(name)).map((rule) => ({ ...rule, name })));

/** The bar containers: page headers (selection state included), the reader bar and the site browser bar. */
const BAR_SELECTOR = /^\.norea-(?:app-bar(?:-row)?|selection-bar|reader-topbar|site-browser-bar)$/;

describe("header style", () => {
  it("sizes one header row from the control height plus a 4px margin above and below", () => {
    expect(tokens).toMatch(/--norea-app-bar-height: calc\(var\(--norea-control-sm\) \+ var\(--norea-space-2\)\);/);
    expect(tokens).toMatch(/--norea-app-bar-padding-inline: var\(--norea-space-2\);/);
    const row = rules(sheet("app.css")).find((rule) => rule.selectors.includes(".norea-app-bar-row"))!;
    expect(declaration(row.body, "min-height")).toBe("var(--norea-app-bar-height)");
    expect(declaration(row.body, "padding")).toBe("0 var(--norea-app-bar-padding-inline)");
    expect(sheet("reader.css")).toMatch(/--norea-reader-bar-height: calc\(var\(--norea-app-bar-height\) \+ 1px\);/);
  });

  it("gives no bar container a height or vertical padding of its own", () => {
    for (const rule of allRules) {
      if (!rule.selectors.some((selector) => BAR_SELECTOR.test(selector))) continue;
      for (const property of ["height", "min-height"]) {
        const value = declaration(rule.body, property);
        if (value === undefined) continue;
        expect(
          ["var(--norea-app-bar-height)", "var(--norea-reader-bar-height)"],
          `${rule.name} ${rule.selectors.join(", ")} ${property}`,
        ).toContain(value);
      }
    }
  });

  it("draws header icon buttons and text actions borderless", () => {
    const base = rules(sheet("app.css")).find(
      (rule) => rule.selectors.includes(".norea-app-bar .norea-icon-button") &&
        rule.selectors.includes(".norea-app-bar .mantine-Button-root"),
    )!;
    expect(declaration(base.body, "background")).toBe("transparent");
    expect(declaration(base.body, "border-color")).toBe("transparent");
    for (const rule of allRules) {
      if (!rule.selectors.some((selector) => /app-bar.*(?:icon-button|Button-root)/.test(selector))) continue;
      const border = declaration(rule.body, "border-color") ?? declaration(rule.body, "border");
      if (border !== undefined) expect(border, `${rule.name} ${rule.selectors.join(", ")}`).toBe("transparent");
    }
  });

  it("keeps the selection state on the header's own height and padding", () => {
    const own = allRules.filter((rule) => rule.selectors.includes(".norea-selection-bar"));
    expect(own).toEqual([]);
  });
});

it("keeps the library header flush with the top on phones, like every other page header", () => {
  const app = readFileSync(new URL("./app.css", import.meta.url), "utf8");
  const phone = app.slice(app.indexOf("@media (max-width: 767px)"));
  expect(phone).not.toMatch(/^\s*\.norea-page-frame \{\s*padding-top/m);
  expect(phone).toMatch(/\.norea-page-frame:not\(\.norea-library-page\) \{\s*padding-top/);
});
