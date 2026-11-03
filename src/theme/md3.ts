import { parseColor } from "./color";

export type AppThemeId =
  | "default"
  | "midnight-dusk"
  | "teal-turquoise"
  | "yotsuba"
  | "lavender"
  | "strawberry-daiquiri"
  | "tako"
  | "catppuccin"
  | "yinyang";

export interface Md3Palette {
  name: string;
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;
  secondary: string;
  background: string;
  onBackground: string;
  surface: string;
  onSurface: string;
  surfaceVariant: string;
  onSurfaceVariant: string;
  outline: string;
  outlineVariant: string;
  error: string;
  inverseSurface: string;
  inverseOnSurface: string;
  inversePrimary: string;
}

export interface AppThemeDefinition {
  id: AppThemeId;
  label: string;
  light: Md3Palette;
  dark: Md3Palette;
}

export const APP_THEMES: AppThemeDefinition[] = [
  {
    id: "default",
    label: "Moss",
    light: {
      name: "Moss",
      primary: "rgb(61, 110, 88)",
      onPrimary: "rgb(255, 255, 255)",
      primaryContainer: "rgb(226, 238, 231)",
      onPrimaryContainer: "rgb(20, 53, 38)",
      secondary: "rgb(74, 74, 71)",
      background: "rgb(251, 251, 250)",
      onBackground: "rgb(26, 26, 24)",
      surface: "rgb(255, 255, 255)",
      onSurface: "rgb(26, 26, 24)",
      surfaceVariant: "rgb(244, 244, 242)",
      onSurfaceVariant: "rgb(74, 74, 71)",
      outline: "rgb(138, 138, 133)",
      outlineVariant: "rgb(232, 232, 228)",
      error: "rgb(196, 74, 58)",
      inverseSurface: "rgb(26, 26, 24)",
      inverseOnSurface: "rgb(251, 251, 250)",
      inversePrimary: "rgb(128, 170, 149)",
    },
    dark: {
      name: "Moss",
      primary: "rgb(128, 170, 149)",
      onPrimary: "rgb(15, 43, 31)",
      primaryContainer: "rgb(39, 78, 57)",
      onPrimaryContainer: "rgb(226, 238, 231)",
      secondary: "rgb(204, 203, 196)",
      background: "rgb(26, 26, 24)",
      onBackground: "rgb(238, 238, 233)",
      surface: "rgb(31, 31, 28)",
      onSurface: "rgb(238, 238, 233)",
      surfaceVariant: "rgb(54, 54, 49)",
      onSurfaceVariant: "rgb(204, 203, 196)",
      outline: "rgb(138, 138, 133)",
      outlineVariant: "rgb(74, 74, 69)",
      error: "rgb(255, 180, 171)",
      inverseSurface: "rgb(238, 238, 233)",
      inverseOnSurface: "rgb(31, 31, 28)",
      inversePrimary: "rgb(61, 110, 88)",
    },
  },
  {
    id: "midnight-dusk",
    label: "Midnight Dusk",
    light: {
      name: "Daybreak Bloom",
      primary: "rgb(240, 36, 117)",
      onPrimary: "rgb(255, 255, 255)",
      primaryContainer: "rgb(255, 217, 225)",
      onPrimaryContainer: "rgb(63, 0, 23)",
      secondary: "rgb(187, 0, 84)",
      background: "rgb(255, 251, 255)",
      onBackground: "rgb(28, 27, 31)",
      surface: "rgb(254, 251, 255)",
      onSurface: "rgb(28, 27, 31)",
      surfaceVariant: "rgb(243, 221, 224)",
      onSurfaceVariant: "rgb(82, 67, 70)",
      outline: "rgb(132, 115, 117)",
      outlineVariant: "rgb(214, 194, 196)",
      error: "rgb(186, 26, 26)",
      inverseSurface: "rgb(53, 47, 48)",
      inverseOnSurface: "rgb(250, 238, 239)",
      inversePrimary: "rgb(255, 177, 193)",
    },
    dark: {
      name: "Midnight Dusk",
      primary: "rgb(240, 36, 117)",
      onPrimary: "rgb(255, 255, 255)",
      primaryContainer: "rgb(189, 28, 92)",
      onPrimaryContainer: "rgb(255, 255, 255)",
      secondary: "rgb(240, 36, 117)",
      background: "rgb(22, 21, 29)",
      onBackground: "rgb(229, 225, 229)",
      surface: "rgb(22, 21, 29)",
      onSurface: "rgb(229, 225, 229)",
      surfaceVariant: "rgb(82, 67, 70)",
      onSurfaceVariant: "rgb(214, 193, 196)",
      outline: "rgb(158, 140, 143)",
      outlineVariant: "rgb(82, 67, 70)",
      error: "rgb(255, 180, 171)",
      inverseSurface: "rgb(236, 224, 224)",
      inverseOnSurface: "rgb(53, 47, 48)",
      inversePrimary: "rgb(187, 0, 84)",
    },
  },
  {
    id: "teal-turquoise",
    label: "Teal Turquoise",
    light: {
      name: "Teal",
      primary: "rgb(0, 106, 106)",
      onPrimary: "rgb(255, 255, 255)",
      primaryContainer: "rgb(111, 247, 246)",
      onPrimaryContainer: "rgb(0, 32, 32)",
      secondary: "rgb(74, 99, 99)",
      background: "rgb(250, 253, 252)",
      onBackground: "rgb(25, 28, 28)",
      surface: "rgb(250, 253, 252)",
      onSurface: "rgb(25, 28, 28)",
      surfaceVariant: "rgb(218, 229, 228)",
      onSurfaceVariant: "rgb(63, 73, 72)",
      outline: "rgb(111, 121, 121)",
      outlineVariant: "rgb(190, 201, 200)",
      error: "rgb(186, 26, 26)",
      inverseSurface: "rgb(45, 49, 49)",
      inverseOnSurface: "rgb(239, 241, 240)",
      inversePrimary: "rgb(76, 218, 218)",
    },
    dark: {
      name: "Turquoise",
      primary: "rgb(76, 218, 218)",
      onPrimary: "rgb(0, 55, 55)",
      primaryContainer: "rgb(0, 79, 79)",
      onPrimaryContainer: "rgb(111, 247, 246)",
      secondary: "rgb(176, 204, 203)",
      background: "rgb(25, 28, 28)",
      onBackground: "rgb(224, 227, 226)",
      surface: "rgb(25, 28, 28)",
      onSurface: "rgb(224, 227, 226)",
      surfaceVariant: "rgb(63, 73, 72)",
      onSurfaceVariant: "rgb(190, 201, 200)",
      outline: "rgb(136, 147, 146)",
      outlineVariant: "rgb(63, 73, 72)",
      error: "rgb(255, 180, 171)",
      inverseSurface: "rgb(224, 227, 226)",
      inverseOnSurface: "rgb(45, 49, 49)",
      inversePrimary: "rgb(0, 106, 106)",
    },
  },
  {
    id: "yotsuba",
    label: "Yotsuba",
    light: {
      name: "Yotsuba",
      primary: "rgb(174, 50, 0)",
      onPrimary: "rgb(255, 255, 255)",
      primaryContainer: "rgb(255, 219, 208)",
      onPrimaryContainer: "rgb(58, 11, 0)",
      secondary: "rgb(119, 87, 77)",
      background: "rgb(255, 251, 255)",
      onBackground: "rgb(32, 26, 24)",
      surface: "rgb(255, 251, 255)",
      onSurface: "rgb(32, 26, 24)",
      surfaceVariant: "rgb(245, 222, 215)",
      onSurfaceVariant: "rgb(83, 67, 63)",
      outline: "rgb(133, 115, 110)",
      outlineVariant: "rgb(216, 194, 188)",
      error: "rgb(186, 26, 26)",
      inverseSurface: "rgb(54, 47, 45)",
      inverseOnSurface: "rgb(251, 238, 234)",
      inversePrimary: "rgb(255, 181, 158)",
    },
    dark: {
      name: "Yotsuba",
      primary: "rgb(255, 181, 158)",
      onPrimary: "rgb(94, 23, 0)",
      primaryContainer: "rgb(133, 36, 0)",
      onPrimaryContainer: "rgb(255, 219, 208)",
      secondary: "rgb(231, 189, 177)",
      background: "rgb(32, 26, 24)",
      onBackground: "rgb(237, 224, 220)",
      surface: "rgb(32, 26, 24)",
      onSurface: "rgb(237, 224, 220)",
      surfaceVariant: "rgb(83, 67, 63)",
      onSurfaceVariant: "rgb(216, 194, 188)",
      outline: "rgb(160, 140, 135)",
      outlineVariant: "rgb(83, 67, 63)",
      error: "rgb(255, 180, 171)",
      inverseSurface: "rgb(237, 224, 220)",
      inverseOnSurface: "rgb(54, 47, 45)",
      inversePrimary: "rgb(174, 50, 0)",
    },
  },
  {
    id: "lavender",
    label: "Lavender",
    light: {
      name: "Lavender",
      primary: "rgb(121, 68, 173)",
      onPrimary: "rgb(255, 255, 255)",
      primaryContainer: "rgb(240, 219, 255)",
      onPrimaryContainer: "rgb(44, 0, 81)",
      secondary: "rgb(102, 90, 111)",
      background: "#EDE2FF",
      onBackground: "#111129",
      surface: "#EDE2FF",
      onSurface: "#111129",
      surfaceVariant: "rgb(233, 223, 235)",
      onSurfaceVariant: "rgb(74, 69, 78)",
      outline: "rgb(124, 117, 126)",
      outlineVariant: "rgb(204, 196, 206)",
      error: "rgb(186, 26, 26)",
      inverseSurface: "rgb(50, 47, 51)",
      inverseOnSurface: "rgb(246, 239, 244)",
      inversePrimary: "rgb(221, 184, 255)",
    },
    dark: {
      name: "Lavender",
      primary: "rgb(221, 184, 255)",
      onPrimary: "rgb(72, 8, 123)",
      primaryContainer: "rgb(96, 42, 147)",
      onPrimaryContainer: "rgb(240, 219, 255)",
      secondary: "rgb(208, 193, 218)",
      background: "#111129",
      onBackground: "rgb(231, 225, 229)",
      surface: "#111129",
      onSurface: "rgb(231, 225, 229)",
      surfaceVariant: "rgb(74, 69, 78)",
      onSurfaceVariant: "rgb(204, 196, 206)",
      outline: "rgb(150, 142, 152)",
      outlineVariant: "rgb(74, 69, 78)",
      error: "rgb(255, 180, 171)",
      inverseSurface: "rgb(231, 225, 229)",
      inverseOnSurface: "rgb(50, 47, 51)",
      inversePrimary: "rgb(121, 68, 173)",
    },
  },
  {
    id: "strawberry-daiquiri",
    label: "Strawberry Daiquiri",
    light: {
      name: "Strawberry Daiquiri",
      primary: "rgb(182, 30, 64)",
      onPrimary: "rgb(255, 255, 255)",
      primaryContainer: "rgb(255, 218, 219)",
      onPrimaryContainer: "rgb(64, 0, 14)",
      secondary: "rgb(118, 86, 88)",
      background: "rgb(255, 251, 255)",
      onBackground: "rgb(32, 26, 26)",
      surface: "rgb(255, 251, 255)",
      onSurface: "rgb(32, 26, 26)",
      surfaceVariant: "rgb(244, 221, 222)",
      onSurfaceVariant: "rgb(82, 67, 68)",
      outline: "rgb(133, 115, 115)",
      outlineVariant: "rgb(215, 193, 194)",
      error: "rgb(186, 26, 26)",
      inverseSurface: "rgb(54, 47, 47)",
      inverseOnSurface: "rgb(251, 238, 238)",
      inversePrimary: "rgb(255, 178, 184)",
    },
    dark: {
      name: "Strawberry Daiquiri",
      primary: "rgb(255, 178, 184)",
      onPrimary: "rgb(103, 0, 29)",
      primaryContainer: "rgb(145, 0, 44)",
      onPrimaryContainer: "rgb(255, 218, 219)",
      secondary: "rgb(230, 189, 191)",
      background: "rgb(32, 26, 26)",
      onBackground: "rgb(236, 224, 223)",
      surface: "rgb(32, 26, 26)",
      onSurface: "rgb(236, 224, 223)",
      surfaceVariant: "rgb(82, 67, 68)",
      onSurfaceVariant: "rgb(215, 193, 194)",
      outline: "rgb(159, 140, 141)",
      outlineVariant: "rgb(82, 67, 68)",
      error: "rgb(255, 180, 171)",
      inverseSurface: "rgb(236, 224, 223)",
      inverseOnSurface: "rgb(54, 47, 47)",
      inversePrimary: "rgb(182, 30, 64)",
    },
  },
  {
    id: "tako",
    label: "Tako",
    light: {
      name: "Tako",
      primary: "#66577E",
      onPrimary: "rgb(255, 255, 255)",
      primaryContainer: "rgb(236, 220, 255)",
      onPrimaryContainer: "rgb(39, 0, 87)",
      secondary: "rgb(99, 91, 112)",
      background: "#F7F5FF",
      onBackground: "#21212E",
      surface: "#F7F5FF",
      onSurface: "#21212E",
      surfaceVariant: "rgb(232, 224, 235)",
      onSurfaceVariant: "rgb(73, 69, 78)",
      outline: "rgb(122, 117, 127)",
      outlineVariant: "rgb(203, 196, 207)",
      error: "rgb(186, 26, 26)",
      inverseSurface: "rgb(50, 48, 51)",
      inverseOnSurface: "rgb(245, 239, 244)",
      inversePrimary: "#F3B375",
    },
    dark: {
      name: "Tako",
      primary: "#F3B375",
      onPrimary: "rgb(61, 28, 111)",
      primaryContainer: "rgb(85, 53, 135)",
      onPrimaryContainer: "rgb(236, 220, 255)",
      secondary: "rgb(206, 194, 219)",
      background: "#21212E",
      onBackground: "rgb(230, 225, 230)",
      surface: "#21212E",
      onSurface: "rgb(230, 225, 230)",
      surfaceVariant: "rgb(73, 69, 78)",
      onSurfaceVariant: "rgb(203, 196, 207)",
      outline: "rgb(149, 142, 153)",
      outlineVariant: "rgb(73, 69, 78)",
      error: "rgb(255, 180, 171)",
      inverseSurface: "rgb(230, 225, 230)",
      inverseOnSurface: "rgb(50, 48, 51)",
      inversePrimary: "#66577E",
    },
  },
  {
    id: "catppuccin",
    label: "Catppuccin",
    light: {
      name: "Catppuccin",
      primary: "rgb(136, 57, 239)",
      onPrimary: "rgb(220, 224, 232)",
      primaryContainer: "rgb(136, 57, 239)",
      onPrimaryContainer: "rgb(220, 224, 232)",
      secondary: "rgb(136, 57, 239)",
      background: "rgb(230, 233, 239)",
      onBackground: "rgb(76, 79, 105)",
      surface: "rgb(230, 233, 239)",
      onSurface: "rgb(76, 79, 105)",
      surfaceVariant: "rgb(239, 241, 245)",
      onSurfaceVariant: "rgb(76, 79, 105)",
      outline: "rgb(174, 165, 187)",
      outlineVariant: "rgb(172, 176, 190)",
      error: "rgb(210, 15, 57)",
      inverseSurface: "rgb(30, 30, 46)",
      inverseOnSurface: "rgb(205, 214, 244)",
      inversePrimary: "rgb(203, 166, 247)",
    },
    dark: {
      name: "Catppuccin",
      primary: "rgb(203, 166, 247)",
      onPrimary: "rgb(17, 17, 27)",
      primaryContainer: "rgb(203, 166, 247)",
      onPrimaryContainer: "rgb(17, 17, 27)",
      secondary: "rgb(203, 166, 247)",
      background: "rgb(24, 24, 37)",
      onBackground: "rgb(205, 214, 244)",
      surface: "rgb(24, 24, 37)",
      onSurface: "rgb(205, 214, 244)",
      surfaceVariant: "rgb(30, 30, 46)",
      onSurfaceVariant: "rgb(205, 214, 244)",
      outline: "rgb(146, 137, 157)",
      outlineVariant: "rgb(88, 91, 112)",
      error: "rgb(243, 139, 168)",
      inverseSurface: "rgb(205, 214, 244)",
      inverseOnSurface: "rgb(76, 79, 105)",
      inversePrimary: "rgb(136, 57, 239)",
    },
  },
  {
    id: "yinyang",
    label: "Yinyang",
    light: {
      name: "Yinyang",
      primary: "#000000",
      onPrimary: "#FFFFFF",
      primaryContainer: "#000000",
      onPrimaryContainer: "#FFFFFF",
      secondary: "#000000",
      background: "#FDFDFD",
      onBackground: "#222222",
      surface: "#FDFDFD",
      onSurface: "#222222",
      surfaceVariant: "#E8E8E8",
      onSurfaceVariant: "#515151",
      outline: "#838383",
      outlineVariant: "#CFCFCF",
      error: "#BA1A1A",
      inverseSurface: "#333333",
      inverseOnSurface: "#F4F4F4",
      inversePrimary: "#A6A6A6",
    },
    dark: {
      name: "Yinyang",
      primary: "#FFFFFF",
      onPrimary: "#5A5A5A",
      primaryContainer: "#FFFFFF",
      onPrimaryContainer: "#000000",
      secondary: "#FFFFFF",
      background: "#1E1E1E",
      onBackground: "#E6E6E6",
      surface: "#1E1E1E",
      onSurface: "#E6E6E6",
      surfaceVariant: "#313131",
      onSurfaceVariant: "#D1D1D1",
      outline: "#999999",
      outlineVariant: "#2A2A2A",
      error: "#FFB4AB",
      inverseSurface: "#E6E6E6",
      inverseOnSurface: "#1E1E1E",
      inversePrimary: "#CECECE",
    },
  },
];

