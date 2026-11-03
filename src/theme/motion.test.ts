import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MOTION_DURATION_BASE_MS,
  MOTION_DURATION_FAST_MS,
  MOTION_DURATION_SLOW_MS,
  prefersReducedMotion,
} from "./motion";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

function rootToken(name: string): string {
  const root = tokens.slice(0, tokens.indexOf("@media"));
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(root);
  expect(match, name).not.toBeNull();
  return match![1]!.trim();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("motion constants", () => {
  it("mirror the duration tokens", () => {
    expect(rootToken("--norea-duration-fast")).toBe(`${MOTION_DURATION_FAST_MS}ms`);
    expect(rootToken("--norea-duration-base")).toBe(`${MOTION_DURATION_BASE_MS}ms`);
    expect(rootToken("--norea-duration-slow")).toBe(`${MOTION_DURATION_SLOW_MS}ms`);
  });
});

describe("prefersReducedMotion", () => {
  it("reads the reduced motion media query", () => {
    const matchMedia = vi.fn((query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)" }));
    vi.stubGlobal("window", { matchMedia });
    expect(prefersReducedMotion()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  });

  it("allows motion when the query does not match or matchMedia is missing", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    expect(prefersReducedMotion()).toBe(false);
    vi.stubGlobal("window", {});
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("JavaScript animation paths", () => {
  const srcDir = new URL("../", import.meta.url);
  const sources = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name));

  it("check reduced motion wherever they ease or smooth-scroll", () => {
    const animated = sources.filter((name) => {
      const source = readFileSync(new URL(name, srcDir), "utf8");
      return /easeOutCubic\(|animateScrollTop\(|behavior: "smooth"|\.animate\(/.test(source);
    });
    expect(animated.length).toBeGreaterThan(0);
    for (const name of animated) {
      const source = readFileSync(new URL(name, srcDir), "utf8");
      expect(source, name).toMatch(/prefersReducedMotion\(|readerScrollAnimationDuration\(/);
    }
  });
});
