# Page Structure, Task-Flow and Feature Redesign

**Status:** Draft for review, 2026-11-03, revision 5.

**Companion plan:** `docs/superpowers/plans/2026-11-03-ui-ux-overhaul.md`.
- The plan owns tokens, primitives, defects and sequencing.
- This spec owns:
  - what each page contains and where each function lives
  - how each page is laid out on phone and desktop
  - which existing features are redesigned to take fewer actions

**Product rule (user direction, 2026-11-03):** existing features may be redesigned when that serves the user. The measure is how few actions the app needs to do what the user wants, at the moment and in the place they want it. A redesign that removes actions, or makes the app act on its own at the right time, beats preserving today's behavior.

**Method:**
- For every page, every user-reachable function was listed from source and given a usage class:
  - **Core:** almost every visit.
  - **Frequent:** most weeks.
  - **Occasional.**
  - **Rare.**
  - **Diagnostic.**
- The page is built around its core task. Every other function goes to the container that fits its usage class and its interaction shape.
- Where today's feature forces avoidable actions, it is redesigned. Redesigns are listed in §2 with before/after action counts.
- Usage classes are hypotheses from code reading. They are re-checked after each page ships.

## 1. Rules

### 1.1 When a page must be split

1. **Two jobs with different mindsets** (consumption vs management) get separate screens.
2. **An Occasional-or-rarer function that needs more than two controls** moves off the page into a sheet, a dialog or a sub-route.
3. **More than one scroll container on a phone** means one list becomes its own view.
4. **A workflow with more than one decision step** becomes a dedicated full-screen flow with explicit steps.

### 1.2 Container choice

| Container | Use for | Do not use for |
|---|---|---|
| Route (deep-linkable, back returns) | Destinations, item details, multi-step flows | Quick adjustments |
| Sub-route | Management screens reached from a destination | Single settings |
| Bottom sheet (phone) / popover or side panel (desktop) | Contextual adjustments that keep the content visible | Forms with more than 2 text fields |
| Dialog | Confirmations; forms of 1-4 fields | Scrolling lists |
| Full-screen dialog (phone) / large modal (desktop) | Forms over 4 fields or with preview; long pickers | Navigation |
| Overflow menu | Occasional/Rare actions on the current object | Core actions; toggles whose state must stay visible |
| Inline disclosure ("Details", "Advanced") | Explanatory or diagnostic information; advanced settings | Required recovery actions (§1.4) |
| Contextual action bar | Multi-selection actions | Persistent tools |
| Toast | Outcome of an async action, sometimes with one follow-up action | Errors that block work |

### 1.3 Shared layout patterns

**Phone (<768px)**
- Top app bar (`--norea-bar-height`, 3.5rem): title, at most two action icons, overflow.
- Bottom nav with 5 tabs. It is hidden in the reader, in selection mode (the action bar replaces it), and in full-screen dialogs.
- One scroll container per page.
- Page-level actions sit in the lower two thirds of the screen.

**Tablet (768-1199px)**
- Rail.
- Phone structure in a wider column.
- Two panes at 992px and up where a list/detail pair exists.

**Desktop (≥1200px)**
- Rail with labels.
- The page header sits in the content column, and actions may carry text labels.
- Side panels replace bottom sheets.

**Toasts**
- Bottom-center above the bottom nav (phone), bottom-right (desktop). Today they are top-right (`src/main.tsx:295`).
- They avoid the keyboard, the safe areas, the selection bars and the reader bars.

**Primary action:** each page has exactly one, visually filled.

### 1.4 Information placement

- **Primary.** The minimum needed to choose and act: cover, title, reading progress, unread/new count, actionable download state.
- **Secondary.** One step away: author, genres, release date, size, language, source.
- **Diagnostic.** Only in "Details" or Settings > Developer & diagnostics: ids, paths, plugin ids, base URLs, lanes, priorities, IPs, protocols, raw errors.
- **Recovery overrides usage class.** When work is blocked, the recovery action is primary and shown in place. This covers Verify, Retry, Restart pass, Choose folder, Repair media and a required copy choice. Only the explanation may live in "Details".
- **Bar heights and sizes are rem tokens.** The px values in this spec are illustrations at 100% scale. D8's touch floor is the only px exception.

## 2. Feature redesigns

### 2.0 How redesigns are written

Each redesign states the following:

- **Actions:** the full task, counted from the same starting point before and after: taps, clicks, typed fields and confirmations. Waits are not counted.
- **Scope:** which layers change.
  - **U:** UI
  - **S:** persisted store field (additive)
  - **Q:** query, service or scheduler logic
  - **M:** DB migration. This means a schema version bump plus an appended, immutable migration (CLAUDE.md).
  - **B:** backup format. This means a format version bump, a current-format reader only, and both the portable path and the exact-schema device-backup path (`docs/release-compatibility.md:15`).
  - **N:** native (Rust or Kotlin)
- **Lifecycle:** for anything automatic, when it runs, when it is skipped, and how overlap, cancellation, deduplication and missed runs are handled.
- **Safety:** the invariants that must be re-checked at execution time.
- **Default.**

Automatic behavior obeys four rules:
- it runs through the existing task scheduler and the plugin fetch path
- it never infers success from a UI event
- it records its outcome where the user will look: a badge, Needs attention, or a toast
- a user cancellation is respected until the next scheduled run

### RD1 Continue-reading shelf in Library

- **Today:** History, then a row (2). Library, then the novel, then Continue (3).
- **New:** at the top of the All view, a shelf of up to 6 novels with a resume target, ordered by last read.
  - A novel qualifies when its latest read chapter is unfinished, or is finished and has a next chapter.
  - A tap applies History's rule (`src/routes/history.tsx:836-845`).
  - Each card shows its cover, "Ch. N", and either a progress ring or "Next".
  - The shelf hides when another category, a search or a filter is active. It is collapsible, and Library > Display has "Show continue reading".
- **Actions:** from Library, 3 → 1. From app start, 2 → 1.
- **Scope:** U, S, Q (composition of the recently-read query with next-chapter lookup).
- **Default:** on.

### RD2 Automatic library update checks

> **Superseded by §2.2** (download goals, VPN routes, freshness model). Kept for history; do not implement as written.

- **Today:** Updates, then Check (2), every time. A check covers every library novel (`src/lib/updates/check-library-updates.ts:51`).
- **New:** Settings > Library > Updates offers:
  - Interval: Off / 6h / 12h / 24h
  - Skip completed novels (opt-in, to save traffic)
  - Only these categories (optional)
- **Lifecycle:**
  - A check starts only while the app is visible, matching `src/lib/content-sync/scheduler.ts:18-22`.
  - It starts on launch or when the app returns to the foreground, if the stored `lastCheckAt` is older than the interval.
  - It is skipped while a check task is already running (overlap guard), or while offline. A skipped or missed run happens at the next foreground return.
  - A check that already started continues if the window is hidden, the same way any running task does.
  - If the user cancels, the next attempt waits for the next interval.
  - Results raise the Updates nav badge. A system notification is posted only if the check finishes while the app is hidden.
- **Scope:**
  - S: interval, filters, `lastCheckAt`
  - Q: a category and status filter in the novel selection; a source-scoped retry API, which today is all-or-nothing; a trigger
- **Default:** 12h, skip completed off.

### RD3 Automatic download of new chapters

> **Superseded by §2.2** (download goals, VPN routes, freshness model). Kept for history; do not implement as written.

- **Today:** Updates, then one download per new chapter (N + 1).
- **New:** Settings > Downloads & storage > Automatic downloads:
  - Off / All library novels / Chosen categories
  - "Only novels with reading progress"
- **Lifecycle:**
  - **Trigger:** every update check, automatic (RD2) or manual. Queueing happens inside the same per-novel check step that inserts the new chapters, so there is no gap between discovery and queueing. If a check is cancelled or the app exits, the unchecked novels are simply checked next time.
  - It queues only chapters *discovered by that check*. `checkLibraryUpdates` currently returns a paginated Updates window, not discovery deltas (`check-library-updates.ts:32`), so it must return the set of newly inserted chapter ids.
  - Chapters already stored or queued are skipped.
  - Chapters the user cancelled or deleted after an automatic queueing are never re-queued automatically.
- **Actions:** N + 1 → 0, after opting in.
- **Scope:** S, Q (discovery deltas, deduplication, a record of user-cancelled automatic items).
- **Default:** Off. After the user's first manual batch download, a one-time toast offers "Download new chapters automatically?"

### RD4 Read-ahead count replaces "Download next chapter"

> **Superseded by §2.2** (download goals, VPN routes, freshness model). Kept for history; do not implement as written.

- **Today:** a boolean prefetches one adjacent chapter (`src/components/reader/use-next-reader-chapter.ts:73`, `src/store/reader.ts:149,572`).
- **New:** "Keep chapters ahead": 0 / 1 / 3 / 5 / 10.
- **Lifecycle:**
  - Prefetch tasks run at background priority in the source queue.
  - They are deduplicated against stored and queued chapters.
  - Tasks not yet started are cancelled when the user leaves the novel.
  - Failures are not toasted. They are retried on the next chapter change.
- **Rehydration:**
  - Global, source and novel overrides are normalized.
  - An existing new value wins.
  - Otherwise `true` maps to 1 and `false` to 0. The old field stays ignored.
- **Actions:** preparing 10 chapters for offline reading takes 3 actions before every session today (novel page, Download, Next 10). With the setting it takes 0 per session, after a one-time setting change of 2 actions.
- **Scope:** S, Q, U.
- **Default:** 1, which is today's behavior.
- **Risk:** source traffic and queue contention. Mitigated by background priority and per-source cooldowns.

### RD5 Automatic cleanup of finished chapters

- **Today:** Storage or the Settings cleanup, then conditions, preview, review and two confirmations (about 6) (`src/components/ChapterCleanupPanel.tsx:136`).
- **New:** Settings > Downloads & storage > "Remove finished chapters automatically": Off / keep the last 5, 10 or 20 finished chapters per novel.
  - Keep-last-N avoids a durable completion timestamp. `read_at` records when a chapter was opened, not finished (`src/db/queries/chapter.ts:822-826`), so no M or B change is needed.
- **Eligibility.** New predicates are added to `src/db/queries/chapter-cleanup.ts`, and every one is re-checked immediately before each deletion. A chapter is eligible only when all of these hold:
  - progress is finished
  - it is not bookmarked
  - it is not in the local work
  - its source plugin is installed
  - it is outside the per-novel retention window
  - it passes the server-copy predicate when a content server is configured (`src/lib/chapter-cleanup.ts:25-33`)
- **With a content server**, unattended deletion uses only `server-contains-local` (`src/lib/chapter-cleanup.ts:27-34`). The weaker modes `any`, `server-present` and `server-coverage` do not prove a complete server copy, so they are never used automatically unless the user picks one in a separate, explicitly acknowledged option.
- **Without a content server**, enabling the setting states that no server copy exists and requires an explicit acknowledgement before it takes effect.
- **Lifecycle:**
  - It runs as a maintenance task after a chapter reaches finished, and daily while the app is visible.
  - A missed daily run happens at the next foreground return once 24h have passed since the stored `lastCleanupAt`.
  - It is skipped while another cleanup is running. Each run is reported in Storage as "Removed 12 chapters (48 MB) today" with an "Undo is not possible" note.
- **Scope:** S, Q.
- **Compatibility:** it changes the documented explicit-cleanup workflow (`docs/release-compatibility.md:185`), so that document is updated in the same slice.
- **Default:** Off.

### RD6 Multiple plugin repositories

- **Today:** one repository at every layer:
  - DB `repository_singleton_uniq` (`src/db/schema.ts:325`)
  - the TS backup format (`src/lib/backup/format.ts:119,307`)
  - the Rust restore (`src-tauri/src/backup.rs:352`)
  - the UI
- Replacing the repository keeps installed plugins (`src/db/queries/repository.ts:34`). However, two catalogs cannot be browsed at the same time, and plugins from the old catalog lose their update path.
- **New:** a repository list with name, enabled, priority, Refresh and Remove (confirmed). The available catalog merges the enabled repositories. `norea://repo/add?url=` adds a repository after a confirm dialog that shows the URL.
- **Provenance.**
  - Each installed plugin records its publishing repository.
  - Updates come only from that repository.
  - A higher version in another repository is shown as "Also available from X", and switching publisher is an explicit action.
  - Legacy installs are bound on migration to the existing repository only when the installed row's `source_url` (`src/db/schema.ts:340`) equals the plugin URL in that repository's cached index. An id match alone is not enough.
  - Any other legacy install stays "unknown publisher": it is never auto-updated, and Extensions shows "Choose publisher" when a repository offers that id.
  - Multi-source template identity is preserved.
