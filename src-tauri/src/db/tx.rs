use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sqlx::{SqliteConnection, SqlitePool};

use super::{
    ChapterDirectoryUpdateDto, DbMutationEffects, DbMutationEnvelope, UserStateCommitPriority,
    WorkDirectoryUpdateDto,
};

const DB_BEGIN_RETRY_DELAY_MS: u64 = 100;

#[derive(Clone, Default)]
pub enum MetadataRoot {
    #[default]
    None,
    Path(PathBuf),
    App(tauri::AppHandle),
}

impl std::fmt::Debug for MetadataRoot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::None => write!(f, "MetadataRoot::None"),
            Self::Path(path) => f.debug_tuple("MetadataRoot::Path").field(path).finish(),
            Self::App(_) => write!(f, "MetadataRoot::App(..)"),
        }
    }
}

impl MetadataRoot {
    pub fn resolve(&self) -> Result<Option<PathBuf>, String> {
        match self {
            Self::None => Ok(None),
            Self::Path(path) => Ok(Some(path.clone())),
            Self::App(app) => crate::chapter_media::media_root(app).map(Some),
        }
    }
}

#[derive(Debug, Clone)]
pub struct TxOptions {
    pub remote_content_sync: bool,
    pub notify_content_sync: bool,
    pub busy_begin_retries: u32,
    pub publish_metadata: bool,
    pub metadata_root: MetadataRoot,
}

impl Default for TxOptions {
    fn default() -> Self {
        Self {
            remote_content_sync: false,
            notify_content_sync: true,
            busy_begin_retries: 0,
            publish_metadata: true,
            metadata_root: MetadataRoot::None,
        }
    }
}

#[derive(Debug)]
struct FileRollbackEntry {
    path: PathBuf,
    previous_bytes: Option<Vec<u8>>,
}

#[derive(Debug)]
struct WorkMetadataRollbackEntry {
    root: PathBuf,
    relative: String,
    previous_bytes: Option<Vec<u8>>,
}

#[derive(Debug, Default)]
pub struct TxContext {
    effects: DbMutationEffects,
    file_rollbacks: Vec<FileRollbackEntry>,
    metadata_file_rollbacks: Vec<WorkMetadataRollbackEntry>,
    fetched_catalog: Option<super::work_metadata::FetchedChapterCatalog>,
    native_directories_dirty_root: Option<PathBuf>,
}

impl TxContext {
    pub fn record_user_state_change(&mut self, priority: UserStateCommitPriority) {
        self.effects.user_state_priority = Some(match self.effects.user_state_priority {
            Some(existing) => existing.merge(priority),
            None => priority,
        });
        self.effects.user_state_ledger_changed = true;
    }

    pub fn record_user_state_ledger_change(&mut self) {
        self.effects.user_state_ledger_changed = true;
    }

    pub fn request_user_state_deferred_apply(&mut self) {
        self.effects.user_state_deferred_ready = true;
    }

    pub fn record_user_state_deferred_novel(&mut self, novel_id: i64) {
        if novel_id > 0 && !self.effects.user_state_deferred_novel_ids.contains(&novel_id) {
            self.effects.user_state_deferred_novel_ids.push(novel_id);
        }
        self.effects.user_state_deferred_ready = true;
    }

    pub fn mark_work_metadata_changed(&mut self) {
        self.effects.work_metadata_changed = true;
    }

    pub fn record_cover_changed(&mut self, novel_id: i64) {
        if novel_id >= 0 && !self.effects.cover_changed_novel_ids.contains(&novel_id) {
            self.effects.cover_changed_novel_ids.push(novel_id);
        }
    }

    pub fn record_work_directory(&mut self, update: WorkDirectoryUpdateDto) {
        self.effects.work_directories.push(update);
    }

    pub fn record_chapter_directory(&mut self, update: ChapterDirectoryUpdateDto) {
        self.effects.chapter_directories.push(update);
    }

    pub fn set_fetched_chapter_catalog(
        &mut self,
        catalog: super::work_metadata::FetchedChapterCatalog,
    ) {
        self.fetched_catalog = Some(catalog);
    }

    pub(crate) fn take_fetched_chapter_catalog(
        &mut self,
    ) -> Option<super::work_metadata::FetchedChapterCatalog> {
        self.fetched_catalog.take()
    }

    pub fn mark_native_directories_dirty(&mut self, root: &Path) {
        if self.native_directories_dirty_root.is_none() {
            self.native_directories_dirty_root = Some(root.to_path_buf());
        }
    }

