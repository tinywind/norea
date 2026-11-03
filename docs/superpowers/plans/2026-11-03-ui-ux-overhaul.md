# UI/UX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current "admin console" UI with a coherent reader-app design system, and restructure every page so the primary task is obvious, secondary information is one tap away, and diagnostic information is out of the default view.

**Architecture:** One token layer (`src/theme/tokens.css`) plus concrete palette colors generated in TypeScript and mapped onto every Mantine CSS variable through `cssVariablesResolver`. A small set of shared primitives under `src/components/ui/` and one icon module. Pages are rebuilt one vertical slice at a time on top of those primitives, and each page's duplicates are deleted as it migrates. Visual and structural work changes no schema, backup format, plugin contract or Rust code. The feature redesigns in the spec (§2, RD1-RD23) are separate slices. Among them, RD6 (multiple repositories) needs a DB migration, a backup format change and a Rust restore change. RD15 (automatic backup) and RD20 (notification targets) need native work. Each of those follows `docs/release-compatibility.md` and CLAUDE.md's schema migration rules.

**Tech Stack:** React 19, Mantine 9.7.4, TanStack Router/Query, Zustand. New dependencies only after the decisions in "Decisions required" are approved.

**Evidence:**
- Read-only code audit on 2026-11-03 of every route and overlay: shell, Library, Browse/Source/Global search, Novel/Novel merge, Reader, Updates/History/Downloads/Tasks/VPN, Settings.
- Main claims were re-checked against source by the plan author.
- An external Codex review sampled 32 claims and rated them: 25 confirmed, 3 wrong, 4 stale lines. The corrections are applied below; see "Review log".
- Line numbers refer to the working tree on 2026-11-03. Re-check them before editing.

## Global constraints

- **Targets:** Windows desktop and Android phone only.
  - Check layouts at 360x780, 768x1024 and 1440x900.
  - Check each breakpoint boundary (767/768, 991/992, 1199/1200).
  - Check UI scale at 75%, 100% and 150%.
- **Breakpoints:** follow the contract owned by `src/main.tsx` (576/768/992/1200/1408; `max-width` uses the previous pixel).
- **Sizes:** use `rem`/`var()`, so `fontScalePercent` keeps scaling the UI through `src/lib/runtime/viewport.ts:269`. `androidViewScalePercent` must not use WebView zoom.
- **Strings:** visible strings live only in `strings/languages/{en,ko}/app.json`, with en/ko parity.
- **Plugin traffic:** plugin-owned site traffic stays on `src/lib/http.ts` and the scraper WebView. The site browser keeps its native session ownership, native bounds and revision-checked verification identity (`src/components/SiteBrowserOverlay.tsx:61,181`).
- **Reader header:** controls stay icon-based, with the shared back affordance.
- **Persisted stores:** change only additively. A removed setting stays as an ignored field.
  - Value normalization (for example a removed tap preset id) covers global, source and novel scopes and never overwrites customized tap-zone maps (`src/store/reader.ts:1316` and the override normalizers).
  - No readers for earlier external formats are added (`docs/release-compatibility.md:8`).
- **Semantic controls:** no clickable `div`/`span` and no nested interactive DOM.
- **Overlays:** every overlay defines initial focus, focus return, Escape precedence and Android back precedence.
- **Artifacts:** generated screenshots and reports go to `.tmp/ui-ux-overhaul/` and are never committed.
- **Commits:** visual-only changes and behavior changes land in separate commits. A slice that changes typography or row size also reconciles any virtualized row geometry in the same commit.
- **Commands:** build, test and git commands run only when the user asks for them in the current message.

## Root causes

1. **No design tokens.** 29 font sizes, 15 radii, 85 distinct padding declarations, 9 ad-hoc z-index values and 4 durations.
   - Most text is 10-11px: `0.6875rem` is the most common size (37 uses), and 77 declarations are under 12px.
2. **Mantine is half-integrated.**
   - The `norea` color scale repeats 4 palette roles across 10 slots (`src/theme/md3.ts:470-497`).
   - `colors.dark` and `cssVariablesResolver` are not set (`src/main.tsx:186-215`). So 17 Modals, 24 Popovers, 27 Selects and 6 Drawers render Mantine's neutral gray in every dark theme.
   - 92 call sites use raw Mantine colors: `color="red"` x51, `blue` x16, `yellow` x12, `orange` x9.
3. **Overlapping token families.**
   - `--norea-background`, `-on-background`, `-surface`, `-on-surface`, `-surface-variant`, `-outline`, `-primary` and `-on-primary` are written in `src/main.tsx:218-232` and never read.
   - `--norea-on-surface-variant` is read once (`src/styles/app.css:465`) and has two different definitions (`src/styles/app.css:44` vs `src/main.tsx:230`).
   - The real roles are `--norea-design-*`, mixed with `--mantine-color-*`.
4. **Every screen defines its own components.**
   - 27 button-like CSS classes, 8 of them icon buttons.
   - Three button families: `TextButton` x131, raw `<button>` x31, Mantine `Button` x13.
   - 33 glyphs in `ActionGlyphs.tsx`, plus 35 inline SVGs in 13 other files. Some duplicates differ: the search icon uses `r=6` in one place and `r=7` in another. Some different meanings share one glyph.
   - Three identical spin keyframes.
5. **Console aesthetic.**
   - The monospace "meta" font is used 56 times, including for Korean metadata.
   - Uppercase kickers have 0.08-0.14em letter-spacing applied to Hangul.
   - Library list mode is an 8-column table.
   - `ConsolePanel`/`ConsoleChip`/`ConsoleStatusStrip` frame most pages.
6. **No interaction layer.**
   - 51 `:hover` rules and 1 `:active` rule.
   - `-webkit-tap-highlight-color: transparent` removes the platform default (`src/styles/reader.css:2`).
   - 10 `transition` declarations in 8,075 CSS lines, and no Mantine `Transition`/`Collapse`.
   - 37 `Loader`s against 8 `Skeleton`s.
7. **Undersized touch targets.**
   - `IconButton` default is 28px, used about 51 times. The large size is 40px.
   - Reader top bar is 36px. Reader prev/next chapter targets are about 18px tall. `TextButton sm` is 28px.
8. **No information hierarchy.** Internal state is shown by default, sometimes three or four times: DB ids, plugin paths, lanes, priorities, VPN IPs, server URLs, "fan-out", "cached".
9. **Fonts named but never bundled.**
   - `--norea-font-ui` and `--norea-font-display` name Inter and Source Serif 4, but no font assets exist (`src/styles/app.css:57-59`).
   - The reader font list (`src/store/reader.ts:278-289`) has no files either.
   - Georgia has no Hangul.
10. **Contrast is not designed.** `outline`, which is used today for subtle text, is below 4.5:1 against its surfaces in 15 of 18 theme schemes. Examples: Moss light on panel is 3.15, and dark themes are about 2.94. `onPrimary` on `primary` is 4.03 in Midnight Dusk and 4.09 in light Catppuccin.

## Design direction

- **Content first.** Covers, titles and reading progress carry the visual weight; chrome is quiet.
- **One accent per theme.** Use it only for primary actions, current selection and progress.
- **Text floor at 100% UI scale:**
  - 12px for meta
  - 14px for body and list titles
  - 16px and up for page titles
  - no uppercase and no letter-spacing on Korean
  - Small text uses `ink` or `ink-muted`, never `outline`.
- **Touch targets.** Frequently used controls are at least 44px when any pointer is coarse (`@media (any-pointer: coarse)`), and 36px otherwise.
- **Feedback.** Every tap gives a visible pressed state, a transition on state change, and a status message for async results.
- **Three tiers of information:**
  - **Primary:** always visible.
  - **Secondary:** one tap away, in an overflow menu, a detail sheet or an "Advanced" collapse.
  - **Diagnostic:** in the item's "Details" disclosure, or in Settings > Developer & diagnostics.
  - Operational states the user must act on stay primary: storage recovery progress and failure, permission problems and blocked sources (`src/components/runtime/StorageRecovery.tsx:63`).
  - There is no global "diagnostics mode" toggle.

## Decisions

**Decision record (user, 2026-11-03):** every decision below took the recommended option.

| ID | Outcome |
|---|---|
| D1 | Bundle Pretendard Variable as the UI font. Before the font lands, record the pinned version, license file, subset packaging and measured `dist/` size in this file. |
| D2 | Adopt `@tabler/icons-react`, using named imports through `src/components/ui/icons.ts`. |
| D3 | Five destinations: Library, Updates, History, Browse, More. The four tab-visibility switches are removed from the UI (D3b). Their persisted fields stay as ignored values for rehydration. |
| D4 | Merge into `/downloads?view=queue\|storage`. The `/tasks` route is removed with no alias, and every in-app reference moves to `/downloads?view=queue`. `norea://tasks` stays unchanged and opens the Queue view. |
| D5 | Unified chrome in both modes, and the global nav is hidden while reading. `fullPageReader` stays a user setting. Its default and existing persisted values are unchanged. |
| D6 | Own `ConfirmDialog` + `useConfirm()` on Mantine `Modal`. No new package. |
| D7 | Remove the serif display font from UI titles. Serif stays a reader font option only. |
| D8 | Option B. On coarse pointers, touch targets use `max(var(--norea-control-md), 44px)` and never shrink below 44px. This is a documented exception to `verify-scalable-ui-units`. Text still follows the user's UI scale. |

