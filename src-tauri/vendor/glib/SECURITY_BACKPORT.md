# GLib security backport

This is the crates.io glib 0.18.5 source archive with the reviewed production backports and upstream test repair listed below, plus this note. The crate archive SHA-256 is `233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`. Original license and copyright files are retained.

The fix backports [upstream gtk-rs-core PR 1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343), commit `b5a4071e439bef2b5eea76c3aa25e5ae84839e34`, for [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html). The pointer passed to the variadic GLib out-parameter is mutable and passed through `&mut p`.

Tauri 2 uses GTK 3 and glib 0.18 on Linux; replacing only glib with 0.20 would violate the GTK dependency and native-library constraints. The Cargo patch uses this reviewed source without changing the upstream crate version. Version-only scanners can still report 0.18.5; this note documents the source fix rather than claiming an upstream 0.18 release exists.

The upstream optimized variant iterator tests reproduce SIGSEGV with the original crate on Rust 1.99.1. The same 11 tests pass against this patched copy.

`StrV::clear()` also backports [upstream commit 4a7463e](https://github.com/gtk-rs/gtk-rs-core/commit/4a7463e84dd8edaa66553e9d933d2d7fc533613b). Clearing an allocated string array must write its null terminator before the destructor walks the array. The upstream regression reproduces a double-free abort without this four-line fix.

The test-only sentinel reads backport [upstream commit 107ad15](https://github.com/gtk-rs/gtk-rs-core/commit/107ad15cce3a3292c3d5a3a64b09e0017d28275a). They use raw pointers to inspect the allocated null terminator beyond the active slice length instead of invalid `slice::get_unchecked` calls. This changes no production behavior and enables the complete upstream library test suite on current Rust.

Validation uses optimized `cargo test --release --lib` in an isolated Linux container with networking disabled. All 227 library tests pass, including the 11 iterator regressions and the new clear/drop regression. Exact source comparisons are recorded in the maintenance evidence; native device workflows remain separate.
