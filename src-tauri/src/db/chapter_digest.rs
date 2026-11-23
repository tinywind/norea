use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sqlx::{AssertSqlSafe, Row};
use tauri::{AppHandle, State};

use crate::chapter_media::{
    inspect_or_reuse_payload_digest_at, media_root, CachedChapterPayloadDigest,
    ResolvedChapterPayloadDigest,
};
use crate::database::AppDatabase;

use super::chapter::chapter_storage_relative_dir_for_work;

const CHAPTER_DIGEST_CHUNK_SIZE: usize = 500;
const MAX_BACKFILL_BATCH: i64 = 100;
const DEFAULT_BACKFILL_BATCH: i64 = 25;
const MAX_PRE_CANCELLED_IDS: usize = 256;

#[derive(Default)]
pub struct ChapterDigestScanState {
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pre_cancelled: Mutex<HashSet<String>>,
}

struct ScanRegistrationGuard<'a> {
    state: &'a ChapterDigestScanState,
    scan_id: String,
    flag: Arc<AtomicBool>,
}

impl Drop for ScanRegistrationGuard<'_> {
    fn drop(&mut self) {
        self.state.unregister(&self.scan_id, &self.flag);
    }
}

impl ChapterDigestScanState {
    fn register(&self, scan_id: &str) -> Arc<AtomicBool> {
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        let mut pre = self.pre_cancelled.lock().unwrap_or_else(|e| e.into_inner());
        let already_cancelled = pre.remove(scan_id);
        let flag = Arc::new(AtomicBool::new(already_cancelled));
        active.insert(scan_id.to_string(), Arc::clone(&flag));
        flag
    }

    fn unregister(&self, scan_id: &str, flag: &Arc<AtomicBool>) {
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if active
            .get(scan_id)
            .is_some_and(|existing| Arc::ptr_eq(existing, flag))
        {
            active.remove(scan_id);
        }
    }