**D1 record (2026-11-03):** `pretendard@1.3.9` pinned (OFL-1.1, `node_modules/pretendard/dist/LICENSE.txt`), loaded from `dist/web/variable/pretendardvariable-dynamic-subset.css` (92 `unicode-range` woff2 subsets, 8-44 KB each, 2,957,724 bytes total, all served from local `dist/assets/`); `pnpm build` `dist/` grew from 6,090,715 to 9,096,594 bytes.

Options considered:

| ID | Decision | Recommendation | Trade-off / open question |
|---|---|---|---|
| D1 | UI font | Bundle Pretendard Variable (OFL-1.1, Latin + Hangul) as `--norea-font-ui`. Drop Inter and Source Serif 4 from the chrome. | Before approval, record the pinned version, the license file, the offline subset packaging, the measured `dist/` size and the first-paint reflow. The alternative, a system stack (Segoe UI/Malgun Gothic, Roboto/Noto Sans CJK), costs nothing but looks different on each platform. Reader fonts have a separate size budget. |
| D2 | Icon set | Adopt `@tabler/icons-react` (MIT), re-exported through named imports in `src/components/ui/icons.ts`. | New dependency. Named imports keep tree shaking. The alternative is to redraw 68 glyphs onto one grid. |
| D3 | Primary navigation | 5 destinations: Library, Updates, History, Browse, More. More holds Downloads, Settings and About. | Separate sub-decision D3b: whether the four tab-visibility switches (`src/store/appearance.ts:49-53`) are removed or kept to hide Updates/History. |
| D4 | Downloads hub | Merge `/tasks` and `/downloads` into `/downloads?view=queue\|storage`. | The durable `norea://tasks` protocol stays unchanged (`src-tauri/src/task_notifications.rs:276,283`). `src/lib/deep-link.ts:28` keeps parsing it and activation maps to `?view=queue`. This is a route-structure change, so CLAUDE.md requires asking first. |
| D5 | Reader chrome | Unify chrome behavior: center tap toggles one top bar plus a reader bottom bar in both modes, and the global nav is hidden while reading. Keep the `fullPageReader` setting. | Whether the default changes for users who never set it. Existing persisted preferences are not overwritten. Keyboard discoverability (a visible "Aa" button and a shortcut) ships first. |
| D6 | Confirm dialogs | Own `ConfirmDialog` and `useConfirm()` built on Mantine `Modal`, with no new package. | It must handle concurrent requests, unmount cancellation, a pending state while the confirmed action runs, and focus/back. |
| D7 | Display serif | Remove `--norea-font-display` from UI titles. Serif stays a reader font option only. | Consistent with D1. |
| D8 | Floors under reduced UI scale | Text and touch floors are defined at 100% UI scale, and below 100% the user's explicit choice wins for text. Touch targets: option A scales proportionally (pure `rem`). Option B uses `max(var(--norea-control-md), 44px)` on coarse pointers, a deliberate px exception to `verify-scalable-ui-units`. Recommend B. | At 75% scale, `2.75rem` becomes 33px. Decide whether touch targets may shrink below 44px. |

## Feature redesigns

On 2026-11-03 the user authorized redesigning existing features for fewer actions. The redesign set is the spec's §2: RD1-RD23, plus the core systems in §2.2 (download goals, VPN routes, freshness). The core systems supersede RD2, RD3, RD4, RD16 and RD19. Decisions G1-G4, V1-V5 and F1-F3 (spec §2.2.8) were decided on 2026-11-03: all recommendations were accepted, including the four reversals (G3, V1, V2, V4). When a System B slice ships, update the earlier VPN design documents to point at spec §2.2 instead of editing them. The defaults in spec §19 were decided on 2026-11-03: every proposal was accepted.

Each RD is its own slice (Phase 7). It ships after the page it touches has migrated to the new primitives (Phase 4), so behavior and visual changes stay in separate commits.

These items remain outside the RD set and are not scheduled:
- site browser back/forward/reload (needs a native API, because `src/lib/site-browser/types.ts:13` exposes none)
- a "Latest" mode on source pages (needs a plugin capability flag, `src/lib/plugins/types.ts:189`)
- tri-state/multi-source library filters (needs query changes, `src/db/queries/novel.ts:52`)

## Token layer

`src/theme/tokens.css` is imported once in `src/main.tsx` before `src/styles/app.css`. Static scales are plain `rem` CSS.

```css
:root {
  --norea-text-xs: 0.75rem;     /* 12px meta, badges, captions */
  --norea-text-sm: 0.8125rem;   /* 13px secondary text, row meta */
  --norea-text-md: 0.9375rem;   /* 15px body, list titles, inputs */
  --norea-text-lg: 1.0625rem;   /* 17px section titles */
  --norea-text-xl: 1.25rem;     /* 20px page titles (mobile) */
  --norea-text-2xl: 1.5rem;     /* 24px page titles (desktop), novel title */
  --norea-leading-tight: 1.25;
  --norea-leading-normal: 1.5;
  --norea-weight-regular: 400;
  --norea-weight-medium: 500;
  --norea-weight-bold: 650;

  --norea-space-1: 0.25rem;
  --norea-space-2: 0.5rem;
  --norea-space-3: 0.75rem;
  --norea-space-4: 1rem;
  --norea-space-5: 1.5rem;
  --norea-space-6: 2rem;
  --norea-space-7: 3rem;

  --norea-radius-sm: 0.375rem;
  --norea-radius-md: 0.625rem;
  --norea-radius-lg: 1rem;
  --norea-radius-full: 999rem;

  --norea-control-sm: 2.25rem;
  --norea-control-md: 2.75rem;
  --norea-icon-sm: 1.125rem;
  --norea-icon-md: 1.25rem;
  --norea-icon-lg: 1.5rem;

  --norea-duration-fast: 120ms;
  --norea-duration-base: 200ms;
  --norea-duration-slow: 320ms;
  --norea-ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --norea-ease-emphasized: cubic-bezier(0.3, 0, 0, 1.15);

  --norea-z-sticky: 10;
  --norea-z-nav: 200;
  --norea-z-overlay: 300;   /* must stay above Mantine portal defaults; verify against Mantine 9 z-index values */
  --norea-z-toast: 400;
  --norea-z-blocking: 1100;

  --norea-focus-width: 0.125rem;
  --norea-scrim: rgba(0, 0, 0, 0.42);
  --norea-disabled-opacity: 0.45;
}

@media (any-pointer: coarse) {
  /* D8: touch targets never shrink below 44px, even at reduced UI scale. */
  :root {
    --norea-control-sm: max(2.75rem, 44px);
    --norea-control-md: max(2.75rem, 44px);
  }
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --norea-duration-fast: 1ms;
    --norea-duration-base: 1ms;
    --norea-duration-slow: 1ms;
  }
}
```

Reduced motion must also reach JavaScript animation paths, such as paged scrolling in `src/components/reader/use-reader-scroll-layout.ts:203-240` and the seekbar fade. Read it through `window.matchMedia("(prefers-reduced-motion: reduce)")` in the existing reader hooks.

**Color roles are concrete values written from TypeScript.**
- `src/theme/palette-roles.ts` (new) takes an `Md3Palette` and returns concrete `rgb()`/hex strings. Mixing is done in TS, never with CSS `color-mix()`.
- Reasons for computing in TS:
  - Android `minSdk` is 24 (`src-tauri/gen/android/app/build.gradle.kts:101`).
  - Windows sets no WebView2 minimum.
  - Mantine's `toRgba` cannot parse `color-mix()` and turns unknown formats into black (`node_modules/@mantine/core/esm/core/MantineProvider/color-functions/to-rgba/to-rgba.mjs`).
- Migrating `src/styles/tasks.css:139-153`, which uses `color-mix` today, removes those uses.

| Role | Derivation | Replaces |
|---|---|---|
| `--norea-color-bg` | `background` | `--norea-design-bg` |
| `--norea-color-surface` | `surface` | `--norea-design-surface` |
| `--norea-color-surface-raised` | `surfaceVariant` | `--norea-design-panel` |
| `--norea-color-ink` | `onBackground` | `--norea-design-ink` |
| `--norea-color-ink-muted` | `onSurfaceVariant`, adjusted toward `ink` until ≥4.5:1 on bg, surface and raised | `--norea-design-ink-muted`, `--norea-design-ink-subtle` (for text), `--norea-on-surface-variant` |
| `--norea-color-rule` / `-rule-strong` | `outlineVariant` / `outline` (non-text, ≥3:1 for `rule-strong`) | `--norea-design-rule*` |
| `--norea-color-icon-subtle` | `outline` (icons ≥24px only, ≥3:1) | `--norea-design-ink-subtle` (for icons) |
| `--norea-color-accent` | `primary` | `--norea-design-accent` |
| `--norea-color-on-accent` | `onPrimary`, or whichever of white/black reaches ≥4.5:1 on `primary` when `onPrimary` fails or a custom accent is set (`src/theme/md3.ts:457`) | `--norea-design-on-accent` |
| `--norea-color-accent-soft` / `-on-accent-soft` | `primary` mixed into surface at 12% (dark: 18%) / `primary` adjusted to ≥4.5:1 on it | `--norea-design-accent-soft` |
| `--norea-color-danger`, `-warn`, `-ok`, `-info` (+ `-soft`, `-on-soft`) | `error` for danger. Fixed hues per scheme: warn amber 38°, ok green 140°, info blue 210°. Lightness solved per scheme to ≥4.5:1 as text on surface. | `--norea-design-error/warn/ok`, raw Mantine colors |
| `--norea-color-selected` | accent-soft with a 2px accent inset | today's shared hover/current/selected background (`src/styles/novel.css:454-458`) |
| `--norea-color-focus` | `primary`, or `ink` when `primary` is under 3:1 on bg | `--norea-focus-ring` |
| `--norea-shadow-floating` | existing per-scheme values (`src/main.tsx` shadow) | `--norea-design-shadow-floating` |

