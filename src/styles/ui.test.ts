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

function ruleFor(source: string, selector: string): Rule {
  const rule = rules(source).find((candidate) => candidate.selectors.includes(selector));
  expect(rule, selector).toBeDefined();
  return rule as Rule;
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
