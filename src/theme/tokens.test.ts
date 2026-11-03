import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesDir = new URL("../styles/", import.meta.url);

/** Stylesheets that still carry literal values; each one leaves this list in its migration commit. */
const NOT_YET_MIGRATED = new Set([
  "app.css",
  "browse.css",
  "downloads.css",
  "library.css",
  "novel.css",
  "novel-merge.css",
  "plugin-vpn-finder.css",
  "reader.css",
  "settings.css",
  "tasks.css",
  "updates.css",
]);

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

function violation({ property, value }: Declaration): string | undefined {
  if (value.includes("color-mix(")) return "color-mix() instead of a role color";
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
  if (property === "transition" || property === "transition-duration") {
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
  it("lists only existing stylesheets as not yet migrated", () => {
    for (const name of NOT_YET_MIGRATED) expect(sheets).toContain(name);
  });

  for (const name of sheets) {
    if (NOT_YET_MIGRATED.has(name)) {
      it(`${name} still needs migration, otherwise it leaves the allowlist`, () => {
        expect(violations(name)).not.toEqual([]);
      });
    } else {
      it(`${name} uses design tokens`, () => {
        expect(violations(name)).toEqual([]);
      });
    }
  }
});
