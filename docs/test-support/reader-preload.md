# Stored Next Chapter Preparation

The active reader prepares only the next stored chapter. It shares the normal
chapter query and document worker, then mounts one inert, invisible
`ReaderContent` at the current viewport size. Next navigation promotes that same
keyed instance, retaining its DOM, local media resolution, and page measurements.
Missing chapters remain the responsibility of download goals and the existing
interactive download path; this preparation adds no source request or WebView.

Hidden preparation does not save reading progress, anchors, history, or page
indices. It does not run custom JavaScript, auto-scroll, request a wake lock, show
reader controls, or receive input. Closing the reader removes its prepared next
instance. A chapter jump retains at most the displayed chapter and one upcoming
instance. Body or bionic changes discard stale preparation, and both instances
use the live reader settings and viewport. Fonts and local media completion
invalidate page measurements.

HTML that could run embedded content, change another chapter's styles, or fetch
remote media receives query/document preparation only. Custom JavaScript and PDF
chapters use the existing rendering path. Ordinary sanitized novel HTML and
HTML converted from plain text or Markdown support full hidden preparation.
When content or layout is not ready in time, the normal loading path remains.

## Device Check

Use stored chapters or an isolated local fixture. Do not change source traffic
or clear user data for this check.

1. Open a chapter that has a stored following chapter. Wait for
   `[data-reader-preparing="true"]` inside the reader content frame. Its viewport
   must have the same nonzero dimensions as the active reader despite being
   hidden, inert, and excluded from accessibility.
2. Record the prepared stage DOM element and its `data-reader-content-key`, plus
   the next chapter's progress, read time, and novel history. Read or change the
   current page; hidden preparation must not change those records.
3. Use Next. The recorded element must become the visible active stage with the
   same content key and no `data-reader-preparing` attribute. Once prepared,
   switching must not create another content instance or show the content loader.
4. Change font size/family, bionic mode, reading mode, or viewport dimensions;
   allow preparation to finish and repeat Next. Check the new layout and page
   count, including after local images or fonts finish loading.
5. Open the prepared chapter from the chapter list with a saved reading
   position. Confirm that position is restored. Navigate backward, then Next
   again; Next starts at the beginning even if that instance was read before.
6. Jump to another chapter or leave the reader. Confirm old hidden stages are
   removed and the next chapter's reading records remain untouched.