- **Actions:** browsing two catalogs goes from impossible (replace the URL, browse, replace again) to Add, paste, Save (3) once.
- **Scope:**
  - M (appended): drop the singleton index; add `repository.priority` and `repository.enabled`; add `installed_plugin.repository_url`
  - B: the repository array is already in the manifest; lift the single-repository limit in TS and Rust restore; update the exact-schema device-backup path
  - Q: queries
  - U
  - N: Rust restore
- **Default:** existing installs keep their repository at priority 1.

### RD7 Extension updates without hunting

- **Today:**
  - Updates are found only by scanning Available, where "update" means any version difference, including a downgrade (`src/routes/browse.tsx:1627`).
  - Each update is a separate install tap.
  - The index refreshes on demand.
- **New:**
  - Repository indexes refresh at launch, at most daily.
  - Only a strictly newer version, compared with semver rules and falling back to string comparison, counts as an update. A lower or different version shows as "Different version available" and is never part of Update all.
  - The Extensions button and the More badge show the count. Extensions opens with "Updates (N) [Update all]".
- **Transactional update.**
  - Today, registration swaps the in-memory plugin before persistence (`src/lib/plugins/manager.ts:364-376`).
  - The new order: load and validate the new source, persist it, swap it in memory, keep the old source until the swap succeeds, and roll back on failure.
  - Update all reports outcomes per plugin.
  - For multi-source plugins, the template updates first, then each instance.
- **Actions:** N updates go from Browse, Sources, scroll, then N installs (N + 2) to Browse, Extensions, Update all (3).
- **Scope:** U, S, Q.
- **Default:** notify only. "Update automatically" is opt-in, and available only after provenance (RD6) ships.

### RD8 Quick add to library from any cover grid

- **Today:** tap the cover, wait through a blocking import, land on the novel page, tap Library, go back (3). The "In library" marks already exist in all three grids (`src/routes/source.tsx:802`, `src/routes/global-search.tsx:655`, `src/components/ContentServerBrowse.tsx:94`).
- **New:** long-press (touch), right-click or the hover "+" (fine pointer), or the context-menu key and a focused "More" button (keyboard), opens **Add to library** and **Open**.
  - Add runs the import as a background task, keeps the user in the grid, and toasts "Added · Change category".
  - The item shows a pending state, and repeated activation is ignored while it is pending.
  - A failure toasts "Couldn't add · Retry".
  - Server works use the server-provider install path.
- **Actions:** 3 → 2, without leaving the grid.
- **Scope:** U, Q (non-navigating import variant of the existing open-novel task).
- **Default:** on.

### RD9 Guided first run

- **Today:** a new user must:
  - pass the storage gate (Android, `src/components/runtime/ChapterMediaStorageGate.tsx:85`)
  - find Browse > Sources > Repository
  - paste a URL and save
  - scroll Available and install sources one by one
  - That is about 10 actions plus N installs, across 2 screens, with no guidance.
- **New:** after the storage gate (which stays the gate), when a persisted `setupState` is absent and no repository or plugin exists, `/setup` opens:
  1. Add a repository: paste and Add (2), or arrive through a validated deep link (1).
  2. Pick reading languages (1-3).
  3. Suggested sources for those languages, pre-selected: adjust, then Install selected (1 + adjustments).
  4. Done (1).
  - Skip is available on every step, and it records `setupState = skipped`, so local-only users are never asked again. A later "Set up sources" entry stays in the Extensions empty state.
- **Actions:** about 10 + N → about 6 + adjustments, in one guided flow.
- **Scope:** U, S, Q, plus route [S11].
- **Default:** shown once. There is no suggested repository unless the project names one.

### RD10 Library search continues into sources

- **Today:** a title not in the library: Browse, Search, type the query again, submit (3 + typing).
- **New:** library search results end with "Search sources for '…'". With zero matches it is the main content. The tap opens Browse > Search with the query and submits it once, using the existing search parameters (`src/router.tsx:31`). Back restores the Library query, category and scroll position.
- **Actions:** 3 + typing → 1.
- **Scope:** U.
- **Default:** on.

### RD11 Ranges and jumps in chapter lists

- **Today:**
  - Long-press toggles one row only (`src/components/novel/NovelChapterList.tsx:224`).
  - "Mark previous read" excludes the anchor (`src/db/queries/chapter.ts:813`).
  - Any other range means tapping every row.
  - There is no chapter jump in a long list (`NovelChapterList.tsx:499`).
- **New:**
  - **Range by gesture.** The first selected row is the anchor. Long-pressing another row (touch) or Shift-clicking it (desktop) selects every row between them in the current sort order. A second range extends from the same anchor.
  - **Range by number.** The selection bar has "Select range…", a dialog with From and To chapter number fields. It is for distant endpoints on phones.
  - **Jump.** The list header has a "Go to chapter" field that accepts a number or title text and scrolls to and highlights the match.
  - The range actions are Mark read, Mark unread, Download and Delete download. The existing previous/following actions stay, and their labels say that they exclude the anchor.
- **Actions:**
  - chapters 100-150: 51 → 3 (gesture) or 5 (dialog)
  - jumping to chapter 800: long scrolling → 2
- **Scope:** U, selection state.

### RD12 Automatic chapter matching in source migration

- **Today:** choose the target, then two actions per source chapter, then confirm (about 2N + 3). Decisions reset when the target changes (`src/routes/novel-merge.tsx:617`).
- **New:**
  - When the preview loads, a chapter is **auto-accepted only when its chapter number is unique on both sides and the numbers match**.
  - Repeated numbers, missing numbers, and number matches with very different titles are shown for review as "Ambiguous".
  - Copy conflicts must be resolved: several downloaded source chapters mapping to one target (`src/lib/novel-merge.ts:198-207`).
  - Auto-matched rows sit in a collapsed, editable "N matched" section.
  - The step 3 summary lists the counts before execution, because wrong matches move real progress and downloads.
- **Actions:** a clean migration goes from about 2N + 3 to about 4: choose target, Continue, Continue, Confirm. Each ambiguous row or conflict adds about 2.
- **Scope:** U, Q (matching helper on the existing merge machinery).
- **Default:** on.

### RD13 Verify in place, resume the exact operation

- **Today:** in Global search, a challenge row's "Open WebView" opens the site. The user solves the challenge, comes back and presses Retry, which retries every failed source (`src/routes/global-search.tsx:611-618,1108,1237`). The download queue has its own flow (`src/routes/tasks.tsx:895`).
- **New:**
  - Every blocked surface shows **Verify**: the Source page, a Global search row, novel refresh, the update check and Needs attention.
  - Verify opens the site browser in challenge mode. Manual verification and the explicit "Verify and resume" confirmation stay as they are (`src/components/SiteBrowserOverlay.tsx:717`). The scraper session is unchanged.
  - Only after the source-access coordinator confirms access, matched by revision and scope identity, does the *originating operation for that source* retry automatically.
  - Closing the browser never counts as success.
- **Actions:** Global search goes from Open WebView, solve, back, Retry all (3 + solving) to Verify, solve, Verify and resume (2 + solving).
- **Scope:** U, Q. The scheduler is touched only if the resume scope differs from source-queue release.
- **Default:** on.

### RD14 Drop files to import (desktop)

- **Today:** overflow, Import files, the picker, then select (3+), then review and Import (2).
- **New:** dropping supported files anywhere on the window feeds the existing queued import review (§16). Unsupported files show a toast. Android share and open intents are unchanged.
- **Actions:** 3 + 2 → 1 + 2.
- **Scope:** U, plus the Tauri 2 drag-drop window event. No new plugin.

### RD15 Automatic local backup

- **Today:** a manual export with a file dialog every time (`src/lib/backup/io.ts:46`, `src/routes/settings.tsx:1830-1843`).
- **New:** Settings > Backup & sync > Automatic backup: Off / Daily / Weekly, keeping the last N (default 5), written to `backups/` in the storage folder.
- **Coverage**, stated in the row: library, categories, progress, settings and plugins. It does **not** include chapter files or media (`src/lib/backup/pack.ts:4`), and it does not protect against losing the folder itself.
- **Lifecycle:**
  - It runs when the app is visible and the last backup is overdue. A missed run happens at the next launch.
  - The archive is written to a temporary name and then renamed (atomic publish).
  - Only older backups created by this feature, identified by a name prefix, are pruned, and only after a successful write.
  - If the folder becomes unavailable, Needs attention shows "Backup folder unavailable [Choose folder]".
- **Actions:** 3 per backup → 0.
- **Scope:** U, S, Q, N (destination write and rename through the storage bridges, including Android SAF).
- **Default:** Off. Enabling it shows the coverage, then defaults to Weekly with 5 kept.

### RD16 Download all new chapters from Updates

> **Superseded by §2.2** (download goals, VPN routes, freshness model). Kept for history; do not implement as written.

- **Today:** one tap per new chapter (`src/routes/updates.tsx:432`).
- **New:** each date header has "Download all (N)", and the overflow has "Download all new" for all groups. N counts every eligible chapter, including unloaded pages. The route paginates (`updates.tsx:542`), so the action queries ids instead of using the loaded rows, and it excludes stored and queued chapters.
- **Actions:** N → 1 (one group) or 2 (all).
- **Scope:** U, Q.

### RD17 End of novel

- **Today:** next does nothing at the last chapter (`src/components/reader/use-reader-chapter-navigation.ts:236`).
- **New:** reaching the real end, the bottom of the last chapter, shows a card "You're caught up" with **Check for new chapters**. The check runs in place.
  - If chapters are found, the card shows "3 new chapters · Continue".
  - If the check fails, Retry and Verify (RD13) are inline.
  - "Back to novel" is a secondary action.
- **Actions:** checking for more and continuing goes from about 4 (back, overflow, refresh, open the chapter) to 2.
- **Scope:** U, Q (in-place novel refresh).

### RD18 Settings search

- **Today:** about 91 rows in 6 sections, plus 6 reader tabs.
- **New:** a search field at the top of Settings. It matches labels, descriptions and per-locale synonyms. Results read "Section › Row". A result reveals rows that are collapsed under Advanced or hidden behind a condition, and explains the condition when there is one. Reader results are labeled "Global default", so they are not confused with this novel's settings.
- **Actions:** finding an Advanced row in an unknown section goes from opening sections until found (2-6) to typing and choosing (2).
- **Scope:** U (row metadata in `SettingsPrimitives.tsx`).

### RD19 VPN download offered for reachability problems

> **Superseded by §2.2** (download goals, VPN routes, freshness model). Kept for history; do not implement as written.

- **Today:** VPN downloads start only from the Tasks panel (`src/routes/tasks.tsx:1313`).
- **New:** when a source's downloads fail repeatedly with a *reachability* diagnosis (connection failures, timeouts, or IP-level blocking as classified by the existing access-block scope, `src/lib/tasks/source-access-gate.ts:7`), Needs attention offers **Download with VPN**. If VPN is supported but not configured, it offers **Set up VPN**.
  - CAPTCHA and challenge blocks stay Verify-first and are never routed to profile rotation.
  - The existing plan and profile validation runs before launch.
- **Actions:** knowing the feature, Downloads, Start, then the dialog (4+) → Download with VPN, then the dialog (2).
- **Scope:** U, Q.

### RD20 Notifications open the exact place

- **Today:** most task notifications route to Tasks (`src/lib/tasks/task-notification-model.ts:322,398`). Verification already opens directly after validated activation (`src/lib/tasks/task-notification-actions.ts:50`).
- **New:** targets for "N new chapters" (Updates), "Downloads failed" (Queue > Needs attention) and "Backup failed" (Settings > Backup & sync).
- **Native contracts:**
  - Windows protocol generation is restricted (`src-tauri/src/task_notifications.rs:272-283`), so each new target becomes a validated `norea://` path.
  - Android actions are typed.
  - Cold start and warm activation are both handled.
  - A stale target, such as an item that is already resolved, falls back to the Queue.
  - `norea://tasks` stays valid.
- **Actions:** saves 1-2 navigations per notification.
- **Scope:** U, Q, N.

### RD21 Search all reading history

- **Today:** search filters only the latest 100 entries (`src/routes/history.tsx:48,788`).
- **New:** the search query runs in SQLite over the full history, paginated, and the list loads more on scroll.
- **Actions:** finding a book read months ago goes from impossible to typing (1).
- **Scope:** U, Q.

### RD22 Source catalogs load the next page near the end

- **Today:** "Load more" is required for every page (`src/routes/source.tsx:810`).
- **New:** one bounded next-page request runs when the user nears the end. The labeled button stays as the retry and fallback, and as the control during an error.
- **Actions:** one tap per page → 0.
- **Scope:** U.

