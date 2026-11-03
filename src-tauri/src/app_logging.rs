#[cfg(any(target_os = "windows", test))]
mod files;
mod redaction;
#[cfg(target_os = "android")]
mod android;

use std::sync::{Once, OnceLock};
use tauri::AppHandle;

const FILE_BYTES: usize = 1_048_576;
const RECORD_BYTES: usize = 16_384;
static PANIC_HOOK: Once = Once::new();
static APPLICATION_ID: OnceLock<String> = OnceLock::new();

struct SinkGuardedLogger { inner: Box<dyn log::Log> }
thread_local! { static IN_LOG_SINK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
struct LogSinkGuard;
impl LogSinkGuard {
    fn enter() -> Option<Self> {
        if IN_LOG_SINK.try_with(|active| active.replace(true)).unwrap_or(true) { None } else { Some(Self) }
    }
}
impl Drop for LogSinkGuard {
    fn drop(&mut self) { let _ = IN_LOG_SINK.try_with(|active| active.set(false)); }
}
impl log::Log for SinkGuardedLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        IN_LOG_SINK.try_with(|active| !active.get()).unwrap_or(false) && self.inner.enabled(metadata)
    }
    fn log(&self, record: &log::Record<'_>) {
        let Some(_guard) = LogSinkGuard::enter() else { return; };
        self.inner.log(record);
    }
    fn flush(&self) {
        let Some(_guard) = LogSinkGuard::enter() else { return; };
        self.inner.flush();
    }
}

pub(crate) fn install_panic_hook() {
    PANIC_HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let reason = redaction::bounded(&info.to_string(), RECORD_BYTES);
            let detail = std::backtrace::Backtrace::force_capture().to_string();
            if let Err(error) = record_crash("rust-panic", &reason, &detail) {
                eprintln!("Norea panic report unavailable: {}", redaction::bounded(&redaction::redact(&error), RECORD_BYTES));
            }
            previous(info);
        }));
    });
}

fn timestamp() -> String { tauri_plugin_log::TimezoneStrategy::UseUtc.get_now().to_string() }

fn identity() -> String {
    format!("app={} version={} platform={} pid={} thread={:?}/{}",
        APPLICATION_ID.get().map(String::as_str).unwrap_or("io.github.tinywind.norea"),
        env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::process::id(),
        std::thread::current().id(), std::thread::current().name().unwrap_or("unnamed"))
}

fn runtime_line(level: log::Level, target: &str, message: &str) -> String {
    let text = format!("{} {} {} target={} {}", timestamp(), level, identity(), target, message);
    redaction::bounded(&redaction::redact(&text).replace('\r', "\\r").replace('\n', "\\n"), RECORD_BYTES - 1) + "\n"
}

pub(crate) fn emit_runtime(record: &log::Record<'_>) {
    let message = redaction::bounded(&redaction::redact(&record.args().to_string()), RECORD_BYTES);
    #[cfg(target_os = "android")]
    {
        let thread = format!("{:?}/{}", std::thread::current().id(), std::thread::current().name().unwrap_or("unnamed"));
        if let Err(error) = android::enqueue_runtime(record.level().as_str(), record.target(), &thread, &message) {
            eprintln!("{}Norea Android log bridge unavailable: {}", runtime_line(record.level(), record.target(), &message), redaction::redact(&error));
        }
    }
    #[cfg(target_os = "windows")]
    {
        let line = runtime_line(record.level(), record.target(), &message);
        eprint!("{line}");
        if let Some(queue) = RUNTIME_QUEUE.get() { queue.enqueue(record.level(), line); }
    }
    #[cfg(not(any(target_os = "android", target_os = "windows")))]
    eprint!("{}", runtime_line(record.level(), record.target(), &message));
}