**State layers** do not use `color-mix`. Interactive primitives get `position: relative`, plus an `::after` with `background: currentColor; opacity: 0`. Hover sets the opacity to 0.08, but only inside `@media (hover: hover)`. Pressed sets it to 0.12 on `:active`. This replaces `--norea-design-hover-overlay`, which today is 65% white in light mode and invisible on white surfaces (`src/main.tsx:269`).

**Focus** uses a real outline, `outline: var(--norea-focus-width) solid var(--norea-color-focus); outline-offset: 2px`, instead of the shadow-only ring (`src/styles/app.css:148`). Under `@media (forced-colors: active)` it uses `outline-color: Highlight`.

**Mantine mapping** (`src/main.tsx`, using concrete colors from `palette-roles.ts`):
- `cssVariablesResolver`, for both schemes, maps every variable that Mantine 9.7.4's default resolver defines (`node_modules/@mantine/core/esm/core/MantineProvider/MantineCssVariables/default-css-variables-resolver.mjs`):
  - `body`, `text`, `dimmed`, `bright`, `placeholder`
  - `default`, `default-hover`, `default-color`, `default-border`
  - `error`, `success` (if present), `anchor`, `disabled`, `disabled-color`, `disabled-border`
  - the `primary-color-*` filled/light/outline variants
- `colors.dark` is a 10-step concrete ramp from `surface` toward `onSurface`.
- `colors.norea` is a 10-step concrete ramp, `primary` mixed toward white and black, with `primaryShade` set per scheme.
- `theme.radius`, `theme.spacing`, `theme.fontSizes` and `theme.lineHeights` reference the token values, so Mantine `size`/`radius` props resolve to tokens. `defaultRadius: "md"`.
- Coverage is enforced by a test, not a doc: `src/theme/mantine-theme.test.ts` asserts that each resolver key is present for both schemes, and that every generated color parses through Mantine's `toRgba` without falling back to black.
- The dead variables from root cause 3 are deleted after `src/styles/app.css:465` moves to `--norea-color-ink-muted`.

**Contrast gate:** `src/theme/palette-roles.test.ts` iterates all 9 themes x 2 schemes x {AMOLED off/on} and asserts:
- ≥4.5:1 for `ink` and `ink-muted` on bg, surface and raised
- ≥4.5:1 for `on-accent` on accent, and for `on-accent-soft` on accent-soft
- ≥4.5:1 for danger, warn, ok and info used as text on surface
- ≥3:1 for `rule-strong`, `icon-subtle` and focus

It also covers one light and one dark custom accent.

**Value mapping for the CSS migration:**

| Old font-size | Token |
|---|---|
| 0.53125-0.6875rem | `--norea-text-xs` |
| 0.71875-0.84375rem | `--norea-text-sm` |
| 0.875-1rem | `--norea-text-md` |
| 1.0625-1.25rem | `--norea-text-lg` |
| 1.35-1.55rem and clamped titles | `--norea-text-xl` / `--norea-text-2xl` |

| Old radius | Token |
|---|---|
| 0.125-0.3125rem, `--norea-border-radius` | `--norea-radius-sm` |
| 0.375-0.5rem, 6px, 8px | `--norea-radius-md` |
| 999px, 999rem | `--norea-radius-full` (50% stays for true circles) |

| Old gap/padding | Token |
|---|---|
| 0.125-0.3125rem | `--norea-space-1` |
| 0.35-0.55rem | `--norea-space-2` |
| 0.625-0.875rem | `--norea-space-3` |
| 1-1.125rem | `--norea-space-4` |

**Virtualized geometry.** Every virtualized list derives its row height from the computed root font size, not from a px constant. This covers:
- task rows (`src/routes/tasks.tsx:54,734` vs `src/styles/tasks.css:385`)
- novel chapter rows (`src/components/novel/NovelChapterList.tsx:56`, which already compensates at `:494`)
- reader chapter rows (`src/components/reader/ReaderChrome.tsx:10`)
- library rows

The slice that changes a row's typography or height updates its constant in the same commit.

**Guard test:** `src/theme/tokens.test.ts` reads `src/styles/*.css` with `node:fs`. It fails on literal `font-size`, `border-radius`, `transition-duration` and `z-index` values, on `text-transform: uppercase`, on `color-mix(`, and on the meta font outside a tabular-number allowlist. Allowlisted exceptions are `1px` hairlines and safe-area bridges. It starts in report mode, with a list of files not yet migrated, and becomes strict at the end of Phase 2.

## Shared primitives

Each primitive lands in the same commit as its first real consumer.

| Primitive | First consumer | Replaces |
|---|---|---|
| `icons.ts` (named re-exports) | Shell nav (Phase 3) | `ActionGlyphs.tsx`, `NavIcon` (`src/routes/__root.tsx:230-303`), the inline `*Icon` functions in 12 files |
| `ActionIcon` | Reader top bar | `IconButton.tsx`, the 8 `norea-*-icon-button` classes. It shows one Mantine `Tooltip` on fine pointers and drops the native `title` (today both render, `IconButton.tsx:38-46`). |
| `Button` | Novel primary action | `TextButton.tsx` (meta font, weight 800, `src/styles/app.css:594-607`), raw `<button>` actions |
| `Chip` / `FilterChip` (tri-state) | Library filter sheet | console, source, search, genre and summary chips. The tri-state chip replaces the three-segment option control (`src/components/PluginFilters.tsx:187-201`). |
| `StatusBadge` | Library cards | Mantine `Badge` with color names, `ConsoleChip` status |
| `ListRow` | History | ad-hoc rows. The whole row is the primary button; actions are siblings; there are distinct hover, current and selected styles. |
| `OverflowMenu` | Novel header | hand-rolled popover menus (`NovelActions.tsx:101-122`, `tasks.tsx:281-344`) |
| `ResponsiveSheet` | Reader "Aa" sheet | settings popovers, filter drawers, the reader settings sheet. It is a bottom Drawer below 768px and a Popover or Modal above. It has a sticky footer slot and owns focus trap, initial and return focus, Escape and Android back while open. Swipe-to-dismiss is excluded for now. |
| `ConfirmDialog` + `useConfirm` (D6) | Browse uninstall | `window.confirm` (`src/routes/settings.tsx:574,1524,1869,1926,1993`), unconfirmed destructive actions, the RSS modal. The danger variant states the scope and stays visible while the action is pending. |
| `SelectionBar` | Library selection | the library and novel selection strips, and the unused `LibrarySelectionToolbar.tsx` |
| `EmptyState` / `ErrorState` | Library | `StateView` and colored `Alert` states. `ErrorState` shows friendly copy, a primary action and a collapsed "Details" with the raw message. |
| `Skeleton` presets | Library grid | page-level `Loader`s and non-blocking uses of `BlockingLoadingOverlay` |
| `Spinner` | Downloads storage | the three spin keyframes |
| `DetailsDisclosure` | Novel chapter rows | always-visible diagnostic lines |
| `SettingsAdvancedGroup`, `SettingsSlider`, danger row | Settings rebuild | additions to `src/components/SettingsPrimitives.tsx` |

**Deletions once all callers are migrated:**
- `ConsolePrimitives.tsx`. Keep the cover component, renamed `NovelCover`.
- `NovelCard.tsx` (unused today)
- `LibrarySelectionToolbar.tsx` (unused today)
- `SegmentedToggle.tsx`
- `IconButton.tsx`
- `TextButton.tsx`
- `ActionGlyphs.tsx`
- the matching CSS

## Information architecture

**Navigation (D3).**
- Five destinations: Library, Updates, History, Browse, More.
- Rail:
  - 56px wide, or 184px with labels at 1200px and up.
  - Fix the `"1201px"` key (`src/routes/__root.tsx:550`).
  - Make the brand link non-interactive, since today it duplicates Library.
  - Render `.norea-rail-badge`: the Updates unread count and the More active-download count.
- Mobile nav: 12px labels and an active pill indicator, not color alone (`src/styles/app.css:391`).
- The nested `<main>` is removed (`src/components/AppFrame.tsx:84`).

**Downloads hub (D4):** `/downloads?view=queue|storage`.
- **Queue:**
  - Running, queued and failed items, with "Retry all failed" and a confirmed "Cancel all".
  - The VPN section renders only when VPN downloads are supported and configured, or a run, draft or plan exists. Today it renders for every user whenever the page is visible (`src/routes/tasks.tsx:1313`).
  - Lane, priority and VPN IP/protocol go into row details.
