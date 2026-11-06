//! Calls into `AndroidVpnUrlTestBridge`, which loads each test page in the private
//! `:vpn_url_test` WebView process.

use std::sync::OnceLock;

use jni::{
    errors::ThrowRuntimeExAndDefault,
    jni_sig, jni_str,
    objects::{JClass, JString},
    refs::Global,
    EnvUnowned, JValue, JavaVM,
};

struct AndroidUrlTestBridge {
    class: Global<JClass<'static>>,
    java_vm: JavaVM,
}

static BRIDGE: OnceLock<AndroidUrlTestBridge> = OnceLock::new();

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_tinywind_norea_AndroidVpnUrlTestBridge_register(
    mut env: EnvUnowned<'_>,
    class: JClass<'_>,
) {
    env.with_env(|env| -> jni::errors::Result<()> {
        let _ = BRIDGE.set(AndroidUrlTestBridge { java_vm: env.get_java_vm()?, class: env.new_global_ref(class)? });
        Ok(())
    })
    .resolve::<ThrowRuntimeExAndDefault>();
}

fn bridge() -> Result<&'static AndroidUrlTestBridge, String> {
    BRIDGE.get().ok_or_else(|| "Android VPN URL test bridge is not initialized".to_string())
}

fn error_message(error: jni::errors::Error) -> String {
    match error {
        jni::errors::Error::CaughtJavaException { msg, .. } => msg,
        _ => error.to_string(),
    }
}

/// Loads `url` once through the local proxy on `proxy_port` and blocks until the test browser
/// reports what it observed, as JSON. `cancel_page` with the same `id` ends the wait early.
pub(super) fn load_page(id: i64, url: &str, proxy_port: u16, user_agent: &str, page_timeout_ms: i32) -> Result<String, String> {
    let bridge = bridge()?;
    bridge
        .java_vm
        .attach_current_thread_for_scope(|env| {
            let url = env.new_string(url)?;
            let user_agent = env.new_string(user_agent)?;
            let observation = env
                .call_static_method(
                    &bridge.class,
                    jni_str!("load"),
                    jni_sig!("(JLjava/lang/String;ILjava/lang/String;I)Ljava/lang/String;"),
                    &[
                        JValue::Long(id),
                        JValue::from(&url),
                        JValue::Int(i32::from(proxy_port)),
                        JValue::from(&user_agent),
                        JValue::Int(page_timeout_ms),
                    ],
                )?
                .l()?;
            env.cast_local::<JString>(observation)?.try_to_string(env)
        })
        .map_err(error_message)
}

pub(super) fn cancel_page(id: i64) -> Result<(), String> {
    let bridge = bridge()?;
    bridge
        .java_vm
        .attach_current_thread_for_scope(|env| {
            env.call_static_method(&bridge.class, jni_str!("cancel"), jni_sig!("(J)V"), &[JValue::Long(id)])?;
            Ok(())
        })
        .map_err(error_message)
}
