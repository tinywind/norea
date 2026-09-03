use super::{BuildTarget, PlatformBuild, unix_library_filename};
use crate::LinkMode;

pub(super) struct Unix;

impl PlatformBuild for Unix {
    fn library_filename(&self, _target: &BuildTarget, mode: LinkMode) -> &'static str {
        unix_library_filename(mode)
    }

    fn emit_static_link_libraries(&self, _target: &BuildTarget) {
        println!("cargo:rustc-link-lib=stdc++");
        println!("cargo:rustc-link-lib=pthread");
    }
}