- **Storage:**
  - The cache list without the developer description.
  - Chapter cleanup opens the existing `ChapterCleanupPanel` workflow unchanged: preview, server predicates, category conditions and the two-step confirmation (`src/components/ChapterCleanupPanel.tsx:54,139-152`). It is not reduced to "delete read chapters".
  - Keep the `server-contains-local` default. Mode `any` bypasses server inventory checks (`src/lib/chapter-cleanup.ts:29`), and execution deletes real payloads (`src/lib/tasks/chapter-cleanup.ts:91`).
  - For users without a content server, the preview explains that nothing qualifies because no server copy is verified. Deleting without a verified server copy stays an explicit opt-in that states the consequence, behind the existing two-step confirmation.

**Settings sections** (rebuilt from `src/routes/settings.tsx:2042`):
1. **Appearance:** theme mode, app theme (swatches), AMOLED, UI scale as a % slider (`:1032`), Android view size, accent color under Advanced.
2. **General:** language, task notifications. Pause reading history moves to More and the reader overflow (spec S3).
3. **Reader:** global defaults only, without the scope card or the duplicate headings. A Basic tab plus an Advanced collapse that includes custom JS.
4. **Library:** default category to open, sort, chapter sort, and update-check settings (RD2). Display settings live only in Library's View options.
5. **Downloads & storage:** storage folder, chapter cleanup, concurrency and cooldown under Advanced.
6. **Backup & sync:** local backup, content server, device backup. Lookup timeout and conflict policy under Advanced.
7. **Network:** plugin VPN.
8. **Data & reset:** a danger zone using `useConfirm`. It covers:
   - clear library
   - clear reading progress
   - mark all updates read
   - reset appearance (keeps language)
   - reset reader, with a "keep per-novel and per-source settings" option that is on by default
9. **About:** one version line, check for updates, one releases link.
10. **Developer & diagnostics** (last, collapsed):
    - log level, dev update channel, build metadata
    - User-Agent, WebView cache, source request timeout

VPN verdict control, profile limit and issue records live in Network > Advanced (spec §13.1).

Local plugin file install and the multi-source GitHub form move to the Extensions overflow menu (spec §8.4), not to Settings.

Mobile uses a category list, then a detail screen with back, replacing the 50%-width header Select (`src/styles/settings.css:675-707`). Switches stay inline at every width.

## Phase 0 - Independent fixes with existing components

Each item is one `fix(...)` commit with a regression test, using existing components (`StateView` already accepts `action`, `src/components/AppFrame.tsx:173`; `usePageBackNavigation`; Mantine `Modal`).

- [x] **0.1 Device name typing.**
  - Problem: `setDeviceName` trims on every keystroke (`src/store/content-sync.ts:39`). So a trailing space is removed as it is typed, and a space between words cannot be entered from the keyboard. Clearing the field shows the default name again (`src/components/ContentServerSettings.tsx:82-83`).
  - Fix: keep a local draft and trim on save or blur.
  - Test: typing "My Phone" character by character keeps the space.
- [x] **0.2 Settings section re-entry.**
  - Problem: after a local selection (`src/routes/settings.tsx:2115-2117`), navigating again with the same `section` value does not switch back, because the effect at `:1826-1828` only reacts to changes, and the page stays mounted (`src/routes/__root.tsx:641`).
  - Fix: write `section` to the route on select.
  - Test: open `?section=reader`, select Library, then trigger "open settings" from the reader. Reader shows.
- [x] **0.3 Phone reachability.**
  - Problem: `.norea-library-icon-button { display: none }` below 768px (`src/styles/library.css:1281-1283`) hides "Open local files" and Library settings (`src/routes/library.tsx:424,452`).
  - Fix: show both on phones until 4.2 replaces the header.
- [x] **0.4 Reader stuck on failed download or offline.**
  - Problem: the failure is swallowed (`src/components/reader/use-reader-chapter-navigation.ts:191-192`), and `readerBusy` stays true (`src/routes/reader.tsx:177-181`).
  - Fix: record the terminal failure and render `StateView` with a Retry `action` instead of the blocking overlay.
  - Test: a rejected download yields Retry and `readerBusy === false`.
- [x] **0.5 Reader settings sheet opens locked.**
  - Problem: the sheet targets `kind: "novel"` (`src/components/reader/ReaderChrome.tsx:185-194`), and disabled novel overrides lock the panel (`src/components/ReaderSettingsPanel.tsx:215`).
  - Fix: edit the effective scope directly. Show an inline "This novel / All novels" switch. Turning on "This novel" copies the effective values, so source inheritance is preserved.
  - Test: on first open, changing text size changes the rendered size.
- [x] **0.6 Reset scope.**
  - Problem 1: the global reader Reset clears every per-novel and per-source override (`src/store/reader.ts:1299-1307`, triggered at `ReaderSettingsPanel.tsx:840`) with no confirmation.
  - Problem 2: "Appearance defaults" also resets the language (`src/store/appearance.ts:124`).
  - Fix: confirm through a Mantine `Modal` that states the scope, and keep overrides by default. Exclude `appLocale` from the appearance reset.
- [x] **0.7 History search clear.**
  - Problem: the clear button empties the input only (`src/components/SearchBar.tsx:53`), while the applied query changes only on submit (`src/routes/history.tsx:865`).
  - Fix: clearing also clears the applied query.
- [x] **0.8 Android back precedence.**
  - Problems:
    - the novel category drawer is shadowed by the page handler (`NovelCategoryEditor.tsx:65` vs `novel.tsx:320-337`)
    - the novel reader-settings drawer (`novel.tsx:699`) and the local metadata modal (`use-local-novel-editor.tsx:227`) have no handler
    - the library import modal (`LibraryLocalImport.tsx:247`), the category dialogs (`LibraryCategoryDialogs.tsx:103,153`) and library selection have no handler
  - Fix: overlays register their handler only while open, so they are on top of the stack (`src/lib/android-back-navigation.ts:34-37`, last registered first). Page handlers must return false while a child overlay is open.
  - Test: one test per overlay asserts that Back closes the overlay and does not leave the page.
- [x] **0.9 Novel sync errors.**
  - Problem: the `useServerNovelSync` result is ignored (`src/routes/novel.tsx:124`), though the hook keeps its error (`use-server-novel-sync.ts:14`).
  - Fix: a non-blocking notice with Retry, **only for actionable source-refresh failures**. Automatic content-server lookup failures stay off normal pages, as `docs/content-sync.md` requires and commit `11a38a4` decided. Offline and verification failures are left to the task queue and its notifications.

- [x] **0.10 Per-row pending state.**
  - Problem: install and uninstall share one pending boolean across rows (`src/routes/browse.tsx:752,777,1446,1583,1694`).
  - Fix: key it by operation and plugin id.
- [x] **0.11 Wrong targets.**
  - Continue reading: today it is disabled without history and reopens the last chapter (`src/components/novel/NovelWorkspace.tsx:402,404`).
    - Fix: if the last-read chapter is unfinished, resume it. If it is finished, open the next chapter. With no history, open the first unread chapter.
  - Global search per-row Retry retries every failed source (`src/routes/global-search.tsx:1108,1237`).
    - Fix: add a source-scoped retry.
- [x] **0.12 Misleading UI.**
  - Remove the Ctrl K hint (`LibraryFilters.tsx:202`), the arrow-key footer (`LibraryCategories.tsx:126`, `library.footer.shortcuts`), and "or jump" in `library.search.placeholder`. No handlers exist for any of them.
  - Show the novel name in place of `reader.novelMeta` "Novel {id}" (`ReaderChrome.tsx:48`).
  - Make the Tasks header and pill counts use the same filtered set as the list (`tasks.tsx:1103,1132,1229`).
- [x] **0.13 Actionable notifications.**
  - Problem: source-verification and VPN-action toasts auto-close after 5s (`src/components/TaskNotifications.tsx:175,248`).
  - Fix: actionable interruptions persist until resolved or dismissed. Informational notices keep auto-close. The action button uses a normal size, not `compact-xs`.
- [x] **0.14 Task row geometry.**
  - Problem: `TASK_ROW_HEIGHT = 64` (`src/routes/tasks.tsx:54,734`) does not match `4rem` (`src/styles/tasks.css:385`) when the UI scale is not 100%.
  - Fix: derive the height from the root font size, as `NovelChapterList.tsx:494` does.

Verify with the focused Vitest files, plus `pnpm tsc` when requested.

## Phase 1 - Decisions and contracts

- [x] **1.1** Record decisions D1-D8 in this file (see "Decision record"). Behavior additions are still unapproved and stay out of the main line.
- [ ] **1.2** Define the overlay contract as a test, `src/components/ui/overlay-contract.test.tsx`, written when `ResponsiveSheet` lands (Phase 3), not as a separate doc. The contract covers initial focus, focus return, Escape on nested overlays, Android back precedence and pending dismissal.
- [ ] **1.3** Record the reader gesture contract as tests in `use-reader-gestures` before 4.1 changes behavior. It covers:
  - tap vs text selection
  - links
  - media interception (`ReaderContent.tsx:418`)
  - swipe
  - chrome dismissal
  - keyboard guards for modifiers and active selection (`use-reader-keyboard.ts:28`)

