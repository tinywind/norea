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
  shadowFloating: string;
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
  const surfaces = [bg, surface, surfaceRaised];
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
      ensureContrast(accent, [accentSoft], TEXT_CONTRAST, ink),
    ),
    danger: statusRole(danger, surface, ink, scheme),
    warn: statusRole(fixedHue("warn"), surface, ink, scheme),
    ok: statusRole(fixedHue("ok"), surface, ink, scheme),
    info: statusRole(fixedHue("info"), surface, ink, scheme),
    selected: formatRgb(accentSoft),
    focus: formatRgb(focus),
    inverseSurface: formatRgb(inverseSurface),
    onInverseSurface: formatRgb(
      ensureContrast(
        requireColor(palette.inverseOnSurface),
        [inverseSurface],
        TEXT_CONTRAST,
        blackOrWhite(inverseSurface),
      ),
    ),
    shadowFloating: SHADOW_FLOATING[scheme],
  };
}

/**
 * CSS custom properties for the roles, including the `--norea-design-*`
 * aliases that stay until every stylesheet reads the role names directly.
 */
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
    "--norea-design-bg": roles.bg,
    "--norea-design-surface": roles.surface,
    "--norea-design-panel": roles.surfaceRaised,
    "--norea-design-ink": roles.ink,
    "--norea-design-ink-muted": roles.inkMuted,
    "--norea-design-ink-subtle": roles.iconSubtle,
    "--norea-design-rule": roles.rule,
    "--norea-design-rule-strong": roles.ruleStrong,
    "--norea-design-accent": roles.accent,
    "--norea-design-on-accent": roles.onAccent,
    "--norea-design-accent-soft": roles.accentSoft,
    "--norea-design-warn": roles.warn.color,
    "--norea-design-warn-soft": roles.warn.soft,
    "--norea-design-error": roles.danger.color,
    "--norea-design-ok": roles.ok.color,
    "--norea-design-shadow-floating": roles.shadowFloating,
  };
  for (const name of STATUS_ROLE_NAMES) {
    variables[`--norea-color-${name}`] = roles[name].color;
    variables[`--norea-color-${name}-soft`] = roles[name].soft;
    variables[`--norea-color-on-${name}-soft`] = roles[name].onSoft;
  }
  return variables;
}
