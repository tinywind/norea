import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./library.css", import.meta.url), "utf8");

function phoneMediaBlock(source: string): string {
  const start = source.indexOf("@media (max-width: 767px)");
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  throw new Error("Unclosed phone media block");
}

describe("library phone header styles", () => {
  it("keeps library header icon buttons reachable below 768px", () => {
    const hiddenSelectors = [
      ...phoneMediaBlock(css).matchAll(/([^{}]+)\{([^{}]*)\}/g),
    ]
      .filter(([, , body]) => /display:\s*none/.test(body))
      .flatMap(([, selectors]) =>
        selectors.split(",").map((selector) => selector.trim()),
      );

    expect(hiddenSelectors).not.toContain(".norea-library-icon-button");
  });
});