## Phase 2 - Tokens, palette and Mantine mapping (visual only)

- [ ] **2.1 Fonts (D1, D7).**
  - Add the font files and `src/theme/fonts.css`.
  - Set `--norea-font-ui`. Remove Inter and Source Serif 4 from the chrome (`src/main.tsx:190`, `src/styles/app.css:57-59`).
  - Numbers use `font-variant-numeric: tabular-nums` in the UI font, and the monospace meta font goes away.
  - Measure `dist/` before and after.
- [ ] **2.2 Tokens.** Add `src/theme/tokens.css` and import it. Keep the `--norea-design-*` names as aliases until the end of Phase 4.
- [ ] **2.3 Palette roles.** Add `src/theme/palette-roles.ts` plus the contrast gate test. Write the roles from `src/main.tsx`.
- [ ] **2.4 Mantine mapping.**
  - Add `cssVariablesResolver`, concrete `colors.dark` and `colors.norea` ramps, and the token-backed `radius`, `spacing` and `fontSizes`.
  - Add `src/theme/mantine-theme.test.ts`.
  - Delete the dead variables.
  - Check: a Modal, Select, Popover, Drawer and Notification in Lavender dark and Midnight Dusk dark all use `--norea-color-surface`.
- [ ] **2.5 Semantic colors.**
  - Do not pass `var(--norea-color-*)` to Mantine `color` props. Mantine turns `var()` colors into `color-mix()` (`node_modules/@mantine/core/esm/core/MantineProvider/color-functions/rgba/rgba.mjs:5`, `darken/darken.mjs:4`), and filled variants default to white text (`default-variant-colors-resolver/default-variant-colors-resolver.mjs:23`).
  - Instead, register `danger`, `warn`, `ok` and `info` as concrete 10-step theme colors from `palette-roles.ts`, next to `norea`. Add a `variantColorResolver` that returns concrete background, hover, text and border for the `filled`, `light`, `outline`, `subtle` and `default` variants. Each foreground is solved for ≥4.5:1.
  - Then replace the 92 raw color props with those theme color names.
  - `src/theme/mantine-theme.test.ts` asserts contrast for each variant and its hover state, for every theme and scheme, plus the selected state of `SegmentedControl`, `Tabs` and `Chip`.
  - Portal stacking: set `zIndex` defaults for `Modal`, `Drawer`, `Popover`, `Menu`, `Tooltip` and `Notifications` from the layer tokens, so app-level fixed elements (mobile nav, reader chrome, blocking overlay) and Mantine portals have one defined order.
  - Replace the hover overlay with state layers.
  - Derive the cover fallback from the accent hue instead of random HSL stripes (`ConsolePrimitives.tsx:177-190`).
  - Replace the Mantine light shades in the tap-zone previews (`ReaderSettingsPanel.tsx:1191-1214`).
- [ ] **2.6 Mechanical CSS migration.**
  - Work one file per commit, applying the mapping tables.
  - Remove uppercase and kicker letter-spacing. Replace the meta font with tabular numerals. Remove `color-mix`.
  - Reconcile the virtualized row constants in the same commit.
  - Diff review checks that only values changed. Compare screenshots at 75%, 100% and 150% scale.
- [ ] **2.7 Touch floor and focus.**
  - Inside `@media (any-pointer: coarse)`, interactive selectors reach `--norea-control-md`.
  - Replace `-webkit-tap-highlight-color: transparent` with state layers.
  - Switch focus to outlines, with forced-colors support.
- [ ] **2.8 Guard test** becomes strict.

**Exit criteria:**
- No text under 12px at 100% scale.
- No raw Mantine color names.
- The contrast gate passes for all schemes.
- Mantine overlays match the theme in every dark scheme.
- Screenshots of every page are in `.tmp/ui-ux-overhaul/phase2/`.

## Phase 3 - Shell, navigation and first primitives

- [ ] **3.1 Icons (D2).** `src/components/ui/icons.ts`, first consumed by the nav.
  - Then migrate per page in Phase 4, fixing semantic collisions in the same slice. Collisions today:
    - select-all and mark-read share one path (`ActionGlyphs.tsx:8`, `NovelChapterList.tsx:695`)
    - `DownloadedGlyph` is both a filter and a delete
    - `RefreshGlyph` means refresh, clear cookies and clear selection
    - `DetailsGlyph` means both "open source" and "edit metadata"
- [ ] **3.2 Five-item navigation (D3).**
  - `NAV_ITEMS` (`__root.tsx:96-138`), the More page, rail badges, the active pill, the 1200px key, and no nested `<main>`.
  - Remove the four tab-visibility switches from Settings (`settings.tsx:1108-1146`) and drop `visibleWhen` filtering.
  - Keep the persisted `show*Tab` fields in `src/store/appearance.ts` as ignored values, so existing stores rehydrate.
- [ ] **3.3 Downloads hub (D4).**
  - Router entry with a validated `view` search param.
  - Persistent-page bookkeeping (`__root.tsx:61,641`).
  - `TaskNotificationRoute` mapping (`src/lib/tasks/task-notification-model.ts:19,322,398`, `src/components/TaskNotifications.tsx:42`).
  - `norea://tasks` activation to `?view=queue` (`src/lib/deep-link.ts:28`), tested for cold and warm activation and for back history.
  - The Rust protocol is unchanged.
  - Remove the `/tasks` route (`src/router.tsx:90`) with no alias, per D4. Update every in-app `to: "/tasks"`, including `__root.tsx:90-91,126,161` and the notification model.
- [ ] **3.4 `ResponsiveSheet` and `ConfirmDialog`/`useConfirm`.** These land with their first consumers, plus the overlay-contract test.
  - Then replace every `window.confirm`, and add confirmation to:
    - plugin uninstall (`browse.tsx:751`)
    - repository remove (`browse.tsx:729`)
    - cancel all/source/work (`tasks.tsx:658,1006,1259`)
    - VPN run cancel (`VpnDownloadPanel.tsx:73`)
    - VPN work and range cancel (`VpnDownloadRanges.tsx:90,155`)
- [ ] **3.5 Page transitions.** `PageSlot` (`src/styles/app.css:302-309`) cross-fades over `--norea-duration-base`.
- [ ] **3.6 Startup copy.**
  - Merge the two sequential splash cards (`PluginVpnProxyGate.tsx:104-133`, `ChapterMediaStorageGate.tsx:75-83`) into one neutral splash.
  - Rewrite `storageSetup.*` and `pluginVpn.bootstrap.*` without implementation terms, and fix the `storageSetup.useAppStorage` key/label mismatch.
  - Gating behavior (whether local reading proceeds while the plugin proxy is pending) is a separate decision tied to the plugin fetch invariant. It is not changed here.

## Phase 4 - Page slices

**Source of truth for page structure and redesigns:** `docs/superpowers/specs/2026-11-03-ui-ux-page-structure-design.md`. It holds each page's function inventory and new location for every function, the phone/desktop layouts, the task flows, and structural decisions S1-S10. Where a 4.x item below and the spec disagree, the spec wins. The 4.x items keep the code-level defects and references.

Order follows usage. Each slice:
1. migrates to primitives
2. moves information to its tier
3. deletes the page's ad-hoc classes and SVGs
4. replaces class-name assertions it touches with role or behavior assertions
5. stores before/after screenshots

Visual commits come before behavior commits within a slice.

### 4.1 Reader

**Files:** `src/routes/reader.tsx`, `src/components/reader/*`, `ReaderContent.tsx`, `ReaderSeekbars.tsx`, `ReaderSettingsPanel.tsx`, `PdfReaderContent.tsx`, `src/styles/reader.css`.

- **Chrome (D5).**
  - Center tap toggles the chrome in both modes. Any tap dismisses visible chrome instead of paging (`use-reader-chrome.ts:156-172`, `use-reader-gestures.ts:48-72`).
  - Top bar: back, novel name over chapter name, bookmark, "Aa". 44px on coarse pointers.
  - Bottom bar: previous chapter, seekbar with page label, next chapter, chapter list.
  - Hide the global mobile nav while reading, which removes the seekbar overlap (`app.css:364-373`, `use-reader-chrome.ts:197-198`).
  - Remove the 24px strip with its about-18px links (`reader.css:487-504`), and the double-counted bottom offsets (`reader.tsx:263-264`, `reader.css:586,769`).
- **Information.**
  - One progress readout plus the seekbar. Today progress is shown four times, and two of them come from a 350ms-debounced value (`use-reader-progress.ts:17`).
  - Remove the "Offline" status (`ReaderChrome.tsx:44-46`).
  - Show the incognito indicator on phones (`reader.css:860-862`).
- **Settings.**
  - The "Aa" `ResponsiveSheet` holds:
    - text size stepper
    - line height
    - margins
    - theme swatches
    - font
    - scroll/paged mode
    - the 0.5 scope switch
  - "More settings" expands the full panel inside the sheet instead of navigating away (`use-reader-chrome.ts:185`).
  - Hide inapplicable settings: PDF fit on HTML, page transition in scroll mode (`ReaderSettingsPanel.tsx:637-689`). Remove the duplicate headings (`:599,722,852,910,970`).
  - Name the tap presets. Remove `bottom-forward`, which is identical to `balanced` (`src/store/reader.ts:466-477,508-519`), and normalize it in all scopes without touching customized zone maps.
