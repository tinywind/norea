import {
  DEFAULT_THEME,
  defaultCssVariablesResolver,
  mergeMantineTheme,
  toRgba,
  type MantineTheme,
} from "@mantine/core";
import { describe, expect, it } from "vitest";
import { BLACK, contrastRatio, parseColor, requireColor } from "./color";
import {
  NOREA_THEME_COLORS,
  createNoreaMantineTheme,
  type NoreaMantineTheme,
} from "./mantine-theme";
import { APP_THEMES, resolveMd3Palette } from "./md3";
import {
  TEXT_CONTRAST,
  resolvePaletteRoles,
  type ColorScheme,
  type PaletteRoles,
} from "./palette-roles";

interface ThemeCase {
  label: string;
  roles: PaletteRoles;
  mantine: NoreaMantineTheme;
  merged: MantineTheme;
}

const SCHEMES: ColorScheme[] = ["light", "dark"];
const VARIANTS = ["filled", "light", "outline", "subtle", "default"] as const;

const CASES: ThemeCase[] = APP_THEMES.flatMap((theme) =>
  SCHEMES.flatMap((scheme) =>
    [false, true].map((amoledBlack) => {
      const roles = resolvePaletteRoles(
        resolveMd3Palette(theme.id, scheme, { amoledBlack }),
        scheme,
        { customAccent: false },
      );
      const mantine = createNoreaMantineTheme(roles, scheme);
      return {
        label: `${theme.id} ${scheme}${amoledBlack ? " amoled" : ""}`,
        roles,
        mantine,
        merged: mergeMantineTheme(DEFAULT_THEME, mantine.theme),
      };
    }),
  ),
);

function expectConcreteColor(value: string, name: string) {
  expect(value, name).not.toMatch(/var\(|color-mix\(/);
  const rgba = toRgba(value);
  if (rgba.r === 0 && rgba.g === 0 && rgba.b === 0) {
    expect(parseColor(value), `${name} parsed as black: ${value}`).toEqual(BLACK);
  }
}

function contrast(foreground: string, background: string): number {
  return contrastRatio(requireColor(foreground), requireColor(background));
}

describe("createNoreaMantineTheme CSS variables", () => {
  it.each(CASES)("$label overrides every Mantine scheme variable it owns", ({ mantine, merged }) => {
    const defaults = defaultCssVariablesResolver(merged);
    const resolved = mantine.cssVariablesResolver(merged);
    const otherColors = Object.keys(merged.colors).filter(
      (name) => !(NOREA_THEME_COLORS as readonly string[]).includes(name),
    );
    const ownsKey = (key: string) =>
      !otherColors.some((name) => key.startsWith(`--mantine-color-${name}-`));
    const primaryKeys = Object.keys(defaults.variables).filter((key) =>
      key.startsWith("--mantine-primary-color-"),
    );

    for (const scheme of SCHEMES) {
      const required = [
        ...Object.keys(defaults[scheme]).filter(ownsKey),
        ...primaryKeys,
      ];
      expect(required.length).toBeGreaterThan(40);
      for (const key of required) {
        expect(resolved[scheme], `${scheme} ${key}`).toHaveProperty(key);
      }
    }
  });

  it.each(CASES)("$label resolves every generated color to a concrete value", ({ mantine, merged }) => {
    const resolved = mantine.cssVariablesResolver(merged);
    for (const scheme of SCHEMES) {
      for (const [key, value] of Object.entries(resolved[scheme])) {
        if (key === "--mantine-color-scheme") continue;
        expectConcreteColor(value, `${scheme} ${key}`);
      }
    }
    for (const name of [...NOREA_THEME_COLORS, "dark"]) {
      const shades = merged.colors[name];
      expect(shades, name).toHaveLength(10);
      shades!.forEach((shade, index) => expectConcreteColor(shade, `${name}.${index}`));
    }
  });

  it.each(CASES)("$label puts Mantine overlays on the palette surface", ({ roles, mantine, merged }) => {
    const resolved = mantine.cssVariablesResolver(merged);
    expect(resolved.dark["--mantine-color-body"]).toBe(roles.surface);
    expect(merged.colors.dark![6]).toBe(roles.surface);
  });
});

describe("createNoreaMantineTheme variant colors", () => {
  it.each(CASES)("$label keeps every variant foreground readable at rest and on hover", ({ roles, merged }) => {
    for (const color of NOREA_THEME_COLORS) {
      for (const variant of VARIANTS) {
        const result = merged.variantColorResolver({ color, theme: merged, variant });
        const restBackgrounds =
          result.background === "transparent"
            ? [roles.bg, roles.surface, roles.surfaceRaised]
            : [result.background];
        for (const background of [...restBackgrounds, result.hover]) {
          expect(
            contrast(result.color, background),
            `${color} ${variant}: ${result.color} on ${background}`,
          ).toBeGreaterThanOrEqual(TEXT_CONTRAST);
        }
      }
    }
  });

  it("uses the theme accent foreground instead of Mantine's hardcoded white", () => {
    const midnightDark = CASES.find((entry) => entry.label === "midnight-dusk dark")!;
    const filled = midnightDark.merged.variantColorResolver({
      color: "norea",
      theme: midnightDark.merged,
      variant: "filled",
    });
    expect(filled.color).toBe(midnightDark.roles.onAccent);
    expect(filled.color).not.toBe("var(--mantine-color-white)");
  });

  it("leaves raw Mantine colors on the default resolver", () => {
    const [first] = CASES;
    const result = first!.merged.variantColorResolver({
      color: "red",
      theme: first!.merged,
      variant: "filled",
    });
    expect(result.background).toBe("var(--mantine-color-red-filled)");
  });
});
