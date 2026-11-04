import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesDir = new URL("../styles/", import.meta.url);

/** The root size carries the UI scale setting, so it is not a type-scale step. */
const ALLOWED_FONT_SIZES = new Set([
  "inherit",
  "1em",
  "100%",
  "var(--norea-root-font-size)",
]);
const ALLOWED_RADIUS_PARTS = new Set(["0", "50%", "inherit"]);
const ALLOWED_LETTER_SPACING = new Set(["0", "normal"]);
const MAX_LOCAL_Z_INDEX = 10;
const MOTION_PROPERTIES = new Set([
  "transition",
  "transition-duration",
  "transition-delay",
  "animation",
  "animation-duration",
  "animation-delay",
]);
const MIN_FONT_SIZE_PX = 12;

interface Declaration {
  line: number;
  property: string;
  value: string;
}

function declarations(source: string): Declaration[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
  const result: Declaration[] = [];
  const pattern = /[{;]\s*(-?-?[a-zA-Z][-a-zA-Z0-9]*)\s*:\s*([^;{}]*)/g;
  for (const match of withoutComments.matchAll(pattern)) {
    const propertyOffset = match.index + match[0].indexOf(match[1]);
    result.push({
      line: withoutComments.slice(0, propertyOffset).split("\n").length,
      property: match[1].toLowerCase(),
      value: match[2].trim().replace(/\s+/g, " "),
    });
  }
  return result;
}

function topLevelParts(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of value) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth === 0 && (character === " " || character === "/")) {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) parts.push(current);
  return parts;
}

function withoutFunctions(value: string): string {
  let previous = value;
  for (;;) {
    const next = previous.replace(/[a-z-]+\([^()]*\)/g, " ");
    if (next === previous) return next;
    previous = next;
  }
}

function literalDurations(value: string): string[] {
  return [...withoutFunctions(value).matchAll(/(?:^|[\s,])(\d*\.?\d+(?:ms|s))\b/g)]
    .map((match) => match[1])
    .filter((duration) => parseFloat(duration) !== 0);
}

function declaresFontSize(property: string): boolean {
  return (
    property === "font-size" ||
    property === "font" ||
    (property.startsWith("--") && property.includes("font-size"))
  );
}

function pixelFontSizeBelowFloor(value: string): boolean {
  return [...value.matchAll(/(?<![\w.-])(\d*\.?\d+)px\b/g)].some(
    (match) => parseFloat(match[1]) < MIN_FONT_SIZE_PX,
  );
}

function violation({ property, value }: Declaration): string | undefined {
  if (value.includes("color-mix(")) return "color-mix() instead of a role color";
  if (declaresFontSize(property) && pixelFontSizeBelowFloor(value)) {
    return `font size under ${MIN_FONT_SIZE_PX}px`;
  }
  if (property === "font-size") {
    if (ALLOWED_FONT_SIZES.has(value) || value.includes("var(--norea-text-")) {
      return undefined;
    }
    return "literal font-size instead of --norea-text-*";
  }
  if (/^border(-[a-z]+)*-radius$/.test(property)) {
    const literal = topLevelParts(value).some(
      (part) =>
        !ALLOWED_RADIUS_PARTS.has(part) && !part.startsWith("var(--norea-radius-"),
    );
    return literal ? "literal radius instead of --norea-radius-*" : undefined;
  }
  if (MOTION_PROPERTIES.has(property)) {
    return literalDurations(value).length > 0
      ? "literal duration instead of --norea-duration-*"
      : undefined;
  }
  if (property === "z-index") {
    if (value === "auto" || value.startsWith("var(--norea-z-")) return undefined;
    const local = /^\d+$/.test(value) && Number(value) <= MAX_LOCAL_Z_INDEX;
    return local ? undefined : "app layer z-index instead of --norea-z-*";
  }
  if (property === "text-transform" && value === "uppercase") {
    return "uppercase text";
  }
  if (property === "letter-spacing" && !ALLOWED_LETTER_SPACING.has(value)) {
    return "letter-spacing on UI text";
  }
  if (property === "font-family" && value.includes("--norea-font-meta")) {
    return "meta font instead of tabular numerals";
  }
  return undefined;
}

function violations(name: string): string[] {
  const source = readFileSync(new URL(name, stylesDir), "utf8");
  return declarations(source).flatMap((declaration) => {
    const reason = violation(declaration);
    return reason
      ? [`${name}:${declaration.line} ${declaration.property}: ${declaration.value} (${reason})`]
      : [];
  });
}

