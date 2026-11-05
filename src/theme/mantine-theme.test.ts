import {
  ActionIcon,
  Button,
  CloseButton,
  DEFAULT_THEME,
  MantineProvider,
  Menu,
  Notification,
  Popover,
  Select,
  Tooltip,
  defaultCssVariablesResolver,
  mergeMantineTheme,
  toRgba,
  type MantineTheme,
} from "@mantine/core";
import { createElement as h, type ElementType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BLACK, contrastRatio, parseColor, requireColor } from "./color";
import {
  NOREA_THEME_COLORS,
  createNoreaMantineTheme,
  type NoreaMantineTheme,
} from "./mantine-theme";
import { APP_THEMES, resolveMd3Palette } from "./md3";
import {
  MOTION_DURATION_BASE_MS,
  MOTION_DURATION_FAST_MS,
  MOTION_DURATION_SLOW_MS,
  OVERLAY_MOTION,
} from "./motion";
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
      const mantine = createNoreaMantineTheme(roles, scheme, "Close");
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
    for (const scheme of SCHEMES) {
      expect(resolved[scheme]["--mantine-color-body"], scheme).toBe(roles.surface);
    }
    expect(merged.colors.dark![6]).toBe(roles.surface);
  });
});

function renderOverlays({ mantine }: ThemeCase, scheme: ColorScheme): string {
  const target = (label: string) => h("button", { type: "button" }, label);
  return renderToStaticMarkup(
    h(
      MantineProvider,
      { theme: mantine.theme, forceColorScheme: scheme },
      h(
        Popover,
        { opened: true, withinPortal: false },
        h(Popover.Target, null, target("popover")),
        h(Popover.Dropdown, null, "popover"),
      ),
      h(Select, {
        comboboxProps: { withinPortal: false },
        data: ["option"],
        dropdownOpened: true,
      }),
      h(
        Menu,
        { opened: true, withinPortal: false },
        h(Menu.Target, null, target("menu")),
        h(Menu.Dropdown, null, "menu"),
      ),
      h(Tooltip, { label: "tooltip", opened: true, withinPortal: false }, target("tooltip")),
      h(Notification, null, "notification"),
      h(Notification, { color: "danger", title: "failed" }, "danger notification"),
    ),
  );
}

function inlineStyleOf(html: string, className: string): string[] {
  return [...html.matchAll(/<div style="([^"]*)" class="([^"]*)"/g)]
    .filter((match) => match[2]!.split(" ").includes(className))
    .map((match) => match[1]!);
}

describe("createNoreaMantineTheme overlay surfaces", () => {
  const overlayCases = CASES.filter(
    (entry) => entry.label === "lavender light" || entry.label === "midnight-dusk dark",
  );

  it.each(overlayCases)("$label paints dropdowns, tooltips and notifications from the palette", (entry) => {
    const { roles } = entry;
    const scheme = entry.label.endsWith("light") ? "light" : "dark";
    const html = renderOverlays(entry, scheme);

    for (const name of ["Popover", "Select", "Menu"]) {
      const [style] = inlineStyleOf(html, `mantine-${name}-dropdown`);
      expect(style, name).toContain(`background-color:${roles.overlaySurface}`);
      expect(style, name).toContain(`--popover-border-color:${roles.overlayBorder}`);
    }
    const [tooltip] = inlineStyleOf(html, "mantine-Tooltip-tooltip");
    expect(tooltip).toContain(`--tooltip-bg:${roles.inverseSurface}`);
    expect(tooltip).toContain(`--tooltip-color:${roles.onInverseSurface}`);
    const [notification, danger] = inlineStyleOf(html, "mantine-Notification-root");
    expect(notification).toContain(`background-color:${roles.inverseSurface}`);
    expect(notification).toContain(`--notification-color:${roles.inverseAccent}`);
    expect(danger).toContain(`--notification-color:${roles.inverseStatus.danger}`);
  });
});

describe("createNoreaMantineTheme overlay elevation", () => {
  const [first] = CASES;

  it("paints modal and drawer surfaces from the overlay role over the themed scrim", () => {
    const { components } = first!.merged;
    for (const name of ["Modal", "Drawer"]) {
      expect(components[name]?.styles, name).toEqual({
        root: { "--mantine-color-body": first!.roles.overlaySurface },
        overlay: { "--overlay-bg": "var(--norea-scrim)" },
      });
      expect(components[name]?.defaultProps, name).toMatchObject({
        shadow: "var(--norea-shadow-2)",
        zIndex: "var(--norea-z-overlay)",
      });
    }
    expect(components.Modal?.defaultProps?.radius).toBe("lg");
  });

  it("lifts menus, popovers and tooltips onto the popover layer with the menu shadow", () => {
    const { components } = first!.merged;
    for (const name of ["Popover", "Menu"]) {
      expect(components[name]?.defaultProps, name).toMatchObject({
        radius: "md",
        shadow: "var(--norea-shadow-1)",
        zIndex: "var(--norea-z-popover)",
      });
    }
    expect(components.Tooltip?.defaultProps?.zIndex).toBe("var(--norea-z-popover)");
    expect(components.Notifications?.defaultProps?.zIndex).toBe("var(--norea-z-toast)");
  });
});

