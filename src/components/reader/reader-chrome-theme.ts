import type { CSSProperties } from "react";
import type { ReaderAppearanceSettings } from "../../store/reader";
import {
  BLACK,
  WHITE,
  ensureContrast,
  formatRgb,
  hslToRgb,
  minContrast,
  mixRgb,
  parseColor,
  relativeLuminance,
  type Rgb,
} from "../../theme/color";
import {
  STATUS_ROLE_NAMES,
  TEXT_CONTRAST,
  type ColorScheme,
  type StatusRoleName,
} from "../../theme/palette-roles";

const READER_STATUS_HUES: Record<StatusRoleName, { hue: number; saturation: number }> = {
  danger: { hue: 8, saturation: 0.75 },
  warn: { hue: 38, saturation: 0.9 },
  ok: { hue: 140, saturation: 0.55 },
  info: { hue: 210, saturation: 0.75 },
};

const READER_SOFT_MIX: Record<ColorScheme, number> = { light: 0.12, dark: 0.18 };
const READER_BORDER_MIX: Record<ColorScheme, number> = { light: 0.28, dark: 0.34 };
const READER_STATUS_START_LIGHTNESS: Record<ColorScheme, number> = { light: 0.45, dark: 0.65 };

function solveReaderStatusHue(
  hue: number,
  saturation: number,
  scheme: ColorScheme,
  backgrounds: Rgb[],
  fallbackInk: Rgb,
): Rgb {
  const direction = scheme === "light" ? -1 : 1;
  for (
    let lightness = READER_STATUS_START_LIGHTNESS[scheme];
    lightness >= 0 && lightness <= 1;
    lightness += direction * 0.01
  ) {
    const candidate = hslToRgb(hue, saturation, lightness);
    if (minContrast(candidate, backgrounds) >= TEXT_CONTRAST) return candidate;
  }
  return ensureContrast(
    scheme === "light" ? BLACK : WHITE,
    backgrounds,
    TEXT_CONTRAST,
    fallbackInk,
  );
}

/**
 * Colors for the reader shell and its bars, derived from the reader theme so
 * a dark page is not framed by light app chrome. Returns undefined for colors
 * the parser cannot read, which leaves the app palette in place.
 */
export function getReaderChromeThemeStyle(
  appearance: Pick<ReaderAppearanceSettings, "backgroundColor" | "textColor">,
): CSSProperties | undefined {
  const background = parseColor(appearance.backgroundColor);
  const ink = parseColor(appearance.textColor);
  if (!background || !ink) return undefined;
  const chromeBg = mixRgb(background, ink, 0.06);
  const scheme: ColorScheme = relativeLuminance(background) < 0.35 ? "dark" : "light";
  const surfaces = [background, chromeBg];

  const variables: Record<string, string> = {
    "--norea-reader-bg": formatRgb(background),
    "--norea-reader-chrome-bg": formatRgb(chromeBg),
    "--norea-reader-chrome-raised": formatRgb(mixRgb(background, ink, 0.1)),
    "--norea-reader-ink": formatRgb(ink),
    "--norea-reader-ink-muted": formatRgb(mixRgb(ink, background, 0.35)),
    "--norea-reader-rule": formatRgb(mixRgb(background, ink, 0.18)),
  };
  for (const name of STATUS_ROLE_NAMES) {
    const spec = READER_STATUS_HUES[name];
    const base = solveReaderStatusHue(spec.hue, spec.saturation, scheme, surfaces, ink);
    const soft = mixRgb(chromeBg, base, READER_SOFT_MIX[scheme]);
    const border = mixRgb(chromeBg, base, READER_BORDER_MIX[scheme]);
    const onSoft = ensureContrast(base, [soft, chromeBg, background], TEXT_CONTRAST, ink);
    variables[`--norea-reader-${name}`] = formatRgb(base);
    variables[`--norea-reader-${name}-soft`] = formatRgb(soft);
    variables[`--norea-reader-on-${name}-soft`] = formatRgb(onSoft);
    variables[`--norea-reader-${name}-border`] = formatRgb(border);
  }
  return variables as CSSProperties;
}
