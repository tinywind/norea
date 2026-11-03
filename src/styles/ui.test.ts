import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesDir = new URL("./", import.meta.url);
const css = readFileSync(new URL("./ui.css", stylesDir), "utf8");
const appCss = readFileSync(new URL("./app.css", stylesDir), "utf8");

function mediaBlock(source: string, query: string): string {
  const start = source.indexOf(`@media ${query}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`Unclosed ${query} media block`);
}

interface Rule {
  selectors: string[];
  body: string;
}

function rules(source: string): Rule[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1]
      .split(",")
      .map((selector) => selector.trim().replace(/\s+/g, " "))
      .filter(Boolean),
    body: match[2],
  }));
}

/** Every declaration that applies to the exact selector, across all rules that list it. */
function ruleFor(source: string, selector: string): Rule {
  const matching = rules(source).filter((candidate) => candidate.selectors.includes(selector));
  expect(matching, selector).not.toEqual([]);
  return { selectors: [selector], body: matching.map((rule) => rule.body).join("\n") };
}

describe("state layer utility", () => {
  it("paints a currentColor layer that hover raises only on hover-capable pointers", () => {
    expect(css).toMatch(/\.norea-state-layer::after \{[^}]*background: currentColor;[^}]*opacity: 0;/);
    const hover = mediaBlock(css, "(hover: hover)");
    expect(hover).toMatch(/\.norea-state-layer:hover[^{]*::after \{\s*opacity: 0\.08;/);
    expect(css.replace(hover, "")).not.toMatch(/:hover/);
    expect(css).toMatch(/\.norea-state-layer:active[^{]*::after \{\s*opacity: 0\.12;/);
  });

  it("replaces the white hover overlay variables in every stylesheet", () => {
    const sheets = readdirSync(stylesDir).filter((name) => name.endsWith(".css"));
    for (const name of sheets) {
      const source = readFileSync(new URL(`./${name}`, stylesDir), "utf8");
      expect(source, name).not.toMatch(/hover-overlay/);
    }
  });
});

describe("focus indicator", () => {
  it("draws a real outline in the focus role instead of a shadow ring", () => {
    for (const selector of [
      ":focus-visible",
      ".mantine-focus-auto:focus-visible",
      ".mantine-focus-always:focus",
    ]) {
      const { body } = ruleFor(appCss.replace(mediaBlock(appCss, "(forced-colors: active)"), ""), selector);
      expect(body, selector).toMatch(/outline: var\(--norea-focus-width\) solid var\(--norea-color-focus\);/);
      expect(body, selector).toMatch(/outline-offset: 2px;/);
      expect(body, selector).not.toMatch(/box-shadow/);
    }
  });

  it("switches the outline to the system highlight color in forced colors mode", () => {
    const forced = mediaBlock(appCss, "(forced-colors: active)");
    expect(ruleFor(forced, ":focus-visible").body).toMatch(/outline-color: Highlight;/);
  });

  it("points Mantine input focus borders at the focus role", () => {
    expect(appCss).toMatch(/\.mantine-Input-wrapper[^{]*\{\s*--input-bd-focus: var\(--norea-color-focus\);/);
  });

  it("never hides focus behind a shadow-only ring in any stylesheet", () => {
    const sheets = readdirSync(stylesDir).filter((name) => name.endsWith(".css"));
    for (const name of sheets) {
      const source = readFileSync(new URL(`./${name}`, stylesDir), "utf8");
      for (const rule of rules(source)) {
        if (!rule.selectors.some((selector) => /:focus(-visible)?\b/.test(selector))) continue;
        expect(rule.body, `${name} ${rule.selectors.join(", ")}`).not.toMatch(/--norea-focus-ring/);
      }
    }
  });
});

describe("coarse pointer touch floor", () => {
  const coarse = mediaBlock(css, "(any-pointer: coarse)");

  it("raises shared controls, nav links and chip buttons to the 44px control token", () => {
    for (const selector of [
      "html:root .norea-icon-button",
      "html:root .mantine-ActionIcon-root",
      "html:root .norea-text-button",
      "html:root .mantine-Button-root",
      "html:root .mantine-CloseButton-root",
      "html:root .norea-rail-link",
      "html:root button.norea-console-chip",
    ]) {
      const { body } = ruleFor(coarse, selector);
      expect(body, selector).toMatch(/min-height: var\(--norea-control-md\);/);
      expect(body, selector).toMatch(/min-width: var\(--norea-control-md\);/);
    }
  });

  it("grows the hit area with a transparent pseudo-element where the bar height is fixed", () => {
    for (const control of [
      ".mantine-Input-section .mantine-ActionIcon-root",
      ".norea-library-selection-icon",
      ".norea-novel-selection-icon",
      ".norea-mobile-nav-link",
    ]) {
      const { body } = ruleFor(coarse, `html:root ${control}::before`);
      expect(body, control).toMatch(/content: "";/);
      expect(body, control).toMatch(/height: max\(100%, var\(--norea-control-md\)\);/);
      expect(body, control).toMatch(/width: max\(100%, var\(--norea-control-md\)\);/);
      expect(body, control).not.toMatch(/background/);
      expect(ruleFor(coarse, `html:root ${control}`).body, control).toMatch(/position: relative;/);
    }
    expect(
      ruleFor(coarse, "html:root .mantine-Input-section .mantine-ActionIcon-root").body,
    ).toMatch(/min-height: 0;/);
  });

  it("lets reader bar buttons take the full touch floor instead of a hit-area overlay", () => {
    expect(coarse).not.toMatch(/norea-reader-/);
  });

  it("keeps the touch floor out of fine pointer layouts", () => {
    expect(css.replace(coarse, "")).not.toMatch(/--norea-control-md/);
  });
});

describe("tap highlight", () => {
  it("is suppressed only on reader tap surfaces and controls with their own pressed state", () => {
    const reader = readFileSync(new URL("./reader.css", stylesDir), "utf8");
    const suppressed = rules(reader)
      .filter((rule) => /-webkit-tap-highlight-color: transparent/.test(rule.body))
      .flatMap((rule) => rule.selectors)
      .sort();
    expect(suppressed).toEqual([
      ".norea-pdf-reader-viewport",
      ".norea-reader-chapter-row",
      ".norea-reader-floating-seekbar",
      ".norea-reader-icon-button",
      ".reader-viewport",
    ]);
    const sheets = readdirSync(stylesDir).filter((name) => name.endsWith(".css") && name !== "reader.css");
    for (const name of sheets) {
      const source = readFileSync(new URL(`./${name}`, stylesDir), "utf8");
      expect(source, name).not.toMatch(/-webkit-tap-highlight-color/);
    }
  });
});

describe("page slot transition", () => {
  it("cross-fades pages with motion tokens", () => {
    expect(ruleFor(appCss, ".norea-page-slot").body).toMatch(
      /transition: opacity var\(--norea-duration-base\) var\(--norea-ease-standard\);/,
    );
  });

  it("keeps a leaving page visible only until its fade ends", () => {
    const { body } = ruleFor(appCss, '.norea-page-slot[data-active="false"]');

    expect(body).toMatch(/opacity: 0;/);
    expect(body).toMatch(/visibility: hidden;/);
    expect(body).toMatch(/pointer-events: none;/);
    expect(body).toMatch(/position: absolute;/);
    expect(body).toMatch(
      /transition:\s*opacity var\(--norea-duration-base\) var\(--norea-ease-standard\),\s*visibility 0s linear var\(--norea-duration-base\);/,
    );
  });
});
