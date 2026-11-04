import {
  createTheme,
  defaultVariantColorsResolver,
  rem,
  type CSSVariablesResolver,
  type MantineColorsTuple,
  type MantineThemeOverride,
  type VariantColorResolverResult,
  type VariantColorsResolver,
} from "@mantine/core";
import {
  BLACK,
  WHITE,
  blackOrWhite,
  ensureContrast,
  formatRgb,
  mixRgb,
  relativeLuminance,
  requireColor,
  type Rgb,
} from "./color";
import {
  MOTION_DURATION_BASE_MS,
  MOTION_DURATION_SLOW_MS,
  OVERLAY_MOTION,
} from "./motion";
import {
  STATUS_ROLE_NAMES,
  TEXT_CONTRAST,
  type ColorScheme,
  type PaletteRoles,
} from "./palette-roles";

export const UI_FONT_FAMILY =
  '"Pretendard Variable", Pretendard, system-ui, -apple-system, "Segoe UI", "Malgun Gothic", Roboto, "Noto Sans KR", sans-serif';

export const NOREA_THEME_COLORS = ["norea", ...STATUS_ROLE_NAMES] as const;
export type NoreaThemeColor = (typeof NOREA_THEME_COLORS)[number];

/** Index of the unmixed base color in every generated 10-step ramp. */
const RAMP_BASE_SHADE = 5;
const RAMP_TOWARD_WHITE = [0.9, 0.76, 0.6, 0.42, 0.22];
const RAMP_TOWARD_BLACK = [0.15, 0.3, 0.45, 0.6];
/** `colors.dark` puts the surface at shade 6, where Mantine paints dark popovers, inputs and notifications. */
const DARK_RAMP_TOWARD_INK = [0.9, 0.75, 0.6, 0.45, 0.28, 0.12, 0];
const DARK_RAMP_TOWARD_BLACK = [0.15, 0.3, 0.45];

const SOFT_MIX = { light: 0.12, dark: 0.18 } as const;
const SOFT_HOVER_EXTRA = 0.06;
const OUTLINE_HOVER_MIX = 0.05;
const FILLED_HOVER_MIX = 0.12;
const DEFAULT_HOVER_MIX = 0.06;
const DISABLED_MIX = 0.08;
const DISABLED_COLOR_MIX = 0.4;

const BORDER_WIDTH = rem(1);
const STATE_LAYER_CLASS = "norea-state-layer";

function toTuple(colors: Rgb[]): MantineColorsTuple {
  return colors.map(formatRgb) as unknown as MantineColorsTuple;
}

function colorRamp(base: Rgb): MantineColorsTuple {
  return toTuple([
    ...RAMP_TOWARD_WHITE.map((amount) => mixRgb(base, WHITE, amount)),
    base,
    ...RAMP_TOWARD_BLACK.map((amount) => mixRgb(base, BLACK, amount)),
  ]);
}

function darkRamp(surface: Rgb, ink: Rgb): MantineColorsTuple {
  return toTuple([
    ...DARK_RAMP_TOWARD_INK.map((amount) => mixRgb(surface, ink, amount)),
    ...DARK_RAMP_TOWARD_BLACK.map((amount) => mixRgb(surface, BLACK, amount)),
  ]);
}

interface ColorVariants {
  filled: string;
  filledHover: string;
  onFilled: string;
  light: string;
  lightHover: string;
  /** Text for light, subtle and outline variants, readable on every surface and their hover fills. */
  lightColor: string;
  outlineHover: string;
}

