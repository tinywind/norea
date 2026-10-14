#[tauri::command]
pub(crate) fn get_default_device_name() -> Result<String, String> {
    let name = platform_device_name().map_err(|error| format!("device name: {error}"))?;
    let name = name.trim();
    if name.is_empty() {
        return Err("device name: the system returned an empty name".to_string());
    }
    Ok(name.to_string())
}

#[cfg(target_os = "windows")]
fn platform_device_name() -> Result<String, String> {
    use windows::{
        core::PWSTR,
        Win32::System::SystemInformation::{ComputerNamePhysicalDnsHostname, GetComputerNameExW},
    };

    let mut buffer = [0_u16; 256];
    let mut length = buffer.len() as u32;
    unsafe {
        GetComputerNameExW(
            ComputerNamePhysicalDnsHostname,
            Some(PWSTR(buffer.as_mut_ptr())),
            &mut length,
        )
    }
    .map_err(|error| error.to_string())?;
    String::from_utf16(&buffer[..length as usize]).map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
fn platform_device_name() -> Result<String, String> {
    std::fs::read_to_string("/proc/sys/kernel/hostname").map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
fn platform_device_name() -> Result<String, String> {
    use jni::{jni_sig, jni_str, objects::JString, JavaVM};

    // MainActivity initializes the JNI VM before creating the app WebView.
    JavaVM::singleton()
        .and_then(|vm| {
            vm.attach_current_thread_for_scope(|env| {
                let model = env
                    .get_static_field(
                        jni_str!("android/os/Build"),
                        jni_str!("MODEL"),
                        jni_sig!("Ljava/lang/String;"),
                    )?
                    .l()?;
                env.cast_local::<JString>(model)?.try_to_string(env)
            })
        })
        .map_err(|error| error.to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "android")))]
fn platform_device_name() -> Result<String, String> {
    Err("this platform does not support reading the device name".to_string())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    #[test]
    fn reads_the_configured_computer_name() {
        let expected = std::env::var("COMPUTERNAME").unwrap();
        let actual = super::get_default_device_name().unwrap();
        assert!(!actual.is_empty());
        assert!(
            actual.eq_ignore_ascii_case(&expected),
            "{actual} != {expected}"
        );
    }
}
