import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import en from "../../../strings/languages/en/app.json";

/*
 * D10 button rule (docs/superpowers/plans/2026-11-03-ui-ux-overhaul.md):
 * filled = the one primary action, `default` = outline secondary action,
 * `subtle` = borderless bar/row control or text link, `light` = pressed toggle
 * only; chips are ChipButtons. Icon-only buttons are borderless and named; sheet
 * footers hold label-only actions; the same action keeps the same icon.
 */

const srcDir = new URL("../../", import.meta.url);
const stylesDir = new URL("../../styles/", import.meta.url);

const sources = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .map((name) => name.replaceAll("\\", "/"))
  .filter((name) => name.endsWith(".tsx") && !/\.test\.tsx$/.test(name))
  .map((name) => ({ name, source: readFileSync(new URL(name, srcDir), "utf8") }));

const APP_ICONS = new Set(
  [...readFileSync(new URL("components/ui/icons.ts", srcDir), "utf8").matchAll(/export const (\w+Icon) =/g)].map(
    (match) => match[1]!,
  ),
);

interface Element {
  file: string;
  line: number;
  tag: string;
  /** The opening tag, props included. */
  open: string;
  /** Everything between the opening and closing tag; empty when self-closing. */
  children: string;
}

/** End index (exclusive) of the JSX opening tag that starts at `start`, skipping braces in props. */
function openTagEnd(source: string, start: number): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0) return index + 1;
  }
  throw new Error(`Unclosed tag at ${start}`);
}

/** Every `<tag ...>` element in `source`, with children up to its matching close tag. */
function elements(file: string, source: string, tag: string): Element[] {
  const escaped = tag.replace(".", "\\.");
  const opener = new RegExp(`<${escaped}(?=[\\s>/])`, "g");
  return [...source.matchAll(opener)].map((match) => {
    const start = match.index!;
    const end = openTagEnd(source, start);
    const open = source.slice(start, end);
    let children = "";
    if (!open.endsWith("/>")) {
      const tokens = new RegExp(`<${escaped}(?=[\\s>/])|</${escaped}>`, "g");
      tokens.lastIndex = end;
      let depth = 1;
      for (let token = tokens.exec(source); token; token = tokens.exec(source)) {
        if (token[0].startsWith("</")) depth -= 1;
        else if (!source.slice(token.index, openTagEnd(source, token.index)).endsWith("/>")) depth += 1;
        if (depth === 0) {
          children = source.slice(end, token.index);
          break;
        }
      }
    }
    return { file, line: source.slice(0, start).split("\n").length, tag, open, children };
  });
}

