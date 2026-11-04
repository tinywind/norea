import {
  BLACK,
  WHITE,
  blackOrWhite,
  contrastRatio,
  ensureContrast,
  formatRgb,
  hslToRgb,
  minContrast,
  mixRgb,
  requireColor,
  type Rgb,
} from "./color";
import type { Md3Palette } from "./md3";

export type ColorScheme = "light" | "dark";

export const STATUS_ROLE_NAMES = ["danger", "warn", "ok", "info"] as const;
export type StatusRoleName = (typeof STATUS_ROLE_NAMES)[number];

export interface StatusRole {
  /** Text and icon color, at least 4.5:1 on bg, surface and surface-raised. */
  color: string;
  soft: string;
  onSoft: string;
}

export interface PaletteRoles {
  bg: string;
  surface: string;
  surfaceRaised: string;
  ink: string;
  inkMuted: string;
  rule: string;
  ruleStrong: string;
  iconSubtle: string;
  accent: string;
  onAccent: string;
  accentSoft: string;
  onAccentSoft: string;
  danger: StatusRole;
  warn: StatusRole;
  ok: StatusRole;
  info: StatusRole;
  selected: string;
  focus: string;
  /** Tooltip and snackbar surface, opposite to the scheme. */
  inverseSurface: string;
  onInverseSurface: string;
  /** Action text on the inverse surface, such as a toast's button, at 4.5:1. */
  inverseAccent: string;
  /** Toast accent bars on the inverse surface, at 3:1. */
  inverseStatus: Record<StatusRoleName, string>;
  shadowFloating: string;
  /** Sheets, dialogs, menus and popovers: `surface` lifted toward `ink`, always set apart from `bg`. */
  overlaySurface: string;
  /** Overlay outline: the rule color in dark schemes, invisible in light ones. */
  overlayBorder: string;
  scrim: string;
  /** Menus and popovers. */
  shadow1: string;
  /** Dialogs and side drawers. */
  shadow2: string;
  /** Bottom sheets: an upward shadow. */
  shadowSheet: string;
}

export const TEXT_CONTRAST = 4.5;
export const NON_TEXT_CONTRAST = 3;

const SOFT_MIX = { light: 0.12, dark: 0.18 } as const;

const FIXED_STATUS_HUES = {
  warn: { hue: 38, saturation: 0.9 },
  ok: { hue: 140, saturation: 0.55 },
  info: { hue: 210, saturation: 0.75 },
} as const;

/** Light schemes start dark enough to read on white; dark schemes start as light tints. */
const STATUS_START_LIGHTNESS = { light: 0.45, dark: 0.65 } as const;
const LIGHTNESS_STEP = 0.01;

const SHADOW_FLOATING = {
  light: "0 0.5rem 1.25rem rgba(15, 23, 42, 0.14)",
  dark: "0 0.5rem 1.5rem rgba(0, 0, 0, 0.42)",
} as const;

const OVERLAY_ELEVATION = {
  light: {
    scrim: "rgba(15, 23, 42, 0.4)",
    shadow1: "0 0.25rem 0.75rem rgba(15, 23, 42, 0.14)",
    shadow2: "0 0.75rem 2rem rgba(15, 23, 42, 0.2)",
    shadowSheet: "0 -0.5rem 1.5rem rgba(15, 23, 42, 0.14)",
  },
  dark: {
    scrim: "rgba(0, 0, 0, 0.56)",
    shadow1: "0 0.25rem 0.75rem rgba(0, 0, 0, 0.44)",
    shadow2: "0 0.75rem 2rem rgba(0, 0, 0, 0.56)",
    shadowSheet: "0 -0.5rem 1.5rem rgba(0, 0, 0, 0.48)",
  },
} as const;

/** How far the overlay surface starts from `surface` toward `ink`. */
const OVERLAY_LIFT = { light: 0.03, dark: 0.08 } as const;
const OVERLAY_LIFT_STEP = 0.01;
/** The smallest luminance contrast an overlay keeps against the page background. */
export const OVERLAY_SEPARATION = 1.05;

