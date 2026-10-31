# Device backup, selection, browsing, and VPN verification

Date: 2026-10-31

## Environment

- Host: tinywind-SER.
- App and content-server branches: `0.2`.
- Android: installed Waydroid, Android 13, x86_64, 540 × 960 display.
- UI tests used an isolated `io.github.tinywind.norea.qa20261031` package and
  `Documents/NoreaQA20261031` storage folder.
- Content-server integration tests used an isolated data directory and port
  18089. Production content files were not used as test fixtures.
- Temporary Android package settings were reverted before the commit.

## Automated checks

- App TypeScript check and the complete Vitest suite pass.
- Android APK builds pass with `--target x86_64`.
- Six native device-backup tests pass inside Waydroid, including the complete
  application schema, plugin code, personal data, sequences, and triggers.
- Seventy-six native VPN tests pass inside Waydroid.
- Content-server tests: 186 pass; type checking and console build pass.
- Content-server Docker workflow for commit
  `133ad8c6d90b2aa4793846c5877c11f648e7b765` passes.

Relevant commands:

```sh
pnpm tsc
pnpm test
pnpm exec tauri android build --apk --target x86_64 --debug
cargo test --lib --target x86_64-linux-android --no-run
```

The cross-compiled Rust test executable was pushed to Waydroid and run there
with the Android C++ runtime. A desktop Rust test run was not substituted for
the Android execution.

## Waydroid UI scenarios

| Scenario | Observed result |
| --- | --- |
| Select all filtered works | 135 fixture works, 130 matching the query, and only 100 rendered cards. The new button selected all 130 matching works. |
| Download previous chapters with multiple selections | Selecting chapters 3 and 6 offered two earlier chapters. Only chapters 1 and 2 completed their downloads; both produced actual content files. |
| Replace a connected VPN | Connected to 219.100.37.3. Selecting 219.100.37.104 invoked disconnect, apply new profile, then connect in that order. |
| New VPN rejects authentication | The second public server rejected authentication. The old connection was not restored; the failed target remained identifiable and traffic stayed blocked until explicit disconnect. |
| Hide personal verdict X | Marking 219.100.37.53 as failed removed it with the default filter enabled. Disabling the filter showed it again. |
| Public server list caching | Closing and reopening the modal invoked no catalog load. Explicit refresh invoked one load with forceRefresh=true. Reopening after that refresh did not load again. |
| Preserve server browse filters | Search `QA Server` and source `qa-source` survived work navigation and Back. They also survived an explicit WebView document reload. |
| Default backup identifier | The device name `WayDroid x86_64 Device` was shown without a private sync key input. |
| List saved devices | The selector listed both `WayDroid x86_64 Device` and `QA Spare Tablet`. |
| Replace the same backup slot | Uploading the current device again replaced that name's snapshot. |
| Full database and settings restore | The selected backup restored the database and settings after deliberate changes, then reloaded the app. |
| Preserve original files | All four fixture files remained byte-identical across restore. |
| Reopen preserved files absent from the restored DB | Opening the server work rebuilt its local index on the first attempt. The work opened, Back retained the filters, and all four original files remained byte-identical. |

### Full restore checks

Before restore, the test removed installed plugins, repository entries,
categories, and category memberships; cleared library membership and reading
progress; added an extra work; removed the VPN profile; changed the storage
folder setting and language; and added an extra local setting.

The selected snapshot restored:

- 135 works, eight chapters, one installed plugin, and one repository.
- One category and 130 work-category relationships.
- All 135 library memberships.
- Chapter 5 progress of 42% and its bookmark.
- The complete installed JavaScript source, verified by exact string comparison.
- The repository URL, Korean UI setting, VPN Finder profile and classification,
  and the original storage folder setting.

The extra work and extra setting disappeared. The imported VPN profile's
remote host was 219.100.37.104, and the profile remained disabled as saved.

Archive inspection found exactly `manifest.json`, `norea.db`, and
`profile.ovpn`. The archive contained no separate chapter, cover, or image files.

Physical download flags and byte counts reset because the archive contains no
downloaded content files. Existing files are inspected again when used. Reading
progress and other personal data are retained.

## Server rollout

The successful workflow published:

```text
tinywind0/norea-content-server@sha256:8f06b74986a5b554cc21bf4cc54081c6276769ea870205bc6b9be1dfc024bcfc
```

The running server was recreated from that digest through its existing Compose
configuration. Verification confirmed:

- The image revision matches the exact published source commit.
- Existing volume bindings, port 18087, restart policy, application environment,
  and Docker network remain configured.
- A consistent SQLite snapshot was saved before replacement.
- The original administrator password file and 20 sampled original content
  files are unchanged.
- Database integrity is `ok`; existing records remain present. Normal server
  activity added records during verification.
- The container is healthy.
- Capabilities report `deviceBackupVersion: 1`.
- The device-backup listing rejects unauthenticated requests with HTTP 401.

The image's Node.js version changed with its base image; application environment
values were preserved.

## Backup contract

Full device restore requires the same database schema and migration history.
Invalid checksums, corrupt archives, and incompatible databases are rejected
before database replacement. Database replacement is transactional, and saved
settings are rolled back if installation fails before commit.

All saved app settings, including server credentials and VPN configuration, are
included. OS folder permissions, WebView cookies, and VPN credentials kept only
in process memory are not portable database settings and are not archived.
A different device may need to grant access to its storage folder.

Pending filesystem mutation jobs from the source device are cancelled or removed
during restore. Preserved files that are absent from the restored database are
indexed only when the user explicitly opens that work or requests recovery.
