import { describe, expect, it } from "vitest";
import { contrastRatio, requireColor } from "./color";
import { APP_THEMES, resolveMd3Palette, type AppThemeId } from "./md3";
import {
  NON_TEXT_CONTRAST,
  OVERLAY_SEPARATION,
  STATUS_ROLE_NAMES,
  TEXT_CONTRAST,
  paletteRoleCssVariables,
  resolvePaletteRoles,
  type ColorScheme,
  type PaletteRoles,
} from "./palette-roles";

interface RoleCase {
  label: string;
  roles: PaletteRoles;
}

function resolveCase(
  themeId: AppThemeId,
  scheme: ColorScheme,
  options: { amoledBlack?: boolean; customAccentColor?: string },
): PaletteRoles {
  return resolvePaletteRoles(resolveMd3Palette(themeId, scheme, options), scheme, {
    customAccent: Boolean(options.customAccentColor),
  });
}

const SCHEMES: ColorScheme[] = ["light", "dark"];

const THEME_CASES: RoleCase[] = APP_THEMES.flatMap((theme) =>
  SCHEMES.flatMap((scheme) =>
    [false, true].map((amoledBlack) => ({
      label: `${theme.id} ${scheme}${amoledBlack ? " amoled" : ""}`,
      roles: resolveCase(theme.id, scheme, { amoledBlack }),
    })),
  ),
);

const CUSTOM_ACCENT_CASES: RoleCase[] = [
  {
    label: "default light custom accent #f5d76e",
    roles: resolveCase("default", "light", { customAccentColor: "#f5d76e" }),
  },
  {
    label: "lavender dark custom accent #1d4ed8",
    roles: resolveCase("lavender", "dark", { customAccentColor: "#1d4ed8" }),
  },
];

const ALL_CASES = [...THEME_CASES, ...CUSTOM_ACCENT_CASES];

function contrast(foreground: string, background: string): number {
  return contrastRatio(requireColor(foreground), requireColor(background));
}

function expectContrast(
  foreground: string,
  background: string,
  minimum: number,
  pair: string,
) {
  expect(
    contrast(foreground, background),
    `${pair}: ${foreground} on ${background}`,
  ).toBeGreaterThanOrEqual(minimum);
}