    pub fn cancel(&self, scan_id: &str) {
        let active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(flag) = active.get(scan_id) {
            flag.store(true, Ordering::Release);
            return;
        }
        drop(active);
        let mut pre = self.pre_cancelled.lock().unwrap_or_else(|e| e.into_inner());
        if pre.len() >= MAX_PRE_CANCELLED_IDS {
            pre.clear();
        }
        pre.insert(scan_id.to_string());
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveChapterPayloadDigestInputDto {
    pub chapter_id: i64,
    pub chapter_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveChapterPayloadDigestItemDto {
    pub chapter_id: i64,
    pub body_sha256: Option<String>,
    pub body_bytes: Option<u64>,
    pub payload_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillChapterPayloadDigestsResultDto {
    pub processed: usize,
    pub next_after_chapter_id: Option<i64>,
    pub remaining: i64,
}

async fn load_cached_digests(
    db: &AppDatabase,
    chapter_ids: &[i64],
) -> Result<HashMap<i64, CachedChapterPayloadDigest>, String> {
    let mut cached = HashMap::with_capacity(chapter_ids.len());
    for chunk in chapter_ids.chunks(CHAPTER_DIGEST_CHUNK_SIZE) {
        let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "SELECT chapter_id, storage_dir, storage_signature, body_sha256, body_bytes, payload_hash \
             FROM chapter_payload_digest WHERE chapter_id IN ({})",
            placeholders.join(",")
        );
        let mut query = sqlx::query(AssertSqlSafe(sql));
        for id in chunk {
            query = query.bind(*id);
        }
        let rows = query
            .fetch_all(db.reader())
            .await
            .map_err(|err| format!("db chapter digest: load cached digests: {err}"))?;
        for row in rows {
            let chapter_id: i64 = row.get("chapter_id");
            let body_bytes: i64 = row.get("body_bytes");
            if body_bytes < 0 {
                continue;
            }
            cached.insert(
                chapter_id,
                CachedChapterPayloadDigest {
                    storage_dir: row.get("storage_dir"),
                    storage_signature: row.get("storage_signature"),
                    body_sha256: row.get("body_sha256"),
                    body_bytes: body_bytes as u64,
                    payload_hash: row.get("payload_hash"),
                },
            );
        }
    }
    Ok(cached)
}

async fn persist_digest_updates(
    db: &AppDatabase,
    upserts: &[(i64, ResolvedChapterPayloadDigest)],
    deletes: &[i64],
) -> Result<(), String> {
    if upserts.is_empty() && deletes.is_empty() {
        return Ok(());
    }
    let mut tx = db
        .writer()
        .begin()
        .await
        .map_err(|err| format!("db chapter digest: begin write tx: {err}"))?;
    for (chapter_id, digest) in upserts {
        let body_bytes = i64::try_from(digest.body_bytes)
            .map_err(|_| "db chapter digest: body size exceeds SQLite integer limit".to_string())?;
        // Use INSERT ... WHERE EXISTS so a chapter deleted concurrently does not fail the batch.
        sqlx::query(
            "INSERT INTO chapter_payload_digest( \
               chapter_id, storage_dir, storage_signature, body_sha256, body_bytes, payload_hash, updated_at \
             ) \
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, unixepoch() \
             WHERE EXISTS (SELECT 1 FROM chapter WHERE id = ?1) \
             ON CONFLICT(chapter_id) DO UPDATE SET \
               storage_dir = excluded.storage_dir, \
               storage_signature = excluded.storage_signature, \
               body_sha256 = excluded.body_sha256, \
               body_bytes = excluded.body_bytes, \
               payload_hash = excluded.payload_hash, \
               updated_at = excluded.updated_at",
        )
        .bind(*chapter_id)
        .bind(&digest.storage_dir)
        .bind(&digest.storage_signature)
        .bind(&digest.body_sha256)
        .bind(body_bytes)
        .bind(&digest.payload_hash)
        .execute(&mut *tx)
        .await
        .map_err(|err| format!("db chapter digest: upsert digest: {err}"))?;
    }
    for chunk in deletes.chunks(CHAPTER_DIGEST_CHUNK_SIZE) {
        let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "DELETE FROM chapter_payload_digest WHERE chapter_id IN ({})",
            placeholders.join(",")
        );
        let mut query = sqlx::query(AssertSqlSafe(sql));
        for id in chunk {
            query = query.bind(*id);
        }
        query
            .execute(&mut *tx)
            .await
            .map_err(|err| format!("db chapter digest: delete stale digests: {err}"))?;
    }
    tx.commit()
        .await
        .map_err(|err| format!("db chapter digest: commit write tx: {err}"))?;
    Ok(())
}

pub(crate) async fn resolve_payload_digests_at(
    db: &AppDatabase,
    root: PathBuf,
    items: Vec<ResolveChapterPayloadDigestInputDto>,
    cancel_flag: Arc<AtomicBool>,
) -> Result<Vec<ResolveChapterPayloadDigestItemDto>, String> {
    if items.is_empty() {
        return Ok(Vec::new());
    }
    if cancel_flag.load(Ordering::Acquire) {
        return Err("Chapter comparison was cancelled.".to_string());
    }
    let chapter_ids: Vec<i64> = items.iter().map(|item| item.chapter_id).collect();
    let cached = load_cached_digests(db, &chapter_ids).await?;
    if cancel_flag.load(Ordering::Acquire) {
        return Err("Chapter comparison was cancelled.".to_string());
    }

    let cancel_for_blocking = Arc::clone(&cancel_flag);
    let (results, upserts, deletes, cancelled) = tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::with_capacity(items.len());
        let mut upserts = Vec::new();
        let mut deletes = Vec::new();
        let mut cancelled = false;
        for item in items {
            if cancel_for_blocking.load(Ordering::Acquire) {
                cancelled = true;
                break;
            }
            let existing = cached.get(&item.chapter_id);
            match inspect_or_reuse_payload_digest_at(&root, &item.chapter_dir, existing) {
                Ok(Some(resolved)) => {
                    let body_sha256 = resolved.body_sha256.clone();
                    let body_bytes = resolved.body_bytes;
                    let payload_hash = resolved.payload_hash.clone();
                    if !resolved.cache_hit {
                        upserts.push((item.chapter_id, resolved));
                    }
                    results.push(ResolveChapterPayloadDigestItemDto {
                        chapter_id: item.chapter_id,
                        body_sha256: Some(body_sha256),
                        body_bytes: Some(body_bytes),
                        payload_hash: Some(payload_hash),
                        error: None,
                    });
                }
                Ok(None) => {
                    if existing.is_some() {
                        deletes.push(item.chapter_id);
                    }
                    results.push(ResolveChapterPayloadDigestItemDto {
                        chapter_id: item.chapter_id,
                        body_sha256: None,
                        body_bytes: None,
                        payload_hash: None,
                        error: None,
                    });
                }
                Err(error) => {
                    results.push(ResolveChapterPayloadDigestItemDto {
                        chapter_id: item.chapter_id,
                        body_sha256: None,
                        body_bytes: None,
                        payload_hash: None,
                        error: Some(error),
                    });
                }
            }
        }
        (results, upserts, deletes, cancelled)
    })
    .await
    .map_err(|err| format!("db chapter digest: resolve task failed: {err}"))?;