### RD23 Copy reading settings across scopes

- **Today:** comfort settings tuned for one novel must be re-entered for another or globally. The scoped values exist (`src/store/reader.ts:412`).
- **New:** when "Aa" edits a narrower scope, its menu offers "Use these settings for all novels" and "Use inherited settings", which turns the override off.
- **Actions:** applying a tuned setup globally goes from re-entering 4-6 values to 2.
- **Scope:** U, Q (store actions).

## 2.1 Not redesigned yet

**Imported document groups.** Every import goes into the single local work (`src/lib/local-import-library.ts:38`). Grouping chapters by source file needs a persistence design (metadata and backup), and is recorded here as a future candidate.

## 2.2 Core systems: downloads, VPN routes and freshness

The app's heaviest jobs are getting chapters onto the device, getting past sources that throttle or block, and keeping the library current. Today each one is a set of one-shot commands. The app forgets the user's intent as soon as the command is queued. This section redesigns all three as systems that hold the user's intent and keep acting on it.

The section supersedes RD2, RD3, RD4, RD16 and RD19 (see §2.2.6). All facts below were traced in code on 2026-11-03 and spot-checked by the spec author.

### 2.2.1 What the user is trying to do

| Job | User's words |
|---|---|
| J1 Offline | "I want this novel readable without waiting or a connection: the next few chapters, or all of it." |
| J2 Current | "Tell me when the novels I read have new chapters, and have them ready." |
| J3 Throughput | "This site is slow or blocks me. Get the big download done anyway." |
| J4 Attention | "Only bother me when something actually needs me, and let me fix it in one place." |

### 2.2.2 How it works today (verified)

**Downloads (J1)**

Commands, not goals:
- The choices are all, unread, next 10, next 30 and selected. Each computes a chapter set once, from the rows currently loaded (`src/components/novel/novel-detail-model.ts:130-160`).
- Nothing remembers that the user wanted "the whole novel" or "stay ahead of me".
- In the library, "next 10/30" returns nothing for a novel the user has not started (`src/components/library/library-batch-download.ts:55-64`). The novel page starts at chapter 0 instead.

Throughput:
- One source runs one non-UI task at a time (`src/lib/tasks/scheduler.ts:1924-1928`). Chapter downloads apply a configurable cooldown (default 1s) after source access (`src/lib/tasks/chapter-download.ts:347-349`, `scheduler.ts:2373-2381`).
- Illustrative estimate, not measured: at 2-4s per page plus the default cooldown, one novel downloads serially at about 3-5s per chapter. That is roughly 1h per 1,000 chapters.
- There is no ETA anywhere.
- Concurrency (default 3) only parallelizes across sources.

Priority:
- A single download tapped from Updates gets `user` priority, but chapter downloads are not promoted (`scheduler.ts:181-189`).
- So that chapter waits behind earlier background chapters from the same source.

Failures:
- Since commit 627c530 every failure is final, and retrying is a manual fresh enqueue. The reasons were no hidden retry loops, plus queue registration and cleanup on every attempt.
- The failed job's SQLite row is deleted on terminal failure (`src/lib/tasks/chapter-download.ts:1462-1469`). The failure lives only in memory, so a restart erases what failed.
- There is no "retry all failed".
- A stored body with missing media counts as downloaded (`src/db/queries/chapter.ts:58-62`). That is an intentional body-count rule, with media repair kept separate (`docs/release-compatibility.md:95,110`). As a result, "Download all" skips such chapters, and each one needs Repair.

Restart:
- The queue survives, but it is restored as one anonymous background batch titled "Queued chapter downloads". Original batches, priorities and per-novel progress are dropped (`chapter-download.ts:1996-2008`).
- Source pauses are forgotten (`scheduler.ts:237-239`).

Content server first:
- Each chapter does its own server lookup with a 3s deadline before the source (`src/lib/content-sync/novel-source.ts:88-94`).
- A per-work chapter listing already exists (`src/lib/content-sync/chapters.ts:18`), but downloads do not use it to plan.

**VPN split downloads (J3; Android only, `src/lib/tasks/vpn-download-runtime.ts:266-271`)**

Prerequisite harvest:
- The user opens Settings > Data > Plugin VPN > Find public servers, then taps O on each server they want. The default needs 3, one per worker.
- There is no health check, no refill and no retirement of dead servers. Volunteer relays die, so this repeats.

Manual run:
- The only entry is "Download with VPN" on Tasks. Start adopts every queued ordinary download from every source (`src/lib/tasks/chapter-download.ts:244-252`).
- After the run completes, new requests are ordinary again, and the user must launch another run.

Frozen parallelism:
- The range count is fixed when a work enrolls, as min(workers, slots, currently free profiles, chapters) (`vpn-download-runtime.ts:841`).
- A small pool at that moment limits that work permanently. A range waits for its own assigned profile even when others are idle (`src/lib/tasks/vpn-download-coordinator.ts:750-767`).

Restart:
- Every unfinished range becomes `interrupted`, and the user must press Resume (`vpn-download-coordinator.ts:162-179`).
- One notification is raised per range, so a big run produces dozens.

Two "VPNs" share one vocabulary:
- The foreground "plugin VPN" (browsing) and the download workers are separate mechanisms.
- Disconnecting the foreground VPN in Settings stops every download worker (`vpn-download-runtime.ts:345-348`).
- A foreground connection silently removes its profile from the worker pool.
- Settings can say "Disabled" while 7 workers are connected.

Exhaustion recovery:
- Recovery is a per-IP "Allow again in this batch" in Settings > Data > Manage VPN profiles, two screens away from where the problem shows.

**Freshness (J2)**

One function, four names:
- "Refresh current scope from latest chapters" (Library), "Check for updates" (Updates), and "Refresh from latest chapter" / "Full metadata refresh" (Novel) all call `syncNovelFromSource` (`src/lib/plugins/sync-novel.ts:268`).
- They differ only in `since` vs `full` chapter mode, a forced cover re-download, and scope.
- Running Library refresh and Updates check together fetches every novel twice, because their dedupe keys differ.

"Updates" is not updates:
- The list is every unread chapter of every library novel, ordered by `found_at` (`src/db/queries/chapter.ts:1130-1134`).
- A newly added 500-chapter novel shows 500 "updates". Real new releases drown in backlog.

No freshness record:
- There is no per-novel last-checked, last-success or failure count.
- `novel.updated_at` changes when the user reads (`chapter.ts:719-725`), so "Updated X ago" mixes reading with source activity.
- The library tag "complete" means "everything read", not "the novel is finished" (`src/db/queries/novel.ts:350-352`).

Manual and blunt:
- Checks run only when the user taps. They cover every library novel, including finished ones.
- Failed refresh tasks are not retryable one by one (`scheduler.ts:2146-2150`). Retry re-checks the whole library.
- Opening a content-server work runs a full `parseNovel` every time. Opening an ordinary novel never refreshes it.
- Every successful source refresh bumps the content-server upload revision, even when nothing changed (`docs/content-sync.md:204-205`, `src/db/work-metadata.ts:425-428`). A 300-novel check can therefore make up to 300 works eligible for upload at the next sync.

### 2.2.3 Journeys today vs redesigned

| Journey | Today (actions, plus what goes wrong) | Redesigned |
|---|---|---|
| Download a whole 1,500-chapter novel | Novel, Download, All (2). About 2h with no ETA. Each failure needs a retry tap. A restart loses the failure list and the novel's progress. Missing-media chapters are silently skipped. | Novel, Download, "Entire novel" (2). Chapters already on the content server arrive first, in parallel. The rest come from the source with an ETA. Transient failures retry within a bound. A restart changes nothing. If the source throttles, one tap "Speed up with VPN", or it happens automatically (V1). |
| Keep the novels I'm reading ready offline | Daily: Updates, Check, wait, then scan backlog for real new ones, then download per row or select novels plus a mode (≥5 every time) | Once: set "Keep 5 ahead for novels I'm reading" (default). Then 0 per day. |
| Know what's new | Updates, Check (2), then dig through all unread | Badge on Updates. The list shows only new releases since the last visit. |
| Big download on a blocking source with VPN | Settings, Find servers, mark 3+ servers O (5+, repeated as servers die). Tasks, Download with VPN, Start (3). Relaunch after each run. Resume after each restart. Per-range notifications. | One-time: Settings > Network > VPN downloads > "Find servers automatically" (3). Then per download: 0 (automatic) or 1 ("Speed up with VPN"). Resumes after restart. One summary notification. |
| Source starts blocking mid-way | Catch a 5s toast, Verify, solve. A CDN challenge fails chapters with no hint. | A persistent Needs-attention item with Verify. Solving resumes exactly the blocked work (RD13). Other failure classes are grouped per source with one Retry. |
| After a restart | Queue resumes as one anonymous batch. Failures and pauses are gone. VPN ranges need Resume. | Everything resumes from the goals. Failures stay listed. VPN routes resume unless the user paused them (V2). |

### 2.2.4 System A: download goals

**Concept.** Each novel can hold a persistent **download goal**. The app keeps the goal satisfied as reading progresses, new chapters appear, failures clear and the app restarts.

| Goal | Meaning | Replaces |
|---|---|---|
| None | Nothing kept automatically | — |
| Keep N ahead (N = 3, 5, 10, 30) | Chapters after the reading position stay downloaded, N at a time | next10/next30, RD4 read-ahead |
| All remaining | Every chapter after the reading position, including new releases | "Download unread", RD3 |
| Entire novel | Every chapter, including new releases | "Download all" |
| Selected chapters (once) | A one-off set, chosen by selection or range (RD11) | Selection download |

**Defaults and budgets.**
- Settings > Downloads & storage > "Keep chapters ahead for novels I'm reading": Off / 1 / 3 / 5 / 10. The choice is G2. Today's default is 1 (`src/store/reader.ts:572`).
- The default goal applies only to **active** novels: in the library and opened within the last 14 days. A reader with progress in hundreds of old titles gets no sudden mass download when returning to the app.
- A novel's own explicit goal overrides the default and ignores the activity window.
- Global budgets pause automatic goal work. They never pause an explicit single-chapter download.
  - **Storage:** free space below 1 GB, or a user-set cap.
  - **Network:** "Automatic downloads on mobile data", default Off. It needs native metered-network detection (N): Android `ConnectivityManager`, the Windows network cost API.
  - **Battery:** Android battery saver on.
  - A paused budget shows one Needs-attention line, for example "Automatic downloads paused: on mobile data [Allow once]".
- "Pause automatic downloads" sits in the Downloads app bar.
- Novels not in the library get no goal unless the user sets one. One-time "download these chapters" (Selected once) always stays available.

**Where users set it.**
- Novel page: "Download" opens a sheet with the goal choices and a status line, for example "Downloading 34 of 120 · about 25 min · source Foo" or "All set · 1,200 chapters on device".
- Library selection: Download opens "Set download goal" for the selection.
- Library cards and the novel header show a small offline state: satisfied, in progress, or needs attention.

**Priority.**
1. A chapter the user is opening right now.
2. A single chapter the user tapped. This fixes today's non-promotion (`scheduler.ts:181-189`).
3. Goal work nearest the reading position of the novel read most recently.
4. Other goal work, ordered by distance from the reading position.

All of it keeps the existing per-source serial execution and cooldown (plugin fetch invariant).

**Content server first, planned per novel (G4).** When a goal is set or grows, the app lists the work's server chapters (`fetchServerChapters`, which pages 100 at a time, `src/lib/content-sync/chapters.ts:18`).
- Chapters the server has download on a **server lane**. That is app-owned traffic to the user's own server, not plugin-owned site traffic (CLAUDE.md "App and repository fetches may use ordinary app-side HTTP helpers"). It has its own small concurrency (default 3) and no source cooldown.
- The server lane is an **execution route of the same queued job**, not a second queue, so a chapter has one owner.
- Each transfer revalidates identity and completeness at download time, because the listing may be stale.
- A failed server transfer falls back to the source exactly as today (`docs/content-sync.md:87-105`).
- Server-only chapters never go to a plugin.
- Only the remainder enters the source queue.
- If the listing fails, the novel falls back to today's per-chapter lookup.

**Failure policy.** This **reverses commit 627c530's manual-retry decision** (G3 needs the user's approval). It keeps 627c530's other reasons:
- every attempt is a fresh enqueue (`chapter-download.ts:1077`), with registration and cleanup
- failures stay visible: a chapter waiting to retry shows "Retrying in 2 min · Cancel" from the first failure, not only after the last
- the retry budget is persisted with the failure state, so a restart cannot reset it into a loop

