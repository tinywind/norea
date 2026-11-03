import type { CSSProperties } from "react";
import type { ReaderAppearanceSettings } from "../../store/reader";
import { formatRgb, mixRgb, parseColor } from "../../theme/color";

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
  return {
    "--norea-reader-bg": formatRgb(background),
    "--norea-reader-chrome-bg": formatRgb(mixRgb(background, ink, 0.06)),
    "--norea-reader-chrome-raised": formatRgb(mixRgb(background, ink, 0.1)),
    "--norea-reader-ink": formatRgb(ink),
    "--norea-reader-ink-muted": formatRgb(mixRgb(ink, background, 0.35)),
    "--norea-reader-rule": formatRgb(mixRgb(background, ink, 0.18)),
  } as CSSProperties;
}