- **States.**
  - A single loading indicator, removing the inline plus blocking pair (`reader.tsx:314-322,476-482`).
  - `StateView`/`ErrorState` with Retry for load, not-found and PDF errors (`PdfReaderContent.tsx:1550-1558`).
  - Rewrite `reader.chapterNotFoundMessage` without "local DB".
- **Desktop.**
  - Line length is capped at `40rem` by default (`use-reader-content-style.ts:110-113`).
  - The chapter panel scrolls to the current chapter (`ReaderChrome.tsx:262`).
  - Below 1200px, a chapter list opens in a sheet.
  - The status overlay stays inside the content column (`ReaderStatusOverlay.tsx:87-100`).
- **Text interaction** (gesture contract from 1.3): remove `pointer-events: none` from `.reader-content` (`reader.css:288`), so selection, copy and links work, and tell taps apart from selections.
- **Keyboard and focus:**
  - Escape closes the topmost overlay, then hides the chrome, and only then exits.
  - Add next/previous chapter keys.
  - The settings sheet traps focus while open (`ReaderChrome.tsx:210`).
  - Chrome and seekbar auto-hide is suspended while keyboard focus is inside either region or a seekbar drag is active. Today the hide timer runs regardless (`use-reader-chrome.ts:50-55`).
  - Test: focusing a chrome button and waiting past the timeout keeps the chrome and focus.
- **Theme.** The reader chrome follows the reader theme colors.
- **PDF.**
  - Pages get meaningful labels.
  - Retry is available.
  - Allow pinch zoom or provide zoom controls; `touch-action: pan-x pan-y` blocks pinch today (`reader.css:358`).
  - Progress is preserved across retries.
  - The lack of a text layer is documented as a limitation, not hidden (`PdfReaderContent.tsx:470`).
- **Fonts** (D1 budget): bundle the listed reader fonts, or trim the list. Add one Korean serif and one Korean sans (`src/store/reader.ts:278-289`).

### 4.2 Library

**Files:** `src/routes/library.tsx`, `src/components/library/*`, `LibraryGrid.tsx`, `CategoriesDrawer.tsx`, `LibrarySettingsPanel.tsx`, `src/styles/library.css`.

- **Header.** Search, Filter with an active count, Sort and Overflow. The overflow holds Import, New local novel, Refresh, Display and Library settings. This replaces the filter toggles, view toggles, mobile view picker, icon buttons and the 390px settings popover.
- **Filters.**
  - One filter sheet: Unread, Downloaded, Local, Completed, Needs repair, Source.
  - Delete the four duplicate filter UIs (`LibraryFilters.tsx:130-171`, `LibraryCategories.tsx:290-320`, `library.tsx:475-494`, `CategoriesDrawer.tsx:123`).
  - Filters persist across restarts (`src/store/library.ts:149-153`), so "N filters active · Clear" stays visible whenever any are active.
- **Sort.** Field plus direction, with one label set. Today there are 16 flat options under two label sets.
- **Categories.**
  - Phones: horizontal category tabs.
  - Tablet and desktop: one shared `CategoryList` in the side panel and the drawer.
  - Remove the dead mobile category button (`library.tsx:385-390`) and the "Manage categories" duplicate.
  - The category dialogs block dismissal while a mutation is pending, announce errors and restore focus (`LibraryCategoryDialogs.tsx:103,153`).
- **Cards.**
  - The cover fills the width at 2:3 in every mode, with `max-width: 100%`.
  - Novels-per-row applies on phones, with a minimum card width of `6.5rem` so 150% scale cannot overflow (`library.css:1381-1384`).
  - Show the title, a one-line author, an unread badge on the cover and a slim progress bar.
  - Remove the status dot. Its "Synced" label is misleading (`LibraryGrid.tsx:300-326`).
  - Use consistent mode names.
- **List mode.** `ListRow` replaces the 8-column table (`library.css:909`).
- **Selection.**
  - `SelectionBar` replaces the header. The "0 selected" strip is removed (`library.tsx:496-500`).
  - Show checkbox overlays.
  - Show success messages for batch download and category assignment.
- **Import.**
  - After a multi-file import, the modal shows a result with a Done button instead of a lone Cancel (`LibraryLocalImport.tsx:287-294`).
  - Closing is blocked during analysis as well as import (`:160`).
  - Batch identity:
    - Today a new incoming request resets the mutation and replaces the review items even while a batch is importing (`LibraryLocalImport.tsx:173-181,193-205`).
    - New requests (file intents, picker) wait in a queue until the user acknowledges the current batch result.
    - Analysis and completion callbacks are bound to a batch id, so a late result for an older batch is ignored.
    - Test: a second request during an active import does not replace the first batch's items or its result.
  - Partial success and duplicates are reported per file.
- **Diagnostics.**
  - Remove the status strip; its refresh result becomes a message (`library.tsx:668-679`).
  - Show storage recovery as a compact banner, keeping its progress, retry and dismiss.
  - Raw database errors become `ErrorState`.
- **States.**
  - Grid skeleton while loading.
  - The empty state offers Import and Browse sources.
  - The no-match state offers Clear filters.

### 4.3 Novel detail

**Files:** `src/routes/novel.tsx`, `src/components/novel/*`, `LocalCoverPicker.tsx`, `src/styles/novel.css`.

- **Primary action.** A labeled "Continue · Ch. N" or "Start reading" button (fix 0.11). "Read from start" moves to the overflow.
- **Header actions.** Library (labeled) and Download (menu) stay visible. An `OverflowMenu` holds Refresh (merged modes), Reader settings, Open source, Migrate source, Edit categories and Manage server data.
- **Hero.**
  - Phones show the cover first.
  - The summary is clamped to 3 lines with "More".
  - Category chips sit beside the library button, replacing the always-on panel (`NovelCategoryEditor.tsx:72-93`).
  - Titles are clamped with an ellipsis (`novel.css:140-148`).
  - Localize the plugin status chip.
  - Remove the duplicate "local" chip.
- **Chapter header.**
  - Shows "N chapters · M downloaded · K unread".
  - Rename "cached".
  - Drop the "Chapter index" kicker (`novel.tsx:451-469`).
  - "Manage server data" moves to the overflow.
- **Chapter rows.**
  - Delete the dead `--inline` flags (`NovelChapterList.tsx:354-374`, `novel.css:631-633`).
  - Drop the Read and Downloaded flags.
  - Server status, duplicate source and download phase move into `DetailsDisclosure`.
  - Show the download failure inline as accessible text (`:152,389,665`).
  - Distinct selected, current and hover styles.
- **Selection.** A bottom `SelectionBar` on phones with labeled 44px actions, plus a visible "Select" entry.
- **Destructive actions.**
  - Chapter download delete removes real files (`src/lib/tasks/download-cache-delete.ts:227`), so it keeps a confirmation, made lighter: a single-line `ConfirmDialog` instead of the full deletion dialog.
  - Un-shelving without deletion uses a short `ConfirmDialog`, kept distinct from the optional device or server deletion (`ContentDeletionDialog.tsx:86`).
  - The deletion dialog hides the server URL and replaces the disabled-checked checkbox with plain text.
- **Metadata editor and cover picker.**
  - Full-screen on phones; stop the paired `Group grow` fields squeezing.
  - The cover conversion has a pending state, ignores stale results from earlier selections, and announces errors (`LocalCoverPicker.tsx:33,87`).
- **Layout.** One scroll container on mobile (`novel.css:822-844`), and the action row wraps.
- **States.** Hero and row skeletons, and the empty-chapters state offers Refresh (`novel.tsx:648-666`).

### 4.4 Updates and History

**Files:** `src/routes/updates.tsx`, `src/routes/history.tsx`, `src/styles/updates.css`, `src/styles/app.css:1000-1545`.

- **Updates.**
  - Group rows by date.
  - One open target per row, plus Download. Today there are three open targets and two detail targets (`updates.tsx:357-453`).
  - Remove the always-true Unread flag and the status dot.
  - Show the source name as text.
  - Show inline progress: "Checking 3/12 sources".
  - Failures collapse into an "N sources failed" chip, with the raw reasons in details.
  - The "Caught up" state becomes an `EmptyState`.
- **History.**
  - A row tap continues reading. Today it opens details (`history.tsx:407`). This is a navigation behavior change, so it gets its own commit.
  - Progress and time stay visible on phones as one meta line (`app.css:1444-1446,1512-1514`).
  - Remove the summary panel.
  - The Resume card either follows the filters or goes away.
  - Removing a novel from history clears read timestamps (`src/db/queries/chapter.ts:840-853`) and cannot be undone without storing the originals, so it keeps a confirmation.
  - "Clear all" is offered in the overflow, with confirmation.
  - Translate `history.chapterPrefix` in ko.

### 4.5 Browse, Source, Global search

**Files:** `src/routes/browse.tsx`, `source.tsx`, `global-search.tsx`, `ContentServerBrowse.tsx`, `SiteBrowserOverlay.tsx`, `PluginFilters.tsx`, `src/styles/browse.css`.

