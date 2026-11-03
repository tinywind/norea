use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const FILE_BYTES: usize = 1_048_576;

fn regular(metadata: &Metadata) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 { return false; }
    }
    !metadata.file_type().is_symlink()
}

fn options(read: bool, write: bool, create: bool) -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(read).write(write).create(create).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0);
    }
    options
}

fn open_file(path: &Path, options: &OpenOptions) -> Result<File, String> {
    let file = options.open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || !regular(&metadata) { return Err(format!("{} is not a regular log file", path.display())); }
    Ok(file)
}

struct Directory { path: PathBuf, handle: File }

impl Directory {
    fn open(path: &Path, create: bool) -> Result<Self, String> {
        if !path.is_absolute() { return Err("Log directory must be absolute".into()); }
        for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
            if create && !ancestor.exists() {
                match fs::create_dir(ancestor) {
                    Ok(()) => {},
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
                    Err(error) => return Err(format!("{}: {error}", ancestor.display())),
                }
            }
            let metadata = fs::symlink_metadata(ancestor).map_err(|error| format!("{}: {error}", ancestor.display()))?;
            if !metadata.is_dir() || !regular(&metadata) { return Err(format!("{} is not a regular log directory", ancestor.display())); }
        }
        let mut open = OpenOptions::new();
        open.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            open.custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC);
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE};
            open.share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0);
        }
        let handle = open.open(path).map_err(|error| format!("{}: {error}", path.display()))?;
        let metadata = handle.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_dir() || !regular(&metadata) { return Err("Opened log directory is linked or unavailable".into()); }
        Ok(Self { path: path.to_path_buf(), handle })
    }

    fn child(&self, name: &str) -> PathBuf {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            PathBuf::from(format!("/proc/self/fd/{}", self.handle.as_raw_fd())).join(name)
        }
        #[cfg(target_os = "windows")]
        { self.path.join(name) }
    }
}

#[derive(Clone)]
struct OwnedLog { root: PathBuf, name: String, sequence: u64, size: u64 }

pub(super) struct FileLogStore {
    namespace: String,
    state_dir: PathBuf,
    roots: Vec<PathBuf>,
    retained_roots: Vec<PathBuf>,
}

impl FileLogStore {
    pub(super) fn new(namespace: String, state_dir: PathBuf, roots: Vec<PathBuf>) -> Self {
        Self { namespace, state_dir, roots, retained_roots: Vec::new() }
    }

    pub(super) fn retain_root(&mut self, root: PathBuf) { self.retained_roots.push(root); }

