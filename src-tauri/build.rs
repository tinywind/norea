use std::{path::Path, process::Command};

fn main() {
    stamp_local_git_sha();
    tauri_build::build()
}

/// CI stamps `NOREA_GIT_SHA`; local builds fall back to the checked-out commit
/// so About can still name the build. A build without git leaves it unset.
fn stamp_local_git_sha() {
    let Some(sha) = git_output(&["rev-parse", "--short=7", "HEAD"]) else {
        return;
    };
    println!("cargo:rustc-env=NOREA_LOCAL_GIT_SHA={sha}");

    let mut watched = vec!["HEAD".to_string(), "packed-refs".to_string()];
    if let Some(head_ref) = git_output(&["symbolic-ref", "-q", "HEAD"]) {
        watched.push(head_ref);
    }
    for name in watched {
        if let Some(path) = git_output(&["rev-parse", "--git-path", &name]) {
            if Path::new(&path).exists() {
                println!("cargo:rerun-if-changed={path}");
            }
        }
    }
}

fn git_output(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!value.is_empty()).then_some(value)
}