**Tabs:** Sources (launch), Search, Extensions (manage), and Content server, which is shown only when configured (`browse.tsx:678`).

**Sources**
- Tap-to-open rows showing the plugin icon (`PluginItem.iconUrl`, never rendered today; `src/lib/plugins/types.ts:197`), name and language. Pinned sources come first.
- A per-row overflow holds Settings, Open site, Clear cookies and Uninstall.
- Base URLs move out of the rows. Today a mistap opens the site browser (`browse.tsx:1372-1389`).

**Extensions**
- Layout: a text filter, then Installed, then Available. The "Updates (N)" section with Update all arrives with RD7 (Phase 7).
- Remove:
  - the per-row "Repository: url" (`browse.tsx:1684-1686`)
  - the duplicate tab badge
  - the deep-link text in `browse.repository.emptyMessage`
- Fix the empty state when the language filter hides every plugin (`browse.tsx:1497-1502`).
- Local plugin install and the multi-source form move to the Extensions overflow menu (spec §8.4).
- The plugin settings modal gets Cancel and dirty-state handling (`PluginSettingsEditor.tsx:194-210`).

**Global search**
- The search field comes first at every width.
- Scope becomes a chip row (All / Pinned / Selected) with an "Edit" sheet, replacing the stacked scope panel (`global-search.tsx:188-379`).
- Remove "Before fan-out", ActiveScopeRow, the "eligible" count and the summary duplicates (`:387-414,494-526,1157-1174`).
- Errors show friendly text with details.
- Rows needing a challenge open the source-access verification flow (`:611-618`). Retrying only that source after confirmed access arrives with RD13 (Phase 7).
- Tighten the Cloudflare regex so plain "403"/"forbidden" are not misclassified (`:73-75`).

**Source page**
- The source name stays visible on phones (`app.css:1381-1384`).
- Remove the "Source state" panel and the bottom status strip (`source.tsx:695-742,842-860`).
- Remove the novel paths on cards (`:215-217`) and the duplicate badges.
- Reader settings move into the overflow.
- "Load more" gets a text label.
- Grid skeletons replace the page-1 full-screen overlay. Cancel no longer navigates Back (`:559-578`).
- Errors get Retry and Open site.
- The filter sheet has a sticky Apply/Reset footer and tri-state `FilterChip`s.
- Either offer a Latest mode or rename "General filters" (`:379`).

**Content server**
- Source names replace `id (count)`, falling back to the id (`ContentServerBrowse.tsx:76`).
- "Delete from server" moves from the grid cards to the work detail overflow (`:99-101`).
- The not-configured state links to Settings.

**Site browser**
- Tokens replace the inline styles and Mantine variables (`SiteBrowserOverlay.tsx:553-683`).
- The title shows the page host.
- The challenge footer offers "Verify and resume" and "Keep paused". The X button means "Keep paused". "Force stop and continue" gets a clearer name.
- Back, forward and reload need a native API, so they are listed under behavior additions.

### 4.6 Settings

**Files:** `src/routes/settings.tsx`, `SettingsPrimitives.tsx`, `src/styles/settings.css`, and the new `src/components/settings/*`.

- Split `settings.tsx` (2,136 lines) into one component per section, and apply the section map and the mobile list-then-detail layout.
- Remove the following:
  - "Tauri 2" (`:1748`)
  - the hidden breadcrumb (`:1770`, `settings.css:140`)
  - unused `.norea-settings-switch-list` (`settings.css:345`)
  - the scope card on the settings page (`ReaderSettingsPanel.tsx:520`)
  - the duplicate release button and link (`:1688-1703`)
- Give the Data section the same row layout as the rest (`settings.css:367-480`).
- Settings that act only after a restart (User-Agent) get a restart prompt.
- Add theme swatches (`:975`), auto-scroll units (`ReaderSettingsPanel.tsx:486-511`), and locale-formatted device-backup dates (`ReadingStateSettings.tsx:85`).
- Rewrite descriptions over 120 characters and remove the implementation wording:
  - "contents/"
  - "final chapter content is always trusted"
  - "root font size in px"
  - "release workflow stamps this build"
- Errors and status use one pattern: inline `ErrorState`/status text in the row, plus notifications for async results. This replaces the borrowed `norea-storage-setup-error` class (`settings.tsx:718,732`).

### 4.7 Downloads hub

**Files:** `src/routes/tasks.tsx`, `src/routes/downloads.tsx`, `VpnDownload*.tsx`, `PluginVpnFinder.tsx`, `VpnGateServerVerdictControl.tsx`, `TaskNotifications.tsx`, `src/styles/tasks.css`, `downloads.css`, `plugin-vpn-finder.css`.

- **Queue.**
  - Group items by novel, with failed items pinned on top.
  - Add "Retry all failed".
  - Work groups that contain failures start expanded (`tasks.tsx:1096-1098`).
  - Lane and priority go into details.
  - Queued rows get a visible row affordance, replacing actions hidden until selected (`tasks.tsx:440`, `tasks.css:394-396`).
  - The source-access banner uses tokens and normal-size buttons (`tasks.tsx:829-919`, `tasks.css:155-181`).
  - The sort popover becomes an `OverflowMenu`.
- **VPN.**
  - Gated per D4.
  - Range rows show the work, the chapter range and progress. The IP, protocol and the "Chapter ID" fallback go into details (`VpnDownloadRanges.tsx` range block).
  - `noProfiles` and `exhausted` link to Settings > Network.
- **Storage.**
  - Count and size stay visible on phones (`downloads.css:214-217`).
  - Filter and refresh get different icons.
  - Cached chapters get a Read action.
  - The page stops using its own inner scroller (`downloads.css:1-20`).
- **VPN finder.**
  - Renders one layout per breakpoint, instead of both the table and the cards (`PluginVpnFinder.tsx:542-727`).
  - The verdict control gets a visible text label without duplicating its existing accessible name (`VpnGateServerVerdictControl.tsx:45,55`).
  - Localize `logType`.
  - Full-screen on phones.
  - No flag emoji on Windows (`PluginVpnFinder.tsx:146-151`).

### 4.8 Novel migrate source

**Files:** `src/routes/novel-merge.tsx`, `src/styles/novel-merge.css`.

- Confirm before discarding decisions, including on Android Back (`:617,749-755,943,1000`).
- Show mapped, excluded and kept counts in the confirmation (`:1155-1186`).
- Use novel names instead of "A/B". In ko, replace the English loanword for "merge" with the native term for "migration".
- Phones get a single list of "source chapter → target select".
- Virtualize both lists (`:313,419`).
- After a merge, show a success message.
- Auto-matching is listed under behavior additions.

## Phase 5 - Motion and feedback

- [ ] **5.1 State layers.** Apply them on every primitive. Restrict hover to `@media (hover: hover)`.
- [ ] **5.2 Transitions.**
  - Sheets and dialogs: enter and exit, with a scrim.
  - The selection bar slides in.
  - `Collapse` for expandable groups.
  - Removed rows fade and collapse.
  - Progress bars animate their width.
  - Scroll-mode tap paging scrolls smoothly (`use-reader-scroll-layout.ts:320`), with reduced motion honored in that JS path.
- [ ] **5.3 Feedback.**
  - Success messages for save, assign, import, merge and batch download.
  - Inline progress for long checks.
  - Optimistic bookmark and library toggles with rollback on error.
- [ ] **5.4 Long-press cue.** Scale to 0.97 plus a state layer. Use haptics only if an existing bridge supports them; no new plugin.
- [ ] **5.5 Reduced motion** check on Windows with animations disabled, and on Android with animator scale set to 0.

## Phase 6 - Copy and localization

- [ ] **6.1** Remove jargon from visible strings:
  - cached, indexed, fan-out, eligible, lane, priority, prepared origin
  - "Chapter index", "Media fallback", "Force stop and continue"
  - "Server: Complete/Incomplete"
- [ ] **6.2** Unify ko terminology: pick one Korean term for "chapter" (two are mixed today) and one for "library" (a native word and a loanword are mixed). Translate "Ch.", "Ref" and "Page-fit media".
- [ ] **6.3** Prune unused keys and verify en/ko parity. Examples:
  - `novel.lastRead`, `novel.updated`, `novel.unreadCount`, `novel.released`
  - `novel.notInLibrary`, `novel.never`
  - `novel.local.moveChapterUp/Down`, `novel.selection.deleteDownloadsConfirm`
  - keys orphaned by Phases 3-4
- [ ] **6.4** Remove reachable dev artifacts: `reader.sample`, `reader.sampleContent`, `SAMPLE_CHAPTER_HTML` (`use-reader-chapter-document.ts:363`), and the `http://127.0.0.1:8080` placeholder (`ContentServerSettings.tsx:262`).
- [ ] **6.5** Accessible labels on search inputs (`SearchBar.tsx:26`) and on every icon-only control that remains.

## Phase 7 - Feature redesigns (spec §2)

Each RD is one slice with tests. Slices ship in the order below, ranked by actions saved per week for a typical reader, with the cheapest scope first where the gain is equal.

