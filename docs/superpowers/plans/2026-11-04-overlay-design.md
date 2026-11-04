# Overlay design plan

Status: plan only. Nothing here is implemented yet.

Scope: every layered surface that appears over a page and goes away again:
bottom sheets, side drawers, centered dialogs, full-screen sheets, confirms,
menus, popovers, toasts and the reader's Aa sheet and side panel.

## Current state

| Family | Component | Call sites | Uses the primitive |
|---|---|---|---|
| Responsive sheet | `ResponsiveSheet` | 15 in 12 files | yes |
| Dialog | raw Mantine `Modal` | 18 in 17 files | no |
| Side drawer | raw Mantine `Drawer` | 2 (reader settings in `novel.tsx`, `source.tsx`) | no |
| Confirm | `ConfirmDialog` / `useConfirm` | 14 files | 3 hand-rolled confirms bypass it (`ReaderSettingsPanel`, `ReadingStateSettings`, `LibraryCategoryDialogs`) |
| Menu | `OverflowMenu` / raw `Menu` | 23 / 2 (`ReaderQuickSettings`, `QuickAddCard`) | mostly |
| Popover | raw `Popover` | 1 (`ReaderChrome`) | no |
| Toast | `AppToasts` | 21 calls | yes |

## Problems

1. Overlays have the same color as the page. Mantine body, dropdown and
   notification colors all resolve to `surface`
   (`src/theme/mantine-theme.ts:225`), and several palettes define `surface`
   equal to `bg` (`src/theme/md3.ts`).
2. Elevation is not themed. `--norea-shadow-floating` is never applied to
   Modal or Drawer; Mantine's light-tuned default shadow almost disappears in
   dark mode.
3. `--norea-scrim` has no consumer. Mantine's default black 0.6 overlay is
   used everywhere; the blocking overlay hardcodes its own color
   (`src/styles/app.css:549`).
4. Headers are undesigned: no title ramp, subtitle slot, height or divider.
   The close button is Mantine's default.
5. Actions have no pattern. Only `ResponsiveSheet` has a sticky footer; raw
   modals put buttons in the body, so they scroll away on long content.
6. Radius is inconsistent: bottom sheets use `radius-lg` on the top edge,
   modals Mantine's `md`, side drawers none.
7. Motion is generic: every modal, including phone full-screen ones, enters
   with `fade-down` (`mantine-theme.ts:315`). Enter and exit share one 200ms
   curve, and there are no decelerate/accelerate curves. The reader side
   panel mounts without motion.
8. Sizes are ad hoc (`lg`, `68rem`, `24rem`, default).
9. Z-order is ad hoc: literal `zIndex={400}` equals the toast layer
   (`ContentDeletionDialog.tsx:85`); category dialogs tie with menus.
10. Toasts use `surface` although `inverseSurface` is documented as the
    snackbar role (`palette-roles.ts:47`).
11. Bottom-anchored inputs may sit under the Android keyboard:
    `--norea-viewport-height` is `100dvh` and does not follow
    `visualViewport`. Needs a device check.
12. Raw overlays each re-implement busy locking and back navigation; the
    drag-handle CSS is duplicated (`src/styles/ui.css:101-145`).

## Design spec

### Tokens

- **Overlay surface:** a new `overlaySurface` role, `surface` lifted toward
  `ink` (light 3%, dark 8%), with a guaranteed contrast step against `bg` in
  every palette. Dark mode adds a 1px `rule` border.
- **Radius:** bottom-sheet top corners and the side drawer's leading edge
  `--norea-radius-xl` (1.5rem, new); dialogs `lg`; menus, popovers and toasts
  `md`.
- **Elevation:** `--norea-shadow-1` (menus), `--norea-shadow-2` (dialogs),
  `--norea-shadow-sheet` (upward shadow for bottom sheets); alpha per scheme.
- **Scrim:** light `rgba(15, 23, 42, 0.40)`, dark `rgba(0, 0, 0, 0.56)`, no
  blur. Non-modal reader panels get no scrim.
