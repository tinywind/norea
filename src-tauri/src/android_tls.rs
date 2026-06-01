use jni::{
    EnvUnowned,
    errors::ThrowRuntimeExAndDefault,
    objects::{JClass, JObject},
};

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_tinywind_norea_RustlsPlatformVerifierBridge_init(
    mut env: EnvUnowned<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
) {
    env.with_env(|env| rustls_platform_verifier::android::init_with_env(env, context))
        .resolve::<ThrowRuntimeExAndDefault>();
}