    fn sequence(&self, category: &str, name: &str) -> Option<u64> {
        let prefix = format!("norea-{}-{category}-", self.namespace);
        let tail = name.strip_prefix(&prefix)?.strip_suffix(".log")?;
        let fields: Vec<_> = tail.split('-').collect();
        if fields.len() != 4 || fields[0].len() != 20 || fields[3].len() != 32 ||
            !fields[0..3].iter().all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())) ||
            !fields[3].bytes().all(|byte| byte.is_ascii_hexdigit()) { return None; }
        fields[0].parse().ok()
    }

    fn inventory(&self, root: &Path, category: &str) -> Result<Vec<OwnedLog>, String> {
        let directory = Directory::open(root, false)?;
        let entries = fs::read_dir(directory.child("")).map_err(|error| error.to_string())?;
        let mut files = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue; };
            let Some(sequence) = self.sequence(category, &name) else { continue; };
            let metadata = fs::symlink_metadata(directory.child(&name)).map_err(|error| error.to_string())?;
            if metadata.is_file() && regular(&metadata) {
                files.push(OwnedLog { root: root.to_path_buf(), name, sequence, size: metadata.len() });
            }
        }
        Ok(files)
    }

    fn known_roots(&self, directory: &Directory) -> Result<Vec<PathBuf>, String> {
        let mut file = open_file(&directory.child("roots.json"), &options(true, true, true))?;
        file.lock().map_err(|error| error.to_string())?;
        if file.metadata().map_err(|error| error.to_string())?.len() > FILE_BYTES as u64 { return Err("Log root history exceeds its limit".into()); }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(|error| error.to_string())?;
        let mut roots: Vec<PathBuf> = if bytes.is_empty() { Vec::new() } else { serde_json::from_slice(&bytes).map_err(|error| format!("Log root history: {error}"))? };
        let mut changed = false;
        for root in self.roots.iter().chain(&self.retained_roots) {
            if !roots.contains(root) { roots.push(root.clone()); changed = true; }
        }
        if changed {
            let bytes = serde_json::to_vec(&roots).map_err(|error| error.to_string())?;
            if bytes.len() > FILE_BYTES { return Err("Log root history exceeds its limit".into()); }
            file.seek(SeekFrom::Start(0)).map_err(|error| error.to_string())?;
            file.set_len(0).map_err(|error| error.to_string())?;
            file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
        }
        Ok(roots)
    }

    fn next_sequence(&self, directory: &Directory, category: &str, observed: u64) -> Result<u64, String> {
        let mut file = open_file(&directory.child(&format!("{category}.sequence")), &options(true, true, true))?;
        file.lock().map_err(|error| error.to_string())?;
        let mut bytes = [0_u8; 8];
        let previous = if file.metadata().map_err(|error| error.to_string())?.len() == 0 { 0 } else {
            file.read_exact(&mut bytes).map_err(|error| format!("Log sequence: {error}"))?;
            u64::from_le_bytes(bytes)
        };
        let next = previous.max(observed).checked_add(1).ok_or("Log sequence exhausted")?;
        file.seek(SeekFrom::Start(0)).map_err(|error| error.to_string())?;
        file.write_all(&next.to_le_bytes()).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
        Ok(next)
    }

    pub(super) fn write_runtime(&mut self, text: &str) -> Result<PathBuf, String> { self.write("runtime", text, false) }
    pub(super) fn write_crash(&mut self, text: &str) -> Result<PathBuf, String> { self.write("crash", text, false) }
    pub(super) fn write_staged_crash(&mut self, text: &str) -> Result<PathBuf, String> { self.write("crash", text, true) }

    pub(super) fn delete_crash(&self, path: &Path) -> Result<(), String> {
        let root = path.parent().ok_or("Crash file has no parent")?;
        let name = path.file_name().and_then(|name| name.to_str()).ok_or("Crash filename is unavailable")?;
        if !self.roots.iter().any(|owned| owned == root) || self.sequence("crash", name).is_none() {
            return Err("Crash deletion is outside owned storage".into());
        }
        let directory = Directory::open(root, false)?;
        let leaf = directory.child(name);
        match fs::symlink_metadata(&leaf) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
            Ok(metadata) if metadata.is_file() && regular(&metadata) => fs::remove_file(leaf).map_err(|error| error.to_string()),
            _ => Err("Crash deletion refuses non-regular files".into()),
        }
    }

    pub(super) fn read_crashes(&self) -> Result<Vec<(PathBuf, String)>, String> {
        let mut inventory: Vec<_> = self.roots.iter().flat_map(|root| self.inventory(root, "crash").unwrap_or_default()).collect();
        inventory.sort_by_key(|file| std::cmp::Reverse(file.sequence));
        let mut reports = Vec::new();
        for owned in inventory.into_iter().take(10) {
            let directory = Directory::open(&owned.root, false)?;
            let file = open_file(&directory.child(&owned.name), &options(true, false, false))?;
            let mut report = String::new();
            file.take((FILE_BYTES + 1) as u64).read_to_string(&mut report).map_err(|error| error.to_string())?;
            if report.len() > FILE_BYTES { return Err("Pending crash exceeds its limit".into()); }
            reports.push((owned.root.join(&owned.name), report));
        }
        Ok(reports)
    }

    fn prune(&self, roots: &[PathBuf], category: &str) {
        let mut files: Vec<_> = roots.iter().flat_map(|root| self.inventory(root, category).unwrap_or_default()).collect();
        files.sort_by(|left, right| (left.sequence, &left.name).cmp(&(right.sequence, &right.name)));
        let excess = files.len().saturating_sub(10);
        for file in files.into_iter().take(excess) {
            let result = (|| {
                let directory = Directory::open(&file.root, false)?;
                let path = directory.child(&file.name);
                let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
                if !metadata.is_file() || !regular(&metadata) { return Err("Refused non-regular retention target".into()); }
                fs::remove_file(path).map_err(|error| error.to_string())
            })();
            if let Err(error) = result { eprintln!("Norea log retention unavailable: {}", super::redaction::redact(&error)); }
        }
    }

    fn write(&mut self, category: &str, text: &str, emergency: bool) -> Result<PathBuf, String> {
        let text = super::redaction::bounded(text, FILE_BYTES);
        let state = Directory::open(&self.state_dir, true)?;
        let lock_name = format!("{category}{}.state", if emergency { "-stage" } else { "" });
        let lock = open_file(&state.child(&lock_name), &options(true, true, true))?;
        lock.lock().map_err(|error| error.to_string())?;
        let known = if emergency { self.roots.clone() } else { self.known_roots(&state)? };
        let observed = known.iter().flat_map(|root| self.inventory(root, category).unwrap_or_default()).map(|file| file.sequence).max().unwrap_or(0);
        let mut errors = Vec::new();
        for root in &self.roots {
            let mut created = None;
            let attempt: Result<PathBuf, String> = (|| {
                let directory = Directory::open(root, true)?;
                let latest = if category == "runtime" {
                    self.inventory(root, category)?.into_iter().max_by_key(|file| file.sequence)
                        .filter(|file| file.size + text.len() as u64 <= FILE_BYTES as u64)
                } else { None };
                let name = match latest {
                    Some(file) => file.name,
                    None => {
                        let sequence = self.next_sequence(&state, category, observed)?;
                        let millis = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
                        let mut random = [0_u8; 16];
                        getrandom::fill(&mut random).map_err(|error| error.to_string())?;
                        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
                        let name = format!("norea-{}-{category}-{sequence:020}-{millis}-{}-{suffix}.log", self.namespace, std::process::id());
                        let mut create = options(false, true, false);
                        create.create_new(true);
                        open_file(&directory.child(&name), &create)?;
                        created = Some(name.clone());
                        name
                    }
                };
                let mut append = options(false, true, false);
                append.append(true);
                let mut file = open_file(&directory.child(&name), &append)?;
                if file.metadata().map_err(|error| error.to_string())?.len() + text.len() as u64 > FILE_BYTES as u64 { return Err("Log append exceeds file limit".into()); }
                file.write_all(text.as_bytes()).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
                Ok(root.join(name))
            })();
            match attempt {
                Ok(path) => {
                    self.prune(&known, category);
                    if !errors.is_empty() { eprintln!("Norea logging fallback: {}", super::redaction::redact(&errors.join("; "))); }
                    return Ok(path);
                }
                Err(error) => {
                    if let Some(name) = created {
                        if let Ok(directory) = Directory::open(root, false) { let _ = fs::remove_file(directory.child(&name)); }
                    }
                    errors.push(format!("{}: {error}", root.display()));
                }
            }
        }
        Err(super::redaction::bounded(&errors.join("; "), 16_384))
    }
}