- **Z ladder:** overlay 300 < nested overlay 310 < menu/popover 320 <
  confirm 330 < toast 400 < site browser 1000 < blocking 1100.
- **Motion:** add `--norea-ease-decelerate` and `--norea-ease-accelerate`.
  Sheets and drawers slide from their own edge: enter 320ms decelerate, exit
  200ms accelerate. Dialogs fade and scale from 0.96: enter 200ms, exit
  120ms. Menus and popovers scale from the trigger origin, 120ms. Toasts slide
  up 200ms. The reduced-motion tokens already collapse all of these.

### Anatomy

- **Header:** at least 3.5rem tall. Title `text-lg` bold, optional subtitle
  `text-sm` muted, 44px close button at the trailing edge. A divider appears
  once the body scrolls.
- **Handle (bottom sheets):** a 2.25rem × 0.25rem pill with a full-width
  touch strip. Drag down to dismiss.
- **Body:** the same inline padding as the header; `space-5` between
  sections, `space-3` inside one; scroll contained.
- **Footer:** sticky, on the overlay surface, with a top rule and the bottom
  safe area. Desktop: right-aligned, primary rightmost. Phone: equal-width
  buttons, stacked when there are more than two.

### Sizes and presentation

- **Dialog widths:** `sm` 24rem (confirm), `md` 32rem (forms), `lg` 45rem
  (managers), `xl` 68rem (VPN finder).
- **Side drawer:** 24rem, 28rem from 1408px.
- **Bottom sheet:** at most 40rem wide from 768px and 90% tall.
- **By width:** below 768px, a bottom sheet (full screen for long forms);
  768 to 1199px, a dialog or side drawer; from 1200px, the reader uses its
  non-modal side panel. No new breakpoints.

## Implementation phases

1. **Tokens and theme:** `tokens.css`, `palette-roles.ts`, `motion.ts`,
   `mantine-theme.ts`.
   - Add the surface, shadow, scrim, motion and z tokens.
   - Wire Modal, Drawer, Menu, Popover and Notification defaults to them.
   - Tests: the overlay surface stays distinct from `bg` in every palette, the
     z ladder keeps its order, and the scrim, shadow and ease tokens are used.
2. **Primitive anatomy:** `ResponsiveSheet.tsx`, `ConfirmDialog.tsx`,
   `ui.css`.
   - Add `subtitle`, `size` and `busy` (busy locks Escape, outside click and
     close).
   - Scroll divider, one shared handle, drag to dismiss on every bottom sheet.
   - Keyboard inset from `visualViewport`.
   - Extend `ResponsiveSheet.test.tsx` and `overlay-contract.test.tsx`.
3. **Migration:**
   - Move the three hand-rolled confirms to `useConfirm`.
   - Move the two reader-settings drawers and the remaining raw `Modal`s to
     `ResponsiveSheet`.
   - Drop literal z-indexes and the duplicated safe-area CSS
     (`settings.css:540-557`).
4. **Menus, popovers, toasts and reader:**
   - Restyle the two raw menus and the reader popover to the spec.
   - Add slide motion to the reader side panel.
   - Put toasts on the chosen surface, with a status accent bar.
5. **Guard:** a static test fails when `Modal` or `Drawer` is imported from
   `@mantine/core` outside `src/components/ui/`, or when TSX contains a
   literal `zIndex`.

Each phase ends with `pnpm tsc`, `pnpm test` and a Y700 check (display 0) of
one sheet, dialog, menu and toast in light and dark mode.

## Open decisions

1. Toast surface: inverse (snackbar) or the lifted overlay surface?
2. Scrim blur on desktop? It is expensive on Android WebView.
3. Long forms on phones: full screen or a 90% sheet?
4. Tablet portrait (768-991px): bottom sheet or centered dialog?
5. Should toasts appear above the site browser overlay?
6. Header divider: always, or only once the body scrolls?
7. Drag to dismiss on sheets that contain forms?
8. Phone footer: equal-width buttons, or a full-width primary?
