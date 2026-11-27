mod metadata_journal;

use metadata_journal::MetadataJournal;
use std::collections::HashMap;
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

impl TxOptions {
    pub fn with_app_metadata(app: tauri::AppHandle) -> Self {
        Self {
            metadata_root: MetadataRoot::App(app),
            ..Self::default()
        }
    }
}

#[derive(Debug)]
pub struct TxContext {
    effects: DbMutationEffects,
    metadata_journal: MetadataJournal,
    metadata_file_guards: HashMap<String, (Option<String>, String)>,
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

    pub fn write_metadata_file(&mut self, root: &Path, relative: &str, bytes: &[u8]) -> Result<bool, String> {
        self.prepare_metadata_change(root, relative, Some(bytes))?;
        crate::chapter_media::write_work_metadata_bytes_at(root, relative, bytes)
    }

    pub fn remove_metadata_file(&mut self, root: &Path, relative: &str) -> Result<(), String> {
        self.prepare_metadata_change(root, relative, None)?;
        crate::chapter_media::remove_work_metadata_file_at(root, relative)
    }

    fn prepare_metadata_change(&mut self, root: &Path, relative: &str, intended: Option<&[u8]>) -> Result<(), String> {
        let previous = crate::chapter_media::read_work_metadata_bytes_at(root, relative)?;
        if let Some((original, next)) = self.metadata_file_guards.get(relative) {
            let current = previous.as_deref().map(metadata_journal::digest);
            if current != *original && current.as_ref() != Some(next) {
                return Err("The cover changed outside chapter reconciliation. Existing files and the recovery backup were retained.".into());
            }
        }
        if previous.as_deref() != intended {
            self.metadata_journal.record(root, relative, previous.as_deref(), intended)?;
        }
        Ok(())
    }

    pub fn guard_work_metadata_rollback(
        &mut self,
        relative: impl Into<String>,
        original_sha256: Option<String>,
        next_sha256: String,
    ) {
        self.metadata_file_guards
            .insert(relative.into(), (original_sha256, next_sha256));
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

pub(crate) async fn recover_metadata_files_in_tx(pool: &SqlitePool, conn: &mut SqliteConnection) -> Result<(), String> {
    MetadataJournal::new(pool.connect_options().get_filename()).recover(conn).await
}

pub(crate) async fn recover_metadata_files(pool: &SqlitePool) -> Result<(), String> {
    let mut tx = begin_immediate_with_retries(pool, 0).await?;
    recover_metadata_files_in_tx(pool, &mut tx).await?;
    tx.commit().await.map_err(|err| format!("finish metadata recovery: {err}"))
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
    let metadata_journal = MetadataJournal::new(pool.connect_options().get_filename());
    metadata_journal.recover(&mut tx).await?;
    let mut ctx = TxContext {
        effects: Default::default(),
        metadata_journal,
        metadata_file_guards: HashMap::new(),
        fetched_catalog: None,
        native_directories_dirty_root: None,
    };

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

        if let Some(token) = ctx.metadata_journal.token() {
            sqlx::query("INSERT INTO work_metadata_commit(id, token) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET token = excluded.token")
                .bind(token)
                .execute(&mut *tx)
                .await
                .map_err(|err| format!("record metadata commit: {err}"))?;
        }

        Ok(value)
    }
    .await;

    match outcome {
        Ok(value) => match tx.commit().await {
            Ok(()) => {
                if ctx.metadata_journal.token().is_some() {
                    if let Err(err) = recover_metadata_files(pool).await {
                        log::warn!("db tx: metadata journal cleanup pending: {err}");
                    }
                }
                Ok(DbMutationEnvelope { value, effects: ctx.effects })
            }
            Err(err) => {
                let rollback_failure = recover_metadata_files(pool).await.err();
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
            let rollback_failure = ctx.metadata_journal.recover(&mut tx).await.err();
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
    use std::fs;
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
        let root = test_db.dir.path().to_owned();
        let existing = "contents/demo/work/cover.png";
        let created = "contents/demo/work/override.json";
        let existing_file = root.join(existing);
        let created_file = root.join(created);
        fs::create_dir_all(existing_file.parent().unwrap()).unwrap();
        fs::write(&existing_file, b"before-tx").unwrap();

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
                    ctx.write_metadata_file(&root, existing, b"mutated-in-tx")?;
                    ctx.write_metadata_file(&root, created, b"{}")?;
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
