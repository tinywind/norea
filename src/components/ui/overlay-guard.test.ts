import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const srcDir = new URL("../../", import.meta.url);
/** Only the overlay primitives may build on Mantine's Modal and Drawer directly. */
const PRIMITIVES_DIR = "components/ui/";
const MANTINE_OVERLAYS = new Set(["Modal", "Drawer"]);
/** Matches the CSS guard: small values stack siblings locally, larger ones belong on the layer ladder. */
const MAX_LOCAL_Z_INDEX = 10;

const sources = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .map((name) => name.replaceAll("\\", "/"))
  .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".test-support.ts"));

/** Names a file imports from `@mantine/core`, without `type` and `as` aliases. */
function mantineCoreImports(source: string): string[] {
  const pattern = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@mantine\/core["']/g;
  return [...source.matchAll(pattern)].flatMap((match) =>
    match[1]!
      .split(",")
      .map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim())
      .filter(Boolean),
  );
}

/** `zIndex` values that bypass the layer tokens: offsets with calc() or literals above the local range. */
function literalZIndexes(source: string): string[] {
  const pattern = /\bzIndex\s*[=:]\s*([^,}\n]+)/g;
  return [...source.matchAll(pattern)]
    .map((match) => match[1]!.trim())
    .filter((value) => {
      if (value.includes("calc(")) return true;
      const withoutTokens = value.replace(/var\(--norea-z-[a-z-]+\)/g, "");
      return [...withoutTokens.matchAll(/\d+/g)].some((number) => Number(number[0]) > MAX_LOCAL_Z_INDEX);
    });
}

describe("overlay guard", () => {
  it("routes every dialog and drawer through the overlay primitives", () => {
    const offenders = sources
      .filter((name) => !name.startsWith(PRIMITIVES_DIR))
      .flatMap((name) => {
        const imported = mantineCoreImports(readFileSync(new URL(name, srcDir), "utf8"));
        return imported.filter((entry) => MANTINE_OVERLAYS.has(entry)).map((entry) => `${name}: ${entry}`);
      });
    expect(offenders).toEqual([]);
  });

  it("keeps overlay layers on the z-index tokens", () => {
    const offenders = sources
      .filter((name) => name.endsWith(".tsx"))
      .flatMap((name) =>
        literalZIndexes(readFileSync(new URL(name, srcDir), "utf8")).map((value) => `${name}: zIndex ${value}`),
      );
    expect(offenders).toEqual([]);
  });
});

describe("overlay guard rules", () => {
  it("reads Mantine imports across lines, type-only imports and aliases", () => {
    expect(mantineCoreImports('import { Button, Modal } from "@mantine/core";')).toEqual(["Button", "Modal"]);
    expect(mantineCoreImports('import {\n  Drawer as SideDrawer,\n  Text,\n} from "@mantine/core";')).toEqual(["Drawer", "Text"]);
    expect(mantineCoreImports('import { type ModalProps } from "@mantine/core";')).toEqual(["ModalProps"]);
    expect(mantineCoreImports('import { Modal } from "./Modal";')).toEqual([]);
  });

  it("flags app-layer literals and calc offsets but keeps tokens and local stacking", () => {
    expect(literalZIndexes("<Modal zIndex={400} />")).toHaveLength(1);
    expect(literalZIndexes('zIndex="calc(var(--norea-z-overlay) + 1)"')).toHaveLength(1);
    expect(literalZIndexes('zIndex: "1000"')).toHaveLength(1);
    expect(literalZIndexes('zIndex="var(--norea-z-confirm)"')).toEqual([]);
    expect(literalZIndexes('zIndex: nested ? "var(--norea-z-overlay-nested)" : undefined')).toEqual([]);
    expect(literalZIndexes("style={{ zIndex: 1 }}")).toEqual([]);
  });
});