pub(crate) fn initialize(application_id: &str) -> Result<(), String> {
    let _ = APPLICATION_ID.set(application_id.to_string());
    #[cfg(target_os = "windows")]
    {
        let config = current_config();
        let queue = RuntimeLogQueue::new(log::max_level, |line| current_config().store().write_runtime(line).map(|_| ()))?;
        let _ = RUNTIME_QUEUE.set(queue);
        log::set_max_level(files::read_native_level(&config.config_dir).unwrap_or(log::LevelFilter::Off));
    }
    let (max_level, logger) = tauri_plugin_log::fern::Dispatch::new()
        .level(log::LevelFilter::Trace)
        .level_for("h2", log::LevelFilter::Warn)
        .level_for("hyper", log::LevelFilter::Warn)
        .level_for("hyper_util", log::LevelFilter::Warn)
        .level_for("reqwest", log::LevelFilter::Warn)
        .level_for("sqlx", log::LevelFilter::Info)
        .level_for("tracing", log::LevelFilter::Warn)
        .level_for("jni", log::LevelFilter::Warn)
        .chain(tauri_plugin_log::fern::Output::call(emit_runtime))
        .into_log();
    log::set_boxed_logger(Box::new(SinkGuardedLogger { inner: logger }))
        .map_err(|error| format!("Install application logger: {error}"))?;
    log::set_max_level(max_level);
    #[cfg(target_os = "windows")]
    log::set_max_level(files::read_native_level(&current_config().config_dir).unwrap_or(log::LevelFilter::Off));
    #[cfg(not(target_os = "windows"))]
    log::set_max_level(log::LevelFilter::Trace);
    Ok(())
}

pub(crate) fn set_runtime_level(level: &str) -> Result<(), String> {
    let parsed = crate::parse_runtime_log_level(level)?;
    #[cfg(target_os = "android")]
    {
        android::set_level(level)?;
        log::set_max_level(log::LevelFilter::Trace);
    }
    #[cfg(target_os = "windows")]
    {
        log::set_max_level(parsed);
        files::write_native_level(&current_config().config_dir, level)?;
    }
    #[cfg(not(any(target_os = "android", target_os = "windows")))]
    log::set_max_level(parsed);
    let _ = parsed;
    Ok(())
}

pub(crate) fn configure(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        let config = PlatformConfig {
            application_id: app.config().identifier.clone(),
            config_dir: app.path().app_config_dir().map_err(|error| format!("Log config directory: {error}"))?,
            downloads: app.path().download_dir().ok(),
            temporary: std::env::temp_dir(),
        };
        if let Some(current) = CONFIG.get() {
            *current.write().map_err(|_| "Log configuration lock is poisoned")? = config;
        } else { let _ = CONFIG.set(std::sync::RwLock::new(config)); }
        recover_pending_crashes();
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
    Ok(())
}

pub(crate) fn record_crash(kind: &str, message: &str, detail: &str) -> Result<(), String> {
    let message = redaction::bounded(&redaction::redact(message), RECORD_BYTES);
    let detail = redaction::bounded(&redaction::redact(detail), FILE_BYTES);
    #[cfg(target_os = "android")]
    match android::write_crash(kind, &message, &detail) {
        Ok(_) => return Ok(()),
        Err(error) => {
            #[cfg(not(test))]
            return Err(error);
            #[cfg(test)]
            let _ = error;
        }
    }
    #[cfg(any(target_os = "windows", test))]
    {
        let report = redaction::bounded(&format!("{} crash={}\n{}\n{}\n{}\n", timestamp(), kind, identity(), message, detail), FILE_BYTES);
        publish_crash(report).map(|_| ())
    }
    #[cfg(not(any(target_os = "android", target_os = "windows", test)))]
    Err("Crash file logging is unavailable on this platform".into())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
enum FrontendCrashKind { Error, UnhandledRejection }

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FrontendCrash {
    kind: FrontendCrashKind,
    message: String,
    stack: Option<String>,
    url: Option<String>,
}

#[tauri::command]
pub(crate) async fn record_frontend_crash(_app: AppHandle, crash: FrontendCrash) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let kind = match crash.kind { FrontendCrashKind::Error => "frontend-error", FrontendCrashKind::UnhandledRejection => "frontend-unhandled-rejection" };
        let url = crash.url.as_deref().map(|url| redaction::bounded(&redaction::redact(url), 4_096));
        let detail = format!("url={}\n{}", url.as_deref().unwrap_or("unavailable"),
            crash.stack.as_deref().unwrap_or("JavaScript stack unavailable"));
        record_crash(kind, &crash.message, &detail)
    }).await.map_err(|error| format!("Record frontend crash task: {error}"))?
}

