import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The page header rule (see `PageHeader` in components/AppFrame.tsx): primary
 * nav destinations start with their title and show no back button; every page
 * reached by drilling in shows one at the leading edge of the same header.
 */
const PRIMARY_ROUTES: Readonly<Record<string, readonly string[]>> = {
  "/": ["components/library/LibraryAppBar.tsx"],
  "/browse": ["routes/browse.tsx"],
  "/history": ["routes/history.tsx"],
  "/more": ["routes/more.tsx"],
  "/updates": ["routes/updates.tsx"],
};

const DRILL_IN_ROUTES: Readonly<Record<string, readonly string[]>> = {
  "/browse/extensions": ["routes/extensions.tsx"],
  "/downloads": ["routes/downloads-queue.tsx", "routes/downloads-storage.tsx"],
  "/novel": ["routes/novel.tsx"],
  "/novel-merge": ["routes/novel-merge.tsx"],
  "/settings": ["routes/settings.tsx"],
  "/setup": ["routes/setup.tsx"],
  "/source": ["routes/source.tsx"],
};

/** The reader keeps its themed bar; its back still leads the bar. */
const READER_ROUTE = "/reader";

/** A primary destination without page-level controls draws no bar; its heading is hidden. */
const NO_BAR_ROUTES: readonly string[] = ["routes/more.tsx"];

/** Back inside a primary destination's own sub-view, never out of the destination. */
const PRIMARY_SUB_VIEW_BACKS: Readonly<Record<string, readonly string[]>> = {
  "components/library/LibraryAppBar.tsx": ["onBack={closeSearch}"],
  "routes/updates.tsx": ['onBack={view === "backlog" ? () => setView("new") : undefined}'],
};

/** Section headers inside a page body, not page headers. */
const SECTION_HEADERS = ['<header className="norea-task-group-header">'];

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function rawPageHeaders(code: string): string[] {
  return [...code.matchAll(/<header\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => !SECTION_HEADERS.includes(tag));
}

/** The opening tag of every `<PageHeader` element, up to its `>` outside braces. */
function pageHeaderTags(code: string): string[] {
  const tags: string[] = [];
  for (let start = code.indexOf("<PageHeader"); start >= 0; start = code.indexOf("<PageHeader", start + 1)) {
    let depth = 0;
    let end = start;
    for (; end < code.length; end += 1) {
      const character = code[end];
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
      if (character === ">" && depth === 0) break;
    }
    tags.push(code.slice(start, end + 1));
  }
  return tags;
}

function backProps(tag: string): string[] {
  return [...tag.matchAll(/onBack=\{/g)].map((match) => {
    let depth = 0;
    let end = match.index + "onBack=".length;
    for (; end < tag.length; end += 1) {
      if (tag[end] === "{") depth += 1;
      if (tag[end] === "}") depth -= 1;
      if (depth === 0) break;
    }
    return tag.slice(match.index, end + 1);
  });
}

describe("page header rule", () => {
  it("classifies every routed page", () => {
    const routed = [...source("router.tsx").matchAll(/path: "([^"]+)"/g)].map((match) => match[1]).sort();
    const classified = [...Object.keys(PRIMARY_ROUTES), ...Object.keys(DRILL_IN_ROUTES), READER_ROUTE].sort();
    expect(routed).toEqual(classified);
  });

  it("matches the primary destinations to the bottom nav and rail", () => {
    const nav = [...source("routes/__root.tsx").matchAll(/to: "([^"]+)",\s*labelKey:/g)].map((match) => match[1]);
    expect(nav.sort()).toEqual(Object.keys(PRIMARY_ROUTES).sort());
  });

  it.each(Object.entries(PRIMARY_ROUTES))("gives %s a bar of controls, a hidden title and no back out of the page", (_route, files) => {
    for (const file of files) {
      const code = source(file);
      expect(rawPageHeaders(code), file).toEqual([]);
      if (NO_BAR_ROUTES.includes(file)) {
        expect(pageHeaderTags(code), file).toEqual([]);
        expect(code, file).toMatch(/<VisuallyHidden component="h1">/);
        continue;
      }
      const subViewBacks = PRIMARY_SUB_VIEW_BACKS[file] ?? [];
      const tags = pageHeaderTags(code);
      expect(tags.length, file).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(tag, file).toMatch(/\btitle=\{/);
        // A slot of page controls (a non-self-closing tag) or `titleHidden` keeps the title off screen.
        expect(/\btitleHidden\b/.test(tag) || !tag.endsWith("/>"), `${file}: ${tag}`).toBe(true);
      }
      expect(tags.flatMap(backProps), file).toEqual(subViewBacks);
    }
  });

  it.each(Object.entries(DRILL_IN_ROUTES))("gives every %s header a back button", (_route, files) => {
    for (const file of files) {
      const code = source(file);
      expect(rawPageHeaders(code), file).toEqual([]);
      const tags = pageHeaderTags(code);
      expect(tags.length, file).toBeGreaterThan(0);
      for (const tag of tags) expect(backProps(tag), `${file}: ${tag}`).toHaveLength(1);
    }
  });

  it("keeps header text actions borderless", () => {
    const files = [...Object.values(PRIMARY_ROUTES), ...Object.values(DRILL_IN_ROUTES)].flat();
    for (const file of [...files, "components/ui/SelectionBar.tsx", "components/SiteBrowserOverlay.tsx"]) {
      for (const tag of pageHeaderTags(source(file))) {
        expect(tag, file).not.toMatch(/variant=(?:"(?:default|outline|filled|light)"|\{)/);
      }
    }
  });

  it("draws the selection state with the same header component", () => {
    const tags = pageHeaderTags(source("components/ui/SelectionBar.tsx"));
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatch(/backIcon="close"/);
    expect(backProps(tags[0]!)).toEqual(["onBack={onExit}"]);
  });

  it("leads the reader bar and the site browser with the shared back button", () => {
    const reader = source("components/reader/ReaderChrome.tsx");
    expect(reader).toMatch(/<header className="norea-reader-topbar"[^>]*>\s*<BackIconButton/);
    const siteBrowser = pageHeaderTags(source("components/SiteBrowserOverlay.tsx"));
    expect(siteBrowser).toHaveLength(1);
    expect(backProps(siteBrowser[0]!)).toEqual(["onBack={closeBrowser}"]);
  });
});