/** The balanced `{...}` expression that starts at `start`. */
function braceBlock(source: string, start: number): string {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unclosed block at ${start}`);
}

const where = (element: Element) => `${element.file}:${element.line}`;
const prop = (open: string, name: string) => new RegExp(`\\s${name}[=\\s>/]`).test(open);
const variantOf = (open: string) => /\svariant=(?:"([^"]+)"|\{([^}]*)\})/.exec(open);
const labelKeys = (text: string) => [...text.matchAll(/\bt\("([\w.]+)"/g)].map((match) => match[1]!);
/** The translation keys inside the `{...}` value of one prop of an opening tag. */
const propKeys = (open: string, name: string) => {
  const at = open.search(new RegExp(`\\s${name}=\\{`));
  return at < 0 ? [] : labelKeys(braceBlock(open, open.indexOf("{", at)));
};
const iconsIn = (text: string) =>
  [...new Set([...text.matchAll(/\b([A-Z]\w*Icon)\b/g)].map((match) => match[1]!))].filter((name) => APP_ICONS.has(name));

const buttons = sources.flatMap(({ name, source }) => [
  ...elements(name, source, "Button"),
  ...elements(name, source, "TextButton"),
]);

/** Sheet footers: each `<SheetActions>` block, or a `footer={...}` prop that has none. */
const footers = sources.flatMap(({ name, source }) => {
  const blocks = [...source.matchAll(/footer=\{/g)].map((match) => ({
    line: source.slice(0, match.index).split("\n").length,
    text: braceBlock(source, match.index! + "footer=".length),
  }));
  for (const match of source.matchAll(/<SheetActions>/g)) {
    const end = source.indexOf("</SheetActions>", match.index);
    blocks.push({ line: source.slice(0, match.index).split("\n").length, text: source.slice(match.index, end) });
  }
  return blocks
    .filter((block) => !(block.text.startsWith("{") && block.text.includes("<SheetActions>")))
    .map((block) => ({ file: name, ...block }));
});

describe("D10 icon-only buttons", () => {
  it("names every IconButton and never boxes it with a variant", () => {
    const iconButtons = sources.flatMap(({ name, source }) => elements(name, source, "IconButton"));
    expect(iconButtons.length).toBeGreaterThan(40);
    const offenders = iconButtons
      .filter((element) => element.file !== "components/IconButton.tsx")
      .filter((element) => !prop(element.open, "label") || prop(element.open, "variant"))
      .map(where);
    expect(offenders).toEqual([]);
  });

  it("keeps raw ActionIcons borderless and named", () => {
    const offenders = sources
      .flatMap(({ name, source }) => elements(name, source, "ActionIcon"))
      .filter((element) => element.file !== "components/IconButton.tsx")
      .filter((element) => !prop(element.open, "aria-label") || (variantOf(element.open)?.[1] ?? "subtle") !== "subtle")
      .map(where);
    expect(offenders).toEqual([]);
  });

  it("draws the shared icon button without a box in every stylesheet", () => {
    const sheets = readdirSync(stylesDir).filter((name) => name.endsWith(".css"));
    const offenders: string[] = [];
    for (const name of sheets) {
      const source = readFileSync(new URL(name, stylesDir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = match[1]!.split(",").map((selector) => selector.trim());
        if (!selectors.some((selector) => /norea-icon-button|norea-novel-chapter-state-button|norea-selection-action/.test(selector))) {
          continue;
        }
        for (const declaration of match[2]!.matchAll(/(?:^|;)\s*(border(?:-color)?|box-shadow)\s*:\s*([^;]+)/g)) {
          const value = declaration[2]!.trim();
          if (!/transparent|^0$|^none$/.test(value)) offenders.push(`${name} ${selectors.join(", ")}: ${declaration[1]} ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("D10 emphasis", () => {
  it("reserves the light variant for pressed toggles", () => {
    const offenders = buttons
      .filter((element) => variantOf(element.open)?.[0].includes("light"))
      .filter((element) => !prop(element.open, "aria-pressed"))
      .map(where);
    expect(offenders).toEqual([]);
  });

  it("draws every chip with ChipButton instead of a rounded Button", () => {
    const chips = sources.flatMap(({ name, source }) => elements(name, source, "ChipButton"));
    expect(chips.length).toBeGreaterThan(15);
    expect(buttons.filter((element) => /\sradius=/.test(element.open)).map(where)).toEqual([]);
    const rawChips = sources
      .filter(({ name }) => name !== "components/ChipButton.tsx")
      .filter(({ source }) => /className="[^"]*norea-chip\b/.test(source))
      .map(({ name }) => name);
    expect(rawChips).toEqual([]);
  });

  it("gives sheet footers label-only actions: an outline cancel and at most one filled primary", () => {
    expect(footers.length).toBeGreaterThan(10);
    const offenders = footers
      .flatMap((footer) => {
        const actions = [...elements(footer.file, footer.text, "Button"), ...elements(footer.file, footer.text, "TextButton")];
        const problems: string[] = [];
        let filled = 0;
        for (const action of actions) {
          const variant = variantOf(action.open)?.[1] ?? (action.tag === "Button" ? "filled" : "default");
          if (variant === "filled") filled += 1;
          if (prop(action.open, "leftSection") || prop(action.open, "rightSection")) problems.push("icon");
          if (variant === "light") problems.push("light");
          if (labelKeys(action.children).includes("common.cancel") && variant !== "default") problems.push("cancel");
        }
        if (filled > 1) problems.push("two primaries");
        return problems.map((problem) => `${footer.file}:${footer.line} ${problem}`);
      });
    expect(offenders).toEqual([]);
  });
});

/** Every labeled control that shows an app icon: JSX buttons, menu items and overflow item objects. */
function iconedActions(): Array<{ at: string; keys: string[]; icons: string[] }> {
  const jsx = sources.flatMap(({ name, source }) =>
    ["IconButton", "Button", "TextButton", "SelectionAction", "Menu.Item", "button"].flatMap((tag) =>
      elements(name, source, tag).map((element) => {
        const childKeys = labelKeys(element.children);
        const labelPropKeys = propKeys(element.open, "label");
        return {
          at: where(element),
          keys: childKeys.length > 0 ? childKeys : labelPropKeys.length > 0 ? labelPropKeys : propKeys(element.open, "title"),
          icons: iconsIn(element.open + element.children),
        };
      }),
    ),
  );
  const objects = sources.flatMap(({ name, source }) =>
    [...source.matchAll(/\bicon:\s*(\w+Icon)\b/g)].flatMap((match) => {
      let depth = 0;
      let start = match.index!;
      for (; start >= 0; start -= 1) {
        if (source[start] === "}") depth += 1;
        if (source[start] === "{") {
          if (depth === 0) break;
          depth -= 1;
        }
      }
      const block = braceBlock(source, start);
      const label = /\blabel:\s*([^\n]+)/.exec(block)?.[1] ?? "";
      return [{ at: `${name}:${source.slice(0, match.index).split("\n").length}`, keys: labelKeys(label), icons: [match[1]!] }];
    }),
  );
  return [...jsx, ...objects].filter((entry) => entry.keys.length > 0 && entry.icons.length === 1);
}

/** The most common actions and the one icon each keeps everywhere it appears. */
const ACTION_ICONS: Record<string, string> = {
  "common.openSite": "SourceIcon",
  "common.refresh": "RefreshIcon",
  "common.retry": "RetryIcon",
  "common.settings": "SettingsIcon",
  "reader.settingsShort": "ReaderSettingsIcon",
  "contentSync.browse": "BrowseIcon",
  "contentSync.rescan": "RescanIcon",
  "contentSync.syncNow": "SyncIcon",
  "deviceBackup.restore": "RestoreIcon",
  "deviceBackup.upload": "UploadIcon",
  "downloads.deleteAll": "TrashIcon",
  "downloads.deleteChapter": "TrashIcon",
  "downloads.refresh": "RefreshIcon",
  "library.deleteSelectedDownloads": "TrashIcon",
  "library.manageCategories": "CategoryIcon",
  "library.refresh": "RefreshIcon",
  "library.selection.categories": "CategoryIcon",
  "library.selection.download": "DownloadIcon",
  "library.selection.start": "SelectIcon",
  "library.settings.title": "SettingsIcon",
  "librarySettings.defaultChapterSort": "SortIcon",
  "novel.checkNewChapters": "RefreshIcon",
  "novel.deleteDownload": "TrashIcon",
  "novel.download": "DownloadIcon",
  "novel.downloadChapter": "DownloadIcon",
  "novel.filter.open": "FilterIcon",
  "novel.select": "SelectIcon",
  "novel.selection.deleteDownloads": "TrashIcon",
  "novel.selection.downloadSelected": "DownloadIcon",
  "selection.markRead": "MarkReadIcon",
  "selection.markUnread": "MarkUnreadIcon",
  "quickAdd.add": "AddToLibraryIcon",
  "settings.about.githubReleases": "GithubIcon",
  "settings.about.update.check": "RefreshIcon",
  "settings.about.update.install": "DownloadIcon",
  "settings.data.downloadedContent.button": "TrashIcon",
  "settings.data.exportBackup": "ExportIcon",
  "settings.data.importBackup": "ImportIcon",
  "settings.data.libraryMembership.button": "TrashIcon",
  "settings.data.pluginVpn.connection.connect": "ConnectIcon",
  "settings.data.pluginVpn.saved.manage": "SettingsIcon",
  "settings.data.pluginVpn.saved.reallow": "RestartIcon",
  "settings.data.pluginVpn.saved.reallowAll": "RestartIcon",
  "settings.data.pluginVpn.tested.approveAll": "PreferIcon",
  "settings.data.readingProgress.button": "TrashIcon",
  "settings.data.updatesQueue.button": "TrashIcon",
  "settings.data.webViewCache.button": "TrashIcon",
  "source.filters": "FilterIcon",
  "source.sourceSettings": "SettingsIcon",
  "storageSetup.selectExternalFolder": "FolderIcon",
  "storageSetup.selectFolder": "FolderIcon",
  "tasks.sort": "SortIcon",
  "updates.check": "RefreshIcon",
};

describe("D10 same action, same icon", () => {
  const actions = iconedActions();

  it("draws each common action with its one icon", () => {
    const offenders = actions.flatMap((entry) =>
      entry.keys
        .filter((key) => key in ACTION_ICONS && ACTION_ICONS[key] !== entry.icons[0])
        .map((key) => `${entry.at} ${key}: ${entry.icons[0]} instead of ${ACTION_ICONS[key]}`),
    );
    expect(offenders).toEqual([]);
    const seen = new Set(actions.flatMap((entry) => entry.keys));
    expect(Object.keys(ACTION_ICONS).filter((key) => !seen.has(key))).toEqual([]);
  });

  it("never pairs one label with two different icons", () => {
    const iconsByKey = new Map<string, Set<string>>();
    for (const entry of actions) {
      if (entry.keys.length !== 1) continue;
      const icons = iconsByKey.get(entry.keys[0]!) ?? new Set<string>();
      icons.add(entry.icons[0]!);
      iconsByKey.set(entry.keys[0]!, icons);
    }
    const mixed = [...iconsByKey].filter(([, icons]) => icons.size > 1).map(([key, icons]) => `${key}: ${[...icons].join(", ")}`);
    expect(mixed).toEqual([]);
  });
});

describe("D10 action labels", () => {
  it("names one action per button instead of chaining a second one the first implies", () => {
    const keys = new Set([
      ...buttons.flatMap((element) => labelKeys(element.children)),
      ...sources.flatMap(({ name, source }) => elements(name, source, "IconButton")).flatMap((element) => propKeys(element.open, "label")),
    ]);
    expect(keys.size).toBeGreaterThan(150);
    const messages = en as Record<string, string>;
    expect([...keys].filter((key) => / (?:and|then) /i.test(messages[key] ?? ""))).toEqual([]);
  });

  it("connects without saying it switches or applies first", () => {
    expect(Object.values(en).filter((value) => /^(?:switch|apply) and connect$/i.test(value))).toEqual([]);
  });
});