| Failure class | Automatic behavior | Shown to the user |
|---|---|---|
| Offline, route change | Wait and resume (unchanged) | Nothing |
| Timeout, HTTP 429/503 (honoring `Retry-After`), transient network | Up to 3 fresh enqueues with backoff (30s, 2min, 10min). Each attempt is recorded. | "Retrying" with Cancel on the row and novel status. Needs attention after the last attempt. |
| Challenge on the source host | The source is blocked until verified (unchanged). Verify resumes the blocked work (RD13). | Needs attention: "Source Foo needs verification [Verify]" |
| Challenge on another host (a CDN), currently a plain error (`src/lib/http/response.ts:88-93`) | Classified as a challenge for that host, so it is treated like the row above | Same |
| Plugin parse error, storage error | No retry | Needs attention, grouped: "Source Foo: 12 chapters failed (couldn't read the page) [Retry all] [Details]" |
| Missing media | One automatic repair attempt once the source is reachable | "8 chapters are missing images [Repair all]" |

- Status reports body count and media completeness **separately**, for example "1,200 chapters · 8 missing images". This keeps the body-count rule (`docs/release-compatibility.md:95`), so missing images are visible instead of hidden inside "downloaded".
- Failure state is **persisted per chapter**: class, last error summary, attempts, retry budget and time. It survives restart, the Needs-attention list rebuilds from it, and it is cleared when that chapter later succeeds.

**Ownership.**
- Goal reconciliation never writes queue rows itself. It submits requests through the existing submission path (`src/lib/tasks/chapter-download-requests.ts:59-120`), so every chapter keeps exactly one owner across ordinary, server and VPN execution and handover.
- Cancelling a goal's work stops the goal. If the user deletes a novel's downloads while it has a goal, the app asks "Also stop keeping this novel downloaded?".
- Removing a novel from the library cancels its goal. Its downloads are kept unless deletion is chosen.
- A disappearing plugin pauses the goal with "Source unavailable".
- After a device restore, goals are restored but generate no work until the restore pause fence clears (`docs/release-compatibility.md:279`) and the user resumes downloads.

**Restart.** Goals and failure state are durable. On launch the app recomputes the remaining work as goal targets minus stored chapters, and enqueues it with the right priority. It does not depend on restoring batch identity. Per-novel progress is derived from the database, so it is never lost.

**ETA.**
- Each source keeps a rolling average of chapter duration.
- A novel's ETA is its position in that source's serial order times that average. The server lane is estimated separately.
- It is shown as "about 25 min", or "a few hours" when the estimate is over 2h.

**Scope:**
- M (appended):
  - `novel_download_goal` table: novel id, goal kind, N, updated time
  - chapter download failure state: new table keyed by chapter id
  - per-source duration samples in memory only
- B:
  - Goals are user intent, so they join the portable backup and the format version is bumped.
  - Failure state is runtime state. It joins only the exact-schema device backup.
- Q: goal resolver, priority, server lane, failure classifier, bounded retry.
- U: the goal sheet, offline indicators and Needs attention.

### 2.2.5 System B: VPN as a per-source route

**Concept.** The user does not "run VPN downloads". The app downloads a source's goal work over one of two **routes**: Direct, or VPN workers. The route belongs to the source, not to a global run. While a source is on the VPN route, all of its goal work and new requests use it, and the route ends by itself when that source has nothing left.

**When a source switches to VPN** (setting "VPN downloads": Off / Ask / Automatic; Android only):
- **Automatic** (default, V1, updated by the user on 2026-11-03: "just handle it well"): when a source is **diagnosed** as limiting downloads and VPN downloads are supported and usable, the source switches to the VPN route without asking, and the novel row shows a small "VPN" label.
- **Ask** (opt-in): the novel status line and Needs attention offer "Speed up with VPN" instead. One tap switches that source.
- **VPN machinery is invisible by default.** Runs, ranges, workers, profiles and IPs never appear in the default Downloads view. VPN-owned work shows in the same per-novel list as ordinary downloads. The technical breakdown lives only in a per-novel "Details" sheet. The user sees a VPN problem only when the app cannot solve it alone: a manual verification, or no eligible server at all.
  - Limiting means repeated reachability-class failures (timeouts, connection failures, IP-level blocks), or sustained throughput below 50% of that source's own baseline over the last 10 chapters.
  - A long ETA alone is not a trigger.
  - The first automatic switch on a device shows a one-time notice that downloads go through public volunteer relays, with a link to turn the behavior off.
  - The user can choose "Always use VPN for this source". It is remembered as a per-source preference, separate from the live connection, so a keep-ahead goal does not flap the route as new chapters arrive.
  - Idle worker connections close after 5 minutes without work.
- CAPTCHA-only blocks stay Verify-first and never trigger the route.
- This reverses the 2026-11-03 rule that ordinary requests stay ordinary until the user launches VPN downloading, so it needs the user's approval (V1).

**Contracts kept from the agreed VPN designs:**
- the app chooses profiles and ranges, with no per-work assignment
- contiguous, non-overlapping ranges that are never stolen
- exhaustion pauses only the affected range, and there is no endless wraparound
- O/X is the user's device-wide verdict
- replacement retries the same chapter
- an explicit pause is final
- never fall back silently from VPN to Direct
- isolated worker processes
- the plugin fetch invariant

**Changes:**

1. **Chunked ranges (V3; needs device measurement).**
   - A source's VPN work is split into fixed-size contiguous chunks (default 50 chapters) at enrollment. Chunks are frozen once created.
   - A free worker takes the next unstarted chunk of the highest-priority work for that source.
   - Parallelism therefore grows as profiles become available, instead of being fixed by the pool size at enrollment.
   - It is still contiguous and still not round-robin per chapter. An in-progress chunk is never taken from another worker.
   - **True scope:**
     - Today every range requires an assigned profile id and hash (`src/db/queries/vpn-download-plans.ts:59-61`), and scheduling iterates enrolled ranges (`src/lib/tasks/vpn-download-coordinator.ts:528`).
     - Chunks therefore need durable ids and checkpoints, a profile lease deferred until dispatch (a plan contract change in TS and Rust), a bounded plan size, and priority across works.
     - Existing enrolled ranges migrate unchanged, as chunks that already hold their profile.
     - The chunk size of 50 is a starting point to validate on Y700 and Waydroid.
   - **Changed chapter order or identity.** Before each chapter, a chunk validates its frozen chapter ids. Missing or renumbered chapters are reported, not guessed.