    /// Captures the pre-transaction contents of a `contents/<plugin>/<work>/...`
    /// metadata or cover file so that any subsequent SQLite or publication error
    /// restores the exact previous file via atomic storage replacement.
    pub fn snapshot_work_metadata_file(
        &mut self,
        root: &Path,
        relative: &str,
    ) -> Result<(), String> {
        if self
            .metadata_file_rollbacks
            .iter()
            .any(|entry| entry.root == root && entry.relative == relative)
        {
            return Ok(());
        }
        let previous_bytes =
            crate::chapter_media::read_work_metadata_bytes_at(root, relative)?;
        self.metadata_file_rollbacks.push(WorkMetadataRollbackEntry {
            root: root.to_path_buf(),
            relative: relative.to_string(),
            previous_bytes,
        });
        Ok(())
    }

    /// Captures the current contents of `path` (if not already captured in this
    /// transaction) so that a subsequent rollback or failed `COMMIT` restores
    /// the exact pre-transaction file state.
    pub fn snapshot_file_for_rollback(&mut self, path: &Path) -> Result<(), String> {
        if self.file_rollbacks.iter().any(|entry| entry.path == path) {
            return Ok(());
        }
        let previous_bytes = match fs::read(path) {
            Ok(bytes) => Some(bytes),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => {
                return Err(format!(
                    "db tx: snapshot '{}' before write: {err}",
                    path.display()
                ))
            }
        };
        self.file_rollbacks.push(FileRollbackEntry {
            path: path.to_path_buf(),
            previous_bytes,
        });
        Ok(())
    }

    fn rollback_files(&mut self) -> Option<String> {
        let mut rollback_failures: Vec<String> = Vec::new();

        for entry in self.metadata_file_rollbacks.drain(..).rev() {
            let current = match crate::chapter_media::read_work_metadata_bytes_at(
                &entry.root,
                &entry.relative,
            ) {
                Ok(bytes) => bytes,
                Err(err) => {
                    rollback_failures.push(err);
                    continue;
                }
            };
            if current == entry.previous_bytes {
                continue;
            }
            let result = match entry.previous_bytes {
                Some(ref bytes) => crate::chapter_media::write_work_metadata_bytes_at(
                    &entry.root,
                    &entry.relative,
                    bytes,
                )
                .map(|_| ()),
                None => crate::chapter_media::remove_work_metadata_file_at(
                    &entry.root,
                    &entry.relative,
                ),
            };
            if let Err(err) = result {
                log::warn!(
                    "db tx: failed to restore work metadata '{}' on rollback: {err}",
                    entry.relative
                );
                rollback_failures.push(err);
            }
        }

        for entry in self.file_rollbacks.drain(..).rev() {
            match entry.previous_bytes {
                Some(bytes) => {
                    if let Some(parent) = entry.path.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    if let Err(err) = fs::write(&entry.path, bytes) {
                        log::warn!(
                            "db tx: failed to restore '{}' on rollback: {err}",
                            entry.path.display()
                        );
                        rollback_failures.push(err.to_string());
                    }
                }
                None => {
                    if let Err(err) = fs::remove_file(&entry.path) {
                        if err.kind() != std::io::ErrorKind::NotFound {
                            log::warn!(
                                "db tx: failed to remove created file '{}' on rollback: {err}",
                                entry.path.display()
                            );
                            rollback_failures.push(err.to_string());
                        }
                    }
                }
            }
        }

        if rollback_failures.is_empty() {
            None
        } else {
            Some(rollback_failures.join("; "))
        }
    }
}

fn is_busy_error(error: &sqlx::Error) -> bool {
    let text = error.to_string();
    let lower = text.to_ascii_lowercase();
    lower.contains("database is locked")
        || lower.contains("database is busy")
        || lower.contains("sqlite_busy")
        || lower.contains("sqlite_locked")
        || lower.contains("code: 5 ")
        || lower.contains("code: 6 ")
}

async fn begin_immediate_with_retries(
    pool: &SqlitePool,
    retries: u32,
) -> Result<sqlx::Transaction<'static, sqlx::Sqlite>, String> {
    let attempts = retries.saturating_add(1);
    for attempt in 0..attempts {
        match pool.begin_with("BEGIN IMMEDIATE").await {
            Ok(tx) => return Ok(tx),
            Err(err) if is_busy_error(&err) && attempt + 1 < attempts => {
                let delay_ms = DB_BEGIN_RETRY_DELAY_MS.saturating_mul(u64::from(attempt + 1));
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            Err(err) => return Err(format!("db tx: begin immediate: {err}")),
        }
    }
    Err("db tx: could not start write transaction".to_string())
}