const sheets = readdirSync(stylesDir)
  .filter((name) => name.endsWith(".css"))
  .sort();

describe("design token guard", () => {
  for (const name of sheets) {
    it(`${name} uses design tokens`, () => {
      expect(violations(name)).toEqual([]);
    });
  }
});

describe("design token guard rules", () => {
  const flagged = (property: string, value: string) =>
    violation({ line: 1, property, value }) !== undefined;

  it("flags pixel font sizes under the 12px floor in any font-size declaration", () => {
    expect(flagged("font-size", "11px")).toBe(true);
    expect(flagged("font-size", "max(10px, var(--norea-text-xs))")).toBe(true);
    expect(flagged("font", "600 11.5px/1.2 var(--norea-font-ui)")).toBe(true);
    expect(flagged("--norea-reader-meta-font-size", "10px")).toBe(true);
    expect(flagged("--norea-root-font-size", "16px")).toBe(false);
    expect(flagged("font-size", "var(--norea-text-xs)")).toBe(false);
  });

  it("flags the literal values the token scale replaces", () => {
    expect(flagged("font-size", "0.6875rem")).toBe(true);
    expect(flagged("border-radius", "0.25rem")).toBe(true);
    expect(flagged("transition", "opacity 120ms ease")).toBe(true);
    expect(flagged("transition-delay", "50ms")).toBe(true);
    expect(flagged("animation", "spin 0.9s linear infinite")).toBe(true);
    expect(flagged("animation-duration", "1s")).toBe(true);
    expect(flagged("animation", "spin var(--norea-duration-spin) linear infinite")).toBe(false);
    expect(flagged("z-index", "30")).toBe(true);
    expect(flagged("text-transform", "uppercase")).toBe(true);
    expect(flagged("letter-spacing", "0.08em")).toBe(true);
    expect(flagged("background", "color-mix(in srgb, red 10%, white)")).toBe(true);
    expect(flagged("font-family", "var(--norea-font-meta)")).toBe(true);
  });

  it("keeps the documented exceptions", () => {
    expect(flagged("font-size", "var(--norea-root-font-size)")).toBe(false);
    expect(flagged("border-radius", "50%")).toBe(false);
    expect(flagged("border", "1px solid var(--norea-color-rule)")).toBe(false);
    expect(flagged("padding-bottom", "var(--norea-safe-area-bottom)")).toBe(false);
    expect(flagged("transition-duration", "0s")).toBe(false);
    expect(flagged("z-index", "10")).toBe(false);
  });
});

describe("overlay tokens", () => {
  const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
  const rootTokens = tokens.slice(0, tokens.indexOf("@media"));
  const srcDir = new URL("../", import.meta.url);
  const consumers = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.(css|tsx?)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith("tokens.css"))
    .map((name) => readFileSync(new URL(name, srcDir), "utf8"))
    .join("\n");

  function zIndex(name: string): number {
    const match = new RegExp(`--norea-z-${name}:\\s*(\\d+);`).exec(rootTokens);
    expect(match, name).not.toBeNull();
    return Number(match![1]);
  }

  it("keeps the layer ladder in order", () => {
    const ladder = [
      "sticky",
      "nav",
      "overlay",
      "overlay-nested",
      "popover",
      "confirm",
      "toast",
      "site-browser",
      "blocking",
    ].map(zIndex);
    expect(ladder).toEqual([...ladder].sort((a, b) => a - b));
    expect(new Set(ladder).size).toBe(ladder.length);
  });

  it("gives every overlay token a consumer", () => {
    for (const token of [
      "--norea-scrim",
      "--norea-shadow-1",
      "--norea-shadow-2",
      "--norea-shadow-sheet",
      "--norea-ease-decelerate",
      "--norea-ease-accelerate",
      "--norea-radius-xl",
      "--norea-color-overlay-border",
      "--norea-z-popover",
      "--norea-z-overlay-nested",
      "--norea-z-confirm",
      "--norea-dialog-sm",
      "--norea-dialog-md",
      "--norea-dialog-lg",
      "--norea-dialog-xl",
      "--norea-side-sheet-width",
      "--norea-bottom-sheet-max-width",
    ]) {
      expect(consumers, token).toContain(`var(${token})`);
    }
  });
});
