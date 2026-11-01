# Incomplete server chapter verification

Date: 2026-11-01

## Contract

Stored incomplete chapters appear in server counts, server chapter lists and the
library. They can be downloaded. Media completeness is shown separately from
availability and local stored-body state. Missing media remains eligible for
explicit repair; it does not prevent opening a stored chapter body.

## Automated verification

- App TypeScript check passed.
- All 2,039 frontend tests passed across 170 files.
- All 25 native content-sync tests passed inside local x86_64 Waydroid. These
  include complete, partial-ZIP and missing-ZIP download/install round trips.
- Server tests: 186 passed. Server type checking and console build passed.
- Regression tests failed before implementation and passed after the fixes.
  They cover incomplete catalog visibility and lookup, original-file downloads,
  persisted repair state, completion cache updates, and offline reader navigation.
- Scoped compatibility, IPC and UI interaction reviews passed after correcting
  the reader guards that previously required fully downloaded media.

## Waydroid acceptance

The targeted x86_64 debug APK used an isolated
`io.github.tinywind.norea.qa20261101incomplete` package and
`Documents/NoreaQAIncomplete20261101` storage folder. Temporary Android package
configuration changes were reverted. Production device apps were not replaced.

The local test server on port 18104 used a private copy of work
`newtoki-novel/63219`, including its original chapter bodies and media artifacts.
The app had no source plugin installed.

- Server browsing showed 393 chapters. Opening the work cached all 393 chapter
  records, including every chapter from 1 through 300.
- Chapters 1 through 365 displayed `Server: Incomplete`; chapters 366 through 393
  displayed `Server: Complete`. The work could be added to the library normally.
- The normal chapter download action stored chapter 1 with a 16,860-byte body,
  a 418-byte manifest and a 22-byte empty ZIP. The queue completed successfully.
  Its body, manifest and ZIP matched the source bytes exactly.
- The downloaded chapter retained `is_downloaded=0`, `media_repair_needed=1`
  and positive body bytes. The library showed one cached chapter and the remote
  media warning. Completion did not falsely mark the media complete.
- The same action downloaded complete chapter 366 with a 16,038-byte body and
  a 215,001-byte ZIP. Its original files also matched byte for byte; its
  persisted flags were `is_downloaded=1` and `media_repair_needed=0`.
- After stopping the test server and restarting the app, chapter 1 opened its
  stored body offline. The reader displayed the body and no download queue entry
  was created. Both chapters retained their respective completeness states.

One UI session was terminated by Android's low-memory killer while the host was
under memory pressure. The task's Gradle daemon was stopped, and the download,
restart and offline checks were repeated successfully. No original content was
modified to satisfy completeness.

## Content-server rollout

Server source commit: `a475791932ecc329798144224b5cd655467a5026`.
Successful workflow: `41292353018` (`Validate and publish Docker image`).
Published branch tag: `tinywind0/norea-content-server:0.2`.
Published and running digest:
`sha256:18a01b4c1712d2afd0bf95bab1c3b97cfa8d380bb5bf5b03eed71ab060c943f7`.

The existing Compose service was recreated from that digest. The running source
revision matched the workflow commit and the service became healthy. Mounts,
environment, port bindings, restart policy and Docker network were retained.
SQLite integrity remained `ok`, existing table counts were retained, and the
installation password file plus 15 sampled original chapter artifacts were
unchanged.

The deployed API returned 393 chapters for the affected work, beginning with
chapter 1 and `complete: false`. Exact lookup of that incomplete chapter and
download of its original body succeeded. No database schema or chapter package
version changed.
