//! Raw C ABI for the source-built OpenVPN 3 Core client.
//!
//! Prefer the safe `openvpn-connect` crate unless implementing another wrapper.

#![allow(
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    clippy::doc_markdown
)]

// Keep Cargo's native link metadata for the source-built static LZ4 dependency
// in the final link whenever `vendor` is enabled. The C++ adapter itself uses
// LZ4, while this raw Rust module does not call its Rust FFI.
#[cfg(feature = "vendor")]
use lz4_sys as _;

mod rust_backend;

pub use rust_backend::install as install_rust_backend;

include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
