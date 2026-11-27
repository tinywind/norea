# Vendored crate maintenance

The Rust host selects these local sources in `src-tauri/Cargo.toml`. The linked
notes identify each base archive by SHA-256 and describe the local changes.

| Crate | Base | Patch record | Upstream status and removal check |
| --- | --- | --- | --- |
| glib | 0.18.5 | [Security backports](../src-tauri/vendor/glib/SECURITY_BACKPORT.md) | The fixes have upstream commits linked in the record. Remove the patch when the GTK dependency accepts a release containing all three and the optimized iterator and string-vector tests pass. |
| openvpn-connect-sys | 0.1.2 | [Native source notes](../src-tauri/vendor/openvpn-connect-sys/PATCHES.md) | The OpenVPN Core and Asio revisions are pinned. On a crate upgrade, compare the frame-aware TUN allocation, crypto policy and native compatibility changes. Run packet and certificate tests on supported targets before dropping local changes. |
| tao | 0.37.2 | [Android looper ownership](../src-tauri/vendor/tao/PATCHES.md) | Carried locally. Check the next upstream Android event-loop proxy for shared looper ownership and verify repeated proxy cloning on a device. |
| tauri | 2.12.5 | [Mobile channel lifetime](../src-tauri/vendor/tauri/PATCHES.md) | Carried locally. Check one-shot channel cleanup and native listener lifetime together before removing the patch. |
| wry | 0.57.1 | [Android evaluation callbacks](../src-tauri/vendor/wry/PATCHES.md) | Carried locally. Check callback consumption, reentrant evaluation and destroyed-activity handling in the candidate release. |

At dependency review, compare the candidate crate archive with the documented
base and patch. Record any matching upstream issue, PR or released commit in
the crate note. Remove the Cargo override only after the replacement passes
the relevant platform checks.