async fn set_content_sync_origin(conn: &mut SqliteConnection, remote: bool) -> Result<(), String> {
    let flag: i64 = if remote { 1 } else { 0 };
    sqlx::query("UPDATE content_sync_origin SET remote = ?1 WHERE id = 1")
        .bind(flag)
        .execute(conn)
        .await
        .map(|_| ())
        .map_err(|err| format!("db tx: set content_sync_origin remote={flag}: {err}"))
}

async fn read_content_sync_max_sequence(conn: &mut SqliteConnection) -> Result<Option<i64>, String> {
    sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(MAX(sequence), 0) FROM content_sync_journal",
    )
    .fetch_optional(conn)
    .await
    .map_err(|err| format!("db tx: read content_sync_journal max sequence: {err}"))
}

pub async fn with_write_tx<T, F>(
    pool: &SqlitePool,
    options: TxOptions,
    run: F,
) -> Result<DbMutationEnvelope<T>, String>
where
    F: for<'c> FnOnce(
        &'c mut SqliteConnection,
        &'c mut TxContext,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'c>>,
{
    let mut tx = begin_immediate_with_retries(pool, options.busy_begin_retries).await?;
    let mut ctx = TxContext::default();

    let outcome: Result<T, String> = async {
        if options.remote_content_sync {
            set_content_sync_origin(&mut tx, true).await?;
        }

        let value = run(&mut tx, &mut ctx).await?;

        if options.publish_metadata && !matches!(options.metadata_root, MetadataRoot::None) {
            let fetched = ctx.take_fetched_chapter_catalog();
            super::work_metadata::flush_dirty_in_tx(
                &options.metadata_root,
                &mut tx,
                &mut ctx,
                fetched.as_ref(),
            )
            .await?;
        }

        if options.remote_content_sync {
            set_content_sync_origin(&mut tx, false).await?;
        }

        if options.notify_content_sync {
            ctx.effects.content_sync_max_sequence =
                read_content_sync_max_sequence(&mut tx).await?;
        }

        Ok(value)
    }
    .await;

    match outcome {
        Ok(value) => match tx.commit().await {
            Ok(()) => Ok(DbMutationEnvelope {
                value,
                effects: ctx.effects,
            }),
            Err(err) => {
                let rollback_failure = ctx.rollback_files();
                if let Some(root) = ctx.native_directories_dirty_root.take() {
                    let _ =
                        super::work_metadata::restore_native_directories_from_pool(pool, &root)
                            .await;
                }
                match rollback_failure {
                    Some(rb_err) => Err(format!(
                        "work metadata: publication and rollback failed: db tx: commit: {err}; rollback: {rb_err}"
                    )),
                    None => Err(format!("db tx: commit: {err}")),
                }
            }
        },
        Err(error) => {
            let rollback_failure = ctx.rollback_files();
            if let Err(rollback_err) = tx.rollback().await {
                log::warn!("db tx: rollback failed after error: {rollback_err}");
            }
            if let Some(root) = ctx.native_directories_dirty_root.take() {
                let _ =
                    super::work_metadata::restore_native_directories_from_pool(pool, &root).await;
            }
            match rollback_failure {
                Some(rb_err) => Err(format!(
                    "work metadata: publication and rollback failed: {error}; rollback: {rb_err}"
                )),
                None => Err(error),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::open_test_db;
    use crate::db::ReadMode;

    #[tokio::test]
    async fn write_tx_commits_and_reports_merged_effects() {
        let test_db = open_test_db().await;
        let envelope = with_write_tx(
            test_db.db.pool_for(ReadMode::Queued),
            TxOptions::default(),
            |conn, ctx| {
                Box::pin(async move {
                    sqlx::query(
                        "INSERT INTO novel (plugin_id, path, name, in_library) VALUES ('demo', '/n1', 'Novel 1', 1)",
                    )
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| err.to_string())?;
                    ctx.record_user_state_ledger_change();
                    ctx.record_user_state_change(UserStateCommitPriority::Reading);
                    ctx.record_user_state_change(UserStateCommitPriority::Normal);
                    ctx.record_user_state_deferred_novel(1);
                    ctx.mark_work_metadata_changed();
                    ctx.record_cover_changed(1);
                    ctx.record_cover_changed(1);
                    ctx.record_work_directory(WorkDirectoryUpdateDto {
                        novel_id: 1,
                        plugin_id: "demo".to_string(),
                        novel_path: "/n1".to_string(),
                        directory: Some("contents/demo/n1".to_string()),
                        fingerprint: Some("fp1".to_string()),
                    });
                    ctx.record_chapter_directory(ChapterDirectoryUpdateDto {
                        chapter_id: 10,
                        directory: Some("contents/demo/n1/0001".to_string()),
                    });
                    Ok(42_i64)
                })
            },
        )
        .await
        .expect("write tx succeeds");

        assert_eq!(envelope.value, 42);
        assert_eq!(
            envelope.effects.user_state_priority,
            Some(UserStateCommitPriority::Normal)
        );
        assert!(envelope.effects.user_state_ledger_changed);
        assert!(envelope.effects.user_state_deferred_ready);
        assert_eq!(envelope.effects.user_state_deferred_novel_ids, vec![1]);
        assert!(envelope.effects.work_metadata_changed);
        assert_eq!(envelope.effects.cover_changed_novel_ids, vec![1]);
        assert_eq!(envelope.effects.work_directories.len(), 1);
        assert_eq!(envelope.effects.chapter_directories.len(), 1);
        assert!(envelope.effects.content_sync_max_sequence.is_some());

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM novel")
            .fetch_one(test_db.db.pool_for(ReadMode::Committed))
            .await
            .expect("reader sees committed row");
        assert_eq!(count, 1);
        test_db.db.close().await;
    }

    #[tokio::test]
    async fn remote_origin_guard_suppresses_content_sync_journal_triggers_and_resets_flag() {
        let test_db = open_test_db().await;
        with_write_tx(
            test_db.db.writer(),
            TxOptions {
                remote_content_sync: true,
                ..TxOptions::default()
            },
            |conn, _ctx| {
                Box::pin(async move {
                    sqlx::query(
                        "INSERT INTO novel (id, plugin_id, path, name, in_library) VALUES (1, 'demo', '/n1', 'Novel 1', 1)",
                    )
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| err.to_string())?;
                    sqlx::query(
                        "INSERT INTO chapter (id, novel_id, path, name, position, is_downloaded, stored_content_type) VALUES (10, 1, '/c1', 'Ch 1', 1, 1, 'html')",
                    )
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| err.to_string())?;
                    Ok(())
                })
            },
        )
        .await
        .expect("remote sync tx succeeds");

        let journal_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM content_sync_journal")
            .fetch_one(test_db.db.writer())
            .await
            .unwrap();
        assert_eq!(
            journal_count, 0,
            "remote=1 must suppress echo entries in content_sync_journal"
        );

        let remote_flag: i64 =
            sqlx::query_scalar("SELECT remote FROM content_sync_origin WHERE id = 1")
                .fetch_one(test_db.db.writer())
                .await
                .unwrap();
        assert_eq!(remote_flag, 0, "remote flag must be reset before commit");
        test_db.db.close().await;
    }

    #[tokio::test]
    async fn failed_write_tx_rolls_back_sqlite_and_file_snapshots() {
        let test_db = open_test_db().await;
        let existing_file = test_db.dir.path().join("existing-novel.json");
        let created_file = test_db.dir.path().join("created-novel.json");
        fs::write(&existing_file, b"before-tx").unwrap();

        let existing_clone = existing_file.clone();
        let created_clone = created_file.clone();
        let err = with_write_tx(
            test_db.db.writer(),
            TxOptions::default(),
            move |conn, ctx| {
                Box::pin(async move {
                    sqlx::query(
                        "INSERT INTO novel (plugin_id, path, name, in_library) VALUES ('demo', '/rollback', 'Rollback', 1)",
                    )
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| err.to_string())?;
                    ctx.snapshot_file_for_rollback(&existing_clone)?;
                    fs::write(&existing_clone, b"mutated-in-tx").unwrap();
                    ctx.snapshot_file_for_rollback(&created_clone)?;
                    fs::write(&created_clone, b"new-in-tx").unwrap();
                    Err::<(), String>("simulated failure".to_string())
                })
            },
        )
        .await
        .unwrap_err();

        assert_eq!(err, "simulated failure");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM novel")
            .fetch_one(test_db.db.writer())
            .await
            .unwrap();
        assert_eq!(count, 0);
        assert_eq!(fs::read(&existing_file).unwrap(), b"before-tx");
        assert!(!created_file.exists());
        test_db.db.close().await;
    }
}