export const APP_THEME_OPTIONS = APP_THEMES.map((theme) => ({
  value: theme.id,
  label: theme.label,
}));

export function getAppTheme(id: AppThemeId): AppThemeDefinition {
  return APP_THEMES.find((theme) => theme.id === id) ?? APP_THEMES[0]!;
}

/** Returns the trimmed accent when it is a complete supported color, so partial input is ignored. */
export function normalizeCustomAccentColor(value?: string): string | undefined {
  const color = value?.trim();
  return color && parseColor(color) ? color : undefined;
}

export function resolveMd3Palette(
  id: AppThemeId,
  colorScheme: "light" | "dark",
  options: { amoledBlack?: boolean; customAccentColor?: string } = {},
): Md3Palette {
  const base = getAppTheme(id)[colorScheme];
  const customAccentColor = normalizeCustomAccentColor(options.customAccentColor);
  return {
    ...base,
    primary: customAccentColor || base.primary,
    primaryContainer: customAccentColor || base.primaryContainer,
    inversePrimary: customAccentColor || base.inversePrimary,
    ...(options.amoledBlack && colorScheme === "dark"
      ? {
          background: "#000000",
          surface: "#000000",
          surfaceVariant: "#101010",
          inverseSurface: "#E6E6E6",
        }
      : {}),
  };
}

export function makeMantineColorScale(
  palette: Md3Palette,
): [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
] {
  return [
    palette.primaryContainer,
    palette.primaryContainer,
    palette.inversePrimary,
    palette.inversePrimary,
    palette.primary,
    palette.primary,
    palette.primary,
    palette.primary,
    palette.onPrimaryContainer,
    palette.onPrimaryContainer,
  ];
}