function colorVariants(
  base: Rgb,
  onFilled: Rgb,
  surfaces: { bg: Rgb; surface: Rgb; raised: Rgb; ink: Rgb },
  scheme: ColorScheme,
): ColorVariants {
  const awayFromForeground = relativeLuminance(onFilled) > 0.5 ? BLACK : WHITE;
  const filledHover = mixRgb(base, awayFromForeground, FILLED_HOVER_MIX);
  const light = mixRgb(surfaces.surface, base, SOFT_MIX[scheme]);
  const lightHover = mixRgb(
    surfaces.surface,
    base,
    SOFT_MIX[scheme] + SOFT_HOVER_EXTRA,
  );
  const outlineHover = mixRgb(surfaces.surface, base, OUTLINE_HOVER_MIX);
  const lightColor = ensureContrast(
    base,
    [light, lightHover, outlineHover, surfaces.bg, surfaces.surface, surfaces.raised],
    TEXT_CONTRAST,
    surfaces.ink,
  );
  return {
    filled: formatRgb(base),
    filledHover: formatRgb(filledHover),
    onFilled: formatRgb(onFilled),
    light: formatRgb(light),
    lightHover: formatRgb(lightHover),
    lightColor: formatRgb(lightColor),
    outlineHover: formatRgb(outlineHover),
  };
}

function isNoreaThemeColor(color: string): color is NoreaThemeColor {
  return (NOREA_THEME_COLORS as readonly string[]).includes(color);
}

export interface NoreaMantineTheme {
  theme: MantineThemeOverride;
  cssVariablesResolver: CSSVariablesResolver;
}

/**
 * Builds the Mantine theme and CSS variable resolver from concrete palette
 * roles, so every Mantine surface, text and variant color is an rgb() value
 * that already meets the contrast gate.
 */