    // Persist computed digests even when cancelled so partial progress is reused on the next scan.
    let _ = persist_digest_updates(db, &upserts, &deletes).await;

    if cancelled || cancel_flag.load(Ordering::Acquire) {
        return Err("Chapter comparison was cancelled.".to_string());
    }
    Ok(results)
}

pub(crate) async fn refresh_chapter_payload_digest_best_effort(
    app: &AppHandle,
    db: &AppDatabase,
    chapter_id: i64,
) {
    let Ok(root) = media_root(app) else {
        return;
    };
    let row = sqlx::query(
        "SELECT \
           d.directory AS cached_dir, \
           n.plugin_id, \
           n.source_novel_id, \
           c.chapter_number, \
           c.position \
         FROM chapter c \
         JOIN novel n ON n.id = c.novel_id \
         LEFT JOIN work_metadata_directory_cache d ON d.chapter_id = c.id \
         WHERE c.id = ?1",
    )
    .bind(chapter_id)
    .fetch_optional(db.reader())
    .await;
    let Ok(Some(row)) = row else {
        return;
    };
    let cached_dir: Option<String> = row.get("cached_dir");
    let storage_dir = if let Some(dir) = cached_dir.filter(|value| !value.is_empty()) {
        dir
    } else {
        let plugin_id: String = row.get("plugin_id");
        let source_novel_id: Option<String> = row.get("source_novel_id");
        let chapter_number: Option<String> = row.get("chapter_number");
        let position: i64 = row.get("position");
        let Some(novel_id_str) = source_novel_id else {
            return;
        };
        match chapter_storage_relative_dir_for_work(
            &plugin_id,
            &novel_id_str,
            chapter_number.as_deref(),
            position,
        ) {
            Ok(dir) => dir,
            Err(_) => return,
        }
    };

    let inspected = tauri::async_runtime::spawn_blocking(move || {
        inspect_or_reuse_payload_digest_at(&root, &storage_dir, None)
    })
    .await;
    match inspected {
        Ok(Ok(Some(resolved))) => {
            let _ = persist_digest_updates(db, &[(chapter_id, resolved)], &[]).await;
        }
        Ok(Ok(None)) => {
            let _ = persist_digest_updates(db, &[], &[chapter_id]).await;
        }
        _ => {}
    }
}