/** Lifts `surface` toward `ink` until it reaches `OVERLAY_SEPARATION` against `bg`. */
function liftOverlaySurface(surface: Rgb, ink: Rgb, bg: Rgb, scheme: ColorScheme): Rgb {
  for (let lift = OVERLAY_LIFT[scheme]; lift <= 1; lift += OVERLAY_LIFT_STEP) {
    const candidate = mixRgb(surface, ink, lift);
    if (contrastRatio(candidate, bg) >= OVERLAY_SEPARATION) return candidate;
  }
  return ink;
}

function solveFixedHue(
  hue: number,
  saturation: number,
  scheme: ColorScheme,
  backgrounds: Rgb[],
): Rgb {
  const direction = scheme === "light" ? -1 : 1;
  for (
    let lightness = STATUS_START_LIGHTNESS[scheme];
    lightness >= 0 && lightness <= 1;
    lightness += direction * LIGHTNESS_STEP
  ) {
    const candidate = hslToRgb(hue, saturation, lightness);
    if (minContrast(candidate, backgrounds) >= TEXT_CONTRAST) return candidate;
  }
  return scheme === "light" ? BLACK : WHITE;
}

function statusRole(
  color: Rgb,
  surface: Rgb,
  ink: Rgb,
  scheme: ColorScheme,
): StatusRole {
  const soft = mixRgb(surface, color, SOFT_MIX[scheme]);
  return {
    color: formatRgb(color),
    soft: formatRgb(soft),
    onSoft: formatRgb(ensureContrast(color, [soft], TEXT_CONTRAST, ink)),
  };
}

/**
 * Resolves concrete UI color roles from an MD3 palette that already has the
 * AMOLED and custom accent overrides applied. Every text role is solved to
 * WCAG 4.5:1 and every non-text role to 3:1 against the surfaces it sits on.
 */
