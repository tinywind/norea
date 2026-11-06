import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesDir = new URL("./", import.meta.url);
const css = readFileSync(new URL("./ui.css", stylesDir), "utf8");
const appCss = readFileSync(new URL("./app.css", stylesDir), "utf8");

function mediaBlock(source: string, query: string): string {
  const start = source.indexOf(`@media ${query}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`Unclosed ${query} media block`);
}

interface Rule {
  selectors: string[];
  body: string;
}

function rules(source: string): Rule[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1]
      .split(",")
      .map((selector) => selector.trim().replace(/\s+/g, " "))
      .filter(Boolean),
    body: match[2],
  }));
}

/** Every declaration that applies to the exact selector, across all rules that list it. */
function ruleFor(source: string, selector: string): Rule {
  const matching = rules(source).filter((candidate) => candidate.selectors.includes(selector));
  expect(matching, selector).not.toEqual([]);
  return { selectors: [selector], body: matching.map((rule) => rule.body).join("\n") };
}

describe("state layer utility", () => {
  it("paints a currentColor layer that hover raises only on hover-capable pointers", () => {
    expect(css).toMatch(/\.norea-state-layer::after \{[^}]*background: currentColor;[^}]*opacity: 0;/);
    const hover = mediaBlock(css, "(hover: hover)");
    expect(hover).toMatch(/\.norea-state-layer:hover[^{]*::after \{\s*opacity: 0\.08;/);
    expect(css.replace(hover, "")).not.toMatch(/:hover/);
    expect(css).toMatch(/\.norea-state-layer:active[^{]*::after \{\s*opacity: 0\.12;/);
  });

  it("anchors the layer without overriding a control's own position", () => {
    expect(css).toMatch(/:where\(\.norea-state-layer\) \{\s*position: relative;\s*\}/);
    expect(css).not.toMatch(/(^|\n)\.norea-state-layer \{/);
  });

  it("replaces the white hover overlay variables in every stylesheet", () => {
    const sheets = readdirSync(stylesDir).filter((name) => name.endsWith(".css"));
    for (const name of sheets) {
      const source = readFileSync(new URL(`./${name}`, stylesDir), "utf8");
      expect(source, name).not.toMatch(/hover-overlay/);
    }
  });
});

/** The stylesheet with every `@media (hover: hover ...)` block cut out. */
function withoutHoverMedia(source: string): string {
  let result = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (;;) {
    const start = result.indexOf("@media (hover: hover");
    if (start < 0) return result;
    let depth = 0;
    let end = result.indexOf("{", start);
    for (; end < result.length; end += 1) {
      if (result[end] === "{") depth += 1;
      if (result[end] === "}") depth -= 1;
      if (depth === 0) break;
    }
    result = result.slice(0, start) + result.slice(end + 1);
  }
}

describe("long-press cue", () => {
  it("shrinks a held item and keeps the pressed layer while it is held", () => {
    expect(ruleFor(css, '.norea-state-layer[data-pressing="true"]').body).toMatch(/transform: scale\(0\.97\);/);
    expect(ruleFor(css, '.norea-state-layer[data-pressing="true"]::after').body).toMatch(/opacity: 0\.12;/);
  });

  it("eases library items and chapter rows into and out of the held scale with a motion token", () => {
    const library = readFileSync(new URL("./library.css", stylesDir), "utf8");
    const novel = readFileSync(new URL("./novel.css", stylesDir), "utf8");
    for (const [source, selector] of [
      [library, ".norea-library-card"],
      [library, ".norea-library-row"],
      [novel, ".norea-novel-chapter .norea-novel-chapter-open"],
    ] as const) {
      expect(ruleFor(source, selector).body, selector).toMatch(
        /transition: transform var\(--norea-duration-slow\) var\(--norea-ease-standard\);/,
      );
    }
  });
});

describe("transitions", () => {
  it("fades the selection bar in and slides the phone action bar up with motion tokens", () => {
    expect(ruleFor(css, ".norea-selection-bar > .norea-app-bar-row").body).toMatch(
      /animation: norea-selection-bar-enter var\(--norea-duration-base\) var\(--norea-ease-standard\);/,
    );
    const phone = mediaBlock(css, "(max-width: 767px)");
    expect(ruleFor(phone, ".norea-selection-bar-actions").body).toMatch(
      /animation: norea-selection-actions-enter var\(--norea-duration-base\) var\(--norea-ease-standard\);/,
    );
    expect(css).toMatch(/@keyframes norea-selection-actions-enter \{\s*from \{\s*transform: translateY\(100%\);/);
  });

  it("animates progress bar widths with the base motion token", () => {
    expect(ruleFor(css, ".mantine-Progress-root").body).toMatch(
      /--progress-transition-duration: var\(--norea-duration-base\);/,
    );
    const library = readFileSync(new URL("./library.css", stylesDir), "utf8");
    const history = readFileSync(new URL("./history.css", stylesDir), "utf8");
    for (const [source, selector] of [
      [library, ".norea-library-card-progress"],
      [history, ".norea-history-progress-bar"],
    ] as const) {
      expect(ruleFor(source, selector).body, selector).toMatch(
        /transition: width var\(--norea-duration-base\) var\(--norea-ease-standard\);/,
      );
    }
  });
});

describe("hover styles", () => {
  it("apply only on hover-capable pointers, so a touch never leaves a sticky hover", () => {
    const sheets = readdirSync(stylesDir).filter((name) => name.endsWith(".css"));
    for (const name of sheets) {
      const source = readFileSync(new URL(`./${name}`, stylesDir), "utf8");
      expect(withoutHoverMedia(source), name).not.toMatch(/:hover/);
    }
  });
});

describe("focus indicator", () => {
  it("draws a real outline in the focus role instead of a shadow ring", () => {
    for (const selector of [
      ":focus-visible",
      ".mantine-focus-auto:focus-visible",
      ".mantine-focus-always:focus",
    ]) {
      const { body } = ruleFor(appCss.replace(mediaBlock(appCss, "(forced-colors: active)"), ""), selector);
      expect(body, selector).toMatch(/outline: var\(--norea-focus-width\) solid var\(--norea-color-focus\);/);
      expect(body, selector).toMatch(/outline-offset: 2px;/);
      expect(body, selector).not.toMatch(/box-shadow/);
    }
  });

  it("switches the outline to the system highlight color in forced colors mode", () => {
    const forced = mediaBlock(appCss, "(forced-colors: active)");
    expect(ruleFor(forced, ":focus-visible").body).toMatch(/outline-color: Highlight;/);
  });

  it("points Mantine input focus borders at the focus role", () => {
    expect(appCss).toMatch(/\.mantine-Input-wrapper[^{]*\{\s*--input-bd-focus: var\(--norea-color-focus\);/);
  });

  it("never hides focus behind a shadow-only ring in any stylesheet", () => {
    const sheets = readdirSync(stylesDir).filter((name) => name.endsWith(".css"));
    for (const name of sheets) {
      const source = readFileSync(new URL(`./${name}`, stylesDir), "utf8");
      for (const rule of rules(source)) {
        if (!rule.selectors.some((selector) => /:focus(-visible)?\b/.test(selector))) continue;
        expect(rule.body, `${name} ${rule.selectors.join(", ")}`).not.toMatch(/--norea-focus-ring/);
      }
    }
  });
});

describe("unchecked selection controls", () => {
  it("outline boxes, radios and off switch tracks with the 3:1 strong rule", () => {
    expect(ruleFor(appCss, "[data-mantine-color-scheme] .mantine-Checkbox-input:not(:checked):not(:disabled):not([data-indeterminate]):not([data-error])").body)
      .toMatch(/border-color: var\(--norea-color-rule-strong\);/);
    expect(ruleFor(appCss, "[data-mantine-color-scheme] .mantine-Radio-radio:not(:checked):not(:disabled):not([data-error])").body)
      .toMatch(/border-color: var\(--norea-color-rule-strong\);/);
    expect(ruleFor(appCss, "[data-mantine-color-scheme] .mantine-Switch-input:not(:checked):not(:disabled) + .mantine-Switch-track").body)
      .toMatch(/--switch-bg: var\(--norea-color-rule-strong\);/);
  });
});

describe("coarse pointer touch floor", () => {
  const coarse = mediaBlock(css, "(any-pointer: coarse)");

  it("raises shared controls, nav links and chip buttons to the 44px control token", () => {
    for (const selector of [
      "html:root .norea-icon-button",
      "html:root .mantine-ActionIcon-root",
      "html:root .mantine-CloseButton-root",
      "html:root .norea-rail-link",
      "html:root button.norea-console-chip",
    ]) {
      const { body } = ruleFor(coarse, selector);
      expect(body, selector).toMatch(/min-height: var\(--norea-control-md\);/);
      expect(body, selector).toMatch(/min-width: var\(--norea-control-md\);/);
    }
  });

  it("gives labeled buttons the touch height with a floor wider than the icon square", () => {
    for (const selector of ["html:root .norea-text-button", "html:root .mantine-Button-root"]) {
      const { body } = ruleFor(coarse, selector);
      expect(body, selector).toMatch(/min-height: var\(--norea-control-md\);/);
      expect(body, selector).toMatch(/min-width: 4\.5rem;/);
      expect(body, selector).not.toMatch(/min-width: var\(--norea-control-md\);/);
    }
  });

  it("grows the hit area with a transparent pseudo-element where the bar height is fixed", () => {
    for (const control of [
      ".mantine-Input-section .mantine-ActionIcon-root",
      ".norea-mobile-nav-link",
      ".norea-chip",
    ]) {
      const { body } = ruleFor(coarse, `html:root ${control}::before`);
      expect(body, control).toMatch(/content: "";/);
      expect(body, control).toMatch(/height: max\(100%, var\(--norea-control-md\)\);/);
      expect(body, control).toMatch(/width: max\(100%, var\(--norea-control-md\)\);/);
      expect(body, control).not.toMatch(/background/);
      expect(ruleFor(coarse, `html:root ${control}`).body, control).toMatch(/position: relative;/);
    }
    expect(
      ruleFor(coarse, "html:root .mantine-Input-section .mantine-ActionIcon-root").body,
    ).toMatch(/min-height: 0;/);
  });

  it("keeps chips at their 2rem pill instead of stretching them to the floor", () => {
    expect(coarse).not.toMatch(/\.norea-chip[^{]*\{[^}]*min-height/);
    const { body } = ruleFor(appCss, ".norea-chip");
    expect(body).toMatch(/height: 2rem;/);
    expect(body).toMatch(/border-radius: var\(--norea-radius-full\);/);
    expect(body).toMatch(/font-weight: var\(--norea-weight-medium\);/);
    expect(body).toMatch(/border: 1px solid var\(--norea-color-rule-strong\);/);
    expect(ruleFor(appCss, '.norea-chip[aria-pressed="true"]').body).toMatch(/background: var\(--norea-color-accent-soft\);/);
  });

  it("lets reader bar buttons take the full touch floor instead of a hit-area overlay", () => {
    expect(coarse).not.toMatch(/norea-reader-/);
  });

  it("keeps the touch floor out of fine pointer layouts", () => {
    expect(css.replace(coarse, "")).not.toMatch(/--norea-control-md/);
  });
});

describe("tap highlight", () => {
  it("is suppressed only on reader tap surfaces and controls with their own pressed state", () => {
    const reader = readFileSync(new URL("./reader.css", stylesDir), "utf8");
    const suppressed = rules(reader)
      .filter((rule) => /-webkit-tap-highlight-color: transparent/.test(rule.body))
      .flatMap((rule) => rule.selectors)
      .sort();
    expect(suppressed).toEqual([
      ".norea-pdf-reader-viewport",
      ".norea-reader-chapter-row",
      ".norea-reader-floating-seekbar",
      ".norea-reader-icon-button",
      ".reader-viewport",
    ]);
    const sheets = readdirSync(stylesDir).filter((name) => name.endsWith(".css") && name !== "reader.css");
    for (const name of sheets) {
      const source = readFileSync(new URL(`./${name}`, stylesDir), "utf8");
      expect(source, name).not.toMatch(/-webkit-tap-highlight-color/);
    }
  });
});

describe("page slot transition", () => {
  it("cross-fades pages with motion tokens", () => {
    expect(ruleFor(appCss, ".norea-page-slot").body).toMatch(
      /transition: opacity var\(--norea-duration-base\) var\(--norea-ease-standard\);/,
    );
  });

  it("keeps a leaving page visible only until its fade ends", () => {
    const { body } = ruleFor(appCss, '.norea-page-slot[data-active="false"]');

    expect(body).toMatch(/opacity: 0;/);
    expect(body).toMatch(/visibility: hidden;/);
    expect(body).toMatch(/pointer-events: none;/);
    expect(body).toMatch(/position: absolute;/);
    expect(body).toMatch(
      /transition:\s*opacity var\(--norea-duration-base\) var\(--norea-ease-standard\),\s*visibility 0s linear var\(--norea-duration-base\);/,
    );
  });
});

describe("toast placement", () => {
  it("lifts bottom toasts by an offset that defaults to the bottom navigation inset", () => {
    expect(ruleFor(css, '.norea-toasts[data-position^="bottom"]').body).toMatch(
      /bottom: calc\(var\(--mantine-spacing-md\) \+ var\(--norea-toast-bottom-offset\)\);/,
    );
    expect(ruleFor(css, ":root").body).toMatch(/--norea-toast-bottom-offset: var\(--norea-app-bottom-inset\);/);
  });

  it("clears only the safe area in the reader and the reader bars while they show", () => {
    expect(ruleFor(css, "body[data-norea-reader-active]").body).toMatch(
      /--norea-toast-bottom-offset: var\(--norea-safe-area-bottom\);/,
    );
    const readerBars = /body\[data-norea-reader-bars\] \{\s*--norea-toast-bottom-offset: calc\(\s*var\(--norea-safe-area-bottom\) \+ (2 \* )?var\(--norea-reader-bar-height\)\s*\);/g;
    expect([...css.matchAll(readerBars)].map((match) => match[1])).toEqual([undefined]);
    const reader = readFileSync(new URL("./reader.css", stylesDir), "utf8");
    expect(ruleFor(reader, ":root").body).toMatch(/--norea-reader-bar-height:/);
  });
});

describe("full-screen dialogs", () => {
  it("keep every full-screen modal inside the safe-area insets and above the keyboard", () => {
    const inner = ruleFor(appCss, ".mantine-Modal-root[data-full-screen] .mantine-Modal-inner").body;
    expect(inner).toMatch(
      /padding: var\(--norea-safe-area-top\) var\(--norea-safe-area-right\)\s+calc\(var\(--norea-safe-area-bottom\) \+ var\(--norea-keyboard-inset\)\)\s+var\(--norea-safe-area-left\);/,
    );
    const content = ruleFor(appCss, ".mantine-Modal-root[data-full-screen] .mantine-Modal-content").body;
    expect(content).toMatch(
      /height: calc\(\s*var\(--norea-viewport-height\) - var\(--norea-safe-area-top\) -\s+var\(--norea-safe-area-bottom\) - var\(--norea-keyboard-inset\)\s*\);/,
    );
  });

  it("center other dialogs in the area above the keyboard", () => {
    const inner = ruleFor(appCss, ".mantine-Modal-root:not([data-full-screen]) .mantine-Modal-inner").body;
    expect(inner).toMatch(
      /padding-block-end: calc\(\s*max\(5dvh, var\(--norea-safe-area-bottom\)\) \+ var\(--norea-keyboard-inset\)\s*\);/,
    );
    const content = ruleFor(appCss, ".mantine-Modal-root:not([data-full-screen]) .mantine-Modal-content").body;
    expect(content).toMatch(/- var\(--norea-keyboard-inset\)\s*\);/);
  });

  it("leaves no per-dialog safe-area padding behind", () => {
    const sheets = readdirSync(stylesDir).filter((name) => name.endsWith(".css") && name !== "app.css");
    for (const name of sheets) {
      const source = readFileSync(new URL(name, stylesDir), "utf8");
      expect(source, name).not.toMatch(/\[data-full-screen\]/);
    }
  });
});

describe("list alignment rule", () => {
  const inlineInputBodies = [".mantine-Checkbox-body", ".mantine-Radio-body", ".mantine-Switch-body"];

  it("centers list row leading and trailing elements on the whole text block", () => {
    expect(ruleFor(css, ".norea-list-item").body).toMatch(/align-items: center;/);
    expect(ruleFor(css, ".norea-list-item-leading").body).toMatch(/align-items: center;[^}]*display: flex;/);
    expect(ruleFor(css, ".norea-list-item-trailing").body).toMatch(/align-items: center;[^}]*display: flex;/);
  });

  it("centers checkbox, radio and switch controls on their label block on every pointer", () => {
    const outsideMedia = css.replace(mediaBlock(css, "(any-pointer: coarse)"), "");
    for (const selector of inlineInputBodies) {
      expect(ruleFor(outsideMedia, selector).body, selector).toMatch(/align-items: center;/);
    }
  });

  it("leaves no stylesheet pinning a list leading element or an input control to the first line", () => {
    const pinned = /align-(?:items|self): (?:flex-start|start|baseline|first baseline)/;
    const sheets = readdirSync(stylesDir).filter((name) => name.endsWith(".css"));
    for (const name of sheets) {
      const source = readFileSync(new URL(name, stylesDir), "utf8");
      const offenders = rules(source).filter(
        (rule) =>
          rule.selectors.some((selector) =>
            [...inlineInputBodies, ".norea-list-item-leading", ".mantine-Menu-itemSection"].some((target) =>
              selector.includes(target),
            ),
          ) && pinned.test(rule.body),
      );
      expect(offenders, name).toEqual([]);
    }
  });

  it("lays a library row cover out as a flex item so it never rides a text baseline", () => {
    const library = readFileSync(new URL("./library.css", stylesDir), "utf8");
    expect(ruleFor(library, ".norea-library-row-cover").body).toMatch(/display: flex;/);
  });
});

describe("reader settings sheet", () => {
  const reader = readFileSync(new URL("./reader.css", stylesDir), "utf8");

  it("scrolls its body instead of shrinking setting rows or the tab strip", () => {
    expect(ruleFor(reader, ".norea-reader-quick-body > *").body).toMatch(/flex-shrink:\s*0/);
    expect(ruleFor(reader, ".norea-reader-quick-tabs > .norea-reader-settings-tab-list").body)
      .toMatch(/flex-shrink:\s*0/);
    expect(ruleFor(reader, ".norea-reader-quick-body").body).toMatch(/overflow-y:\s*auto/);
  });

  it("does not add a second gesture-bar inset above the reset footer", () => {
    expect(ruleFor(reader, ".norea-reader-quick-tabs .norea-reader-quick-body").body)
      .not.toMatch(/safe-area-bottom/);
  });
});

/*
 * One-side stripes: a colored edge on one side of a card, row, callout or
 * alert says nothing a full border, a tint or an icon cannot. Only the
 * current-location indicators below keep one, so the current item differs
 * from hover and selection.
 */
describe("one-side stripes", () => {
  const CURRENT_LOCATION_INDICATORS = new Set([
    "app.css .norea-rail-link",
    "app.css .norea-rail-link--active",
    "reader.css .norea-reader-chapter-row",
    "reader.css .norea-reader-chapter-row[data-current=\"true\"]",
    "settings.css .norea-settings-index-row[data-selected=\"true\"]",
  ]);
  const SIDE = "(?:left|right|inline-start|inline-end)";

  function widerThanHairline(value: string): boolean {
    if (/\b(?:medium|thick)\b/.test(value)) return true;
    const length = /(?:^|\s)(\d*\.?\d+)(px|rem|em)\b/.exec(value);
    if (!length) return false;
    const size = Number(length[1]);
    return length[2] === "px" ? size > 1 : size > 0.0625;
  }

  function stripes(body: string): string[] {
    const found: string[] = [];
    for (const match of body.matchAll(new RegExp(`(?:^|;)\\s*(border-${SIDE}(?:-width)?)\\s*:\\s*([^;]+)`, "g"))) {
      if (widerThanHairline(match[2]!)) found.push(`${match[1]}: ${match[2]!.trim()}`);
    }
    for (const match of body.matchAll(new RegExp(`(?:^|;)\\s*(border-${SIDE}-color)\\s*:\\s*([^;]+)`, "g"))) {
      if (!/^(?:transparent|inherit|initial|unset)$/.test(match[2]!.trim())) found.push(`${match[1]}: ${match[2]!.trim()}`);
    }
    for (const match of body.matchAll(/(?:^|;)\s*box-shadow\s*:\s*([^;]+)/g)) {
      const edge = /inset\s+(-?\d*\.?\d+)(?:px|rem|em)?\s+0(?:px|rem)?\s+0(?:px|rem)?\s/.exec(match[1]!);
      if (edge && Number(edge[1]) !== 0) found.push(`box-shadow: ${match[1]!.trim()}`);
    }
    return found;
  }

  it("keeps one-side colored edges to the current-location indicators", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(stylesDir).filter((file) => file.endsWith(".css"))) {
      const source = readFileSync(new URL(`./${name}`, stylesDir), "utf8");
      for (const rule of rules(source)) {
        const found = stripes(rule.body);
        if (found.length === 0) continue;
        // A refinement of an indicator, such as the current row while selected, keeps its edge.
        const indicator = (selector: string) =>
          [...CURRENT_LOCATION_INDICATORS].some((allowed) => {
            const full = `${name} ${selector}`;
            return full.startsWith(allowed) && /^(?:$|[[:])/.test(full.slice(allowed.length));
          });
        if (rule.selectors.every(indicator)) continue;
        offenders.push(`${name} ${rule.selectors.join(", ")}: ${found.join("; ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("flags the stripe shapes it guards against", () => {
    expect(stripes("border-left: 0.25rem solid var(--norea-color-warn);")).toHaveLength(1);
    expect(stripes("border-left-color: var(--norea-color-accent);")).toHaveLength(1);
    expect(stripes("box-shadow: inset 0.1875rem 0 0 var(--norea-color-warn);")).toHaveLength(1);
    expect(stripes("border-right: 1px solid var(--norea-color-rule);")).toEqual([]);
    expect(stripes("box-shadow: inset 0 0 0 1px var(--norea-color-accent);")).toEqual([]);
  });
});

describe("tabbed sheets", () => {
  it("keep one height across tabs as a bottom sheet and as a dialog", () => {
    expect(ruleFor(css, ".norea-responsive-sheet--drawer.norea-sheet--tabbed").body).toMatch(/height: calc\(/);
    expect(css).toMatch(/\.norea-responsive-sheet\.norea-sheet--tabbed:not\([^)]*\) \{\s*height: min\(/);
    const viewOptions = readFileSync(new URL("../components/library/LibraryViewOptions.tsx", stylesDir), "utf8");
    expect(viewOptions).toContain("norea-sheet--tabbed");
  });
});