fn read_config(directory: &Path, name: &str, limit: usize) -> Result<Option<String>, String> {
    let metadata = match fs::symlink_metadata(directory.join(name)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
        Ok(metadata) => metadata,
    };
    if !metadata.is_file() || !regular(&metadata) || metadata.len() > limit as u64 { return Err(format!("Unsafe or oversized {name}")); }
    let directory = Directory::open(directory, false)?;
    let file = open_file(&directory.child(name), &options(true, false, false))?;
    file.lock_shared().map_err(|error| error.to_string())?;
    let mut value = String::new();
    file.take((limit + 1) as u64).read_to_string(&mut value).map_err(|error| error.to_string())?;
    if value.len() > limit { return Err(format!("Oversized {name}")); }
    Ok(Some(value))
}

pub(super) fn read_selected_root(directory: &Path) -> Result<Option<PathBuf>, String> {
    Ok(read_config(directory, "chapter-media-storage-root.txt", 16_384)?
        .map(|value| value.trim().to_string()).filter(|value| !value.is_empty()).map(PathBuf::from))
}

pub(super) fn read_native_level(directory: &Path) -> Result<log::LevelFilter, String> {
    match read_config(directory, "norea-native-log-level.txt", 64)? {
        Some(level) => crate::parse_runtime_log_level(level.trim()),
        None => Ok(log::LevelFilter::Info),
    }
}

