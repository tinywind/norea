use jni::{errors::ThrowRuntimeExAndDefault, jni_sig, jni_str, objects::{JClass, JString}, refs::Global, EnvUnowned, JValue, JavaVM};
use std::sync::OnceLock;

struct AndroidLogBridge { class: Global<JClass<'static>>, java_vm: JavaVM }
static BRIDGE: OnceLock<AndroidLogBridge> = OnceLock::new();

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_tinywind_norea_AndroidAppLoggingBridge_register(mut env: EnvUnowned<'_>, class: JClass<'_>) {
    env.with_env(|env| -> jni::errors::Result<()> {
        let _ = BRIDGE.set(AndroidLogBridge { java_vm: env.get_java_vm()?, class: env.new_global_ref(class)? });
        Ok(())
    }).resolve::<ThrowRuntimeExAndDefault>();
}

fn bridge() -> Result<&'static AndroidLogBridge, String> { BRIDGE.get().ok_or_else(|| "Android log bridge is not initialized".into()) }
fn error_message(error: jni::errors::Error) -> String {
    match error { jni::errors::Error::CaughtJavaException { msg, .. } => msg, _ => error.to_string() }
}

pub(super) fn enqueue_runtime(level: &str, target: &str, thread: &str, message: &str) -> Result<(), String> {
    let bridge = bridge()?;
    bridge.java_vm.attach_current_thread_for_scope(|env| {
        let level = env.new_string(level.to_ascii_lowercase())?;
        let target = env.new_string(target)?;
        let thread = env.new_string(thread)?;
        let message = env.new_string(message)?;
        env.call_static_method(&bridge.class, jni_str!("enqueueRuntime"),
            jni_sig!("(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Z"),
            &[JValue::from(&level), JValue::from(&target), JValue::from(&thread), JValue::from(&message)])?;
        Ok(())
    }).map_err(error_message)
}

pub(super) fn set_level(level: &str) -> Result<(), String> {
    let bridge = bridge()?;
    bridge.java_vm.attach_current_thread_for_scope(|env| {
        let level = env.new_string(level)?;
        env.call_static_method(&bridge.class, jni_str!("setLevel"), jni_sig!("(Ljava/lang/String;)V"), &[JValue::from(&level)])?;
        Ok(())
    }).map_err(error_message)
}

pub(super) fn write_crash(kind: &str, message: &str, detail: &str) -> Result<String, String> {
    let bridge = bridge()?;
    bridge.java_vm.attach_current_thread_for_scope(|env| {
        let kind = env.new_string(kind)?;
        let message = env.new_string(message)?;
        let detail = env.new_string(detail)?;
        let value = env.call_static_method(&bridge.class, jni_str!("writeCrash"),
            jni_sig!("(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;"),
            &[JValue::from(&kind), JValue::from(&message), JValue::from(&detail)])?.l()?;
        if value.is_null() { return Ok(None); }
        env.cast_local::<JString>(value)?.try_to_string(env).map(Some)
    }).map_err(error_message)?.ok_or_else(|| "Android crash report has no writable destination".into())
}
