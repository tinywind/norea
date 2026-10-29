# GLib security backport

This is the crates.io glib 0.18.5 source archive with the reviewed production backports and upstream test repair listed below, plus this note. The crate archive SHA-256 is `233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`. Original license and copyright files are retained.

The fix backports [upstream gtk-rs-core PR 1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343), commit `b5a4071e439bef2b5eea76c3aa25e5ae84839e34`, for [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html). The pointer passed to the variadic GLib out-parameter is mutable and passed through `&mut p`.

Tauri 2 uses GTK 3 and glib 0.18 on Linux; replacing only glib with 0.20 would violate the GTK dependency and native-library constraints. The Cargo patch uses this reviewed source without changing the upstream crate version. Version-only scanners can still report 0.18.5; this note documents the source fix rather than claiming an upstream 0.18 release exists.

The upstream optimized variant iterator tests reproduce SIGSEGV with the original crate on Rust 1.99.1. The same 11 tests pass against this patched copy.

`StrV::clear()` also backports [upstream commit 4a7463e](https://github.com/gtk-rs/gtk-rs-core/commit/4a7463e84dd8edaa66553e9d933d2d7fc533613b). Clearing an allocated string array must write its null terminator before the destructor walks the array. The upstream regression reproduces a double-free abort without this four-line fix.

The test-only sentinel reads backport [upstream commit 107ad15](https://github.com/gtk-rs/gtk-rs-core/commit/107ad15cce3a3292c3d5a3a64b09e0017d28275a). They use raw pointers to inspect the allocated null terminator beyond the active slice length instead of invalid `slice::get_unchecked` calls. This changes no production behavior and enables the complete upstream library test suite on current Rust.

Validation uses optimized `cargo test --release --lib` in an isolated Linux container with networking disabled. All 227 library tests pass, including the 11 iterator regressions and the new clear/drop regression. Exact source comparisons are recorded in the maintenance evidence; native device workflows remain separate.

## CodeQL review

CodeQL 2.27.3 reported seven findings when this source was first vendored in commit `1c36b14313963eaca8063859aba55d6ed3c55516`. The analysis paths and concrete Rust implementations were reviewed individually.

| Alerts | Locations | False-positive evidence |
| --- | --- | --- |
| [47](https://github.com/tinywind/norea/security/code-scanning/47), [48](https://github.com/tinywind/norea/security/code-scanning/48) | `src/object.rs:470,493` | Paths connect `GError*` and character out-parameters to `ObjectRef` through generic conversion helpers. The actual return types select error or string conversions; neither pointer type reaches these `GObject*` implementations. |
| [49](https://github.com/tinywind/norea/security/code-scanning/49) | `src/subclass/boxed.rs:76` | The same generic paths reach a test-only `MyBoxed` derive with an incompatible concrete pointer type. Its generated conversion takes ownership with `Box::into_raw`, preserves borrowed values with `ManuallyDrop`, and consumes an owned box once. |
| [50](https://github.com/tinywind/norea/security/code-scanning/50), [51](https://github.com/tinywind/norea/security/code-scanning/51) | `src/value.rs:462,470` | Error and string conversions are combined with the unrelated `GValue*` conversion and destructor. Nullable string pointers are handled by `Option`; typed errors use their own boxed error implementation. |
| [52](https://github.com/tinywind/norea/security/code-scanning/52) | `src/collections/ptr_slice.rs:898-900` | `drop_in_place` destroys the removed element. The subsequent write initializes its still-allocated array slot. The backing GLib allocation is freed separately by the container destructor. |
| [53](https://github.com/tinywind/norea/security/code-scanning/53) | `src/log.rs:85` | UUID validation returns a `gboolean` that is converted to `bool`. The reported path instead selects `LogLevel::from_glib(u32)` through a generic helper. The UUID string is never passed to this panic. |

These dispositions apply to the cited findings and source revision. CodeQL queries and scanning coverage remain enabled.