describe("createNoreaMantineTheme variant colors", () => {
  it.each(CASES)("$label keeps every variant foreground readable at rest and on hover", ({ roles, merged }) => {
    for (const color of NOREA_THEME_COLORS) {
      for (const variant of VARIANTS) {
        const result = merged.variantColorResolver({ color, theme: merged, variant });
        const surfaces = [roles.bg, roles.surface, roles.surfaceRaised];
        const restBackgrounds =
          result.background === "transparent" ? surfaces : [result.background];
        const hoverBackgrounds = result.hover === "transparent" ? surfaces : [result.hover];
        for (const background of [...restBackgrounds, ...hoverBackgrounds]) {
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

describe("createNoreaMantineTheme button emphasis (D10)", () => {
  it("draws borderless controls with only the state layer and defaults icon-only buttons to borderless", () => {
    const [first] = CASES;
    for (const color of NOREA_THEME_COLORS) {
      const subtle = first!.merged.variantColorResolver({ color, theme: first!.merged, variant: "subtle" });
      expect(subtle, color).toMatchObject({ background: "transparent", hover: "transparent" });
      expect(subtle.border, color).toMatch(/transparent$/);
    }
    expect(first!.merged.components.ActionIcon?.defaultProps).toMatchObject({ variant: "subtle" });
  });
});

describe("createNoreaMantineTheme state layers", () => {
  it("puts the shared state layer on Mantine buttons, icon buttons, close buttons and menu items", () => {
    const [first] = CASES;
    // Mantine's polymorphic components do not fit createElement's overloads.
    const polymorphic = (component: unknown) => component as ElementType;
    const html = renderToStaticMarkup(
      h(
        MantineProvider,
        { theme: first!.mantine.theme },
        h(polymorphic(Button), null, "button"),
        h(polymorphic(ActionIcon), { "aria-label": "icon" }, "i"),
        h(polymorphic(CloseButton), { "aria-label": "close" }),
        h(
          Menu,
          { opened: true, withinPortal: false },
          h(Menu.Target, null, h("button", { type: "button" }, "menu")),
          h(Menu.Dropdown, null, h(polymorphic(Menu.Item), null, "item")),
        ),
      ),
    );
    for (const name of ["Button-root", "ActionIcon-root", "CloseButton-root", "Menu-item"]) {
      const classes = [...html.matchAll(/class="([^"]*)"/g)]
        .map((match) => match[1]!.split(" "))
        .find((list) => list.includes(`mantine-${name}`));
      expect(classes, name).toContain("norea-state-layer");
    }
  });
});

describe("createNoreaMantineTheme motion", () => {
  it("honors reduced motion and moves overlays, collapses and toasts on the motion tokens", () => {
    const [first] = CASES;
    const { components, respectReducedMotion } = first!.merged;
    expect(respectReducedMotion).toBe(true);
    expect(components.Modal?.defaultProps?.transitionProps).toEqual(OVERLAY_MOTION.dialog);
    expect(OVERLAY_MOTION.dialog).toMatchObject({
      duration: MOTION_DURATION_BASE_MS,
      exitDuration: MOTION_DURATION_FAST_MS,
      timingFunction: "var(--norea-ease-decelerate)",
    });
    expect(OVERLAY_MOTION.dialog.transition.out).toMatchObject({
      opacity: 0,
      transform: "scale(0.96)",
      transitionTimingFunction: "var(--norea-ease-accelerate)",
    });
    // The drawer keeps Mantine's slide from its own edge.
    expect(components.Drawer?.defaultProps?.transitionProps).toEqual({
      duration: MOTION_DURATION_SLOW_MS,
      exitDuration: MOTION_DURATION_BASE_MS,
      timingFunction: "var(--norea-ease-decelerate)",
    });
    for (const name of ["Popover", "Menu"]) {
      expect(components[name]?.defaultProps?.transitionProps, name).toEqual(OVERLAY_MOTION.popover);
    }
    expect(OVERLAY_MOTION.popover.duration).toBe(MOTION_DURATION_FAST_MS);
    expect(components.Collapse?.defaultProps).toMatchObject({
      transitionDuration: MOTION_DURATION_BASE_MS,
      transitionTimingFunction: "var(--norea-ease-standard)",
    });
    expect(components.Notifications?.defaultProps?.transitionDuration).toBe(MOTION_DURATION_BASE_MS);
  });
});

describe("createNoreaMantineTheme overlay labels", () => {
  it("names the close button of every modal and drawer", () => {
    const { components } = CASES[0]!.merged;
    for (const name of ["Modal", "Drawer"]) {
      expect(components[name]?.defaultProps?.closeButtonProps, name).toEqual({ "aria-label": "Close" });
    }
  });
});

describe("form field shape", () => {
  it("gives every text, number, password, select and color field the same corner radius", () => {
    const { merged } = CASES[0]!;
    const fields = ["TextInput", "NumberInput", "PasswordInput", "Select", "ColorInput", "Textarea", "Autocomplete", "MultiSelect"];
    const radii = fields.map((name) => (merged.components[name]?.defaultProps as { radius?: unknown } | undefined)?.radius ?? merged.defaultRadius);
    expect(new Set(radii)).toEqual(new Set([merged.defaultRadius]));
  });
});