pub(crate) async fn backfill_payload_digests_at(
    db: &AppDatabase,
    root: PathBuf,
    after_chapter_id: i64,
    limit: i64,
) -> Result<BackfillChapterPayloadDigestsResultDto, String> {
    let clamped_limit = limit.clamp(1, MAX_BACKFILL_BATCH);
    let rows = sqlx::query(
        "SELECT \
           c.id AS chapter_id, \
           d.directory AS cached_dir, \
           n.plugin_id, \
           n.source_novel_id, \
           c.chapter_number, \
           c.position \
         FROM chapter c \
         JOIN novel n ON n.id = c.novel_id \
         LEFT JOIN chapter_payload_digest p ON p.chapter_id = c.id \
         LEFT JOIN work_metadata_directory_cache d ON d.chapter_id = c.id \
         WHERE c.id > ?1 \
           AND (c.is_downloaded = 1 OR c.content_bytes > 0) \
           AND p.chapter_id IS NULL \
         ORDER BY c.id ASC \
         LIMIT ?2",
    )
    .bind(after_chapter_id)
    .bind(clamped_limit)
    .fetch_all(db.reader())
    .await
    .map_err(|err| format!("db chapter digest: list backfill candidates: {err}"))?;

    if rows.is_empty() {
        return Ok(BackfillChapterPayloadDigestsResultDto {
            processed: 0,
            next_after_chapter_id: None,
            remaining: 0,
        });
    }

    let mut last_chapter_id = after_chapter_id;
    let mut targets: Vec<(i64, String)> = Vec::with_capacity(rows.len());
    for row in rows {
        let chapter_id: i64 = row.get("chapter_id");
        last_chapter_id = chapter_id;
        let cached_dir: Option<String> = row.get("cached_dir");
        let storage_dir = if let Some(dir) = cached_dir.filter(|value| !value.is_empty()) {
            Some(dir)
        } else {
            let plugin_id: String = row.get("plugin_id");
            let source_novel_id: Option<String> = row.get("source_novel_id");
            let chapter_number: Option<String> = row.get("chapter_number");
            let position: i64 = row.get("position");
            source_novel_id.and_then(|novel_id_str| {
                chapter_storage_relative_dir_for_work(
                    &plugin_id,
                    &novel_id_str,
                    chapter_number.as_deref(),
                    position,
                )
                .ok()
            })
        };
        if let Some(dir) = storage_dir {
            targets.push((chapter_id, dir));
        }
    }

    let upserts = tauri::async_runtime::spawn_blocking(move || {
        let mut computed = Vec::new();
        for (chapter_id, storage_dir) in targets {
            if let Ok(Some(resolved)) = inspect_or_reuse_payload_digest_at(&root, &storage_dir, None)
            {
                computed.push((chapter_id, resolved));
            }
        }
        computed
    })
    .await
    .map_err(|err| format!("db chapter digest: backfill task failed: {err}"))?;

    let processed = upserts.len();
    persist_digest_updates(db, &upserts, &[]).await?;

    let remaining: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) \
         FROM chapter c \
         LEFT JOIN chapter_payload_digest p ON p.chapter_id = c.id \
         WHERE c.id > ?1 \
           AND (c.is_downloaded = 1 OR c.content_bytes > 0) \
           AND p.chapter_id IS NULL",
    )
    .bind(last_chapter_id)
    .fetch_one(db.reader())
    .await
    .map_err(|err| format!("db chapter digest: count remaining backfill: {err}"))?;

    Ok(BackfillChapterPayloadDigestsResultDto {
        processed,
        next_after_chapter_id: (remaining > 0).then_some(last_chapter_id),
        remaining,
    })
}

#[tauri::command]
pub async fn db_chapter_resolve_payload_digests(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    scan_state: State<'_, ChapterDigestScanState>,
    scan_id: String,
    items: Vec<ResolveChapterPayloadDigestInputDto>,
) -> Result<Vec<ResolveChapterPayloadDigestItemDto>, String> {
    let flag = scan_state.register(&scan_id);
    let _guard = ScanRegistrationGuard {
        state: &scan_state,
        scan_id,
        flag: Arc::clone(&flag),
    };
    let root = media_root(&app)?;
    resolve_payload_digests_at(&db, root, items, flag).await
}

#[tauri::command]
pub async fn db_chapter_cancel_payload_digest_scan(
    scan_state: State<'_, ChapterDigestScanState>,
    scan_id: String,
) -> Result<(), String> {
    scan_state.cancel(&scan_id);
    Ok(())
}