2. **Server discovery (V4; reverses approved-profile-only allocation).**
   - Today only O-approved retained profiles are allocated (`docs/superpowers/specs/2026-11-03-automatic-vpn-download-queue-design.md:116`), and the vault excludes files without O (`docs/superpowers/plans/2026-11-02-vpn-profile-downloads.md:51`).
   - **Step 1, discovery and testing** (no reversal). The app refreshes the VPN Gate list (at most every 6h while VPN downloads are needed) and test-connects candidates. These are shown as "Tested servers" with results.
     - A tunnel test alone does not prove source access, cookies or background stability. A tested server is ranked by its test, then by its real download results.
     - Tests use an idle worker slot and never preempt download work (10 native slots, `src-tauri/src/plugin_vpn/download_workers.rs:217`).
   - **Step 2, usage policy** (the reversal, V4):
     - **"Approved only"** (today's rule): the user approves tested servers with one action, "Approve all working".
     - **"Use tested servers automatically"** (opt-in): unmarked tested servers may be leased. The user's verdicts still win. X is never used. O verdicts and files are never retired or changed automatically.
   - The Finder and manual O/X stay available under Network > Advanced.
3. **Durable route state (V2; reverses explicit restart resume, `docs/superpowers/specs/2026-11-03-automatic-vpn-download-queue-design.md:188`).**
   - Each source's route (Direct / VPN active / VPN paused by user) is persisted.
   - An active route resumes automatically **only** when all of these hold:
     - the process restarted ordinarily
     - the user enabled "Resume VPN downloads after restart"
     - network and storage are intact
   - It **never** resumes after a device restore (that keeps the restore pause fence, `docs/release-compatibility.md:279`), nor after a user pause.
   - One summary notification ("VPN downloads resumed: 3 sources") replaces per-range notifications.
   - Grouped notifications keep each range's identity and generation, so a Verify action opens the right worker session.
4. **Separate controls (V5).** Until the new controls ship, the explicit VPN-off safety semantics stay unchanged (`docs/superpowers/plans/2026-11-02-vpn-profile-downloads.md:83-94`).
   - Network shows two features: **Browse through VPN** (the foreground plugin VPN) and **VPN downloads** (workers, with their own status: "3 connections · 2 sources").
   - Disconnecting Browse no longer stops downloads (`vpn-download-runtime.ts:345-348`). Downloads have their own Pause/Stop.
   - When the foreground uses a pooled profile, the pool shows it as "in use for browsing".
   - Sources that need a login in each isolated worker are not VPN-eligible. Their offer says why.
5. **Exhaustion where it happens.**
   - A chunk that exhausts its candidates shows in Needs attention as "Foo: 1 part paused, no working servers left".
   - It offers Find more servers (runs the automatic pool now), Allow excluded servers again (this batch only), or "Continue without VPN". The last is an explicit, per-source switch back to Direct, never silent.
6. **History.** Finished routes keep a one-line summary ("Foo: 1,450 chapters via VPN, 2h 10m"). Completed plans and chunks are pruned after a successful finish.
7. **Windows.** VPN downloads are unsupported, so the feature and its offers are hidden instead of showing a disabled button.

**Scope:**
- M (appended): source route state; chunked plan fields (the chunk size on the plan; chunks reuse range rows); automatic pool entries distinct from O/X verdicts.
- B: route state goes to the exact-schema device backup only.
- Q: coordinator dispatch from the chunk queue; route triggers; pool refresh and tests.
- N: the Rust finder/vault store unmarked automatic entries separately from O-approved files; test connects use the existing worker slots.
- U.

### 2.2.6 System C: one freshness model

**One operation, one name.** "Check for new chapters" is the only user-facing refresh. It runs the existing `since` path (metadata plus new chapters). The app falls back to `full` on its own when the anchor is missing or inconsistent, as it already does (`sync-novel.ts:231-265`), and also when gap or duplicate signals suggest renumbering (`sync-novel.ts:127-163`).
- The novel overflow keeps "Rebuild chapter list" (full) for the rare manual case.
- The Library "Refresh current scope" button and the novel-page latest/full pair are removed.

**Per-novel freshness record** (M, appended): `last_checked_at`, `last_success_at`, `consecutive_failures`, `last_new_chapter_at`.

**Cadence by reading state** (automatic checks run only while the app is visible; overlap guard; a missed run happens on the next foreground return):

| Novel state | Check every |
|---|---|
| Reading (progress, not finished), or a goal is set | Interval (default 12h) |
| In library, not started | 3 days |
| Status Completed (source status) or fully read | 7 days (extras and corrections still arrive) |
| `consecutive_failures` ≥ 3 | Backs off: 1 day, then 3, then 7. Shown as "Paused checking: failing since Mon [Check now]". |

- Novels being read are checked first. Sources run in parallel and each source stays serial (unchanged).
- **Per-source budget:**
  - at most 30 checks per source per hour, with backoff when the source slows down or fails
  - catch-up on foreground return is bounded: active novels first, the rest spread over the following hours rather than one sweep
  - automatic checks follow the same mobile-data and battery budgets as goals
- "Check now" (Updates app bar, novel overflow) is always available, and it ignores the cadence but not the source budget.
- Novel page: opening a novel whose `last_checked_at` is older than 6h starts a background check and shows "Checking…" in the header. It replaces today's full `parseNovel` on every open of a server work.

**Updates shows chapters found by checks** (M, appended):
- A chapter gets `found_by_check = 1` when a check *inserts* it into a novel that already had chapters. Initial imports and the first sync do not count.
  - This means "first found by this device", not "released by the site". The UI says "New chapters found".
  - Sorting uses the source's release time when the plugin provides a parseable one, otherwise the found time.
- Updates lists unread chapters found by checks, grouped by date. The nav badge counts those found since the user last opened Updates (stored `updatesSeenAt`).
- The unread backlog stays on the novel and the library unread badge. Updates has an "Earlier unread chapters" link to a backlog view.
- This removes the "500 updates" problem (`chapter.ts:1130-1134`).
- Migration: every existing chapter gets 0. There is no backfill, because found time cannot tell a recently imported old chapter from a release. The first check after the update starts the list.

**Covers.** `novel.cover` already stores the source cover value (`src/db/schema.ts:66`, `src/lib/plugins/sync-novel.ts:302`).
- The image is downloaded again when that value changes.
- With an unchanged URL, it is downloaded at most every 30 days, or on "Rebuild chapter list", because sites sometimes replace the bytes behind the same URL.
- Today's forced re-download on every Library or Novel refresh is dropped.

**Failures.**
- Failures are recorded per novel, so Retry re-checks only the failed novels, per source. That replaces today's whole-library retry and the non-retryable tasks (`scheduler.ts:2146-2150`).
- Challenges use RD13.

**Content-server churn.** The upload revision is bumped only when the stored metadata actually changes.

**Server works.** Opening a content-server work keeps its independent server metadata lookup (`src/lib/content-sync/work-refresh.ts:20`). Its source refresh (`work-refresh.ts:94`) follows the 6h staleness rule above instead of a full `parseNovel` on every open.

**Supersedes:**
- RD2: automatic checks become this cadence.
- RD3: new-chapter downloads become goals.
- RD4: read-ahead becomes the default goal.
- RD16: "Download all new" becomes the "Download new releases" action on Updates and the goals.
- RD19: the VPN offer becomes the route trigger.

**Scope:**
- M: appended after the registered version 3 (`src-tauri/src/database.rs:29`). It adds the freshness columns and the `found_by_check` flag, with no backfill.
- B: freshness goes to device backup only. The release flag follows chapter rows in both backups.
- Q: scheduler cadence, check ordering, per-novel retry, revision bump on change only.
- U: removal of the old refresh entry points.

### 2.2.7 One attention surface (J4)

Everything that needs the user lands in **Needs attention**: the top of the Downloads hub, mirrored in the More badge and the notifications. Items are grouped by cause and source, and each has one primary action.

| Item | Action |
|---|---|
| Source needs verification (downloads, checks, searches) | Verify |
| Source failures grouped by class | Retry all · Details |
| Chapters missing images | Repair all |
| VPN part paused with no servers left | Find more servers · Allow again · Continue without VPN |
| Source limiting downloads (Ask mode) | Speed up with VPN |
| Storage folder unavailable | Choose folder |
| Backup folder unavailable (RD15) | Choose folder |
| Android paused background work | Open |

- Notifications are summaries per cause ("3 sources need attention"), not one per range or chapter.
- A grouped item opens its affected novels and chapters directly.
- Dismissing an item hides the notice, but never cancels an unsatisfied goal. The novel keeps showing "needs attention".
- Persistent items stay until they are resolved or dismissed.
- Further items:
  - "Storage almost full: automatic downloads paused" [Manage storage]
  - "Automatic downloads paused on mobile data" [Allow once]

### 2.2.8 Decisions for the user

**Reversal** marks a decision that overturns an earlier, explicitly agreed rule. It needs the user's approval even when it is recommended.

**Decided by the user on 2026-11-03:** every recommendation below is accepted, including the four reversals.
- G3 replaces 627c530's manual-retry rule.
- V1 replaces "ordinary until launched".
- V2 replaces explicit restart resume.
- V4 is approved as an opt-in policy only, with "Approved only" as the default.

The earlier VPN design documents stay as history. This section governs where they differ.

| ID | Decision | Recommendation | Reversal? | Why |
|---|---|---|---|---|
| G1 | Download goals replace one-shot download modes; "Selected once" stays | Yes | No | The intent survives restarts and new chapters, and per-novel progress is never lost |
| G2 | Default keep-ahead for **active** novels (opened within 14 days), under storage, mobile-data and battery budgets | 3 ahead, mobile data off | No | It covers a session offline without mass downloads for old titles. Today's default is 1. |
| G3 | Bounded automatic retry for transient failures: 3 fresh enqueues with backoff, visible "Retrying · Cancel", persisted budget | Yes | **Yes**, 627c530's manual-retry rule | It removes taps for failures that heal by themselves, while keeping fresh enqueues and visibility |
| G4 | Server lane as a second execution route of the same job, with revalidation and source fallback | Yes | No | Server chapters stop waiting behind the source's serial queue |
| V1 | VPN route trigger: Automatic (default, user update 2026-11-03) / Ask / Off, using a diagnosed limit only, per-source "Always" preference | Automatic | **Yes**, "ordinary until launched" (`2026-11-03-automatic-vpn-download-queue-design.md:57`) | It removes the hunt for the feature without surprise connections |
| V2 | Resume VPN routes after an ordinary restart when the user opted in; never after a device restore or a user pause | Opt-in, default on | **Yes**, explicit restart resume (`same:188`) | Today every restart needs Resume, plus a notification for each range |
| V3 | Fixed-size contiguous chunks with deferred profile lease, size validated on device | Yes, after measurement | Partly (partition rule) | Parallelism grows with available servers, and no worker idles while a range waits for its own profile |
| V4 | Automatic discovery and testing (no reversal) plus a usage policy: "Approved only" (default) or "Use tested servers automatically" (opt-in) | Approved only, with "Approve all working" | **Yes**, for the opt-in policy (`same:116`, `vpn-profile-downloads.md:51`) | It removes the manual hunt for servers. Using unmarked relays stays the user's explicit choice. |
| V5 | Browse-through-VPN and VPN downloads controlled separately | Yes | Partly (explicit-off coupling) | Disconnecting browsing should not silently stop downloads |
| F1 | Updates lists chapters found by checks, with no backfill, plus an "Earlier unread" link | Yes | No | Today's list is every unread chapter, so new ones are invisible |
| F2 | Check cadence by reading state, with per-source budgets and bounded catch-up | 12h for active novels | No | It checks what the user reads often and finished novels rarely, without flooding a source |
| F3 | One "Check for new chapters" operation; "Rebuild chapter list" in the overflow | Yes | No | Four names for one function confuse users and fetch twice |

### 2.2.9 Edge cases that must have an answer

| Case | Behavior |
|---|---|
| Storage runs out during a goal | Automatic goal work pauses at the storage budget. Needs attention offers Manage storage. In-flight chapters settle and nothing is half-written. |
| Mobile data or battery saver | Automatic goals and checks pause per the budgets. Explicit downloads continue. |
| Novel removed from the library | Its goal is cancelled. Downloads are kept unless the user chose deletion. |
| Plugin uninstalled, or its chapter identity changes | The goal pauses with "Source unavailable" or "Chapter list changed: [Rebuild]". VPN chunks validate their frozen chapter ids before each chapter. |
| Source requires a login | Not VPN-eligible, because isolated workers have no shared session. The offer explains why. |
| A failed chapter later succeeds | Its failure state and Needs-attention entry clear automatically. |
| Device restore | Goals and routes are restored but generate no work until the restore fence clears and the user resumes. |

## 3. App map

```
/                      Library                                   (RD1, RD10)
/updates               Updates                                   (RD2, RD16)
/history               History                                   (RD21)
/browse                Search (default) | Sources | Server(if configured)
/browse/extensions     Extensions: repositories, updates, installed, available   [S1] (RD6, RD7)
/source                Source catalog                            (RD8, RD13, RD22)
/novel                 Novel detail                              (RD11)
/novel-merge           Migrate source (3 steps)                  (RD12)
/reader                Reader                                    (RD4, RD17)
/downloads?view=queue|storage  Downloads hub (D4)                (RD3, RD5, RD19)
/settings, ?section=x  Settings                                  (RD18)
/more                  More (D3)
/setup                 First-run setup                           (RD9)                [S11]
(removed) /tasks
```

Bottom nav and rail: Library · Updates · History · Browse · More. Browse keeps Search as its default tab, as it is today (`src/router.tsx:38`).

## 4. Library

### 4.1 Functions

| Function | Class | New location |
|---|---|---|
| Open a novel | Core | Card tap |
| Continue reading recent novels | Core | RD1 shelf (All view) |
| Switch category: All, user categories, Uncategorized (`LibraryCategories.tsx:82`) | Core | Category tabs (phone/tablet); in-page category list (≥992) |
| Search titles | Frequent | Phone: the 🔍 icon expands the app bar into a field. Desktop: inline field. Results end with RD10. |
| Quick filters Unread, Downloaded | Frequent | Chip row: [Unread] [Downloaded] [Filters (n)]. One tap on every width. |
| Other filters: local, completed, needs repair, source | Occasional | "View options", Filter tab. Today's boolean flags plus a single source (`src/db/queries/novel.ts:52`). |
| Sort (field + direction) | Occasional | "View options", Sort tab |
| Display (mode, columns, badges, continue shelf) | Rare | "View options", Display tab, which remembers the last tab |
| Refresh library details for the current view (`refreshLibraryMetadata`, `library.tsx:205`) | Occasional | Desktop app bar; phone overflow. The result shows as a toast. New chapters arrive through RD2. |
| Select multiple | Occasional | Long-press, a hover checkbox (fine pointer), or the overflow "Select" item (keyboard) |
| Batch download all / unread / next 10 / next 30 (`LibraryBatchDownloadPicker.tsx:28-40`) | Occasional | Selection bar: Download, then a sheet with 4 options and counts |
| Add the selection to / remove it from categories (`LibraryCategories.tsx:225`) | Occasional | Selection bar: Categories, then a sheet. Each category row shows all/some/none and offers Add or Remove, with explicit Apply/Cancel. |
| Delete downloads / remove from library | Occasional | Selection bar More, confirmed with counts and size |
| Category add / rename / delete / order | Rare | Overflow: Manage categories, then a full-screen dialog (phone) or modal (desktop). Desktop also has "+ Category" in the list. |
| Import files | Rare | Overflow: "Import files" (§16), plus drag-and-drop on Windows (RD14) |
| Open the local files work (`openLocalHome`) | Rare | Overflow: "Local files". The misleading "+" glyph is removed. |
| Library settings | Rare | Overflow, which opens Settings > Library |
| Storage recovery | Operational | A banner above the grid while active, failed (Retry) or completed (Dismiss) |
| Status strip, header meta, "0 selected" strip, tags footer, Ctrl K | Noise | Removed |

### 4.2 Phone layout

```
┌─────────────────────────────────┐
│ Library              🔍  ⧉  ⋮   │  🔍 search, ⧉ view options, ⋮ overflow
├─────────────────────────────────┤
│ All 120 │ Reading 8 │ Uncat. 4 │›│  category tabs
├─────────────────────────────────┤
│ [Unread] [Downloaded] [Filters 1]│  quick chips; Clear appears when active
├─────────────────────────────────┤
│ Continue reading            ▾   │  RD1 (All view only)
│ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ›           │
│ │◔ │ │◑ │ │◕ │ │◔ │  Ch. 52 …   │
│ └──┘ └──┘ └──┘ └──┘             │
├─────────────────────────────────┤
│ ┌────┐ ┌────┐ ┌────┐            │
│ │ 3  │ │    │ │ 12 │  unread badge
│ │▬▬▬ │ │▬   │ │▬▬▬▬│  progress
│ └────┘ └────┘ └────┘            │
│ Title  Title  Title             │
│ Author Author Author            │
├─────────────────────────────────┤
│ ▣Library ◷Updates ⟲History ⌕Browse ≡More │
└─────────────────────────────────┘
```

Phone overflow: Refresh library, Select, Import files, Local files, Manage categories, Library settings.

**Selection mode:**

```
┌─────────────────────────────────┐
│ ✕  3 selected   Select all  Clear│
├─────────────────────────────────┤
│   grid with check overlays      │
├─────────────────────────────────┤
│ ⤓ Download │ ▦ Categories │ ⋮ More │
└─────────────────────────────────┘
```

Back or ✕ exits selection mode.

### 4.3 Desktop layout (≥992px)

```
┌ rail ┬──────────────────────────────────────────────────────────┐
│      │ Library            [ Search titles…   ] ⟳  ⧉ View  ⋮      │
│      ├────────────┬─────────────────────────────────────────────┤
│      │ All    120 │ [Unread] [Downloaded] [Filters]             │
│      │ Reading  8 │ Continue reading ▸ ┌──┐┌──┐┌──┐┌──┐┌──┐┌──┐ │
│      │ Uncat.   4 │ ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐          │
│      │ ─────────  │ │   │ │   │ │   │ │   │ │   │ │   │          │
│      │ + Category │ └───┘ └───┘ └───┘ └───┘ └───┘ └───┘          │
└──────┴────────────┴─────────────────────────────────────────────┘
```

### 4.4 Task flows

| Task | Before | After |
|---|---|---|
| Resume the book I was reading | 2 | 1 (RD1) |
| Open a novel | 1 | 1 |
| Switch category (phone) | 2 | 1 |
| Show only unread | 1 desktop; hidden on phone | 1 everywhere |
| Find a title I don't have yet | 4 (switch to Browse, retype) | 1 (RD10) |
| Download unread of 3 novels | 5, no feedback | 5, with a toast; 0 with RD3 for new chapters |
| Library settings on a phone | Impossible | 2 |

### 4.5 Implementation mapping

- `src/routes/library.tsx`: app bar, quick chips, RD1 shelf, RD10 fallthrough. Removes the selection strip, status strip and header meta.
- `src/components/library/LibraryFilters.tsx` becomes `LibraryViewOptions` (Filter/Sort/Display), absorbing `LibrarySettingsPanel` display fields.
- `LibraryCategories.tsx` and `CategoriesDrawer.tsx` become `CategoryTabs`, `CategoryList` and `CategoryManager`. `LibraryCategoryDialogs.tsx` is kept for names.
- `src/components/LibraryGrid.tsx`: card redesign; list mode on `ListRow`.
- `LibraryBatchDownloadPicker.tsx`: its content moves into the selection-bar sheet.
- Deleted: `LibrarySelectionToolbar.tsx` and the dead mobile category button.

## 5. Novel detail

### 5.1 Functions

| Function | Class | New location |
|---|---|---|
| Continue reading (resume rule as RD1) | Core | Primary button "Continue · Ch. N" (or "Start reading") |
| Start from the beginning (`NovelWorkspace.tsx:409`) | Occasional | Secondary labeled button "From start", next to Library and Download |
| Browse and open chapters | Core | Chapter list |
| Summary, genres | Frequent | Header zone. The summary clamps at 3 lines and expands; genres expand with it. |
| Download goal: none / keep N ahead / all remaining / entire novel / selected once (§2.2.4) | Frequent | "Download" button, then the goal sheet with a status line ("Downloading 34 of 120 · about 25 min") |
| Per-chapter download / retry / delete | Frequent | A trailing download-state button. On a downloaded row it opens Delete download. |
| Repair media (when needed) | Recovery | The trailing button becomes "Repair" in place (§1.4) |
| Add to library | Occasional | "Add to library". The toast offers "Change category" [replaces S5]. |
| Remove from library | Occasional | "In library ✓", then a confirm with options: also delete N downloaded chapters (size), and also delete from server (only for server works, relocated from `ContentDeletionDialog.tsx:89`) |
| Categories | Occasional | Assigned categories show as chips under the title, and tapping a chip opens the category sheet. A novel in the library with no category shows a "+ Category" chip. The sheet has Clear, Cancel and Apply and shows save errors inline (`NovelCategoryEditor.tsx:114`). This is as direct as today's visible Edit button (`:80`). |
| Select chapters; select all / clear; range (RD11) | Occasional | Long-press or the header "Select". The action bar shows Select all and Clear. |
| Mark read / unread, download, delete downloads (selection) | Occasional | Selection bar |
| Download previous (works with multiple selected, `novel.tsx:591`), mark previous read, mark following unread (need one anchor; exclude it) | Occasional | Selection bar More, with labels that state the anchor is excluded |
| Chapter sort | Occasional | List header toggle |
| Check for new chapters / refresh all details | Occasional | Overflow |
| Migrate to another source | Rare | Overflow |
| Open in WebView | Rare | Overflow |
| Reader settings for this novel | Rare | Overflow, which opens reader settings scoped to this novel |
| Manage server data: refresh, pages, select page, clear selection, delete selected, delete work (`ServerChapterManager.tsx:103`) | Rare | Overflow, then a full-screen dialog with those controls |
| Server-incomplete chapter status | Secondary (actionable) | A visible meta badge "Incomplete on server", only when a content server is configured and the chapter is incomplete |
| Local work: edit info, add chapters, reorder | Rare | Overflow. Reorder is an explicit mode with drag handles plus up/down buttons for keyboard and single-pointer use [S6]. |
| Duplicate-source, download phase detail, raw errors | Diagnostic | Row Details. A failure shows a one-line reason plus Retry inline. |

### 5.2 Phone layout

```
┌─────────────────────────────────┐
│ ←  (title appears on scroll)  ⋮ │
├─────────────────────────────────┤
│ ┌──────┐  The Novel Title That  │
│ │cover │  Can Wrap Two Lines…   │
│ │ 2:3  │  Author Name           │
│ └──────┘  Ongoing · Source Foo  │
│           [Romance] [Fantasy]   │  category chips if assigned
│ ┌─────────────────────────────┐ │
│ │ ▶  Continue · Ch. 52        │ │
│ └─────────────────────────────┘ │
│ ✓ In library  ⤓ Download  ↺ From start │
│ Summary clamped to three lines… More ▾ │
├─────────────────────────────────┤
│ 248 chapters · 40 downloaded ⇅ ☐│  sticky: sort, select
├─────────────────────────────────┤
│ Ch. 1  Prologue             ✓  │  read rows dimmed
│ Ch. 52 The Storm   ◔ 45%    ⤓  │  current row marked
│ Ch. 53 Aftermath ⚠ Failed [Retry]│
│ Ch. 54 Media missing   [Repair] │
└─────────────────────────────────┘
```

A single page scroll; the list is windowed against it.

### 5.3 Desktop layout (≥992px)

```
┌ rail ┬───────────────────────┬──────────────────────────────────┐
│      │ ←                    ⋮│ 248 chapters · 40 downloaded  ⇅ ☐│
│      │ ┌─────────┐           ├──────────────────────────────────┤
│      │ │  cover  │           │ Ch. 1  Prologue               ✓ │
│      │ └─────────┘           │ …                                │
│      │ Title · Author        │                                  │
│      │ [▶ Continue · Ch. 52] │                                  │
│      │ [✓ In library][⤓ Download][↺ From start]                 │
│      │ Summary · Genres      │                                  │
└──────┴───────────────────────┴──────────────────────────────────┘
```

The info pane is 22rem wide and scrolls independently when the summary is expanded.

### 5.4 Task flows

| Task | Before | After |
|---|---|---|
| Continue reading | 1, icon-only, disabled without history | 1, labeled, never disabled when chapters exist |
| Mark chapters 1-50 read | 3 hidden | 3 visible (RD11) |
| Download chapters 100-150 | 51 | 3 (RD11) |
| Add to library with a category | Library, Edit, pick, Save (4) | Library, toast "Change category", pick, Apply (4), or 1 with no category |
| Repair a chapter's media | 1 | 1 |

### 5.5 Implementation mapping

- `NovelWorkspace.tsx`: header zone, two-pane layout.
- `NovelActions.tsx`: overflow, Download sheet, library toggle.
- `NovelCategoryEditor.tsx`: chips plus sheet.
- `NovelChapterList.tsx`: `ListRow`, download-state button, Repair in place, details, reorder mode, range selection.
- `src/routes/novel.tsx`: `SelectionBar`.
- `ServerChapterManager.tsx`: full-screen dialog.
- `use-local-novel-editor.tsx`: full-screen on phones.
- `ContentDeletionDialog.tsx`: un-shelve variant with optional device and server deletion.

## 6. Reader

### 6.1 Functions

| Function | Class | New location |
|---|---|---|
| Read, page/scroll | Core | Reading surface |
| Toggle chrome | Core | Center tap, a key, and Escape precedence |
| Next / previous chapter | Core | Bottom bar and keys. RD17 at the end of the novel. |
| Seek within the chapter | Frequent | Bottom bar seekbar with a page/percent label |
| Jump to a chapter | Frequent | Bottom bar "Chapters": a sheet scrolled to the current chapter (phone/tablet), or a toggleable left panel at ≥1200px |
| Text size, theme, mode (scroll / paged / two-page, `ReaderSettingsPanel.tsx:604`) | Frequent | "Aa", always visible at the top |
| Line height, margins, font, alignment | Frequent | "Aa", scrollable below |
| Settings scope with inheritance (all / source / novel; `use-reader-settings.ts:22`) | Occasional | "Aa" header: "Applying to: All novels ▾". The menu offers All novels, This source, This novel, "Use inherited settings" (turns the current override off) and "Use these settings for all novels" (RD23). Turning a scope on copies the effective values. When a narrower scope overrides what is being edited, a notice says "This novel has its own settings. [Edit this novel]". |
| Auto-scroll: switch, interval and step with units (`:480-511`) | Occasional | "Aa", Auto-scroll section. The two existing fields keep their meaning, and play/pause sits in the bottom bar while it is enabled. |
| Read-ahead count (RD4), full-page, keep screen on, page transition, PDF fit, HTML image paging | Rare | "Aa", More settings, Reading. Settings that do not apply to the current mode or content are hidden. |
| Tap preset (named cards), swipe, tap toggle | Rare | More settings, Controls |
| Indicators | Rare | More settings, Indicators |
| Custom colors, save theme | Rare | More settings, Colors |
| Bionic, paragraph spacing, CSS preset, custom CSS, custom JS (warning line) | Rare | More settings, Advanced |
| Reset | Rare | More settings footer. The confirm states the scope and keeps overrides by default. |
| Bookmark | Occasional | Top bar |
| Repair media (when media is missing) | Recovery | A top bar icon shown only while needed (§1.4) |
| Pause reading history | Occasional | A top bar overflow toggle. The "History paused" pill shows on every width while it is on. |
| DB id, "Offline", duplicated progress | Noise | Removed |

### 6.2 Phone layout

```
Chrome hidden                       Chrome shown (center tap)
┌─────────────────────────────┐     ┌─────────────────────────────┐
│                             │     │ ←  Novel name       🔖 ⟳ ⋮  │  ⟳ = repair, only when needed
│  Text text text text text   │     │    Ch. 52 · The Storm       │
│  text text text …           │     ├─────────────────────────────┤
│                             │     │  Text …                     │
│                     45%  ⏲  │     ├─────────────────────────────┤
└─────────────────────────────┘     │ ━━━━━━━━●──────────  p. 4/9 │
                                    │ ◀ Prev  ≡ Chapters  Aa  Next ▶│
                                    └─────────────────────────────┘
```

In normal mode (`fullPageReader` off, D5), the same bars stay visible. The global nav is never shown in the reader.

**"Aa" sheet (phone)**
- Default height about 55%, with a drag handle up to 90%.
- The sticky top block keeps the three most used controls visible even with enlarged text.
- The body scrolls.
- "More settings" pushes a second level inside the sheet, with Back and persistent section tabs.

```
┌─────────────────────────────┐
│ ▔▔▔ Applying to: All novels ▾│
│ Size  − 18 +   Theme ●●●●⊕  │  sticky
│ Mode [Scroll][Paged][2-page]│  sticky
├─────────────────────────────┤
│ Line height  − 1.6 +        │  scrolls
│ Margins      − 16  +        │
│ Font [Original][Pretendard]…│
│ Align [left][justify]       │
│ Auto-scroll ○  every 80 ms · 1 px │
│ More settings ›             │
└─────────────────────────────┘
```

### 6.3 Desktop layout (≥1200px)

```
┌───────────────┬──────────────────────────────────┬──────────────┐
│ Chapters      │ ←  Novel · Ch. 52      🔖 Aa ⋮   │ Aa (panel)   │
│  51 …         ├──────────────────────────────────┤ Applying to… │
│ ▸52 The Storm │   text column, max 40rem         │ Size − 18 +  │
│  53 …         ├──────────────────────────────────┤ …            │
│               │ ━━━━━━●──────   ◀ Prev  Next ▶   │              │
└───────────────┴──────────────────────────────────┴──────────────┘
```

The side panels are optional and remembered per device.

### 6.4 Implementation mapping

- `ReaderChrome.tsx`: bars, chapter sheet/panel, RD17 card.
- `use-reader-chrome.ts`, `use-reader-gestures.ts`, `use-reader-keyboard.ts`: unified toggle, dismiss-on-tap, focus-aware auto-hide, key precedence.
- `ReaderSettingsPanel.tsx` splits into `ReaderQuickSettings` (first level, with the scope menu and inheritance notice) and the grouped second level.
- `src/store/reader.ts`: RD4 field and mapping.
- `src/routes/__root.tsx`: hide the nav on `/reader`.

## 7. Updates

### 7.1 Functions

| Function | Class | New location |
|---|---|---|
| See new releases (chapters inserted by checks into novels that already had chapters; §2.2.6) | Core | Grouped by date. Within a date, runs of more than 3 new chapters of one novel collapse into "Novel B — 8 new". Runs of 3 or fewer stay as individual rows, so a specific chapter needs no expansion in the common case. |
| Read a new chapter | Core | Row tap opens the reader. A collapsed group's tap opens its earliest new chapter, and the chevron expands it. |
| Download one / all new (RD16) | Frequent | Row download button; "Download all (N)" on each date header and in the overflow |
| Open the novel | Occasional | Cover tap. The cover is a sibling button next to the row body, not nested in it, so this stays one tap as it is today (`updates.tsx:379`). |
| Check now | Occasional (RD2 makes it automatic) | App bar refresh. Progress shows as "Checking 3/12 sources · Cancel". The last check time sits under the title. |
| Failed checks | Recovery | With exactly one failed source, its action (Verify or Retry) shows inline under the header. With more than one, a sticky chip "2 sources failed ›" stays visible while scrolling. Its sheet shows the reason per source, Retry per source, Retry all, Verify (RD13), and per failed novel an "Open novel" row (needed for missing-plugin failures, `updates.tsx:883`). |
| Load more | Occasional | Automatic at the end (existing), with a labeled fallback |
| Summary dot, double counts, always-true unread flag, globe tooltip | Noise | Removed. The source name is text. |

Trade-off: the floating check button (`src/styles/updates.css:262-269`) goes away. RD2 makes manual checks rare, and the button lives in the app bar.

### 7.2 Layout

```
┌─────────────────────────────────┐
│ Updates                     ⟳ ⋮ │
│ Last checked 2h ago             │
│ [2 sources failed ›]            │  sticky when present
├─────────────────────────────────┤
│ Today         [Download all (7)]│
│ ┌──┐ Novel A · Source Foo       │
│ │  │ Ch. 120 The Return    ⤓  ⋮ │
│ └──┘ 2h ago                     │
│ ┌──┐ Novel B — 3 new         ▾  │
│ Yesterday                       │
└─────────────────────────────────┘
```

## 8. History

| Function | Class | New location |
|---|---|---|
| Continue a recent novel | Core | Row tap with the resume rule: a finished chapter opens the next one (`history.tsx:836-845`). The row's meta shows "Next: Ch. 53" when that applies. |
| Filter: all / in progress / finished | Occasional | Chip row |
| Search the full history (RD21) | Occasional | A visible field under the app bar, as today (`history.tsx:662`). Enter applies the query, ✕ clears both the field and the applied filter (plan 0.7). |
| Novel details | Occasional | Row overflow |
| Remove one; clear all | Rare | Row overflow; app bar overflow. Both confirmed. |
| Load error | Recovery | `ErrorState` with Retry (existing) |
| Summary panel, resume card | Noise / redundant | Removed. RD1 now covers "continue" on Library [S2]. |

```
┌─────────────────────────────────┐
│ History                      ⋮  │
│ [ Search history…            ]  │
│ [All] [In progress] [Finished]  │
├─────────────────────────────────┤
│ Today                           │
│ ┌──┐ Novel Title                │
│ │  │ Ch. 52 · 45% · 3h ago   ⋮  │
│ └──┘ ▬▬▬▬▬▬────────            │
└─────────────────────────────────┘
```

## 9. Browse

There are three discovery tabs: **Search** (default, as today), **Sources** and **Server** (only when configured). Management moves to `/browse/extensions` [S1].

### 9.1 Search tab

| Function | Class | New location |
|---|---|---|
| Query | Core | Field at the top on every width. It is also reachable from Library search (RD10). |
| Scope: all / pinned / custom; custom select all / clear (`global-search.tsx:310`) | Occasional | Chip row [All 12] [Pinned 3] [Custom…]. The sheet has checkboxes, Select all and Clear. |
| Results per source | Core | A section per source: name, count, horizontal cover row, "›" opens that source's search with the query. Covers support RD8 quick add and show "In library". |
| Source actions: pin/unpin, open source, open site (`:243`) | Occasional | Section header overflow |
| Sources with no results | Secondary | One line "5 sources had no results ▸" that expands to list them (`:440`) |
| Failures; retry one; retry all; verify | Recovery | With exactly one failed source, its Retry or Verify shows inline at the top of the results (§1.4). With more, a sticky chip "3 failed ›" opens a sheet with Retry per source, Retry all and Verify (RD13). |
| Sort: pinned + count (default) / name | Rare | Results overflow, with the last choice kept [S9 revised] |
| "Before fan-out", ActiveScopeRow, eligible count, summary strip | Diagnostic | Removed |

### 9.2 Sources tab

| Function | Class | New location |
|---|---|---|
| Open a source | Core | Row tap |
| Pinned first | Frequent | Pinned section |
| Filter by name | Occasional | Field shown when there are more than 8 sources |
| Language groups | Occasional | Collapsible sections; the persisted language filter selects which are visible |
| Pin / unpin, settings, open site, clear cookies | Occasional/Rare | Row overflow |
| Manage (uninstall, update, version) | Rare | Row overflow "Manage in Extensions" opens the plugin in Extensions. Uninstall lives only in Extensions. |
| Extensions entry | Occasional | App bar button "Extensions" with an update badge (RD7) |

### 9.3 Server tab

Search, source chips, cover grid, Refresh, Load more (`ContentServerBrowse.tsx:79,106`).
- Source chips use the installed plugin's name when it is installed, otherwise the id. The server API exposes ids only (`src/lib/content-sync/browse.ts:24`).
- A card tap opens the work. RD8 quick add is supported.
- "Delete from server" moves to the novel page's server data manager.
- The not-configured state links to Settings > Backup & sync.

### 9.4 Extensions `/browse/extensions` [S1]

| Function | Class | Location |
|---|---|---|
| Updates (N), Update all, per-plugin Update | Occasional | First section, only when updates exist (RD7) |
| Repositories: list, add, enable, priority, refresh, remove (RD6) | Rare | "Repositories" row at the top: "3 repositories ›" opens a full-screen dialog (phone) or large modal (desktop), because it is a scrolling list (§1.2). The add form inside it is a small dialog. |
| Installed: name, language, version; settings; uninstall (confirmed) | Occasional | Section. Pending state is per row. |
| Available: filter field, language chips; Install, or "Add source" for multi-source plugins (`browse.tsx:1630`) | Occasional | Section. The labeled button follows the plugin type. |
| Install from file; add GitHub source | Rare | App bar overflow, then a dialog or full-screen dialog |
| Return context | — | When opened from a source's "Manage in Extensions", Back returns to that source row |

```
┌─────────────────────────────────┐
│ ←  Extensions                ⋮  │
│ Repositories: 3              ›  │
├─────────────────────────────────┤
│ Updates (2)        [Update all] │
│ (ic) Foo   1.2 → 1.3   [Update] │
│ Installed (14)                  │
│ (ic) Bar   KO · 2.0          ⋮  │
│ Available (210)  [ Filter…    ] │
│ [All][KO][EN][JA]…              │
│ (ic) Baz   EN · 1.0   [Install] │
│ (ic) Multi  EN     [Add source] │
└─────────────────────────────────┘
```

### 9.5 Implementation mapping

- `src/routes/browse.tsx` (1,711 lines) splits into `BrowseSearchTab` (from `global-search.tsx`), `BrowseSourcesTab`, `BrowseServerTab` (from `ContentServerBrowse.tsx`) and a new `src/routes/extensions.tsx`.
- Router: add `/browse/extensions`.
- RD6: DB, backup and query changes listed in §2.
- `PluginSettingsEditor.tsx`: Cancel and dirty state.

## 10. Source page

| Function | Class | New location |
|---|---|---|
| Browse the catalog (popular) | Core | Cover grid. RD8 quick add and the "In library" mark. |
| Search within the source | Frequent | The 🔍 icon expands into a field. Submit shows results; ✕ returns to the catalog. |
| Filters with schema-specific controls (text, picker, switch, checkbox group, excludable checkbox group; `PluginFilters.tsx:31-38,69-105`) | Occasional | Filter icon with an active-count badge, shown only when the plugin has filters. The container depends on the schema: a bottom sheet (phone) or right drawer (desktop), switching to a full-screen dialog on phones when there are more than 2 text fields. Footer: sticky Reset, Cancel, Apply. |
| Applied filter values | Secondary | A removable chip row under the app bar |
| Latest mode | — | Not offered. There is no capability flag (`src/lib/plugins/types.ts:189`). A plugin contract change would be needed first. |
| Open a novel | Core | Card tap; the blocking overlay appears only during the import |
| Load more | Frequent | Automatic near the end (RD22), with the labeled button as fallback and retry |
| Open site, source settings, reader settings for this source | Rare | Overflow |
| Verification required | Recovery | An inline banner with Verify (RD13). It resumes the failed page load. |
| Source state panel, status strip, novel paths, duplicate badges | Diagnostic | Removed |

```
┌─────────────────────────────────┐
│ ←  Source Foo           🔍 ⧩ ⋮  │
│ [Genre: Fantasy ×] [Status ×]   │  applied filters
├─────────────────────────────────┤
│ ┌───┐ ┌───┐ ┌───┐               │
│ │ ✓ │ │   │ │   │  ✓ = in library
│ └───┘ └───┘ └───┘               │
│ Title Title Title               │
│   (next page loads near the end)│
└─────────────────────────────────┘
```

## 11. Migrate source (`/novel-merge`)

This is a three-step flow with a step header.
- Back between steps keeps every decision.
- A confirmation is asked only when leaving the flow, or when changing the target would discard decisions. This includes Android Back.

| Step | Content | Phone | Desktop |
|---|---|---|---|
| 1. Choose target | Search across sources, prefilled and run once on entry. Results are kept when returning, and the search can be cancelled [S8]. | List | List |
| 2. Map chapters | RD12 auto-match, then sections: Copy conflicts (must resolve), Unmatched, Ambiguous, and collapsed "N matched" (editable). The row target picker is a searchable sheet with a "Clear mapping" option (`novel-merge.tsx:387,462`). There is an "Undecided only" toggle, "Exclude remaining", and auto-advance to the next undecided row. | Single list | Two panes: source (left), target (right) |
| 3. Confirm | Mapped N, excluded M, copy choices, downloads kept K, progress moves. Cleanup warnings are shown with their outcomes (`:715`). Confirm, then a success toast, then the target novel. | Card | Card |

```
┌─────────────────────────────────┐
│ ←  Migrate "Title"     2 of 3   │
│ ● Choose ─ ● Map ─ ○ Confirm    │
├─────────────────────────────────┤
│ Copy conflicts (1)              │
│ Ch. 12 ×2 → Ch. 12  Keep: [12a|12b]│
│ Unmatched (3)   [Exclude remaining]│
│ Ch. 300 Extra → [Choose…  ]     │
│ Matched (296)                ▸  │
├─────────────────────────────────┤
│                    [ Continue ] │
└─────────────────────────────────┘
```

## 12. Downloads hub (`/downloads?view=queue|storage`)

The hub shows every scheduler task kind (`chapter.download`, searches, update checks, refreshes, backups, maintenance), ordered by what the user can act on.

### 12.1 Queue view

| Function | Class | New location |
|---|---|---|
| Needs attention | Recovery | The top section lists every item that needs the user, each with its action in place. |
| Running and queued downloads | Frequent | "Downloads" grouped by novel and its goal (§2.2.4): cover, title, "12 / 30", ETA, route (Direct / server / VPN), progress. Expanding a novel shows its chapter tasks, each with Cancel and Retry, plus Move to top and Move to bottom in the row overflow (`tasks.tsx:535`). |
| Pause / resume source queues | Occasional | App bar labeled toggle "Pause downloads" or "Resume downloads". It pauses source queues only; interactive and main-queue work continues, as in `scheduler.ts:1262`. |
| Source queue controls: pause, resume, cancel (`tasks.tsx:981`) | Occasional | Novel row overflow: "Source Foo: Pause / Resume / Cancel source", with Cancel confirmed |
| Preparing download requests: cancel (`tasks.tsx:1315`) | Occasional | A row "Adding 30 chapters…" with Cancel |
| Cancel everything | Rare | App bar overflow, confirmed with counts |
| Other activity: searches, checks, refreshes, backup, maintenance | Occasional | A section collapsed unless something is running or failed. Rows have Cancel and Retry where the task supports them. Failed rows stay until dismissed; completed rows leave after the scheduler's normal expiry. |
| Sort | Rare | App bar overflow |
| VPN downloads (`VpnDownloadPanel.tsx`, `VpnDownloadRanges.tsx:86,113,145`) | Occasional | A card shown only when supported and configured, or when a run, draft or plan exists. It summarizes connections and remaining chapters with Pause, Resume and Stop. Expanding shows works and ranges, each with Pause, Resume, Cancel, Retry and Restart pass. Required actions also appear in Needs attention. Launch options are a dialog. |
| Lanes, priority, IP, protocol, chapter ids | Diagnostic | Row Details |

Needs attention covers:
- source challenge: **Verify and resume** / **Stop and continue without it** (`tasks.tsx:895`)
- failed downloads: Retry all, Clear
- an exhausted VPN profile: Restart pass
- a VPN range that needs verification: Verify
- Android background pause: Open
- RD19's Download with VPN / Set up VPN

```
┌─────────────────────────────────┐
│ Downloads   Pause downloads  ⋮  │
│ [Queue •3] [Storage]            │
├─────────────────────────────────┤
│ Needs attention                 │
│ ⚠ Source Foo needs verification │
│        [Verify and resume] [Stop]│
│ ⚠ 4 downloads failed [Retry all]│
├─────────────────────────────────┤
│ Downloads                       │
│ ┌──┐ Novel A          12 / 30 ⋮ │
│ └──┘ ▬▬▬▬▬▬▬────────  ▾         │
│ Adding 30 chapters…    [Cancel] │
├─────────────────────────────────┤
│ VPN downloads  3 conn · 45 left │  only when applicable
│              [Pause] [Stop]  ▾  │
├─────────────────────────────────┤
│ Other activity (1 running)    ▸ │
└─────────────────────────────────┘
```

### 12.2 Storage view

| Function | Class | New location |
|---|---|---|
| What uses space | Frequent | Summary "1.2 GB in 34 novels", then novel rows with "120 chapters · 340 MB" |
| A novel's stored chapters | Occasional | Phone: a full-height sub-view with Back. Desktop: right detail pane. Chapters have Read, Repair media and Delete. Plus "Open novel" (`downloads.tsx:443`). |
| Delete a novel's downloads; delete all (`:561`) | Occasional/Rare | Row overflow; app bar overflow. Both confirmed with sizes. |
| Clean up now | Occasional | App bar "Clean up" opens the existing `ChapterCleanupPanel` workflow, safeguards unchanged |
| Automatic cleanup (RD5) | Rare | A row at the top of Storage: "Auto-remove read chapters: Off ›", which opens the setting |
| Refresh, filter | Rare | App bar |

### 12.3 Implementation mapping

- `src/routes/tasks.tsx` and `src/routes/downloads.tsx` become `src/routes/downloads.tsx` with `DownloadsQueueView`, `NeedsAttention`, `DownloadsStorageView` and `StorageNovelDetail`.
- `VpnDownloadLaunchDialog.tsx` holds the launch options; VPN work renders as ordinary novel rows.
- `VpnDownloadWorks.tsx` renders the per-novel Details sheet.
- `TaskNotifications.tsx` handles the RD20 routes.

## 13. Settings

### 13.1 Structure

- **Phone:** `/settings` lists the sections, each with a one-line summary, plus the RD18 search field. Tapping a section opens `?section=x` with Back.
- **Desktop:** left nav plus detail.

Inside a section, groups have a title. Each row has a label, a control and at most one description line. An "Advanced" collapse holds the rest. Errors and required inputs open the collapse automatically: for example, credentials expand when a connection needs them.

| Section | Contents |
|---|---|
| Appearance | Theme mode, app theme (swatches), AMOLED, UI scale (%), Android view size, navigation labels (`settings.tsx:1148`); Advanced: accent color |
| General | Language, task notifications |
| Reader | Global defaults with the same two-level structure as "Aa", global scope only |
| Library | Default category to open (`src/store/library.ts:103`), default sort, chapter sort. Updates (RD2): interval, skip completed, categories. Display stays in Library's View options. |
| Downloads & storage | Storage folder; automatic downloads (RD3); auto-remove read chapters (RD5); Advanced: concurrency, cooldown |
| Backup & sync | Local backup (Export, Import, automatic backup RD15). Content server connection (URL, device name, mode, interval). Sync actions (Sync now, Rescan, with progress). Device reading-state snapshot (Upload, choose device, Restore with the replacement warning; `ReadingStateSettings.tsx:63-104`). Advanced: lookup timeout, upload conflicts. |
| Browse | Update extensions automatically (RD7) |
| Network | Plugin VPN status card (Connect/Disconnect); Profile (Find servers, Import file); Credentials (collapse); Advanced: saved profile limit, issue records, server verdicts |
| Data & reset | Global destructive actions only: clear library, clear reading progress, mark all updates read, reset appearance (keeps language), reset reader (keeps overrides by default). Contextual destructive actions (cleanup, server data, profiles) stay in their own context. |
| About | Version line, Check for updates, Releases |
| Developer & diagnostics | Log level, dev update channel, build metadata, User-Agent, WebView cache, source request timeout |

Ownership decisions that override the companion plan where they differ:
- Pause reading history lives in **More** and the reader overflow (S3), not in General.
- Library display lives only in View options.
- Custom JS lives in **Reader > Advanced**.
- VPN verdicts live in **Network > Advanced**.

### 13.2 Phone layout

```
┌─────────────────────────────────┐      ┌─────────────────────────────────┐
│ Settings                        │      │ ←  Network                      │
│ [ Search settings…            ] │      ├─────────────────────────────────┤
├─────────────────────────────────┤      │ ● Connected · jp-public-12      │
│ Appearance   Lavender · Dark  › │      │            [Disconnect]         │
│ General      English          › │  →   │ Profile  jp-public-12        ›  │
│ Reader       18px · Scroll    › │      │   [Find servers] [Import file]  │
│ Library      Updates every 12h› │      │ Credentials                  ▸  │
│ Downloads & storage  1.2 GB   › │      │ Advanced                     ▸  │
│ Backup & sync  Weekly backup  › │      └─────────────────────────────────┘
│ Browse  ·  Network  ·  …        │
└─────────────────────────────────┘
```

### 13.3 Implementation mapping

- `src/routes/settings.tsx` (2,136 lines) splits into `src/components/settings/<Section>.tsx` plus `SettingsIndex` and `SettingsSearch` (RD18).
- `SettingsPrimitives.tsx` gains the collapsible description, Advanced group, danger row and row metadata for search.

## 14. More (`/more`)

| Item | Notes |
|---|---|
| Pause reading history (switch) | One owner [S3]. It is also a toggle in the reader overflow. |
| Downloads | Badge with the count of active plus actionable items (failed, blocked, verification) |
| Extensions | Badge with the update count (RD7) |
| Settings | |
| About | |

On desktop, More is the last rail item. Reaching Downloads or Settings costs one more click than today (D3 trade-off). The badges make the cost visible only when something needs attention.

## 15. Startup, storage setup, recovery

- **Startup:** one neutral splash for the media storage check and the plugin proxy bootstrap. A bootstrap failure keeps its error and Retry (`PluginVpnProxyGate.tsx:117`). Gating is unchanged (plan 3.6).
- **Storage choice:** platform-correct options.
  - Android: "Choose a folder" only. It is required, because app storage is rejected (`src/lib/chapter-media-storage.ts:33-35`).
  - Windows: "Use app storage" (default) or "Choose a folder".
  - The explanation is one sentence, with an expandable "What is stored". This is step 1 of RD9 on first run.
- **Recovery:** a Library banner shows progress, failure plus Retry, and completion plus Dismiss (`StorageRecovery.tsx:63`).

## 16. Local import

The real model: imported files become chapters of the single local work named "local" (`src/lib/local-import-library.ts:38-42`, `src/lib/local-library-identity.ts:2`). They are not separate novels.

1. **Entry points:**
   - Library overflow "Import files" opens the picker.
   - Windows drag-and-drop (RD14) and Android share/open intents bypass the picker.
2. **Review dialog** (full-screen on phones, large modal on desktop):
   - Each file shows its detected format, title and chapter count.
   - Per-file states: ready, unsupported format, analysis error, duplicate of another selected file, already imported (`src/components/library/local-import-review.ts:39`).
   - Include checkboxes default to ready files only.
   - [Import N] adds them to Local files.
3. **Progress** is shown per file. Closing is blocked during analysis and import.
4. **Result:**
   - A single file opens the local work automatically, as today (`LibraryLocalImport.tsx:135`).
   - Several files show a result list (imported / skipped / failed with reason) with Done and "Open Local files".
5. **Queueing:** requests arriving meanwhile wait, shown as "2 more files waiting", until the current result is acknowledged. Each batch has an id (plan 4.2).

## 17. Structural decisions

| ID | Decision | Recommendation |
|---|---|---|
| S1 | Extensions as `/browse/extensions` (new route) | Yes, preserving return context |
| S2 | Remove the History resume card | Yes. RD1 and the next-chapter meta replace it. |
| S3 | Pause reading history owned by More plus the reader overflow | Yes |
| S4 | Library View options sheet plus quick chips | Yes |
| S5 | Category on add: toast action instead of a forced sheet | Yes (replaces the earlier S5) |
| S6 | Explicit reorder mode for the local work, with keyboard alternatives | Yes |
| S7 | Updates row tap reads; collapsed group opens its earliest new chapter | Yes |
| S8 | Migrate runs the prefilled search once on entry, cancellable, results kept | Yes |
| S9 | Global search sort moves to the overflow, default pinned + count | Yes (revised) |
| S10 | Toasts bottom (phone) / bottom-right (desktop), avoiding bars and keyboard | Yes |
| S11 | `/setup` first-run route (RD9) | Yes |

## 18. Coverage check

| Area | Section |
|---|---|
| Shell, nav | §1.3, §3, §14 |
| Library, categories, import | §4, §16 |
| Novel, metadata editor, cover picker, server data, deletion | §5 (plan 4.3 for the editor and cover-picker lifecycles) |
| Reader, PDF, reader settings | §6 (plan 4.1 for PDF) |
| Updates | §7 |
| History | §8 |
| Browse, global search, server, extensions | §9 |
| Source page, filters | §10 |
| Site browser | plan 4.5, RD13 |
| Migrate | §11 |
| Tasks, downloads, VPN, cleanup, notifications | §12, RD5, RD19, RD20 |
| Settings, VPN finder, saved profiles, device backup, content server | §13 |
| Startup, storage setup, recovery | §15, RD9 |

## 19. Defaults

**Decided by the user on 2026-11-03:** every proposal below is accepted as stated.

The RD2 and RD3 rows are superseded by §2.2. Their replacements are the cadence model (F2) and download goals (G1, G2), decided in §2.2.8.

| Item | Decided default |
|---|---|
| RD2 update check interval / skip completed | 12h / off (opt-in to save traffic; completed novels can still get extras) |
| RD3 automatic download of new chapters | Off, with a one-time offer after the first manual batch download |
| RD7 automatic extension updates | Off (notify plus Update all). Opt-in only after RD6 provenance ships. |
| RD9 suggested repository URL | None unless the project names one |
| RD15 automatic backup | Off. Enabling shows the coverage, then Weekly with 5 kept. |

## 20. Review log

All reviews used Codex CLI 0.166 in a read-only sandbox. The spec author re-checked each accepted claim against source before applying it. Prompts and outputs are under `.tmp/ui-ux-overhaul/` and are not committed.

| Round | Input | Main corrections applied |
|---|---|---|
| 1 (`codex-spec-review.md`) | Revision 1 | Android storage folder required; single local-work import model; migration copy-conflict choice; reader inheritance and two-page mode; Library Next 10/30 and explicit category add/remove; restart-reading and next-chapter continuation; inventory of server, storage, search, task and VPN recovery controls; recovery-overrides-usage rule; rem bar tokens |
| 2 (`codex-redesign-review.md`) | Revision 2 (RD1-RD20) | Lifecycle, deduplication and missed-run rules for automation; update-check discovery deltas and scoped retry; read-ahead across every scope; enforceable cleanup predicates and keep-last-N; publisher provenance and Rust restore scope for multiple repositories; semver and transactional extension updates; manual verification with revision-checked resume; native notification contracts; backup coverage and atomic publish; honest action counts; regressions removed (category chips, Updates cover tap, visible History search, inline single-failure action); RD21-RD23 added; defaults revised |
| 3 (`codex-redesign-recheck.md`) | Revision 3 | Legacy plugin provenance bound only on a source URL match; unattended cleanup limited to `server-contains-local`; RD3 trigger and RD5 missed-run rules; honest RD4 count; inline single-failure action in Search; Updates collapses only runs over 3; plan order RD6 before RD7 and Phase 4.5 promises moved to RD7/RD13 |
| 4 (`codex-systems-review.md`) | Revision 4 (§2.2 systems) | Cooldown and duration claims corrected; reversals flagged (G3, V1, V2, V4); keep-ahead limited to active novels with storage, mobile-data and battery budgets; goal/queue single ownership, deletion, library removal and restore rules; body count and media completeness reported separately; server lane as a route of the same job with revalidation; VPN trigger from diagnosed limits with consent and per-source preference; chunk scope (deferred lease, durable ids, migration of existing ranges); discovery separated from usage policy; release flag without backfill; existing cover value reused; edge cases added |
