use jni::{
    errors::ThrowRuntimeExAndDefault,
    jni_sig, jni_str,
    objects::{JByteArray, JClass, JObject},
    refs::Global,
    EnvUnowned, JValue, JavaVM,
};
use std::sync::OnceLock;

struct AndroidTlsBridge {
    class: Global<JClass<'static>>,
    java_vm: JavaVM,
}

static ANDROID_TLS_BRIDGE: OnceLock<AndroidTlsBridge> = OnceLock::new();

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_tinywind_norea_RustlsPlatformVerifierBridge_init(
    mut env: EnvUnowned<'_>,
    class: JClass<'_>,
    context: JObject<'_>,
) {
    env.with_env(|env| -> jni::errors::Result<()> {
        let bridge = AndroidTlsBridge {
            java_vm: env.get_java_vm()?,
            class: env.new_global_ref(class)?,
        };
        rustls_platform_verifier::android::init_with_env(env, context)?;
        let _ = ANDROID_TLS_BRIDGE.set(bridge);
        Ok(())
    })
    .resolve::<ThrowRuntimeExAndDefault>();
}

pub(crate) fn https_get(
    url: &str,
    connect_timeout_ms: i32,
    read_timeout_ms: i32,
    max_bytes: i32,
) -> Result<Vec<u8>, String> {
    let bridge = ANDROID_TLS_BRIDGE
        .get()
        .ok_or_else(|| "Android TLS bridge is not initialized".to_string())?;
    bridge
        .java_vm
        .attach_current_thread_for_scope(|env| {
            let url = env.new_string(url)?;
            let response = env
                .call_static_method(
                    &bridge.class,
                    jni_str!("httpsGet"),
                    jni_sig!("(Ljava/lang/String;III)[B"),
                    &[
                        JValue::from(&url),
                        JValue::Int(connect_timeout_ms),
                        JValue::Int(read_timeout_ms),
                        JValue::Int(max_bytes),
                    ],
                )?
                .l()?;
            let response = env.cast_local::<JByteArray>(response)?;
            env.convert_byte_array(&response)
        })
        .map_err(jni_error_message)
}

fn jni_error_message(error: jni::errors::Error) -> String {
    match error {
        jni::errors::Error::CaughtJavaException { msg, .. } => msg,
        _ => error.to_string(),
    }
}