| Order | RD | Depends on | Scope |
|---|---|---|---|
| 1 | RD1 Continue shelf, RD10 search fallthrough, RD22 catalog auto-load | 4.2, 4.5 | UI, history/next-chapter query composition |
| 1b | RD17 end of novel, RD21 full history search | 4.4, 4.1 | UI, in-place refresh, paginated history query |
| 2 | RD23 copy reader settings | 4.1 | Reader store actions |
| 3 | **System C freshness** (spec §2.2.6: one check operation, cadence by reading state, per-source budgets, found-by-check Updates, cover policy, per-novel retry) | 4.4 | Appended migration (freshness columns, `found_by_check`), scheduler cadence, query changes, removal of the old refresh entry points |
| 4 | RD11 range, number range and chapter jump | 4.3 | UI, selection state |
| 5 | RD8 quick add from grids | 4.5 | UI, non-navigating import task, in-library lookup |
| 6 | RD13 verify in place and resume | 4.5, 4.7 | UI, routing of the existing verification resume |
| 7 | RD20 notification targets | 4.7 | Notification model, validated native protocol targets (Windows and Android) |
| 8 | RD6 multiple repositories and publisher provenance | 4.5 | Appended DB migration, TS and Rust restore limits (`backup.rs:352`), exact-schema device backup, publisher provenance, queries, UI. Needs the compatibility review. |
| 9 | RD7 extension updates | RD6 | Store, daily index refresh, semver comparison, transactional plugin update with rollback (`manager.ts:364-376`) |
| 10 | RD9 first-run setup | RD6 | New `/setup` route |
| 11 | RD12 migration auto-match | 4.8 | Matching helper, UI |
| 12 | **System A download goals** (spec §2.2.4: goals, budgets, priority, server lane, bounded retry (G3), persisted failures), then RD5 automatic finished-chapter cleanup | 3, 4.7 | Appended migration (goals, chapter failure state), goal resolver through the existing submission path, metered/battery detection (native), portable backup format bump for goals; update `docs/release-compatibility.md` |
| 12b | **System B VPN routes** (spec §2.2.5: per-source route, diagnosed trigger, chunked ranges with deferred lease, discovery and usage policy, durable route state, separate controls) | 12 | Appended migration (route state, chunk fields, discovered-server entries), coordinator dispatch from a chunk queue, TS and Rust plan contract change, finder/vault changes (native), Y700 and Waydroid measurement for the chunk size |
| 13 | RD14 drop-to-import | 4.2 | Tauri drag-drop event |
| 14 | RD15 automatic backup | 4.6 | Store, scheduled export, atomic native write and owned-file pruning |
| 15 | RD18 settings search | 4.6 | Settings row metadata index |

Verification per slice:
- unit tests for the new logic: matching, range selection, rehydration mapping, scheduler triggers, cleanup predicates
- a before/after action count, recorded in the slice's commit body
- `verify-norea-release-compatibility` for RD4, RD6 and RD15

## Verification

- **Per task.** Run the focused Vitest files, the token guard, the contrast gate and the Mantine theme test. Run `pnpm tsc` and `pnpm test` when requested.
- **Per page slice.**
  - Take screenshots at the three sizes and the breakpoint boundaries, at 75%, 100% and 150% scale, in light and dark (Moss, Lavender, Catppuccin).
  - Store them in `.tmp/ui-ux-overhaul/<page>/`.
  - Checks:
    - no text under 12px at 100%
    - touch targets ≥44px on coarse pointers
    - the primary action is visible without scrolling
    - no diagnostic text in the default view
    - every overlay passes the overlay contract
- **Android.**
  - Waydroid smoke per `docs/development.md`: back precedence, sheets, reader chrome, text selection and safe areas.
  - Use a targeted `pnpm exec tauri android build --apk --target x86_64` when requested.
- **Windows.**
  - `pnpm tauri build --debug` smoke covering:
    - keyboard-only navigation
    - focus outlines and forced colors
    - one tooltip per control
    - reduced motion
    - mixed touch and mouse (`any-pointer`)
  - `norea://tasks` activation, both cold and warm.
- **Skills.**
  - `verify-scalable-ui-units` and `verify-responsive-breakpoint-contract` after Phase 2.
  - `verify-norea-ui-interaction` and `verify-localized-strings` after each slice.
  - `verify-reader-settings-appearance` after 4.1.
  - `verify-norea-release-compatibility` for any persisted-field change: `show*Tab`, `bottom-forward`, `fullPageReader`.

## Commit plan

- **Phase 0:** one `fix(<module>): ...` per item.
- **Phase 2:**
  - `feat(theme): Add design tokens and palette roles`
  - `feat(theme): Map Mantine variables to palette roles`
  - one `style(<module>): Migrate <file> to design tokens` per CSS file
- **Phases 3 and 4:** primitives land with their first consumer. Visual and behavior commits stay separate within each slice.
- **Docs:** each phase ends with a commit if `README.md` or `docs/development.md` describe UI that changed.

## Risks

| Risk | Mitigation |
|---|---|
| Visual regressions from the mechanical migration | Value-only commits, screenshot comparison, geometry reconciled in the same commit. |
| Store rehydration | Ignored fields are kept. Normalization is scoped across global, source and novel settings and leaves custom zones intact. |
| Reader gesture and selection conflicts | The 1.3 contract tests come first, then a Waydroid check. |
| Route change | The durable protocol is unchanged, with cold/warm activation tests. |
| Bundle size | Measured per D1/D2 before approval. |
| Plugin proxy gate | Unchanged without a separate decision. |
| Test churn across 49 files | Assertions are replaced only where a slice touches them. |

## Review log

**External review: Codex CLI 0.166, read-only sandbox, 2026-11-03.** Prompt: `.tmp/ui-ux-overhaul/codex-review-prompt.md`. Output: `.tmp/ui-ux-overhaul/codex-review.md`. The plan author re-checked the main review claims (contrast values, Mantine `toRgba`, `norea://tasks`, real file deletion) against source before accepting them.

| Review finding | Disposition |
|---|---|
| Color scale count wrong (4 roles, not 3); dead variable count; `--norea-on-surface-variant` has a consumer | Fixed in root causes 2-3. |
| 0.1 description imprecise; 0.2 scenario wrong | Rewritten. |
| Stale lines (font declarations, VPN cancel, verdict control) | Refreshed. |
| `outline` fails contrast for small text in 15 of 18 schemes; `onPrimary` fails in two themes | Added the role derivation with contrast targets and the contrast gate test (root cause 10). |
| Mantine mapping incomplete; `color-mix` breaks Mantine `toRgba` | Concrete TS-generated ramps, the full resolver key list, and the `mantine-theme.test.ts` parse check. |
| `color-mix` unsafe for minSdk 24 / unpinned WebView2 | `color-mix` dropped from tokens, state layers built on `currentColor` opacity, existing uses removed. |
| `pointer: coarse` misses hybrid devices | Switched to `any-pointer: coarse`. |
| Floors conflict with 75% scale | Added D8. |
| Virtualized geometry vs typography changes | Same-commit reconciliation rule. |
| Undo unsupported for real file deletion and history timestamps | Undo removed; lighter confirmations kept. |
| Route change touches Rust protocol and deep-link parsing | D4 and 3.3 keep `norea://tasks` and test activation. |
| Reduced motion must reach JS animation; keyboard guards for selection; focus contract | Added to the token notes, 1.3, 4.1 and the overlay contract. |
| Missed areas: SiteBrowser native scope, LocalCoverPicker races, import lifecycle, category dialogs, StorageRecovery states, ChapterCleanup safeguards, PDF, Windows focus | Added to 4.1, 4.2, 4.3, 4.5, the Downloads hub IA, and Phases 2.7 and 6.5. |
| Scope expansion (auto-match, pagination, infinite scroll, context menus, end screens, multi-select delete) | Moved to "Behavior additions that need separate approval". |
| Phase 0 depended on later primitives | Phase 0 now uses existing components only. The confirmation work moved to 3.4. |
| D5 should not overwrite existing preferences | D5 revised. |

**Second pass: the same reviewer re-checked the revised plan.** Prompt: `.tmp/ui-ux-overhaul/codex-recheck-prompt.md`. Output: `.tmp/ui-ux-overhaul/codex-recheck.md`. Result: 6 of the 10 corrections resolved and 4 partial. All 8 spot-checked references were confirmed. Four high-severity gaps remained, and the plan author re-checked each against source:

| Remaining gap | Disposition |
|---|---|
| `var()` colors in Mantine props turn back into `color-mix()`, and filled variants default to white text | 2.5 now registers concrete semantic theme colors, adds a `variantColorResolver` with solved foregrounds and a per-variant contrast test, and sets portal z-index defaults from the layer tokens. |
| The setup-dependent cleanup default would bypass the server-copy check | The Downloads hub IA keeps `server-contains-local`. Deleting without a verified copy is an explicit opt-in. |
| A new import request replaces an active batch | 4.2 adds a request queue, a batch id and a regression test. |
| The chrome hide timer removes focused controls | 4.1 suspends auto-hide while focus is inside the chrome or a seekbar drag is active, with a test. |

Reviewer verdict: Phase 0 is ready to start. Phase 2 starts once D1-D8 are decided and the Mantine variant contract above is in place. The 2.5 revision addresses that contract.