#[cfg(any(target_os = "windows", test))]
use std::{path::PathBuf, sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, RwLock}, time::Duration};

#[cfg(any(target_os = "windows", test))]
#[derive(Clone)]
struct PlatformConfig {
    application_id: String,
    config_dir: PathBuf,
    downloads: Option<PathBuf>,
    temporary: PathBuf,
}

#[cfg(any(target_os = "windows", test))]
impl PlatformConfig {
    fn temporary_root(&self) -> PathBuf {
        self.temporary.canonicalize().unwrap_or_else(|_| self.temporary.clone()).join("Norea-logs").join(&self.application_id)
    }
    fn state_dir(&self) -> PathBuf { self.config_dir.join("norea-log-state") }
    fn pending_root(&self) -> PathBuf { self.temporary_root().join("pending-crashes") }
    fn stage_store(&self) -> files::FileLogStore {
        files::FileLogStore::new(self.application_id.clone(), self.state_dir(), vec![self.pending_root()])
    }
    fn store(&self) -> files::FileLogStore {
        let mut roots = Vec::new();
        if let Ok(selected) = files::read_selected_root(&self.config_dir) {
            if let Some(root) = selected { roots.push(root.canonicalize().unwrap_or(root).join("logs")); }
        }
        if let Some(downloads) = &self.downloads { roots.push(downloads.canonicalize().unwrap_or_else(|_| downloads.clone()).join("Norea/logs")); }
        roots.push(self.temporary_root().join("logs"));
        let mut store = files::FileLogStore::new(self.application_id.clone(), self.state_dir(), roots);
        store.retain_root(self.pending_root());
        store
    }
}

#[cfg(any(target_os = "windows", test))]
static CONFIG: OnceLock<RwLock<PlatformConfig>> = OnceLock::new();

#[cfg(any(target_os = "windows", test))]
fn current_config() -> PlatformConfig {
    if let Some(config) = CONFIG.get().and_then(|lock| lock.try_read().ok()) { return config.clone(); }
    let application_id = APPLICATION_ID.get().cloned().unwrap_or_else(|| "io.github.tinywind.norea".into());
    let temporary = std::env::temp_dir();
    let config_dir = std::env::var_os("APPDATA").map(PathBuf::from)
        .map(|path| path.canonicalize().unwrap_or(path).join(&application_id))
        .unwrap_or_else(|| temporary.join("Norea-logs").join(&application_id).join("native-state"));
    PlatformConfig { application_id, config_dir, downloads: None, temporary }
}

#[cfg(any(target_os = "windows", test))]
static PUBLICATION_BUSY: AtomicBool = AtomicBool::new(false);

#[cfg(any(target_os = "windows", test))]
struct PublicationGuard;
#[cfg(any(target_os = "windows", test))]
impl Drop for PublicationGuard { fn drop(&mut self) { PUBLICATION_BUSY.store(false, Ordering::Release); } }

#[cfg(any(target_os = "windows", test))]
fn publish_crash(report: String) -> Result<PathBuf, String> {
    let config = current_config();
    let staged = config.stage_store().write_staged_crash(&report);
    if PUBLICATION_BUSY.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() { return staged; }
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let staged_path = staged.as_ref().ok().cloned();
    let spawn = std::thread::Builder::new().name("norea-crash-publication".into()).spawn(move || {
        let _guard = PublicationGuard;
        let published = config.store().write_crash(&report);
        if published.is_ok() { if let Some(path) = staged_path { let _ = config.stage_store().delete_crash(&path); } }
        let _ = sender.try_send(published);
    });
    if spawn.is_err() { PUBLICATION_BUSY.store(false, Ordering::Release); return staged; }
    match receiver.recv_timeout(Duration::from_millis(1_500)) {
        Ok(Ok(path)) => Ok(path),
        Ok(Err(error)) => staged.map_err(|staging| format!("Staging: {staging}; publication: {error}")),
        Err(_) => staged,
    }
}

