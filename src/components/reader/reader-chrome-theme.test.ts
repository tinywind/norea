import { expect, it } from "vitest";
import { READER_PRESET_THEMES } from "../../store/reader";
import { contrastRatio, requireColor } from "../../theme/color";
import { STATUS_ROLE_NAMES, TEXT_CONTRAST } from "../../theme/palette-roles";
import { getReaderChromeThemeStyle } from "./reader-chrome-theme";

it("derives the chrome colors from the reader theme", () => {
  const style = getReaderChromeThemeStyle({ backgroundColor: "#000000", textColor: "#FFFFFF" }) as Record<string, string>;
  expect(style["--norea-reader-bg"]).toBe("rgb(0, 0, 0)");
  expect(style["--norea-reader-ink"]).toBe("rgb(255, 255, 255)");
  expect(style["--norea-reader-chrome-bg"]).toBe("rgb(15, 15, 15)");
});

it("keeps chrome text readable on every preset theme", () => {
  for (const theme of READER_PRESET_THEMES) {
    const style = getReaderChromeThemeStyle(theme) as Record<string, string>;
    const chrome = requireColor(style["--norea-reader-chrome-bg"]!);
    expect(contrastRatio(requireColor(style["--norea-reader-ink"]!), chrome), theme.id).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(requireColor(style["--norea-reader-ink-muted"]!), chrome), theme.id).toBeGreaterThanOrEqual(3);
  }
});

it("derives readable reader status alert tokens on every preset theme", () => {
  for (const theme of READER_PRESET_THEMES) {
    const style = getReaderChromeThemeStyle(theme) as Record<string, string>;
    const ink = requireColor(style["--norea-reader-ink"]!);
    for (const name of STATUS_ROLE_NAMES) {
      const soft = requireColor(style[`--norea-reader-${name}-soft`]!);
      const onSoft = requireColor(style[`--norea-reader-on-${name}-soft`]!);
      expect(style[`--norea-reader-${name}-border`], `${theme.id} ${name}`).toMatch(/^rgb\(/);
      expect(contrastRatio(onSoft, soft), `${theme.id} ${name} onSoft`).toBeGreaterThanOrEqual(TEXT_CONTRAST);
      expect(contrastRatio(ink, soft), `${theme.id} ${name} ink`).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    }
  }
});

it("leaves the app palette in place for colors it cannot read", () => {
  expect(getReaderChromeThemeStyle({ backgroundColor: "hsl(0 0% 0%)", textColor: "#fff" })).toBeUndefined();
});
