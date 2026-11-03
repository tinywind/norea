export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const BLACK: Rgb = { r: 0, g: 0, b: 0 };
export const WHITE: Rgb = { r: 255, g: 255, b: 255 };

const HEX_COLOR = /^#([\da-f]{3}|[\da-f]{6})$/i;
const RGB_COLOR =
  /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;

/** Parses `#rgb`, `#rrggbb` and `rgb(r, g, b)`; returns null for anything else. */
export function parseColor(value: string): Rgb | null {
  const color = value.trim();
  const hex = HEX_COLOR.exec(color)?.[1];
  if (hex) {
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((part) => part + part)
            .join("")
        : hex;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    };
  }
  const rgb = RGB_COLOR.exec(color);
  if (!rgb) return null;
  const channels = rgb.slice(1, 4).map(Number);
  if (channels.some((channel) => channel > 255)) return null;
  return { r: channels[0]!, g: channels[1]!, b: channels[2]! };
}

export function requireColor(value: string): Rgb {
  const color = parseColor(value);
  if (!color) throw new Error(`Unsupported palette color: ${value}`);
  return color;
}

export function formatRgb({ r, g, b }: Rgb): string {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

export function formatRgba({ r, g, b }: Rgb, alpha: number): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

function roundRgb({ r, g, b }: Rgb): Rgb {
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
}

/** Per-channel sRGB mix; `amount` 0 keeps `from`, 1 returns `to`. */
export function mixRgb(from: Rgb, to: Rgb, amount: number): Rgb {
  return roundRgb({
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
  });
}

function linearChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance({ r, g, b }: Rgb): number {
  return (
    0.2126 * linearChannel(r) +
    0.7152 * linearChannel(g) +
    0.0722 * linearChannel(b)
  );
}

/** WCAG 2 contrast ratio between two opaque colors. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function minContrast(foreground: Rgb, backgrounds: Rgb[]): number {
  return Math.min(
    ...backgrounds.map((background) => contrastRatio(foreground, background)),
  );
}

/** Black or white, whichever contrasts more with `background` (always at least 4.58:1). */
export function blackOrWhite(background: Rgb): Rgb {
  return contrastRatio(BLACK, background) >= contrastRatio(WHITE, background)
    ? BLACK
    : WHITE;
}

const MIX_STEPS = 50;

/**
 * Mixes `foreground` toward `toward` in small steps and returns the first
 * color that reaches `target` against every background. When `toward` itself
 * fails, continues from it toward black or white.
 */
export function ensureContrast(
  foreground: Rgb,
  backgrounds: Rgb[],
  target: number,
  toward: Rgb,
): Rgb {
  for (let step = 0; step <= MIX_STEPS; step += 1) {
    const candidate = mixRgb(foreground, toward, step / MIX_STEPS);
    if (minContrast(candidate, backgrounds) >= target) return candidate;
  }
  const extreme =
    minContrast(BLACK, backgrounds) >= minContrast(WHITE, backgrounds)
      ? BLACK
      : WHITE;
  if (toward.r === extreme.r && toward.g === extreme.g && toward.b === extreme.b) {
    return extreme;
  }
  return ensureContrast(toward, backgrounds, target, extreme);
}

export function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = hue / 60;
  const second = chroma * (1 - Math.abs((segment % 2) - 1));
  const [r, g, b] =
    segment < 1
      ? [chroma, second, 0]
      : segment < 2
        ? [second, chroma, 0]
        : segment < 3
          ? [0, chroma, second]
          : segment < 4
            ? [0, second, chroma]
            : segment < 5
              ? [second, 0, chroma]
              : [chroma, 0, second];
  const offset = lightness - chroma / 2;
  return roundRgb({
    r: (r + offset) * 255,
    g: (g + offset) * 255,
    b: (b + offset) * 255,
  });
}