#[cfg(target_os = "windows")]
fn recover_pending_crashes() {
    if PUBLICATION_BUSY.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() { return; }
    let config = current_config();
    if std::thread::Builder::new().name("norea-pending-crashes".into()).spawn(move || {
        let _guard = PublicationGuard;
        if let Ok(reports) = config.stage_store().read_crashes() {
            for (path, report) in reports {
                if config.store().write_crash(&report).is_ok() { let _ = config.stage_store().delete_crash(&path); }
            }
        }
    }).is_err() { PUBLICATION_BUSY.store(false, Ordering::Release); }
}

#[cfg(any(target_os = "windows", test))]
struct RuntimeLogQueue {
    sender: std::sync::mpsc::SyncSender<(log::Level, String)>,
    dropped: Arc<AtomicU64>,
}

#[cfg(any(target_os = "windows", test))]
impl RuntimeLogQueue {
    fn new(level: impl Fn() -> log::LevelFilter + Send + 'static, mut write: impl FnMut(&str) -> Result<(), String> + Send + 'static) -> Result<Self, String> {
        let (sender, receiver) = std::sync::mpsc::sync_channel::<(log::Level, String)>(256);
        let dropped = Arc::new(AtomicU64::new(0));
        let pending_dropped = dropped.clone();
        std::thread::Builder::new().name("norea-runtime-logs".into()).spawn(move || {
            while let Ok((severity, text)) = receiver.recv() {
                if severity > level() { continue; }
                let count = pending_dropped.swap(0, Ordering::Relaxed);
                if count > 0 { let _ = write(&runtime_line(log::Level::Error, "logging", &format!("Dropped {count} runtime log records after queue saturation"))); }
                if let Err(error) = write(&text) { eprintln!("Norea runtime logging unavailable: {}", redaction::redact(&error)); }
            }
        }).map_err(|error| error.to_string())?;
        Ok(Self { sender, dropped })
    }
    fn enqueue(&self, level: log::Level, text: String) {
        if self.sender.try_send((level, text)).is_err() { self.dropped.fetch_add(1, Ordering::Relaxed); }
    }
}