export function createNoreaMantineTheme(
  roles: PaletteRoles,
  scheme: ColorScheme,
  closeLabel: string,
): NoreaMantineTheme {
  const bg = requireColor(roles.bg);
  const surface = requireColor(roles.surface);
  const raised = requireColor(roles.surfaceRaised);
  const ink = requireColor(roles.ink);
  const surfaces = { bg, surface, raised, ink };

  const accent = requireColor(roles.accent);
  const bases: Record<NoreaThemeColor, Rgb> = {
    norea: accent,
    danger: requireColor(roles.danger.color),
    warn: requireColor(roles.warn.color),
    ok: requireColor(roles.ok.color),
    info: requireColor(roles.info.color),
  };
  const variants = Object.fromEntries(
    NOREA_THEME_COLORS.map((name) => [
      name,
      colorVariants(
        bases[name],
        name === "norea"
          ? requireColor(roles.onAccent)
          : blackOrWhite(bases[name]),
        surfaces,
        scheme,
      ),
    ]),
  ) as Record<NoreaThemeColor, ColorVariants>;
  const colors = Object.fromEntries(
    NOREA_THEME_COLORS.map((name) => [name, colorRamp(bases[name])]),
  ) as Record<NoreaThemeColor, MantineColorsTuple>;

  const defaultHover = formatRgb(mixRgb(surface, ink, DEFAULT_HOVER_MIX));
  const defaultBorder = `${BORDER_WIDTH} solid ${roles.ruleStrong}`;
  const transparentBorder = `${BORDER_WIDTH} solid transparent`;
  // Mantine paints light-scheme dropdowns white; Combobox-based inputs render through Popover, while Menu, ColorInput and HoverCard resolve their own theme entry.
  const overlayDropdownStyles = {
    backgroundColor: roles.overlaySurface,
    "--popover-border-color": roles.overlayBorder,
  };
  // Modal and Drawer paint their content, sticky header and full-screen inner from --mantine-color-body.
  const overlayRootStyles = { "--mantine-color-body": roles.overlaySurface };
  const scrimStyles = { "--overlay-bg": "var(--norea-scrim)" };
  // Toasts sit on the inverse (snackbar) surface; their accent bar keeps 3:1 against it.
  const toastAccents: Record<NoreaThemeColor, string> = {
    norea: roles.inverseAccent,
    ...roles.inverseStatus,
  };
  const popoverDefaults = {
    radius: "md",
    shadow: "var(--norea-shadow-1)",
    transitionProps: OVERLAY_MOTION.popover,
    zIndex: "var(--norea-z-popover)",
  };

  const variantColorResolver: VariantColorsResolver = (input) => {
    if (input.variant === "default") {
      return {
        background: roles.surface,
        hover: defaultHover,
        color: roles.ink,
        border: defaultBorder,
      };
    }
    const name = input.color ?? input.theme.primaryColor;
    if (!isNoreaThemeColor(name)) return defaultVariantColorsResolver(input);
    const color = variants[name];
    const results: Record<string, VariantColorResolverResult> = {
      filled: {
        background: color.filled,
        hover: color.filledHover,
        color: color.onFilled,
        border: transparentBorder,
      },
      light: {
        background: color.light,
        hover: color.lightHover,
        color: color.lightColor,
        border: transparentBorder,
      },
      outline: {
        background: "transparent",
        hover: color.outlineHover,
        color: color.lightColor,
        border: `${BORDER_WIDTH} solid ${color.lightColor}`,
      },
      subtle: {
        background: "transparent",
        hover: color.lightHover,
        color: color.lightColor,
        border: transparentBorder,
      },
    };
    return results[input.variant] ?? defaultVariantColorsResolver(input);
  };

  const schemeVariables: Record<string, string> = {
    "--mantine-primary-color-contrast": roles.onAccent,
    "--mantine-color-bright": roles.ink,
    "--mantine-color-text": roles.ink,
    "--mantine-color-body": roles.surface,
    "--mantine-color-error": roles.danger.color,
    "--mantine-color-success": roles.ok.color,
    "--mantine-color-placeholder": roles.inkMuted,
    "--mantine-color-anchor": variants.norea.lightColor,
    "--mantine-color-default": roles.surface,
    "--mantine-color-default-hover": defaultHover,
    "--mantine-color-default-color": roles.ink,
    "--mantine-color-default-border": roles.ruleStrong,
    "--mantine-color-dimmed": roles.inkMuted,
    "--mantine-color-disabled": formatRgb(mixRgb(surface, ink, DISABLED_MIX)),
    "--mantine-color-disabled-color": formatRgb(
      mixRgb(surface, ink, DISABLED_COLOR_MIX),
    ),
    "--mantine-color-disabled-border": roles.rule,
    "--mantine-primary-color-filled": variants.norea.filled,
    "--mantine-primary-color-filled-hover": variants.norea.filledHover,
    "--mantine-primary-color-light": variants.norea.light,
    "--mantine-primary-color-light-hover": variants.norea.lightHover,
    "--mantine-primary-color-light-color": variants.norea.lightColor,
  };
  colors.norea.forEach((shade, index) => {
    schemeVariables[`--mantine-primary-color-${index}`] = shade;
  });
  for (const name of NOREA_THEME_COLORS) {
    const color = variants[name];
    Object.assign(schemeVariables, {
      [`--mantine-color-${name}-text`]: color.lightColor,
      [`--mantine-color-${name}-filled`]: color.filled,
      [`--mantine-color-${name}-filled-hover`]: color.filledHover,
      [`--mantine-color-${name}-light`]: color.light,
      [`--mantine-color-${name}-light-hover`]: color.lightHover,
      [`--mantine-color-${name}-light-color`]: color.lightColor,
      [`--mantine-color-${name}-outline`]: color.lightColor,
      [`--mantine-color-${name}-outline-hover`]: color.outlineHover,
    });
  }

  const theme = createTheme({
    fontFamily: UI_FONT_FAMILY,
    headings: { fontFamily: UI_FONT_FAMILY },
    primaryColor: "norea",
    respectReducedMotion: true,
    primaryShade: { light: RAMP_BASE_SHADE, dark: RAMP_BASE_SHADE },
    colors: {
      ...colors,
      dark: darkRamp(surface, ink),
    },
    variantColorResolver,
    defaultRadius: "md",
    radius: {
      xs: "var(--norea-radius-sm)",
      sm: "var(--norea-radius-sm)",
      md: "var(--norea-radius-md)",
      lg: "var(--norea-radius-lg)",
      xl: "var(--norea-radius-lg)",
    },
    spacing: {
      xs: "var(--norea-space-2)",
      sm: "var(--norea-space-3)",
      md: "var(--norea-space-4)",
      lg: "var(--norea-space-5)",
      xl: "var(--norea-space-6)",
    },
    fontSizes: {
      xs: "var(--norea-text-xs)",
      sm: "var(--norea-text-sm)",
      md: "var(--norea-text-md)",
      lg: "var(--norea-text-lg)",
      xl: "var(--norea-text-xl)",
    },
    lineHeights: {
      xs: "var(--norea-leading-tight)",
      sm: "var(--norea-leading-normal)",
      md: "var(--norea-leading-normal)",
      lg: "var(--norea-leading-normal)",
      xl: "var(--norea-leading-normal)",
    },
    components: {
      Alert: { defaultProps: { radius: "sm" } },
      // Every Mantine control paints the shared hover and pressed state layer from ui.css.
      ActionIcon: { classNames: { root: STATE_LAYER_CLASS } },
      Button: { classNames: { root: STATE_LAYER_CLASS }, defaultProps: { radius: "sm" } },
      CloseButton: { classNames: { root: STATE_LAYER_CLASS } },
      Paper: { defaultProps: { radius: "sm" } },
      TextInput: { defaultProps: { radius: "sm" } },
      // Dialogs fade and scale; drawers keep Mantine's slide from their own edge at the slow token.
      Modal: {
        defaultProps: {
          closeButtonProps: { "aria-label": closeLabel },
          radius: "lg",
          shadow: "var(--norea-shadow-2)",
          transitionProps: OVERLAY_MOTION.dialog,
          zIndex: "var(--norea-z-overlay)",
        },
        styles: { root: overlayRootStyles, overlay: scrimStyles },
      },
      Drawer: {
        defaultProps: {
          closeButtonProps: { "aria-label": closeLabel },
          shadow: "var(--norea-shadow-2)",
          transitionProps: {
            duration: MOTION_DURATION_SLOW_MS,
            exitDuration: MOTION_DURATION_BASE_MS,
            timingFunction: "var(--norea-ease-decelerate)",
          },
          zIndex: "var(--norea-z-overlay)",
        },
        styles: { root: overlayRootStyles, overlay: scrimStyles },
      },
      Collapse: {
        defaultProps: {
          transitionDuration: MOTION_DURATION_BASE_MS,
          transitionTimingFunction: "var(--norea-ease-standard)",
        },
      },
      // Portaled dropdowns and tooltips open from inside modals and drawers, so they sit above every overlay layer.
      Popover: {
        defaultProps: popoverDefaults,
        styles: { dropdown: overlayDropdownStyles },
      },
      Menu: {
        classNames: { item: STATE_LAYER_CLASS },
        defaultProps: popoverDefaults,
        styles: { dropdown: overlayDropdownStyles },
      },
      ColorInput: { styles: { dropdown: overlayDropdownStyles } },
      HoverCard: { styles: { dropdown: overlayDropdownStyles } },
      Tooltip: {
        defaultProps: { zIndex: "var(--norea-z-popover)" },
        styles: {
          tooltip: {
            "--tooltip-bg": roles.inverseSurface,
            "--tooltip-color": roles.onInverseSurface,
          },
        },
      },
      Notification: {
        defaultProps: { radius: "md" },
        styles: {
          root: { backgroundColor: roles.inverseSurface, boxShadow: "var(--norea-shadow-2)" },
          title: { color: roles.onInverseSurface },
          description: { color: roles.onInverseSurface },
          closeButton: { color: roles.onInverseSurface },
        },
        vars: (_theme: unknown, props: { color?: string }) => ({
          root: {
            "--notification-color":
              props.color === undefined
                ? toastAccents.norea
                : isNoreaThemeColor(props.color)
                  ? toastAccents[props.color]
                  : undefined,
          },
        }),
      },
      Notifications: {
        defaultProps: {
          transitionDuration: MOTION_DURATION_BASE_MS,
          zIndex: "var(--norea-z-toast)",
        },
      },
    },
  });

  return {
    theme,
    cssVariablesResolver: () => ({
      variables: {},
      light: { "--mantine-color-scheme": "light", ...schemeVariables },
      dark: { "--mantine-color-scheme": "dark", ...schemeVariables },
    }),
  };
}