pub(super) fn write_native_level(directory: &Path, level: &str) -> Result<(), String> {
    crate::parse_runtime_log_level(level)?;
    let directory = Directory::open(directory, true)?;
    let mut file = open_file(&directory.child("norea-native-log-level.txt"), &options(true, true, true))?;
    file.lock().map_err(|error| error.to_string())?;
    file.set_len(0).and_then(|_| file.write_all(level.as_bytes())).and_then(|_| file.sync_all()).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn retained(root: &std::path::Path, category: &str) -> Vec<std::path::PathBuf> {
        let mut paths: Vec<_> = fs::read_dir(root).unwrap().map(|entry| entry.unwrap().path())
            .filter(|path| path.file_name().unwrap().to_string_lossy().starts_with(&format!("norea-test-{category}-")))
            .collect();
        paths.sort();
        paths
    }

    #[test]
    fn rotates_before_one_mib_and_keeps_the_newest_ten_including_active() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("logs");
        let mut store = FileLogStore::new("test".into(), temp.path().join("state"), vec![root.clone()]);
        for index in 0..12 {
            let marker = format!("record-{index}\n");
            let record = marker.clone() + &" ".repeat(1_048_576 - marker.len());
            store.write_runtime(&record).unwrap();
        }
        let paths = retained(&root, "runtime");
        assert_eq!(paths.len(), 10);
        assert!(paths.iter().all(|path| fs::metadata(path).unwrap().len() <= 1_048_576));
        let text: String = paths.iter().map(|path| fs::read_to_string(path).unwrap()).collect();
        assert!(!text.contains("record-0\n"));
        assert!(!text.contains("record-1\n"));
        assert!(text.contains("record-11\n"));
    }

    #[test]
    fn restart_appends_and_crashes_have_an_independent_budget() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("logs");
        FileLogStore::new("test".into(), temp.path().join("state"), vec![root.clone()]).write_runtime("before\n").unwrap();
        let mut store = FileLogStore::new("test".into(), temp.path().join("state"), vec![root.clone()]);
        store.write_runtime("after\n").unwrap();
        assert_eq!(fs::read_to_string(retained(&root, "runtime").pop().unwrap()).unwrap(), "before\nafter\n");
        for index in 0..12 { store.write_crash(&format!("crash-{index}\n")).unwrap(); }
        assert_eq!(retained(&root, "runtime").len(), 1);
        assert_eq!(retained(&root, "crash").len(), 10);
        let text: String = retained(&root, "crash").iter().map(|path| fs::read_to_string(path).unwrap()).collect();
        assert!(!text.contains("crash-0\n"));
        assert!(text.contains("crash-11\n"));
    }

    #[test]
    fn failed_primary_falls_back_without_touching_unrelated_files() {
        let temp = tempfile::tempdir().unwrap();
        let blocker = temp.path().join("blocker");
        fs::write(&blocker, "keep blocker").unwrap();
        let fallback = temp.path().join("fallback");
        fs::create_dir(&fallback).unwrap();
        fs::write(fallback.join("unrelated.log"), "keep unrelated").unwrap();
        let mut store = FileLogStore::new("test".into(), temp.path().join("state"), vec![blocker.clone(), fallback.clone()]);
        let saved = store.write_crash("fallback proof").unwrap();
        assert!(saved.starts_with(&fallback));
        assert_eq!(fs::read_to_string(saved).unwrap(), "fallback proof");
        assert_eq!(fs::read_to_string(blocker).unwrap(), "keep blocker");
        assert_eq!(fs::read_to_string(fallback.join("unrelated.log")).unwrap(), "keep unrelated");
    }

    #[cfg(unix)]
    #[test]
    fn linked_managed_directory_and_leaf_are_never_followed_or_deleted() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let linked = temp.path().join("linked");
        symlink(&outside, &linked).unwrap();
        let root = temp.path().join("logs");
        fs::create_dir(&root).unwrap();
        let sentinel = outside.join("sentinel");
        fs::write(&sentinel, "keep original").unwrap();
        let leaf = root.join("norea-test-crash-00000000000000000001-1000-42-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.log");
        symlink(&sentinel, &leaf).unwrap();
        let mut store = FileLogStore::new("test".into(), temp.path().join("state"), vec![linked.clone(), root.clone()]);
        for _ in 0..12 { assert!(store.write_crash("owned report").unwrap().starts_with(&root)); }
        assert!(fs::symlink_metadata(&leaf).unwrap().file_type().is_symlink());
        assert!(fs::symlink_metadata(&linked).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&sentinel).unwrap(), "keep original");
        assert_eq!(fs::read_dir(outside).unwrap().count(), 1);
    }

    #[test]
    fn every_destination_failure_returns_an_actionable_error() {
        let temp = tempfile::tempdir().unwrap();
        let blocker = temp.path().join("blocker");
        fs::write(&blocker, "keep").unwrap();
        let result = FileLogStore::new("test".into(), temp.path().join("state"), vec![blocker])
            .write_crash("not persisted");
        let error = result.unwrap_err();
        assert!(error.contains("blocker"), "{error}");
        assert!(error.len() < 16_384);
    }
}