#[cfg(target_os = "windows")]
static RUNTIME_QUEUE: OnceLock<RuntimeLogQueue> = OnceLock::new();

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_logger_ignores_records_generated_by_its_own_sink() {
        use std::sync::{Mutex, Weak};
        use std::sync::atomic::AtomicUsize;
        struct ReentrantProbe {
            calls: Arc<AtomicUsize>,
            logger: Arc<Mutex<Option<Weak<dyn log::Log>>>>,
        }
        impl log::Log for ReentrantProbe {
            fn enabled(&self, _: &log::Metadata<'_>) -> bool { true }
            fn flush(&self) {}
            fn log(&self, record: &log::Record<'_>) {
                if self.calls.fetch_add(1, Ordering::Relaxed) == 0 {
                    let logger = self.logger.lock().unwrap().as_ref().unwrap().upgrade().unwrap();
                    logger.log(record);
                }
            }
        }
        let calls = Arc::new(AtomicUsize::new(0));
        let reference = Arc::new(Mutex::new(None));
        let logger: Arc<dyn log::Log> = Arc::new(SinkGuardedLogger { inner: Box::new(ReentrantProbe {
            calls: calls.clone(), logger: reference.clone(),
        }) });
        *reference.lock().unwrap() = Some(Arc::downgrade(&logger));
        logger.log(&log::Record::builder().level(log::Level::Info).target("test").args(format_args!("outer")).build());
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn panic_child() {
        let Ok(root) = std::env::var("NOREA_LOG_PANIC_CHILD") else { return; };
        let root = std::path::PathBuf::from(root);
        let config = PlatformConfig {
            application_id: "test-panic".into(),
            config_dir: root.join("config"),
            downloads: Some(root.join("downloads")),
            temporary: root.join("temporary"),
        };
        std::fs::create_dir_all(config.state_dir()).unwrap();
        let held = if std::env::var_os("NOREA_LOG_HOLD_PUBLIC").is_some() {
            let file = std::fs::File::options().read(true).write(true).create(true).truncate(false)
                .open(config.state_dir().join("crash.state")).unwrap();
            file.lock().unwrap();
            Some(file)
        } else { None };
        CONFIG.set(std::sync::RwLock::new(config)).ok().unwrap();
        let _ = APPLICATION_ID.set("test-panic".into());
        install_panic_hook();
        log::set_max_level(log::LevelFilter::Off);
        std::hint::black_box(&held);
        panic!("panic-proof password=synthetic-panic-secret");
    }

    #[test]
    fn panic_is_saved_at_off_even_when_public_logging_is_locked() {
        for held in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let mut child = std::process::Command::new(std::env::current_exe().unwrap());
            child.args(["--exact", "app_logging::tests::panic_child", "--nocapture"])
                .env("NOREA_LOG_PANIC_CHILD", root.path());
            if held { child.env("NOREA_LOG_HOLD_PUBLIC", "1"); }
            let result = child.output().unwrap();
            assert!(!result.status.success());
            let mut text = String::new();
            fn read_reports(root: &std::path::Path, text: &mut String) {
                if let Ok(entries) = std::fs::read_dir(root) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_dir() { read_reports(&path, text); }
                        else if path.extension().is_some_and(|extension| extension == "log") {
                            let bytes = std::fs::read(&path).unwrap();
                            assert!(bytes.len() <= 1_048_576);
                            text.push_str(&String::from_utf8(bytes).unwrap());
                        }
                    }
                }
            }
            read_reports(root.path(), &mut text);
            assert!(text.contains("panic-proof"), "child output: {}", String::from_utf8_lossy(&result.stdout));
            assert!(text.contains("app_logging::tests::panic_child"));
            assert!(!text.contains("synthetic-panic-secret"));
        }
    }

    #[test]
    fn runtime_queue_rechecks_levels_and_reports_bounded_saturation() {
        use std::sync::mpsc;
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let (written_tx, written_rx) = mpsc::channel();
        let mut first = true;
        let queue = RuntimeLogQueue::new(|| log::LevelFilter::Trace, move |text| {
            if first { first = false; entered_tx.send(()).unwrap(); release_rx.recv().unwrap(); }
            written_tx.send(text.to_string()).unwrap();
            Ok(())
        }).unwrap();
        queue.enqueue(log::Level::Info, "held".into());
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        for index in 0..256 { queue.enqueue(log::Level::Info, format!("queued-{index}")); }
        for _ in 0..10 { queue.enqueue(log::Level::Info, "must-be-dropped".into()); }
        release_tx.send(()).unwrap();
        let lines: Vec<_> = (0..258).map(|_| written_rx.recv_timeout(Duration::from_secs(2)).unwrap()).collect();
        assert_eq!(lines[0], "held");
        assert!(lines[1].contains("Dropped 10 runtime log records"));
        assert!(!lines.iter().any(|line| line == "must-be-dropped"));

        let (written_tx, written_rx) = mpsc::channel();
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let queue = RuntimeLogQueue::new(move || {
            if calls.fetch_add(1, Ordering::Relaxed) == 0 { log::LevelFilter::Off } else { log::LevelFilter::Info }
        }, move |text| { written_tx.send(text.to_string()).unwrap(); Ok(()) }).unwrap();
        queue.enqueue(log::Level::Info, "filtered".into());
        queue.enqueue(log::Level::Info, "probe".into());
        assert_eq!(written_rx.recv_timeout(Duration::from_secs(2)).unwrap(), "probe");
    }
}