export function resolvePaletteRoles(
  palette: Md3Palette,
  scheme: ColorScheme,
  options: { customAccent: boolean },
): PaletteRoles {
  const bg = requireColor(palette.background);
  const surface = requireColor(palette.surface);
  const surfaceRaised = requireColor(palette.surfaceVariant);
  const overlaySurface = liftOverlaySurface(
    surface,
    requireColor(palette.onBackground),
    bg,
    scheme,
  );
  const surfaces = [bg, surface, surfaceRaised, overlaySurface];
  const extreme = scheme === "light" ? BLACK : WHITE;

  const ink = ensureContrast(
    requireColor(palette.onBackground),
    surfaces,
    TEXT_CONTRAST,
    extreme,
  );
  const inkMuted = ensureContrast(
    requireColor(palette.onSurfaceVariant),
    surfaces,
    TEXT_CONTRAST,
    ink,
  );
  const ruleStrong = ensureContrast(
    requireColor(palette.outline),
    surfaces,
    NON_TEXT_CONTRAST,
    ink,
  );

  const accent = requireColor(palette.primary);
  const onPrimary = requireColor(palette.onPrimary);
  const onAccent =
    options.customAccent || contrastRatio(onPrimary, accent) < TEXT_CONTRAST
      ? blackOrWhite(accent)
      : onPrimary;
  const accentSoft = mixRgb(surface, accent, SOFT_MIX[scheme]);
  const inverseSurface = requireColor(palette.inverseSurface);
  const focus =
    minContrast(accent, [bg, surface]) >= NON_TEXT_CONTRAST ? accent : ink;

  const onInverseSurface = ensureContrast(
    requireColor(palette.inverseOnSurface),
    [inverseSurface],
    TEXT_CONTRAST,
    blackOrWhite(inverseSurface),
  );
  const onInverse = (color: Rgb) =>
    formatRgb(ensureContrast(color, [inverseSurface], NON_TEXT_CONTRAST, onInverseSurface));

  const danger = ensureContrast(
    requireColor(palette.error),
    surfaces,
    TEXT_CONTRAST,
    extreme,
  );
  const fixedHue = (name: keyof typeof FIXED_STATUS_HUES) =>
    solveFixedHue(
      FIXED_STATUS_HUES[name].hue,
      FIXED_STATUS_HUES[name].saturation,
      scheme,
      surfaces,
    );

  return {
    bg: formatRgb(bg),
    surface: formatRgb(surface),
    surfaceRaised: formatRgb(surfaceRaised),
    ink: formatRgb(ink),
    inkMuted: formatRgb(inkMuted),
    rule: formatRgb(requireColor(palette.outlineVariant)),
    ruleStrong: formatRgb(ruleStrong),
    iconSubtle: formatRgb(ruleStrong),
    accent: formatRgb(accent),
    onAccent: formatRgb(onAccent),
    accentSoft: formatRgb(accentSoft),
    onAccentSoft: formatRgb(
      ensureContrast(accent, [accentSoft, surfaceRaised], TEXT_CONTRAST, ink),
    ),
    danger: statusRole(danger, surface, ink, scheme),
    warn: statusRole(fixedHue("warn"), surface, ink, scheme),
    ok: statusRole(fixedHue("ok"), surface, ink, scheme),
    info: statusRole(fixedHue("info"), surface, ink, scheme),
    selected: formatRgb(accentSoft),
    focus: formatRgb(focus),
    inverseSurface: formatRgb(inverseSurface),
    onInverseSurface: formatRgb(onInverseSurface),
    inverseAccent: formatRgb(
      ensureContrast(accent, [inverseSurface], TEXT_CONTRAST, onInverseSurface),
    ),
    inverseStatus: {
      danger: onInverse(danger),
      warn: onInverse(fixedHue("warn")),
      ok: onInverse(fixedHue("ok")),
      info: onInverse(fixedHue("info")),
    },
    shadowFloating: SHADOW_FLOATING[scheme],
    overlaySurface: formatRgb(overlaySurface),
    overlayBorder: formatRgb(
      scheme === "dark" ? requireColor(palette.outlineVariant) : overlaySurface,
    ),
    ...OVERLAY_ELEVATION[scheme],
  };
}

/** CSS custom properties for the roles. */
export function paletteRoleCssVariables(
  roles: PaletteRoles,
): Record<string, string> {
  const variables: Record<string, string> = {
    "--norea-color-bg": roles.bg,
    "--norea-color-surface": roles.surface,
    "--norea-color-surface-raised": roles.surfaceRaised,
    "--norea-color-ink": roles.ink,
    "--norea-color-ink-muted": roles.inkMuted,
    "--norea-color-rule": roles.rule,
    "--norea-color-rule-strong": roles.ruleStrong,
    "--norea-color-icon-subtle": roles.iconSubtle,
    "--norea-color-accent": roles.accent,
    "--norea-color-on-accent": roles.onAccent,
    "--norea-color-accent-soft": roles.accentSoft,
    "--norea-color-on-accent-soft": roles.onAccentSoft,
    "--norea-color-selected": roles.selected,
    "--norea-color-focus": roles.focus,
    "--norea-shadow-floating": roles.shadowFloating,
    "--norea-color-overlay-surface": roles.overlaySurface,
    "--norea-color-overlay-border": roles.overlayBorder,
    "--norea-color-inverse-surface": roles.inverseSurface,
    "--norea-color-on-inverse-surface": roles.onInverseSurface,
    "--norea-color-inverse-accent": roles.inverseAccent,
    "--norea-scrim": roles.scrim,
    "--norea-shadow-1": roles.shadow1,
    "--norea-shadow-2": roles.shadow2,
    "--norea-shadow-sheet": roles.shadowSheet,
  };
  for (const name of STATUS_ROLE_NAMES) {
    variables[`--norea-color-${name}`] = roles[name].color;
    variables[`--norea-color-${name}-soft`] = roles[name].soft;
    variables[`--norea-color-on-${name}-soft`] = roles[name].onSoft;
  }
  return variables;
}