describe("resolvePaletteRoles contrast gate", () => {
  it("covers every theme in both schemes with and without AMOLED", () => {
    expect(THEME_CASES).toHaveLength(APP_THEMES.length * 4);
    expect(APP_THEMES).toHaveLength(9);
  });

  it.each(ALL_CASES)("$label keeps ink and ink-muted readable on every surface", ({ roles }) => {
    for (const surface of [roles.bg, roles.surface, roles.surfaceRaised, roles.overlaySurface]) {
      expectContrast(roles.ink, surface, TEXT_CONTRAST, "ink");
      expectContrast(roles.inkMuted, surface, TEXT_CONTRAST, "ink-muted");
    }
  });

  it.each(ALL_CASES)("$label keeps accent foregrounds readable", ({ roles }) => {
    expectContrast(roles.onAccent, roles.accent, TEXT_CONTRAST, "on-accent");
    for (const background of [roles.accentSoft, roles.surfaceRaised]) {
      expectContrast(roles.onAccentSoft, background, TEXT_CONTRAST, "on-accent-soft");
    }
  });

  it.each(ALL_CASES)("$label keeps inverse surface text readable", ({ roles }) => {
    expectContrast(
      roles.onInverseSurface,
      roles.inverseSurface,
      TEXT_CONTRAST,
      "on-inverse-surface",
    );
  });

  it.each(ALL_CASES)("$label keeps status colors readable as text and on soft fills", ({ roles }) => {
    for (const name of STATUS_ROLE_NAMES) {
      for (const surface of [roles.bg, roles.surface, roles.surfaceRaised, roles.overlaySurface]) {
        expectContrast(roles[name].color, surface, TEXT_CONTRAST, name);
      }
      expectContrast(
        roles[name].onSoft,
        roles[name].soft,
        TEXT_CONTRAST,
        `on-${name}-soft`,
      );
    }
  });

  it.each(ALL_CASES)("$label keeps non-text roles at 3:1", ({ roles }) => {
    for (const surface of [roles.bg, roles.surface, roles.surfaceRaised]) {
      expectContrast(roles.ruleStrong, surface, NON_TEXT_CONTRAST, "rule-strong");
      expectContrast(roles.iconSubtle, surface, NON_TEXT_CONTRAST, "icon-subtle");
    }
    for (const surface of [roles.bg, roles.surface]) {
      expectContrast(roles.focus, surface, NON_TEXT_CONTRAST, "focus");
    }
  });

  it.each(ALL_CASES)("$label emits only rgb() or hex colors", ({ roles }) => {
    for (const [name, value] of Object.entries(paletteRoleCssVariables(roles))) {
      if (name.includes("shadow") || name === "--norea-scrim") continue;
      expect(value, name).toMatch(/^(rgb\(\d+, \d+, \d+\)|#[\da-f]{6})$/i);
    }
  });
});

describe("resolvePaletteRoles overlay surface", () => {
  it.each(ALL_CASES)("$label sets overlays apart from the page background", ({ roles }) => {
    expect(roles.overlaySurface).not.toBe(roles.bg);
    expect(
      contrast(roles.overlaySurface, roles.bg),
      `${roles.overlaySurface} on ${roles.bg}`,
    ).toBeGreaterThanOrEqual(OVERLAY_SEPARATION);
  });

  it.each(ALL_CASES)("$label lifts the overlay from the surface toward ink", ({ roles }) => {
    const [surface, overlay, ink] = [roles.surface, roles.overlaySurface, roles.ink].map(requireColor);
    const distanceToInk = (color: typeof surface) =>
      Math.abs(color!.r - ink!.r) + Math.abs(color!.g - ink!.g) + Math.abs(color!.b - ink!.b);
    expect(distanceToInk(overlay)).toBeLessThan(distanceToInk(surface));
  });

  it("outlines overlays with the rule color only in dark schemes", () => {
    const light = resolveCase("default", "light", {});
    const dark = resolveCase("default", "dark", {});
    expect(light.overlayBorder).toBe(light.overlaySurface);
    expect(dark.overlayBorder).toBe(dark.rule);
  });

  it("darkens the scrim and overlay shadows in dark schemes", () => {
    const light = resolveCase("default", "light", {});
    const dark = resolveCase("default", "dark", {});
    expect(light.scrim).toBe("rgba(15, 23, 42, 0.4)");
    expect(dark.scrim).toBe("rgba(0, 0, 0, 0.56)");
    for (const name of ["shadow1", "shadow2", "shadowSheet"] as const) {
      expect(light[name], name).not.toBe(dark[name]);
    }
    expect(light.shadowSheet).toMatch(/^0 -/);
  });
});

describe("resolvePaletteRoles accents", () => {
  it("keeps onPrimary when it already reaches 4.5:1 on the theme accent", () => {
    const roles = resolveCase("default", "light", {});
    expect(roles.onAccent).toBe("rgb(255, 255, 255)");
  });

  it("replaces a failing onPrimary with black or white", () => {
    const roles = resolveCase("midnight-dusk", "dark", {});
    expect(contrast("rgb(255, 255, 255)", roles.accent)).toBeLessThan(TEXT_CONTRAST);
    expect(roles.onAccent).toBe("rgb(0, 0, 0)");
  });

  it("solves the on-accent color for a custom accent instead of reusing onPrimary", () => {
    const roles = resolveCase("default", "dark", { customAccentColor: "#1d4ed8" });
    expect(roles.accent).toBe("rgb(29, 78, 216)");
    expect(roles.onAccent).toBe("rgb(255, 255, 255)");
  });

  it("ignores a partially typed custom accent", () => {
    const roles = resolveCase("default", "light", { customAccentColor: "#3d" });
    expect(roles.accent).toBe("rgb(61, 110, 88)");
  });
});

describe("paletteRoleCssVariables", () => {
  it("writes each role under its --norea-color-* name", () => {
    const roles = resolveCase("lavender", "dark", {});
    const variables = paletteRoleCssVariables(roles);
    expect(variables["--norea-color-ink-muted"]).toBe(roles.inkMuted);
    expect(variables["--norea-color-surface-raised"]).toBe(roles.surfaceRaised);
    expect(variables["--norea-color-danger"]).toBe(roles.danger.color);
    expect(variables["--norea-color-on-warn-soft"]).toBe(roles.warn.onSoft);
    expect(variables["--norea-color-overlay-surface"]).toBe(roles.overlaySurface);
    expect(variables["--norea-color-inverse-surface"]).toBe(roles.inverseSurface);
    expect(variables["--norea-scrim"]).toBe(roles.scrim);
    expect(variables["--norea-shadow-2"]).toBe(roles.shadow2);
  });
});