#[tauri::command]
pub async fn db_chapter_backfill_payload_digests(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    after_chapter_id: Option<i64>,
    limit: Option<i64>,
) -> Result<BackfillChapterPayloadDigestsResultDto, String> {
    let root = media_root(&app)?;
    backfill_payload_digests_at(
        &db,
        root,
        after_chapter_id.unwrap_or(0).max(0),
        limit.unwrap_or(DEFAULT_BACKFILL_BATCH),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::open_and_migrate_pools;
    use std::fs;

    #[tokio::test]
    async fn resolve_caches_reuses_backfills_and_respects_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        let db = open_and_migrate_pools(&dir.path().join("norea.db"))
            .await
            .unwrap();
        let root = dir.path().join("storage");
        fs::create_dir_all(root.join("contents/source/work-1/1")).unwrap();
        fs::create_dir_all(root.join("contents/source/work-1/2")).unwrap();
        fs::write(root.join("contents/source/work-1/1/content.html"), b"one").unwrap();
        fs::write(root.join("contents/source/work-1/2/content.html"), b"two").unwrap();

        sqlx::query(
            "INSERT INTO novel(id, plugin_id, source_novel_id, path, name, in_library) \
             VALUES(1, 'source', 'work-1', '/work', 'Work', 1)",
        )
        .execute(db.writer())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position, is_downloaded, content_bytes) \
             VALUES(1, 1, '/c1', 'One', '1', 1, 1, 3), (2, 1, '/c2', 'Two', '2', 2, 1, 3)",
        )
        .execute(db.writer())
        .await
        .unwrap();

        // Pre-cancelled scan stops immediately without touching disk.
        let state = ChapterDigestScanState::default();
        state.cancel("scan-cancel");
        let cancelled_flag = state.register("scan-cancel");
        let err = resolve_payload_digests_at(
            &db,
            root.clone(),
            vec![ResolveChapterPayloadDigestInputDto {
                chapter_id: 1,
                chapter_dir: "contents/source/work-1/1".into(),
            }],
            cancelled_flag,
        )
        .await
        .unwrap_err();
        assert!(err.contains("cancelled"));

        // Backfill computes one page at a time.
        let page1 = backfill_payload_digests_at(&db, root.clone(), 0, 1)
            .await
            .unwrap();
        assert_eq!(page1.processed, 1);
        assert_eq!(page1.next_after_chapter_id, Some(1));
        assert_eq!(page1.remaining, 1);

        // Resolving both chapters hits cache for chapter 1 and computes + caches chapter 2.
        let resolved = resolve_payload_digests_at(
            &db,
            root.clone(),
            vec![
                ResolveChapterPayloadDigestInputDto {
                    chapter_id: 1,
                    chapter_dir: "contents/source/work-1/1".into(),
                },
                ResolveChapterPayloadDigestInputDto {
                    chapter_id: 2,
                    chapter_dir: "contents/source/work-1/2".into(),
                },
            ],
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        assert_eq!(resolved.len(), 2);
        assert_eq!(resolved[0].body_bytes, Some(3));
        assert!(resolved[0].payload_hash.is_some());
        assert_eq!(resolved[1].body_bytes, Some(3));
        assert!(resolved[1].payload_hash.is_some());
        assert_ne!(resolved[0].payload_hash, resolved[1].payload_hash);

        let cached_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM chapter_payload_digest")
                .fetch_one(db.reader())
                .await
                .unwrap();
        assert_eq!(cached_count, 2);

        // Removing chapter 2's body invalidates its cached digest on resolve.
        fs::remove_file(root.join("contents/source/work-1/2/content.html")).unwrap();
        let after_remove = resolve_payload_digests_at(
            &db,
            root.clone(),
            vec![ResolveChapterPayloadDigestInputDto {
                chapter_id: 2,
                chapter_dir: "contents/source/work-1/2".into(),
            }],
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        assert_eq!(after_remove[0].payload_hash, None);
        let cached_after: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM chapter_payload_digest")
                .fetch_one(db.reader())
                .await
                .unwrap();
        assert_eq!(cached_after, 1);

        db.close().await;
    }
}
