import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesDir = new URL("./", import.meta.url);
const css = readFileSync(new URL("./ui.css", stylesDir), "utf8");

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
