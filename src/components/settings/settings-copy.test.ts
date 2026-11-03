import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import en from "../../../strings/languages/en/app.json";
import ko from "../../../strings/languages/ko/app.json";

const MAX_DESCRIPTION_LENGTH = 120;
const IMPLEMENTATION_WORDING = [
  /contents\//,
  /always trusted/,
  /root font size/,
  /\bin px\b/,
  /release workflow/,
  /GitHub Actions/,
];

const settingsDir = new URL("./", import.meta.url);
const sources = [
  ...readdirSync(settingsDir)
    .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
    .map((name) => new URL(name, settingsDir)),
  new URL("../ContentServerSettings.tsx", settingsDir),
  new URL("../ReadingStateSettings.tsx", settingsDir),
  new URL("../SavedVpnProfilesSettings.tsx", settingsDir),
  new URL("../LibrarySettingsPanel.tsx", settingsDir),
];

const descriptionKeys = [
  ...new Set(
    sources.flatMap((source) => {
      const code = readFileSync(source, "utf8");
      return [
        ...code.matchAll(/description=\{\s*t\(\s*"([^"]+)"/g),
        ...code.matchAll(/t\(\s*"([^"]*[dD]escription[^"]*)"/g),
      ].map((match) => match[1]!);
    }),
  ),
].sort();

describe("settings descriptions", () => {
  it("finds the settings row descriptions", () => {
    expect(descriptionKeys.length).toBeGreaterThan(40);
  });

  it.each([
    ["en", en as Record<string, string>],
    ["ko", ko as Record<string, string>],
  ])("stay short and free of implementation wording in %s", (_locale, messages) => {
    for (const key of descriptionKeys) {
      const text = messages[key];
      expect(text, key).toBeTypeOf("string");
      expect(text.length, key).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
      for (const pattern of IMPLEMENTATION_WORDING) expect(text, key).not.toMatch(pattern);
    }
  });
});
