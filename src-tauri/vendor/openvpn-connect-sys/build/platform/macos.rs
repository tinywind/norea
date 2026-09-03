use super::{BuildTarget, PlatformBuild, apple_library_filename, emit_apple_static_link_libraries};
use crate::LinkMode;

pub(super) struct MacOs;

impl PlatformBuild for MacOs {
    fn library_filename(&self, _target: &BuildTarget, mode: LinkMode) -> &'static str {
        apple_library_filename(mode)
    }

    fn supports_rpath(&self, _target: &BuildTarget) -> bool {
        true
    }

    fn emit_static_link_libraries(&self, _target: &BuildTarget) {
        emit_apple_static_link_libraries(false);
    }
}
