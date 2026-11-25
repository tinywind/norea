use std::collections::HashSet;
use std::fs;

use serde_json::{json, Value as JsonValue};
use sqlx::{AssertSqlSafe, Row};
use tempfile::TempDir;

use crate::db::chapter_composition::ChapterCompositionV1Dto;
use crate::db::test_support::open_test_db;
use crate::db::tx::{with_write_tx, MetadataRoot, TxOptions};
use crate::db::ReadMode;

use super::core::{
    load_held_migration_sources_in_tx, load_user_chapter_rows_by_ids_in_tx, map_user_chapter_row,
    mark_private_chapter_progress_in_tx, populate_user_chapter_composition_ids_in_tx,
    promote_private_work_identities_in_tx, record_chapter_rows_in_tx,
    record_user_state_changes_in_tx, USER_CHAPTER_SELECT,
};
use super::ledger::{
    acknowledge_user_state_operations_in_tx, apply_local_user_state_retention_in_tx,
    apply_user_state_read_page_in_tx, bind_user_state_workspace_in_tx,
    bind_user_state_workspace_with_options_in_tx, get_user_state_ledger_status_in_tx,
    list_user_state_conflicts_in_tx, prepare_user_state_operations_in_tx,
    project_pending_user_state_bounded_in_tx, project_pending_user_state_in_tx,
    prune_acknowledged_user_state_operations_in_tx, rebind_user_state_workspace_in_tx,
    reconcile_user_state_snapshot_in_tx, resolve_user_state_ledger_conflict_in_tx,
    PrepareUserStateOperationsLimitsDto, ADVANCE_ACKNOWLEDGED_PROGRESS_SQL,
    DEFAULT_USER_STATE_OPERATION_RETENTION_SECS, MARK_ACKNOWLEDGED_RECORDS_APPLIED_SQL,
};
use super::materialize::{
    apply_shared_composition_in_tx, defer_user_state_for_novel_in_tx, find_user_state_work_in_tx,
    refresh_unattempted_user_state_identities_in_tx, MaterializeError,
};
use super::migration::{remap_unattempted_chapter_paths_in_tx, UserStateChapterPathBefore};
use super::work_categories::{list_work_categories_in_conn, WorkCategoryLookupDto};
use super::types::{
    parse_user_state_merge_result, parse_user_state_retention_response,
    parse_user_state_snapshot_response, sha256_hex, stored_chapter_path, user_state_entity_key,
    ResolveUserStateLedgerConflictInputDto, UserStateBindingDto, UserStateRebindMode,
    UserStateWorkReferenceDto,
};

fn sample_binding() -> UserStateBindingDto {
    UserStateBindingDto {
        server_url: "https://state.example".to_string(),
        workspace_id: "workspace-1".to_string(),
        epoch: "epoch-1".to_string(),
    }
}

fn sample_work() -> JsonValue {
    json!({
        "pluginId": "source",
        "sourceNovelId": "book",
        "novelPath": "/book",
        "name": "Book",
    })
}

fn shared_record(entity: JsonValue, value: JsonValue, revision: i64, op_id: &str) -> JsonValue {
    json!({
        "entity": entity,
        "value": value,
        "revision": revision,
        "operationId": op_id,
        "updatedAt": revision,
        "deviceId": "other-device",
        "deviceName": "Other device",
    })
}

async fn seed_sample_work(pool: &sqlx::SqlitePool) {
    sqlx::query(
        "INSERT INTO novel(id, plugin_id, source_novel_id, path, name) \
         VALUES (1, 'source', 'book', '/book', 'Book')",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position) \
         VALUES (11, 1, '/chapter/1', 'One', '1', 1)",
    )
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn explain_query_plan_uses_namespace_and_entity_key_index() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    let query = "EXPLAIN QUERY PLAN \
                 SELECT r.entity_key AS entityKey, r.revision, r.payload \
                 FROM json_each(?2) incoming CROSS JOIN user_state_record r \
                   ON r.entity_key = json_extract(incoming.value, '$.entityKey') \
                 WHERE r.namespace = ?1";
    let rows = sqlx::query(query)
        .bind("[\"https://state.example\",\"workspace-1\",\"epoch-1\"]")
        .bind("[{\"entityKey\":\"[\\\"library\\\",\\\"[\\\\\\\"source\\\\\\\",\\\\\\\"id\\\\\\\",\\\\\\\"book\\\\\\\"]\\\"]\"}]")
        .fetch_all(pool)
        .await
        .unwrap();
    let details: Vec<String> = rows.into_iter().map(|r| r.get("detail")).collect();
    assert!(
        details
            .iter()
            .any(|d| d.contains("namespace=? AND entity_key=?")),
        "expected compound PK lookup in query plan, got: {details:?}"
    );
}

#[tokio::test]
async fn acknowledgement_batches_look_up_each_incoming_key_through_the_primary_key() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    for sql in [
        MARK_ACKNOWLEDGED_RECORDS_APPLIED_SQL,
        ADVANCE_ACKNOWLEDGED_PROGRESS_SQL,
    ] {
        let rows = sqlx::query(AssertSqlSafe(format!("EXPLAIN QUERY PLAN {sql}")))
            .bind("[\"https://state.example\",\"workspace-1\",\"epoch-1\"]")
            .bind("[{\"entityKey\":\"key\",\"revision\":1,\"intentSequence\":1,\"baseRevision\":1}]")
            .fetch_all(pool)
            .await
            .unwrap();
        let details: Vec<String> = rows.into_iter().map(|r| r.get("detail")).collect();
        assert!(
            details
                .iter()
                .any(|d| d.contains("namespace=? AND entity_key=?")),
            "expected compound PK lookup in query plan, got: {details:?}"
        );
    }
}

#[tokio::test]
async fn projection_checks_composed_chapter_ownership_for_every_record_of_a_work() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    let binding = sample_binding();
    let opts = TxOptions {
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };

    let b1 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { bind_user_state_workspace_in_tx(conn, ctx, &b1).await })
    })
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO novel(id, plugin_id, source_novel_id, path, name) \
         VALUES (1, 'source', 'book', '/book', 'Book')",
    )
    .execute(pool)
    .await
    .unwrap();
    for (id, entry) in [(21_i64, "entry-1"), (22, "entry-2"), (23, "entry-3")] {
        sqlx::query(
            "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position) \
             VALUES (?1, 1, ?2, ?3, ?4, ?1)",
        )
        .bind(id)
        .bind(format!("norea-composed:{entry}"))
        .bind(entry)
        .bind(id.to_string())
        .execute(pool)
        .await
        .unwrap();
    }
    sqlx::query("INSERT INTO novel_chapter_composition(novel_id, payload) VALUES (1, ?1)")
        .bind(
            json!({ "entries": [
                { "id": "entry-1", "path": "norea-composed:entry-1" },
                { "id": "entry-2", "path": "norea-composed:entry-2" },
                { "id": "entry-3", "path": "norea-composed:entry-3" },
            ] })
            .to_string(),
        )
        .execute(pool)
        .await
        .unwrap();

    let work = sample_work();
    let reading = |entry: &str, owner: &str, revision: i64| {
        shared_record(
            json!({
                "kind": "reading",
                "work": work,
                "chapter": {
                    "chapterPath": format!("norea-composed:{entry}"),
                    "compositionEntryId": owner,
                },
            }),
            json!({ "progress": 10 * revision, "readAt": 100 + revision }),
            revision,
            &format!("op-{revision}"),
        )
    };
    let page = json!({
        "version": 1,
        "workspaceId": binding.workspace_id,
        "epoch": binding.epoch,
        "headRevision": 3,
        "through": 3,
        "nextCursor": 3,
        "hasMore": false,
        "records": [
            reading("entry-1", "entry-1", 1),
            reading("entry-2", "replaced-entry", 2),
            reading("entry-3", "entry-3", 3),
        ],
    });
    let b2 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { apply_user_state_read_page_in_tx(conn, ctx, &b2, &page).await })
    })
    .await
    .unwrap();

    let b3 = binding.clone();
    with_write_tx(pool, opts, move |conn, ctx| {
        Box::pin(async move {
            project_pending_user_state_in_tx(None, conn, ctx, &b3, &HashSet::new()).await
        })
    })
    .await
    .unwrap();

    let progress: Vec<(i64, f64)> =
        sqlx::query("SELECT id, CAST(progress AS REAL) AS progress FROM chapter ORDER BY id")
            .fetch_all(pool)
            .await
            .unwrap()
            .into_iter()
            .map(|row| (row.get("id"), row.get("progress")))
            .collect();
    assert_eq!(progress, vec![(21, 10.0), (22, 0.0), (23, 30.0)]);
    let deferred: Vec<Option<String>> =
        sqlx::query("SELECT deferred_reason FROM user_state_record ORDER BY revision")
            .fetch_all(pool)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.get("deferred_reason"))
            .collect();
    assert_eq!(
        deferred,
        vec![None, Some("chapter-ownership-mismatch".to_string()), None]
    );
}

#[tokio::test]
async fn prelink_edits_become_soft_seeds_and_project_shared_deletions_preserving_dirty_set() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    seed_sample_work(pool).await;

    sqlx::query("INSERT INTO category(id, name, sort, is_system) VALUES (80, 'Pinned', 1, 0)")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO user_state_category(category_id, local_id) VALUES ('local-prelink', 80)")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO novel_category(novel_id, category_id) VALUES (1, 80)")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE novel SET in_library = 1 WHERE id = 1")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE chapter SET progress = 100 WHERE id = 11")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM work_metadata_dirty")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO work_metadata_dirty(plugin_id, path) VALUES ('keep-plugin', '/keep')")
        .execute(pool)
        .await
        .unwrap();

    let work = sample_work();
    let reading_ent = json!({
        "kind": "reading",
        "work": work,
        "chapter": { "chapterPath": "/chapter/1", "name": "One" },
    });
    let library_ent = json!({ "kind": "library", "work": work });
    let resume_ent = json!({ "kind": "resume", "work": work });
    let category_ent = json!({ "kind": "category", "categoryId": "local-prelink" });
    let membership_ent = json!({
        "kind": "membership",
        "work": work,
        "categoryId": "local-prelink",
    });

    let c1 = (reading_ent.clone(), json!({ "progress": 100, "readAt": null }));
    let c2 = (library_ent.clone(), json!({ "inLibrary": true, "addedAt": 20 }));
    let c3 = (
        resume_ent.clone(),
        json!({ "chapter": { "chapterPath": "/chapter/1", "name": "One" }, "anchor": null, "openedAt": 20 }),
    );
    let c4 = (category_ent.clone(), json!({ "name": "Pinned", "sort": 1, "deleted": false }));
    let c5 = (membership_ent.clone(), json!({ "included": true }));

    let opts = TxOptions {
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            record_user_state_changes_in_tx(conn, ctx, &[c1, c2, c3, c4, c5], false).await
        })
    })
    .await
    .unwrap();

    let binding = sample_binding();
    let b1 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { bind_user_state_workspace_in_tx(conn, ctx, &b1).await })
    })
    .await
    .unwrap();

    let b2 = binding.clone();
    let baseline = with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            refresh_unattempted_user_state_identities_in_tx(conn, None).await?;
            prepare_user_state_operations_in_tx(
                None,
                conn,
                ctx,
                &b2,
                &PrepareUserStateOperationsLimitsDto::default(),
            )
            .await
        })
    })
    .await
    .unwrap()
    .value;

    assert_eq!(baseline.len(), 4);
    assert!(baseline.iter().all(|op| op["entity"]["kind"] != json!("library")));
    assert!(baseline
        .iter()
        .all(|op| op["seed"] == json!(true) && op["baseRevision"] == json!(0)));

    let remote = vec![
        shared_record(
            category_ent,
            json!({ "name": "Pinned", "sort": 1, "deleted": true }),
            1,
            "r-1",
        ),
        shared_record(
            library_ent,
            json!({ "inLibrary": false, "addedAt": null }),
            2,
            "r-2",
        ),
        shared_record(membership_ent, json!({ "included": false }), 3, "r-3"),
        shared_record(
            reading_ent,
            json!({ "progress": 0, "readAt": null }),
            4,
            "r-4",
        ),
        shared_record(
            resume_ent,
            json!({ "chapter": null, "anchor": null, "openedAt": null }),
            5,
            "r-5",
        ),
    ];

    let page = json!({
        "version": 1,
        "workspaceId": binding.workspace_id,
        "epoch": binding.epoch,
        "headRevision": 5,
        "through": 5,
        "nextCursor": 5,
        "hasMore": false,
        "records": remote,
    });
    let b3 = binding.clone();
    let env = with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { apply_user_state_read_page_in_tx(conn, ctx, &b3, &page).await })
    })
    .await
    .unwrap();
    assert!(env.effects.user_state_deferred_ready);
    assert!(env.effects.user_state_ledger_changed);

    let mut read_conn = pool.acquire().await.unwrap();
    let status_before = get_user_state_ledger_status_in_tx(&mut read_conn, Some(&binding))
        .await
        .unwrap();
    drop(read_conn);
    assert_eq!(status_before.projection_pending, 4);

    let b4 = binding.clone();
    let proj_opts = TxOptions {
        remote_content_sync: true,
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };
    let proj_res = with_write_tx(pool, proj_opts, move |conn, ctx| {
        Box::pin(async move {
            project_pending_user_state_in_tx(None, conn, ctx, &b4, &HashSet::new()).await
        })
    })
    .await
    .unwrap()
    .value;
    assert_eq!(proj_res.resumes.len(), 1);
    assert_eq!(proj_res.resumes[0].chapter_id, None);

    let ch_state = sqlx::query("SELECT CAST(progress AS REAL) AS progress FROM chapter WHERE id = 11")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(ch_state.get::<f64, _>("progress"), 0.0);

    let in_lib: i64 = sqlx::query_scalar("SELECT in_library FROM novel WHERE id = 1")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(in_lib, 1);

    let cat_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM category WHERE id = 80")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(cat_count, 0);

    let dirty_rows: Vec<(String, String)> =
        sqlx::query("SELECT plugin_id, path FROM work_metadata_dirty")
            .fetch_all(pool)
            .await
            .unwrap()
            .into_iter()
            .map(|r| (r.get("plugin_id"), r.get("path")))
            .collect();
    assert_eq!(
        dirty_rows,
        vec![("keep-plugin".to_string(), "/keep".to_string())]
    );

    let receipts: Vec<JsonValue> = baseline
        .iter()
        .map(|op| {
            let op_key = user_state_entity_key(&op["entity"]).unwrap();
            let cur = remote
                .iter()
                .find(|r| user_state_entity_key(&r["entity"]).unwrap() == op_key)
                .unwrap();
            json!({
                "operationId": op["operationId"],
                "status": "seed-skipped",
                "current": cur,
            })
        })
        .collect();
    let b5 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            acknowledge_user_state_operations_in_tx(conn, ctx, &b5, &receipts).await
        })
    })
    .await
    .unwrap();

    let b6 = binding.clone();
    let remaining = with_write_tx(pool, opts, move |conn, ctx| {
        Box::pin(async move {
            prepare_user_state_operations_in_tx(
                None,
                conn,
                ctx,
                &b6,
                &PrepareUserStateOperationsLimitsDto::default(),
            )
            .await
        })
    })
    .await
    .unwrap()
    .value;
    assert!(remaining.is_empty());
}

#[tokio::test]
async fn portable_stored_chapter_digest_upgrades_norea_folder_and_resolves_on_projection() {
    let temp = TempDir::new().unwrap();
    let body_bytes = b"<p>Stored chapter 19 body</p>";
    let chapter_dir = temp.path().join("contents/source/book/19");
    fs::create_dir_all(&chapter_dir).unwrap();
    fs::write(chapter_dir.join("content.html"), body_bytes).unwrap();
    let inventory =
        crate::chapter_media::inspect_payload_inventory_at(temp.path(), "contents/source/book/19")
            .unwrap();
    let payload_digest = super::types::stored_chapter_digest(&inventory).unwrap();

    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    sqlx::query(
        "INSERT INTO novel(id, plugin_id, source_novel_id, path, name) \
         VALUES (1, 'source', 'book', '/book', 'Book')",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position, is_downloaded, stored_content_type) \
         VALUES (11, 1, 'norea-folder:19', 'Nineteen', '19', 1, 1, 'html')",
    )
    .execute(pool)
    .await
    .unwrap();

    let binding = sample_binding();
    let opts = TxOptions {
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };
    let b1 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { bind_user_state_workspace_in_tx(conn, ctx, &b1).await })
    })
    .await
    .unwrap();

    let local_ent = json!({
        "kind": "reading",
        "work": sample_work(),
        "chapter": { "chapterPath": "norea-folder:19", "name": "Nineteen" },
    });
    let local_val = json!({ "progress": 75, "readAt": 100 });
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            record_user_state_changes_in_tx(conn, ctx, &[(local_ent, local_val)], false).await
        })
    })
    .await
    .unwrap();

    let root_path = temp.path().to_path_buf();
    let b2 = binding.clone();
    let ops = with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            prepare_user_state_operations_in_tx(
                Some(&root_path),
                conn,
                ctx,
                &b2,
                &PrepareUserStateOperationsLimitsDto {
                    allow_opaque_identity: Some(true),
                    ..PrepareUserStateOperationsLimitsDto::default()
                },
            )
            .await
        })
    })
    .await
    .unwrap()
    .value;

    let expected_stored_path = stored_chapter_path(Some("19"), &payload_digest).unwrap();
    assert_eq!(ops.len(), 1);
    assert_eq!(
        ops[0]["entity"]["chapter"]["chapterPath"],
        json!(expected_stored_path)
    );

    // Apply on a second fresh DB that has the same physical payload on disk
    let peer_db = open_test_db().await;
    let peer_pool = peer_db.db.pool_for(ReadMode::Queued);
    sqlx::query(
        "INSERT INTO novel(id, plugin_id, source_novel_id, path, name) \
         VALUES (1, 'source', 'book', '/book', 'Book')",
    )
    .execute(peer_pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position, is_downloaded, stored_content_type) \
         VALUES (22, 1, 'norea-folder:19', 'Nineteen', '19', 1, 1, 'html')",
    )
    .execute(peer_pool)
    .await
    .unwrap();

    let pb1 = binding.clone();
    with_write_tx(peer_pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { bind_user_state_workspace_in_tx(conn, ctx, &pb1).await })
    })
    .await
    .unwrap();

    let rec = shared_record(
        ops[0]["entity"].clone(),
        ops[0]["value"].clone(),
        1,
        "op-stored",
    );
    let page = json!({
        "version": 1,
        "workspaceId": binding.workspace_id,
        "epoch": binding.epoch,
        "headRevision": 1,
        "through": 1,
        "nextCursor": 1,
        "hasMore": false,
        "records": [rec.clone()],
    });
    let pb2 = binding.clone();
    with_write_tx(peer_pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { apply_user_state_read_page_in_tx(conn, ctx, &pb2, &page).await })
    })
    .await
    .unwrap();

    let peer_root = temp.path().to_path_buf();
    let pb3 = binding.clone();
    with_write_tx(peer_pool, opts, move |conn, ctx| {
        Box::pin(async move {
            project_pending_user_state_in_tx(
                Some(&peer_root),
                conn,
                ctx,
                &pb3,
                &HashSet::new(),
            )
            .await
        })
    })
    .await
    .unwrap();

    let peer_prog: f64 =
        sqlx::query_scalar("SELECT CAST(progress AS REAL) FROM chapter WHERE id = 22")
            .fetch_one(peer_pool)
            .await
            .unwrap();
    assert_eq!(peer_prog, 75.0);
}

#[tokio::test]
async fn conflict_recording_and_local_resolution_rebases_progress() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    seed_sample_work(pool).await;

    let binding = sample_binding();
    let opts = TxOptions {
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };
    let b1 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { bind_user_state_workspace_in_tx(conn, ctx, &b1).await })
    })
    .await
    .unwrap();

    let cat_ent = json!({ "kind": "category", "categoryId": "cat-1" });
    let cat_val = json!({ "name": "Favorites", "sort": 0, "deleted": false });
    let c_ent = cat_ent.clone();
    let c_val = cat_val.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            record_user_state_changes_in_tx(conn, ctx, &[(c_ent, c_val)], false).await
        })
    })
    .await
    .unwrap();

    let b2 = binding.clone();
    let ops = with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            prepare_user_state_operations_in_tx(
                None,
                conn,
                ctx,
                &b2,
                &PrepareUserStateOperationsLimitsDto::default(),
            )
            .await
        })
    })
    .await
    .unwrap()
    .value;
    assert_eq!(ops.len(), 1);

    let shared_cat = shared_record(
        cat_ent,
        json!({ "name": "SharedName", "sort": 2, "deleted": false }),
        7,
        "remote-cat",
    );
    let ack = vec![json!({
        "operationId": ops[0]["operationId"],
        "status": "conflict",
        "current": shared_cat,
        "reason": "category-name-conflict",
    })];
    let b3 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { acknowledge_user_state_operations_in_tx(conn, ctx, &b3, &ack).await })
    })
    .await
    .unwrap();

    let mut conn = pool.acquire().await.unwrap();
    let status = get_user_state_ledger_status_in_tx(&mut conn, Some(&binding))
        .await
        .unwrap();
    assert_eq!(status.conflicts, 1);
    let conflicts = list_user_state_conflicts_in_tx(&mut conn, &binding)
        .await
        .unwrap();
    drop(conn);
    assert_eq!(conflicts.len(), 1);

    let input = ResolveUserStateLedgerConflictInputDto {
        id: conflicts[0].id.clone(),
        version: conflicts[0].version.clone(),
        choice: "local".to_string(),
        category_name: Some("RenamedLocal".to_string()),
    };
    let b4 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { resolve_user_state_ledger_conflict_in_tx(conn, ctx, &b4, &input).await })
    })
    .await
    .unwrap();

    let b5 = binding.clone();
    let retried = with_write_tx(pool, opts, move |conn, ctx| {
        Box::pin(async move {
            prepare_user_state_operations_in_tx(
                None,
                conn,
                ctx,
                &b5,
                &PrepareUserStateOperationsLimitsDto::default(),
            )
            .await
        })
    })
    .await
    .unwrap()
    .value;
    assert_eq!(retried.len(), 1);
    assert_eq!(retried[0]["baseRevision"], json!(7));
    assert_eq!(retried[0]["value"]["name"], json!("RenamedLocal"));
}

#[tokio::test]
async fn bulk_projection_skips_missing_works_applies_pre_download_stored_progress_and_reopens_via_b_route() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    let binding = sample_binding();
    let opts = TxOptions {
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };

    let b1 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { bind_user_state_workspace_in_tx(conn, ctx, &b1).await })
    })
    .await
    .unwrap();

    let digest = sha256_hex(b"chapter-19-payload");
    let stored_path = stored_chapter_path(Some("19"), &digest).unwrap();
    let work = sample_work();
    let remote = vec![
        shared_record(
            json!({ "kind": "library", "work": work }),
            json!({ "inLibrary": true, "addedAt": 100 }),
            1,
            "op-lib",
        ),
        shared_record(
            json!({
                "kind": "reading",
                "work": work,
                "chapter": { "chapterPath": stored_path, "name": "Nineteen" },
            }),
            json!({ "progress": 64, "readAt": 250 }),
            2,
            "op-read",
        ),
    ];
    let page = json!({
        "version": 1,
        "workspaceId": binding.workspace_id,
        "epoch": binding.epoch,
        "headRevision": 2,
        "through": 2,
        "nextCursor": 2,
        "hasMore": false,
        "records": remote,
    });

    let b2 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { apply_user_state_read_page_in_tx(conn, ctx, &b2, &page).await })
    })
    .await
    .unwrap();

    // Novel is not in DB yet -> bulk projection parks missing-work immediately with 0 pending.
    let b3 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            project_pending_user_state_in_tx(None, conn, ctx, &b3, &HashSet::new()).await
        })
    })
    .await
    .unwrap();

    let mut conn = pool.acquire().await.unwrap();
    let status = get_user_state_ledger_status_in_tx(&mut conn, Some(&binding))
        .await
        .unwrap();
    drop(conn);
    assert_eq!(status.projection_pending, 0);
    assert_eq!(status.projection_failed, 0);

    // Add novel + undownloaded server-cached chapter (is_downloaded = 0, content_bytes = 0) and trigger B route.
    sqlx::query(
        "INSERT INTO novel(id, plugin_id, source_novel_id, path, name, in_library) \
         VALUES (1, 'source', 'book', '/book', 'Book', 0)",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position, is_downloaded, content_bytes) \
         VALUES (19, 1, 'norea-folder:19', 'Nineteen', '19', 1, 0, 0)",
    )
    .execute(pool)
    .await
    .unwrap();

    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { defer_user_state_for_novel_in_tx(conn, ctx, 1).await })
    })
    .await
    .unwrap();

    let b4 = binding.clone();
    with_write_tx(pool, opts, move |conn, ctx| {
        Box::pin(async move {
            project_pending_user_state_in_tx(None, conn, ctx, &b4, &HashSet::new()).await
        })
    })
    .await
    .unwrap();

    let row = sqlx::query(
        "SELECT n.in_library, n.last_read_at, CAST(c.progress AS REAL) AS progress, c.read_at \
         FROM novel n JOIN chapter c ON c.novel_id = n.id WHERE n.id = 1 AND c.id = 19",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(row.get::<i64, _>("in_library"), 0);
    assert_eq!(row.get::<Option<i64>, _>("last_read_at"), Some(250));
    assert_eq!(row.get::<f64, _>("progress"), 64.0);
    assert_eq!(row.get::<Option<i64>, _>("read_at"), Some(250));
}

#[tokio::test]
async fn retired_migration_sources_and_local_works_are_excluded_and_settled() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    let binding = sample_binding();
    let opts = TxOptions {
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };

    // Seed a local novel + chapter with reading state before binding workspace.
    sqlx::query(
        "INSERT INTO novel(id, plugin_id, source_novel_id, path, name, is_local, in_library) \
         VALUES (10, 'local', 'local-doc', 'local', 'Local Work', 1, 1)",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position, progress, bookmark) \
         VALUES (101, 10, 'local-ch-1', 'Local One', '1', 1, 88, 1)",
    )
    .execute(pool)
    .await
    .unwrap();

    // Also insert a retired migration source novel that still exists locally alongside its migration cache entry.
    sqlx::query(
        "INSERT INTO novel(id, plugin_id, source_novel_id, path, name, in_library) \
         VALUES (20, 'retired-src', 'old-book', '/old-book', 'Old Book', 0)",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO content_sync_cache(cache_key, payload) VALUES (?1, ?2)",
    )
    .bind("norea-content-novel-migration:op-retired")
    .bind(
        json!({
            "operationId": "op-retired",
            "serverUrl": format!("{}/", binding.server_url),
            "status": "completed",
            "source": {
                "pluginId": "retired-src",
                "novelId": "old-book",
                "novelPath": "/old-book",
            },
        })
        .to_string(),
    )
    .execute(pool)
    .await
    .unwrap();

    let b1 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { bind_user_state_workspace_in_tx(conn, ctx, &b1).await })
    })
    .await
    .unwrap();

    // Local changes must produce zero outbound operations.
    let local_ent = json!({
        "kind": "library",
        "work": {
            "pluginId": "local",
            "sourceNovelId": "local-doc",
            "novelPath": "local",
            "name": "Local Work",
        },
    });
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            record_user_state_changes_in_tx(
                conn,
                ctx,
                &[(local_ent, json!({ "inLibrary": true, "addedAt": 10 }))],
                false,
            )
            .await
        })
    })
    .await
    .unwrap();

    let b2 = binding.clone();
    let ops = with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            prepare_user_state_operations_in_tx(
                None,
                conn,
                ctx,
                &b2,
                &PrepareUserStateOperationsLimitsDto::default(),
            )
            .await
        })
    })
    .await
    .unwrap()
    .value;
    assert!(ops.is_empty());

    // Receive remote records for both the retired migration source and a legacy local work.
    let page = json!({
        "version": 1,
        "workspaceId": binding.workspace_id,
        "epoch": binding.epoch,
        "headRevision": 2,
        "through": 2,
        "nextCursor": 2,
        "hasMore": false,
        "records": [
            shared_record(
                json!({
                    "kind": "library",
                    "work": {
                        "pluginId": "retired-src",
                        "sourceNovelId": "old-book",
                        "novelPath": "/old-book",
                        "name": "Old Book",
                    },
                }),
                json!({ "inLibrary": true, "addedAt": 50 }),
                1,
                "op-retired-lib",
            ),
            shared_record(
                json!({
                    "kind": "library",
                    "work": {
                        "pluginId": "local",
                        "sourceNovelId": "local-doc",
                        "novelPath": "local",
                        "name": "Local Work",
                    },
                }),
                json!({ "inLibrary": false, "addedAt": null }),
                2,
                "op-local-lib",
            ),
        ],
    });
    let b3 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { apply_user_state_read_page_in_tx(conn, ctx, &b3, &page).await })
    })
    .await
    .unwrap();

    let mut conn = pool.acquire().await.unwrap();
    let status_before = get_user_state_ledger_status_in_tx(&mut conn, Some(&binding))
        .await
        .unwrap();
    drop(conn);
    assert_eq!(status_before.projection_pending, 0);

    let b4 = binding.clone();
    with_write_tx(pool, opts, move |conn, ctx| {
        Box::pin(async move {
            project_pending_user_state_in_tx(None, conn, ctx, &b4, &HashSet::new()).await
        })
    })
    .await
    .unwrap();

    // Neither the retired source (id 20) nor the local novel (id 10) should be mutated by remote state.
    let retired_lib: i64 = sqlx::query_scalar("SELECT in_library FROM novel WHERE id = 20")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(retired_lib, 0);
    let local_lib: i64 = sqlx::query_scalar("SELECT in_library FROM novel WHERE id = 10")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(local_lib, 1);
}

#[tokio::test]
async fn work_categories_come_from_shared_state_until_the_work_has_local_categories() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    let binding = sample_binding();
    let opts = TxOptions {
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };
    let b1 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { bind_user_state_workspace_in_tx(conn, ctx, &b1).await })
    })
    .await
    .unwrap();

    let work = sample_work();
    let other = json!({ "pluginId": "source", "sourceNovelId": "other", "novelPath": "/other", "name": "Other" });
    let category = |id: &str, name: &str, sort: i64, deleted: bool, revision: i64| {
        shared_record(
            json!({ "kind": "category", "categoryId": id }),
            json!({ "name": name, "sort": sort, "deleted": deleted }),
            revision,
            &format!("op-{revision}"),
        )
    };
    let membership = |work: &JsonValue, id: &str, included: bool, revision: i64| {
        shared_record(
            json!({ "kind": "membership", "work": work, "categoryId": id }),
            json!({ "included": included }),
            revision,
            &format!("op-{revision}"),
        )
    };
    let page = json!({
        "version": 1,
        "workspaceId": binding.workspace_id,
        "epoch": binding.epoch,
        "headRevision": 9,
        "through": 9,
        "nextCursor": 9,
        "hasMore": false,
        "records": [
            category("cat-favorites", "Favorites", 2, false, 1),
            category("cat-later", "Later", 1, false, 2),
            shared_record(json!({ "kind": "library", "work": work }), json!({ "inLibrary": true, "addedAt": 100 }), 3, "op-3"),
            membership(&work, "cat-favorites", true, 4),
            membership(&work, "cat-later", true, 5),
            membership(&work, "cat-removed", true, 6),
            shared_record(json!({ "kind": "library", "work": other }), json!({ "inLibrary": false, "addedAt": null }), 7, "op-7"),
            membership(&other, "cat-favorites", true, 8),
            category("cat-removed", "Removed", 3, true, 9),
        ],
    });
    let b2 = binding.clone();
    with_write_tx(pool, opts, move |conn, ctx| {
        Box::pin(async move { apply_user_state_read_page_in_tx(conn, ctx, &b2, &page).await })
    })
    .await
    .unwrap();

    let lookups = vec![
        WorkCategoryLookupDto {
            plugin_id: "source".to_string(),
            novel_id: "BOOK".to_string(),
            novel_path: "/book".to_string(),
        },
        WorkCategoryLookupDto {
            plugin_id: "source".to_string(),
            novel_id: "other".to_string(),
            novel_path: "/other".to_string(),
        },
    ];
    let categories = |lookups: Vec<WorkCategoryLookupDto>, server_url: &'static str| async move {
        let mut conn = pool.acquire().await.unwrap();
        list_work_categories_in_conn(&mut conn, server_url, &lookups)
            .await
            .unwrap()
            .into_iter()
            .map(|work| work.categories)
            .collect::<Vec<_>>()
    };

    // Not installed here: the received records answer, in or out of the library, without the deleted category.
    assert_eq!(
        categories(lookups.clone(), "https://state.example/").await,
        vec![
            vec!["Later".to_string(), "Favorites".to_string()],
            vec!["Favorites".to_string()]
        ]
    );
    assert_eq!(
        categories(lookups.clone(), "https://another.example").await,
        vec![Vec::<String>::new(), vec![]]
    );

    // Unsent local edits are newer than the received records.
    for (id, included) in [("cat-favorites", false), ("cat-removed", true)] {
        let entity = json!({ "kind": "membership", "work": work, "categoryId": id });
        sqlx::query(
            "INSERT INTO user_state_intent(entity_key, entity_json, value_json) VALUES (?1, ?2, ?3)",
        )
        .bind(user_state_entity_key(&entity).unwrap())
        .bind(entity.to_string())
        .bind(json!({ "included": included }).to_string())
        .execute(pool)
        .await
        .unwrap();
    }
    assert_eq!(
        categories(lookups.clone(), "https://state.example").await[0],
        vec!["Later".to_string()]
    );

    // A work installed here without categories of its own still answers from the shared state.
    sqlx::query(
        "INSERT INTO novel(id, plugin_id, source_novel_id, path, name, in_library) \
         VALUES (1, 'source', 'book', '/book', 'Book', 0)",
    )
    .execute(pool)
    .await
    .unwrap();
    assert_eq!(
        categories(lookups.clone(), "https://state.example").await[0],
        vec!["Later".to_string()]
    );

    // Its own categories answer once it has some, whether or not it is in the library.
    sqlx::query("INSERT INTO category(id, name, sort, is_system) VALUES (50, 'Local shelf', 1, 0)")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO novel_category(novel_id, category_id) VALUES (1, 50)")
        .execute(pool)
        .await
        .unwrap();
    assert_eq!(
        categories(lookups, "https://state.example").await[0],
        vec!["Local shelf".to_string()]
    );
}

#[tokio::test]
async fn path_only_work_category_lookups_match_synced_source_id_records_and_local_offline_works() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    let binding = sample_binding();
    let opts = TxOptions {
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };
    let b1 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { bind_user_state_workspace_in_tx(conn, ctx, &b1).await })
    })
    .await
    .unwrap();

    let synced_work = json!({
        "pluginId": "bookkor",
        "sourceNovelId": "8256",
        "novelPath": "/novel/8256",
        "name": "Synced Novel",
    });
    let page = json!({
        "version": 1,
        "workspaceId": binding.workspace_id,
        "epoch": binding.epoch,
        "headRevision": 4,
        "through": 4,
        "nextCursor": 4,
        "hasMore": false,
        "records": [
            shared_record(
                json!({ "kind": "category", "categoryId": "cat-stars" }),
                json!({ "name": "5 Stars", "sort": 1, "deleted": false }),
                1,
                "op-1",
            ),
            shared_record(
                json!({ "kind": "category", "categoryId": "cat-later" }),
                json!({ "name": "Later", "sort": 2, "deleted": false }),
                2,
                "op-2",
            ),
            shared_record(
                json!({ "kind": "membership", "work": synced_work, "categoryId": "cat-stars" }),
                json!({ "included": true }),
                3,
                "op-3",
            ),
            shared_record(
                json!({ "kind": "membership", "work": synced_work, "categoryId": "cat-later" }),
                json!({ "included": true }),
                4,
                "op-4",
            ),
        ],
    });
    let b2 = binding.clone();
    with_write_tx(pool, opts, move |conn, ctx| {
        Box::pin(async move { apply_user_state_read_page_in_tx(conn, ctx, &b2, &page).await })
    })
    .await
    .unwrap();

    // Local work with a local category (not in the shared state).
    sqlx::query(
        "INSERT INTO novel(id, plugin_id, source_novel_id, path, name, in_library) \
         VALUES (10, 'bookkor', '9001', '/novel/9001', 'Local Only', 0)",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO category(id, name, sort, is_system) VALUES (60, 'Favorite', 1, 0)")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO novel_category(novel_id, category_id) VALUES (10, 60)")
        .execute(pool)
        .await
        .unwrap();

    // Source search results do not carry `novelId`.
    let path_only_lookups = vec![
        WorkCategoryLookupDto {
            plugin_id: "bookkor".to_string(),
            novel_id: String::new(),
            novel_path: "/novel/8256".to_string(),
        },
        WorkCategoryLookupDto {
            plugin_id: "bookkor".to_string(),
            novel_id: String::new(),
            novel_path: "/novel/9001".to_string(),
        },
    ];

    // With a configured server, path-only lookups find both synced source-id records and local categories.
    let mut conn = pool.acquire().await.unwrap();
    let with_server =
        list_work_categories_in_conn(&mut conn, "https://state.example", &path_only_lookups)
            .await
            .unwrap();
    assert_eq!(
        with_server.iter().map(|row| row.categories.clone()).collect::<Vec<_>>(),
        vec![
            vec!["5 Stars".to_string(), "Later".to_string()],
            vec!["Favorite".to_string()],
        ]
    );

    // An unsent local intent removing one category overrides the received record even on path-only lookup.
    let removal_entity =
        json!({ "kind": "membership", "work": synced_work, "categoryId": "cat-later" });
    sqlx::query(
        "INSERT INTO user_state_intent(entity_key, entity_json, value_json) VALUES (?1, ?2, ?3)",
    )
    .bind(user_state_entity_key(&removal_entity).unwrap())
    .bind(removal_entity.to_string())
    .bind(json!({ "included": false }).to_string())
    .execute(&mut *conn)
    .await
    .unwrap();
    let after_pending =
        list_work_categories_in_conn(&mut conn, "https://state.example", &path_only_lookups)
            .await
            .unwrap();
    assert_eq!(after_pending[0].categories, vec!["5 Stars".to_string()]);

    // Without a configured server, local categories still answer cleanly.
    let without_server = list_work_categories_in_conn(&mut conn, "", &path_only_lookups)
        .await
        .unwrap();
    assert_eq!(
        without_server.iter().map(|row| row.categories.clone()).collect::<Vec<_>>(),
        vec![Vec::<String>::new(), vec!["Favorite".to_string()]]
    );
}

#[tokio::test]
async fn defer_user_state_for_novel_reopens_only_deferred_records() {
    use crate::db::content_sync::{delete_local_novel_records_in_tx, DeleteLocalNovelRecordsInputDto};

    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    let binding = sample_binding();
    let opts = TxOptions {
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };
    let proj_opts = TxOptions {
        remote_content_sync: true,
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };

    sqlx::query(
        "INSERT INTO novel(id, plugin_id, source_novel_id, path, name, in_library) \
         VALUES (1, 'source', 'book', '/book', 'Book', 0)",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position) \
         VALUES (11, 1, '/chapter/1', 'One', '1', 1)",
    )
    .execute(pool)
    .await
    .unwrap();

    let b1 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { bind_user_state_workspace_in_tx(conn, ctx, &b1).await })
    })
    .await
    .unwrap();

    let work = sample_work();
    let remote = vec![
        shared_record(
            json!({ "kind": "library", "work": work }),
            json!({ "inLibrary": true, "addedAt": 100 }),
            1,
            "op-lib",
        ),
        shared_record(
            json!({
                "kind": "reading",
                "work": work,
                "chapter": { "chapterPath": "/chapter/1", "name": "One" },
            }),
            json!({ "progress": 50, "readAt": 100 }),
            2,
            "op-read-1",
        ),
        shared_record(
            json!({
                "kind": "reading",
                "work": work,
                "chapter": { "chapterPath": "/chapter/2", "name": "Two" },
            }),
            json!({ "progress": 90, "readAt": 200 }),
            3,
            "op-read-2",
        ),
    ];
    let page = json!({
        "version": 1,
        "workspaceId": binding.workspace_id,
        "epoch": binding.epoch,
        "headRevision": 3,
        "through": 3,
        "nextCursor": 3,
        "hasMore": false,
        "records": remote,
    });
    let b2 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { apply_user_state_read_page_in_tx(conn, ctx, &b2, &page).await })
    })
    .await
    .unwrap();

    let b3 = binding.clone();
    with_write_tx(pool, proj_opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            project_pending_user_state_in_tx(None, conn, ctx, &b3, &HashSet::new()).await
        })
    })
    .await
    .unwrap();

    let states = || async {
        sqlx::query(
            "SELECT revision, applied_revision, deferred_reason \
             FROM user_state_record ORDER BY revision",
        )
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.get::<i64, _>("revision"),
                row.get::<i64, _>("applied_revision"),
                row.get::<Option<String>, _>("deferred_reason"),
            )
        })
        .collect::<Vec<_>>()
    };

    assert_eq!(
        states().await,
        vec![
            (1, 1, None),
            (2, 2, None),
            (3, 3, Some("missing-chapter".to_string())),
        ]
    );
    let mut read_conn = pool.acquire().await.unwrap();
    let initial_status = get_user_state_ledger_status_in_tx(&mut read_conn, Some(&binding))
        .await
        .unwrap();
    drop(read_conn);
    assert_eq!(initial_status.projection_pending, 0);
    assert_eq!(initial_status.projection_failed, 0);

    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position) \
         VALUES (12, 1, '/chapter/2', 'Two', '2', 2)",
    )
    .execute(pool)
    .await
    .unwrap();

    let reopen_env = with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { defer_user_state_for_novel_in_tx(conn, ctx, 1).await })
    })
    .await
    .unwrap();
    assert!(reopen_env.effects.user_state_deferred_ready);
    assert_eq!(
        states().await,
        vec![(1, 1, None), (2, 2, None), (3, 0, None)]
    );

    let mut read_conn = pool.acquire().await.unwrap();
    let pending_status = get_user_state_ledger_status_in_tx(&mut read_conn, Some(&binding))
        .await
        .unwrap();
    drop(read_conn);
    assert_eq!(pending_status.projection_pending, 1);

    let b4 = binding.clone();
    with_write_tx(pool, proj_opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            project_pending_user_state_in_tx(None, conn, ctx, &b4, &HashSet::new()).await
        })
    })
    .await
    .unwrap();

    let ch12_progress: f64 =
        sqlx::query_scalar("SELECT CAST(progress AS REAL) FROM chapter WHERE id = 12")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(ch12_progress, 90.0);

    let mut read_conn = pool.acquire().await.unwrap();
    let applied_status = get_user_state_ledger_status_in_tx(&mut read_conn, Some(&binding))
        .await
        .unwrap();
    drop(read_conn);
    assert_eq!(applied_status.projection_pending, 0);

    let noop_env = with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { defer_user_state_for_novel_in_tx(conn, ctx, 1).await })
    })
    .await
    .unwrap();
    assert!(!noop_env.effects.user_state_deferred_ready);
    assert_eq!(
        states().await,
        vec![(1, 1, None), (2, 2, None), (3, 3, None)]
    );

    let mut read_conn = pool.acquire().await.unwrap();
    let after_noop_status = get_user_state_ledger_status_in_tx(&mut read_conn, Some(&binding))
        .await
        .unwrap();
    drop(read_conn);
    assert_eq!(after_noop_status.projection_pending, 0);

    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            delete_local_novel_records_in_tx(
                conn,
                ctx,
                &DeleteLocalNovelRecordsInputDto {
                    id: 1,
                    plugin_id: "source".to_string(),
                    source_novel_id: Some("book".to_string()),
                    path: "/book".to_string(),
                    record_user_state_removal: false,
                },
            )
            .await
        })
    })
    .await
    .unwrap();

    assert_eq!(
        states().await,
        vec![
            (1, 1, None),
            (2, 2, Some("missing-work".to_string())),
            (3, 3, Some("missing-work".to_string())),
        ]
    );
    let mut read_conn = pool.acquire().await.unwrap();
    let deleted_status = get_user_state_ledger_status_in_tx(&mut read_conn, Some(&binding))
        .await
        .unwrap();
    drop(read_conn);
    assert_eq!(deleted_status.projection_pending, 0);

    sqlx::query(
        "INSERT INTO novel(id, plugin_id, source_novel_id, path, name, in_library) \
         VALUES (1, 'source', 'book', '/book', 'Book', 0)",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position) \
         VALUES (11, 1, '/chapter/1', 'One', '1', 1), \
                (12, 1, '/chapter/2', 'Two', '2', 2)",
    )
    .execute(pool)
    .await
    .unwrap();

    let restore_env = with_write_tx(pool, opts, move |conn, ctx| {
        Box::pin(async move { defer_user_state_for_novel_in_tx(conn, ctx, 1).await })
    })
    .await
    .unwrap();
    assert!(restore_env.effects.user_state_deferred_ready);
    assert_eq!(
        states().await,
        vec![(1, 1, None), (2, 0, None), (3, 0, None)]
    );

    let b5 = binding.clone();
    with_write_tx(pool, proj_opts, move |conn, ctx| {
        Box::pin(async move {
            project_pending_user_state_in_tx(None, conn, ctx, &b5, &HashSet::new()).await
        })
    })
    .await
    .unwrap();

    let in_library: i64 = sqlx::query_scalar("SELECT in_library FROM novel WHERE id = 1")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(in_library, 0);
    let recovered_progress: Vec<(i64, f64)> = sqlx::query(
        "SELECT id, CAST(progress AS REAL) AS progress FROM chapter WHERE novel_id = 1 ORDER BY id",
    )
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|row| (row.get("id"), row.get("progress")))
    .collect();
    assert_eq!(recovered_progress, vec![(11, 50.0), (12, 90.0)]);
}

#[tokio::test]
async fn projects_pending_records_in_bounded_chunks_without_retrying_skipped_failures() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    let binding = sample_binding();
    let opts = TxOptions {
        remote_content_sync: false,
        notify_content_sync: false,
        busy_begin_retries: 0,
        publish_metadata: false,
        metadata_root: MetadataRoot::None,
    };

    seed_sample_work(pool).await;
    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position) \
         VALUES (12, 1, '/chapter/2', 'Two', '2', 2), \
                (13, 1, '/chapter/3', 'Three', '3', 3)",
    )
    .execute(pool)
    .await
    .unwrap();

    let b1 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { bind_user_state_workspace_in_tx(conn, ctx, &b1).await })
    })
    .await
    .unwrap();

    let missing_work = json!({
        "pluginId": "other",
        "sourceNovelId": "missing-book",
        "novelPath": "/missing-book",
        "name": "Missing",
    });
    let mut records = Vec::new();
    for idx in 1..=20 {
        records.push(shared_record(
            json!({
                "kind": "reading",
                "work": missing_work,
                "chapter": { "chapterPath": format!("/missing/{idx}"), "name": format!("M{idx}") },
            }),
            json!({ "progress": 10, "readAt": idx }),
            idx,
            &format!("op-miss-{idx}"),
        ));
    }
    records.push(shared_record(
        json!({ "kind": "category", "categoryId": "cat-1" }),
        json!({ "name": "Favorites", "sort": 1, "deleted": false }),
        21,
        "op-cat",
    ));
    records.push(shared_record(
        json!({
            "kind": "reading",
            "work": sample_work(),
            "chapter": { "chapterPath": "/chapter/1", "name": "One" },
        }),
        json!({ "progress": 25, "readAt": 100 }),
        22,
        "op-read-1",
    ));
    records.push(shared_record(
        json!({
            "kind": "reading",
            "work": sample_work(),
            "chapter": { "chapterPath": "/chapter/2", "name": "Two" },
        }),
        json!({ "progress": 50, "readAt": 200 }),
        23,
        "op-read-2",
    ));
    records.push(shared_record(
        json!({
            "kind": "reading",
            "work": sample_work(),
            "chapter": { "chapterPath": "/chapter/3", "name": "Three" },
        }),
        json!({ "progress": 75, "readAt": 300 }),
        24,
        "op-read-3",
    ));

    let page = json!({
        "version": 1,
        "workspaceId": binding.workspace_id,
        "epoch": binding.epoch,
        "headRevision": 24,
        "through": 24,
        "nextCursor": 24,
        "hasMore": false,
        "records": records,
    });
    let b2 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { apply_user_state_read_page_in_tx(conn, ctx, &b2, &page).await })
    })
    .await
    .unwrap();

    // Inject one corrupted referenced category record so the valid pending membership triggers MaterializeError::Fatal.
    let bad_cat_key = user_state_entity_key(&json!({ "kind": "category", "categoryId": "cat-corrupt" })).unwrap();
    sqlx::query(
        "INSERT INTO user_state_record(namespace, entity_key, revision, applied_revision, payload) \
         VALUES (?1, ?2, 1, 1, 'not-json')",
    )
    .bind(super::types::namespace_for(&binding))
    .bind(&bad_cat_key)
    .execute(pool)
    .await
    .unwrap();

    let bad_entity = json!({
        "kind": "membership",
        "work": sample_work(),
        "categoryId": "cat-corrupt",
    });
    let bad_key = user_state_entity_key(&bad_entity).unwrap();
    let bad_payload = json!({
        "entity": bad_entity,
        "value": { "included": true },
        "revision": 25,
        "operationId": "op-bad",
        "updatedAt": 25,
        "deviceId": "other",
        "deviceName": "Other",
    });
    sqlx::query(
        "INSERT INTO user_state_record(namespace, entity_key, revision, applied_revision, payload) \
         VALUES (?1, ?2, 25, 0, ?3)",
    )
    .bind(super::types::namespace_for(&binding))
    .bind(&bad_key)
    .bind(bad_payload.to_string())
    .execute(pool)
    .await
    .unwrap();

    let mut skipped = HashSet::new();
    let mut chunks = 0_usize;
    loop {
        chunks += 1;
        let b_loop = binding.clone();
        let skip_clone = skipped.clone();
        let fx = with_write_tx(pool, opts.clone(), move |conn, ctx| {
            Box::pin(async move {
                project_pending_user_state_bounded_in_tx(
                    None,
                    conn,
                    ctx,
                    &b_loop,
                    &HashSet::new(),
                    Some(2),
                    &skip_clone,
                )
                .await
            })
        })
        .await
        .unwrap()
        .value;
        for failed in &fx.failed_entity_keys {
            assert!(skipped.insert(failed.clone()), "failed entity must not repeat within one drain");
        }
        if !fx.has_more {
            break;
        }
        assert!(chunks < 10, "bounded projection failed to terminate");
    }

    assert!(chunks >= 2);
    assert!(skipped.contains(&bad_key));
    let progresses: Vec<f64> = sqlx::query_scalar(
        "SELECT CAST(progress AS REAL) FROM chapter WHERE novel_id = 1 ORDER BY id",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    assert_eq!(progresses, vec![25.0, 50.0, 75.0]);
    let cat_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM category WHERE name = 'Favorites'")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(cat_count, 1);
    let parked_missing: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM user_state_record WHERE deferred_reason = 'missing-work'",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(parked_missing, 20);
}

#[tokio::test]
async fn populates_composition_entry_ids_and_scans_content_sync_cache_by_prefix() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    seed_sample_work(pool).await;
    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position) \
         VALUES (12, 1, 'norea-composed:entry-2', 'Composed Two', '2', 2)",
    )
    .execute(pool)
    .await
    .unwrap();
    let comp_payload = json!({
        "version": 1,
        "updatedAt": 1,
        "entries": [
            {
                "id": "entry-2",
                "path": "norea-composed:entry-2",
                "storageChapterNumber": "2",
                "primarySource": 0,
                "user": { "included": true, "order": 2, "name": null, "chapterNumber": null },
                "sources": [
                    {
                        "pluginId": "source",
                        "novelId": "book",
                        "novelPath": "/book",
                        "chapterPath": "/raw/2",
                        "chapterNumber": "2",
                        "name": "Raw Two",
                        "position": 2,
                        "page": "1",
                        "contentType": "html",
                        "releaseTime": null
                    }
                ]
            }
        ]
    });
    sqlx::query(
        "INSERT INTO novel_chapter_composition(novel_id, payload) VALUES (1, ?1)",
    )
    .bind(comp_payload.to_string())
    .execute(pool)
    .await
    .unwrap();

    // Add large unrelated cache blobs alongside migration and renumber entries.
    sqlx::query("INSERT INTO content_sync_cache(cache_key, payload) VALUES (?1, ?2)")
        .bind("norea-novel-merge-storage:big")
        .bind(format!("{{\"blob\":\"{}\"}}", "x".repeat(64_000)))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO content_sync_cache(cache_key, payload) VALUES (?1, ?2)")
        .bind("norea-content-incoming-migration:op-1")
        .bind(
            json!({
                "serverUrl": "https://state.example/",
                "status": "pending",
                "operationId": "op-1",
                "source": { "pluginId": "source", "novelId": "book", "novelPath": "/book" }
            })
            .to_string(),
        )
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO content_sync_cache(cache_key, payload) VALUES (?1, ?2)")
        .bind("norea-source-chapter-renumber:work-1")
        .bind(json!({ "work": { "id": 1 } }).to_string())
        .execute(pool)
        .await
        .unwrap();

    let mut conn = pool.acquire().await.unwrap();
    let rows = load_user_chapter_rows_by_ids_in_tx(&mut conn, &[11, 12])
        .await
        .unwrap();
    assert_eq!(rows[0].composition_entry_id, None);
    assert_eq!(rows[1].composition_entry_id.as_deref(), Some("entry-2"));

    let mut direct: Vec<_> = sqlx::query(AssertSqlSafe(format!("{USER_CHAPTER_SELECT} ORDER BY c.id")))
        .fetch_all(&mut *conn)
        .await
        .unwrap()
        .iter()
        .map(map_user_chapter_row)
        .collect();
    populate_user_chapter_composition_ids_in_tx(&mut conn, &mut direct)
        .await
        .unwrap();
    assert_eq!(direct[1].composition_entry_id.as_deref(), Some("entry-2"));

    let held = load_held_migration_sources_in_tx(&mut conn, "https://state.example")
        .await
        .unwrap();
    assert!(held.id_pairs.contains(&("source".to_string(), "book".to_string())));

    let is_held = crate::db::content_sync::is_novel_migration_source_held_in_conn(
        &mut conn,
        "https://state.example",
        "source",
        "/book",
        "book",
    )
    .await
    .unwrap();
    assert!(is_held);
}

#[tokio::test]
async fn acknowledge_and_prune_operations_respects_retention_and_preserves_attempt_history() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    seed_sample_work(pool).await;
    sqlx::query("UPDATE novel SET source_novel_id = NULL WHERE id = 1")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position) \
         VALUES (12, 1, '/chapter/2', 'Two', '2', 2)",
    )
    .execute(pool)
    .await
    .unwrap();

    let binding = sample_binding();
    let opts = TxOptions {
        remote_content_sync: false,
        notify_content_sync: false,
        busy_begin_retries: 3,
        publish_metadata: false,
        metadata_root: MetadataRoot::None,
    };

    let b1 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { bind_user_state_workspace_in_tx(conn, ctx, &b1).await })
    })
    .await
    .unwrap();

    let work_no_id = json!({
        "pluginId": "source",
        "sourceNovelId": null,
        "novelPath": "/book",
        "name": "Book",
    });
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            record_user_state_changes_in_tx(
                conn,
                ctx,
                &[
                    (
                        json!({ "kind": "reading", "work": work_no_id.clone(), "chapter": { "chapterPath": "/chapter/1", "name": "One" } }),
                        json!({ "progress": 25.0, "readAt": null }),
                    ),
                    (
                        json!({ "kind": "reading", "work": work_no_id, "chapter": { "chapterPath": "/chapter/2", "name": "Two" } }),
                        json!({ "progress": 50.0, "readAt": null }),
                    ),
                ],
                false,
            )
            .await
        })
    })
    .await
    .unwrap();

    let b2 = binding.clone();
    let ops = with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            prepare_user_state_operations_in_tx(
                None,
                conn,
                ctx,
                &b2,
                &PrepareUserStateOperationsLimitsDto {
                    allow_opaque_identity: Some(true),
                    ..Default::default()
                },
            )
            .await
        })
    })
    .await
    .unwrap()
    .value;
    assert_eq!(ops.len(), 2);

    let op1 = &ops[0];
    let op2 = &ops[1];
    let op1_id = op1["operationId"].as_str().unwrap().to_string();
    let op2_id = op2["operationId"].as_str().unwrap().to_string();
    let op1_receipt = json!({
        "operationId": op1_id,
        "status": "applied",
        "current": shared_record(op1["entity"].clone(), op1["value"].clone(), 1, &op1_id),
    });
    let op2_receipt = json!({
        "operationId": op2_id,
        "status": "conflict",
        "reason": "revision-mismatch",
        "current": null,
    });

    let b3 = binding.clone();
    let r1 = op1_receipt.clone();
    let r2 = op2_receipt.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            acknowledge_user_state_operations_in_tx(conn, ctx, &b3, &[r1, r2]).await
        })
    })
    .await
    .unwrap();

    let (op1_status, op1_ack_at): (String, Option<i64>) = sqlx::query_as(
        "SELECT status, acknowledged_at FROM user_state_operation WHERE operation_id = ?1",
    )
    .bind(&op1_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(op1_status, "acknowledged");
    assert!(op1_ack_at.is_some_and(|v| v > 0));

    let (op2_status, op2_ack_at): (String, Option<i64>) = sqlx::query_as(
        "SELECT status, acknowledged_at FROM user_state_operation WHERE operation_id = ?1",
    )
    .bind(&op2_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(op2_status, "conflict");
    assert_eq!(op2_ack_at, None);

    // Idempotent replay preserves original acknowledged_at.
    let fixed_ack_at = op1_ack_at.unwrap() - 100;
    sqlx::query("UPDATE user_state_operation SET acknowledged_at = ?1 WHERE operation_id = ?2")
        .bind(fixed_ack_at)
        .bind(&op1_id)
        .execute(pool)
        .await
        .unwrap();
    let b4 = binding.clone();
    let r1_replay = op1_receipt.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            acknowledge_user_state_operations_in_tx(conn, ctx, &b4, &[r1_replay]).await
        })
    })
    .await
    .unwrap();
    let replayed_ack_at: Option<i64> = sqlx::query_scalar(
        "SELECT acknowledged_at FROM user_state_operation WHERE operation_id = ?1",
    )
    .bind(&op1_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(replayed_ack_at, Some(fixed_ack_at));

    // Freshly acknowledged op1 is not pruned by default 7-day retention.
    let b5 = binding.clone();
    let pruned_fresh = with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            prune_acknowledged_user_state_operations_in_tx(
                conn,
                ctx,
                &b5,
                DEFAULT_USER_STATE_OPERATION_RETENTION_SECS,
            )
            .await
        })
    })
    .await
    .unwrap();
    assert_eq!(pruned_fresh.value, 0);
    assert!(!pruned_fresh.effects.user_state_ledger_changed);

    // Negative retention age is rejected.
    let b_bad = binding.clone();
    let bad_res = with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            prune_acknowledged_user_state_operations_in_tx(conn, ctx, &b_bad, -1).await
        })
    })
    .await;
    assert!(bad_res.is_err());

    // Add a pending op and an expired op in another namespace.
    sqlx::query(
        "INSERT INTO user_state_operation(operation_id, namespace, entity_key, intent_sequence, payload, status, acknowledged_at) \
         VALUES \
           ('op-pending', (SELECT namespace FROM user_state_workspace LIMIT 1), 'k-pend', 99, '{}', 'pending', NULL), \
           ('op-other-ns', 'other-namespace', 'k-other', 1, '{}', 'acknowledged', 1)",
    )
    .execute(pool)
    .await
    .unwrap();

    // Backdate op1 past 7 days and prune.
    sqlx::query("UPDATE user_state_operation SET acknowledged_at = 1 WHERE operation_id = ?1")
        .bind(&op1_id)
        .execute(pool)
        .await
        .unwrap();
    let b6 = binding.clone();
    let pruned_expired = with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            prune_acknowledged_user_state_operations_in_tx(
                conn,
                ctx,
                &b6,
                DEFAULT_USER_STATE_OPERATION_RETENTION_SECS,
            )
            .await
        })
    })
    .await
    .unwrap();
    assert_eq!(pruned_expired.value, 1);
    assert!(pruned_expired.effects.user_state_ledger_changed);

    let remaining_ids: Vec<String> = sqlx::query_scalar(
        "SELECT operation_id FROM user_state_operation ORDER BY operation_id",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    let mut expected_ids = vec![op2_id, "op-other-ns".to_string(), "op-pending".to_string()];
    expected_ids.sort();
    assert_eq!(remaining_ids, expected_ids);

    // Insert an unattempted chapter 13 intent, upgrade novel.source_novel_id, and run refresh_unattempted_user_state_identities_in_tx.
    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position) \
         VALUES (13, 1, '/chapter/3', 'Three', '3', 3)",
    )
    .execute(pool)
    .await
    .unwrap();
    let work_no_id_2 = json!({
        "pluginId": "source",
        "sourceNovelId": null,
        "novelPath": "/book",
        "name": "Book",
    });
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            record_user_state_changes_in_tx(
                conn,
                ctx,
                &[(
                    json!({ "kind": "reading", "work": work_no_id_2, "chapter": { "chapterPath": "/chapter/3", "name": "Three" } }),
                    json!({ "progress": 60.0, "readAt": null }),
                )],
                false,
            )
            .await
        })
    })
    .await
    .unwrap();
    sqlx::query("UPDATE novel SET source_novel_id = 'book' WHERE id = 1")
        .execute(pool)
        .await
        .unwrap();
    with_write_tx(pool, opts.clone(), |conn, _ctx| {
        Box::pin(async move { refresh_unattempted_user_state_identities_in_tx(conn, None).await })
    })
    .await
    .unwrap();

    let ch1_ent: String = sqlx::query_scalar("SELECT entity_json FROM user_state_intent WHERE sequence = 1")
        .fetch_one(pool)
        .await
        .unwrap();
    let ch3_ent: String = sqlx::query_scalar("SELECT entity_json FROM user_state_intent WHERE sequence = 3")
        .fetch_one(pool)
        .await
        .unwrap();
    assert!(serde_json::from_str::<JsonValue>(&ch1_ent).unwrap()["work"]["sourceNovelId"].is_null());
    assert_eq!(
        serde_json::from_str::<JsonValue>(&ch3_ent).unwrap()["work"]["sourceNovelId"].as_str(),
        Some("book")
    );

    // remap_unattempted_chapter_paths_in_tx must NOT remap seq 1 (pruned acknowledged) when acknowledged_sequence == 1.
    // Note: restore novel.source_novel_id = NULL so chapter 1's work_key matches intent seq 1.
    sqlx::query("UPDATE novel SET source_novel_id = NULL WHERE id = 1")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE chapter SET path = '/chapter/1-renamed' WHERE id = 11")
        .execute(pool)
        .await
        .unwrap();
    with_write_tx(pool, opts.clone(), |conn, _ctx| {
        Box::pin(async move {
            remap_unattempted_chapter_paths_in_tx(
                conn,
                &[UserStateChapterPathBefore {
                    id: 11,
                    novel_id: 1,
                    path: "/chapter/1".to_string(),
                }],
            )
            .await
        })
    })
    .await
    .unwrap();
    let ch1_ent_after: String =
        sqlx::query_scalar("SELECT entity_json FROM user_state_intent WHERE sequence = 1")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(
        serde_json::from_str::<JsonValue>(&ch1_ent_after).unwrap()["chapter"]["chapterPath"]
            .as_str(),
        Some("/chapter/1")
    );

    // A newer unattempted edit (sequence = 4 > acknowledged_sequence = 1) DOES remap on path rename.
    let work_no_id_3 = json!({
        "pluginId": "source",
        "sourceNovelId": null,
        "novelPath": "/book",
        "name": "Book",
    });
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            record_user_state_changes_in_tx(
                conn,
                ctx,
                &[(
                    json!({ "kind": "reading", "work": work_no_id_3, "chapter": { "chapterPath": "/chapter/1-renamed", "name": "One" } }),
                    json!({ "progress": 80.0, "readAt": 200 }),
                )],
                false,
            )
            .await
        })
    })
    .await
    .unwrap();
    sqlx::query("UPDATE chapter SET path = '/chapter/1-final' WHERE id = 11")
        .execute(pool)
        .await
        .unwrap();
    with_write_tx(pool, opts, |conn, _ctx| {
        Box::pin(async move {
            remap_unattempted_chapter_paths_in_tx(
                conn,
                &[UserStateChapterPathBefore {
                    id: 11,
                    novel_id: 1,
                    path: "/chapter/1-renamed".to_string(),
                }],
            )
            .await
        })
    })
    .await
    .unwrap();
    let ch1_latest: (i64, String) = sqlx::query_as(
        "SELECT sequence, entity_json FROM user_state_intent WHERE entity_key LIKE '%/chapter/1-final%'",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert!(ch1_latest.0 > 1);
    assert_eq!(
        serde_json::from_str::<JsonValue>(&ch1_latest.1).unwrap()["chapter"]["chapterPath"]
            .as_str(),
        Some("/chapter/1-final")
    );

    // Reclaim space after pruning works cleanly outside write tx.
    let reclaim = test_db.db.reclaim_space(None).await.unwrap();
    assert_eq!(reclaim.auto_vacuum_mode, 2);
    assert_eq!(reclaim.freelist_after, 0);
}

#[test]
fn strict_parsers_accept_seed_skipped_null_and_validate_retention_and_snapshot() {
    let skipped = parse_user_state_merge_result(&json!({
        "operationId": "op-1",
        "status": "seed-skipped",
        "current": null,
    }))
    .unwrap();
    assert_eq!(skipped.status, "seed-skipped");
    assert!(skipped.current.is_none());

    let retention = parse_user_state_retention_response(&json!({
        "version": 1,
        "workspaceId": "ws-1",
        "epoch": "ep-1",
        "headRevision": 5,
        "compactedThrough": 3,
        "seedAllowed": false,
        "seedCutoffAt": 1_700_000_000_000_i64,
    }))
    .unwrap();
    assert_eq!(retention.compacted_through, 3);
    assert!(!retention.seed_allowed);
    assert_eq!(retention.seed_cutoff_at, Some(1_700_000_000_000));
    assert!(parse_user_state_retention_response(&json!({
        "version": 1,
        "workspaceId": "ws-1",
        "epoch": "ep-1",
        "headRevision": 2,
        "compactedThrough": 3,
        "seedAllowed": true,
        "seedCutoffAt": null,
    }))
    .is_err());

    let rec = shared_record(
        json!({ "kind": "bookmark", "work": sample_work(), "chapter": { "chapterPath": "/ch/1", "name": "One" } }),
        json!({ "bookmarked": true }),
        1,
        "op-1",
    );
    let max_key = "k".repeat(131_072);
    let snap = parse_user_state_snapshot_response(&json!({
        "version": 1,
        "workspaceId": "ws-1",
        "epoch": "ep-1",
        "headRevision": 5,
        "snapshotRevision": 5,
        "nextEntityKey": max_key,
        "hasMore": true,
        "seedAllowed": true,
        "seedCutoffAt": null,
        "records": [rec],
    }))
    .unwrap();
    assert_eq!(snap.next_entity_key.as_deref().map(str::len), Some(131_072));
    assert!(parse_user_state_snapshot_response(&json!({
        "version": 1,
        "workspaceId": "ws-1",
        "epoch": "ep-1",
        "headRevision": 5,
        "snapshotRevision": 5,
        "nextEntityKey": "k".repeat(131_073),
        "hasMore": true,
        "seedAllowed": true,
        "seedCutoffAt": null,
        "records": [rec],
    }))
    .is_err());
}

#[tokio::test]
async fn rebind_modes_seed_cutoff_and_snapshot_reconciliation_preserve_invariants() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    let opts = TxOptions {
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };

    seed_sample_work(pool).await;
    sqlx::query(
        "UPDATE novel SET in_library = 0 WHERE id = 1; \
         UPDATE chapter SET progress = 80.0, read_at = 1650000000 WHERE id = 11;",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position, progress, read_at) \
         VALUES (12, 1, '/chapter/2', 'Two', '2', 2, 100.0, 1750000000)",
    )
    .execute(pool)
    .await
    .unwrap();

    // Initial bind with seed_cutoff_ms skips /chapter/1 (1650s < 1700s*1000) and seeds /chapter/2.
    let b1 = sample_binding();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            bind_user_state_workspace_with_options_in_tx(
                conn,
                ctx,
                &b1,
                Some(true),
                Some(1_700_000_000_000),
            )
            .await
        })
    })
    .await
    .unwrap();

    let b1_prep = sample_binding();
    let ops = with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            prepare_user_state_operations_in_tx(
                None,
                conn,
                ctx,
                &b1_prep,
                &PrepareUserStateOperationsLimitsDto::default(),
            )
            .await
        })
    })
    .await
    .unwrap();
    assert!(!ops.value.iter().any(|op| op["entity"]["kind"] == "reading"
        && op["entity"]["chapter"]["chapterPath"] == "/chapter/1"));
    assert!(ops.value.iter().any(|op| op["entity"]["kind"] == "reading"
        && op["entity"]["chapter"]["chapterPath"] == "/chapter/2"));
    let ch1_read_at: Option<i64> = sqlx::query_scalar("SELECT read_at FROM chapter WHERE id = 11")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(ch1_read_at, Some(1_650_000_000));

    // Mode A rebind idempotency & cutoff enforcement.
    let b2 = UserStateBindingDto {
        epoch: "epoch-2".to_string(),
        ..sample_binding()
    };
    let b2_a = b2.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            rebind_user_state_workspace_in_tx(
                conn,
                ctx,
                &b2_a,
                UserStateRebindMode::Reseed,
                None,
                Some(1_700_000_000_000),
                Some(true),
            )
            .await
        })
    })
    .await
    .unwrap();
    let intent_count_after_first: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM user_state_intent")
            .fetch_one(pool)
            .await
            .unwrap();
    let b2_b = b2.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            rebind_user_state_workspace_in_tx(
                conn,
                ctx,
                &b2_b,
                UserStateRebindMode::Reseed,
                None,
                Some(1_700_000_000_000),
                Some(true),
            )
            .await
        })
    })
    .await
    .unwrap();
    let intent_count_after_second: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM user_state_intent")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(intent_count_after_first, intent_count_after_second);

    // Mode B start_fresh suppresses seeding, clears prior intents/conflicts, and allows post-rebind edits.
    let b3 = UserStateBindingDto {
        epoch: "epoch-3".to_string(),
        ..sample_binding()
    };
    let b3_a = b3.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            rebind_user_state_workspace_in_tx(
                conn,
                ctx,
                &b3_a,
                UserStateRebindMode::StartFresh,
                Some(4),
                None,
                None,
            )
            .await
        })
    })
    .await
    .unwrap();
    let b3_prep = b3.clone();
    let ops_b = with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            prepare_user_state_operations_in_tx(
                None,
                conn,
                ctx,
                &b3_prep,
                &PrepareUserStateOperationsLimitsDto::default(),
            )
            .await
        })
    })
    .await
    .unwrap();
    assert!(ops_b.value.is_empty());

    // Local retention 2-A (non-library prune) and 2-B (timestamp strip) update chapters cleanly.
    with_write_tx(pool, opts.clone(), |conn, ctx| {
        Box::pin(async move {
            apply_local_user_state_retention_in_tx(
                conn,
                ctx,
                Some(100),
                Some(10),
                1_755_000_000_000,
            )
            .await
        })
    })
    .await
    .unwrap();
    let ch1_after_2a: (i64, Option<i64>) =
        sqlx::query_as("SELECT progress, read_at FROM chapter WHERE id = 11")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(ch1_after_2a, (0, None));
    let ch2_after_2b: (i64, Option<i64>) =
        sqlx::query_as("SELECT progress, read_at FROM chapter WHERE id = 12")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(ch2_after_2b, (100, None));

    // Snapshot reconciliation: removes absent bookmark record + resets chapter.bookmark, preserves pending edit, cleans dangling alias.
    let bm1 = json!({ "kind": "bookmark", "work": sample_work(), "chapter": { "chapterPath": "/chapter/1", "name": "One" } });
    let bm1_rec = shared_record(bm1.clone(), json!({ "bookmarked": true }), 5, "remote-5");
    sqlx::query("UPDATE chapter SET bookmark = 1 WHERE id = 11")
        .execute(pool)
        .await
        .unwrap();
    let b3_read = b3.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            apply_user_state_read_page_in_tx(
                conn,
                ctx,
                &b3_read,
                &json!({
                    "version": 1,
                    "workspaceId": b3_read.workspace_id,
                    "epoch": b3_read.epoch,
                    "headRevision": 5,
                    "through": 5,
                    "nextCursor": 5,
                    "hasMore": false,
                    "records": [bm1_rec],
                }),
            )
            .await
        })
    })
    .await
    .unwrap();
    let ns3 = serde_json::to_string(&(&b3.server_url, &b3.workspace_id, &b3.epoch)).unwrap();
    sqlx::query("INSERT INTO user_state_alias(namespace, alias_id, canonical_id) VALUES (?1, 'alias-1', 'cat-gone')")
        .bind(&ns3)
        .execute(pool)
        .await
        .unwrap();

    let b3_rec = b3.clone();
    with_write_tx(pool, opts, move |conn, ctx| {
        Box::pin(async move {
            reconcile_user_state_snapshot_in_tx(
                None,
                conn,
                ctx,
                &b3_rec,
                &[],
                6,
                Some(false),
                None,
                &HashSet::new(),
            )
            .await
        })
    })
    .await
    .unwrap();

    let bm_after: i64 = sqlx::query_scalar("SELECT bookmark FROM chapter WHERE id = 11")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(bm_after, 0);
    let alias_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_state_alias")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(alias_count, 0);
    let cursor_after: i64 = sqlx::query_scalar("SELECT cursor FROM user_state_workspace")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(cursor_after, 6);
}

#[tokio::test]
async fn retention_privacy_multi_workspace_cutoff_mode_a_clear_and_gc_pending_op_rebase() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    let opts = TxOptions {
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };

    seed_sample_work(pool).await;
    sqlx::query("UPDATE chapter SET progress = 60.0, read_at = 1600000000 WHERE id = 11")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position, progress, read_at) \
         VALUES (12, 1, '/chapter/2', 'Two', '2', 2, 90.0, 1750000000)",
    )
    .execute(pool)
    .await
    .unwrap();

    // 1. Multi-workspace seed=1 intents must obey seed_cutoff_ms (and seed_allowed=Some(false) inserts no seed=1 intents).
    let b1 = sample_binding();
    let b1_bind = b1.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            bind_user_state_workspace_with_options_in_tx(conn, ctx, &b1_bind, Some(true), None)
                .await
        })
    })
    .await
    .unwrap();

    let b2 = UserStateBindingDto {
        server_url: "https://other.example".to_string(),
        workspace_id: "ws-2".to_string(),
        epoch: "ep-1".to_string(),
    };
    let b2_bind = b2.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            bind_user_state_workspace_with_options_in_tx(
                conn,
                ctx,
                &b2_bind,
                Some(true),
                Some(1_700_000_000_000),
            )
            .await
        })
    })
    .await
    .unwrap();

    let b2_prep = b2.clone();
    let ws2_ops = with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            prepare_user_state_operations_in_tx(
                None,
                conn,
                ctx,
                &b2_prep,
                &PrepareUserStateOperationsLimitsDto::default(),
            )
            .await
        })
    })
    .await
    .unwrap()
    .value;
    assert!(!ws2_ops.iter().any(|op| op["entity"]["kind"] == "reading"
        && op["entity"]["chapter"]["chapterPath"] == "/chapter/1"));
    assert!(ws2_ops.iter().any(|op| op["entity"]["kind"] == "reading"
        && op["entity"]["chapter"]["chapterPath"] == "/chapter/2"));

    let b3 = UserStateBindingDto {
        server_url: "https://third.example".to_string(),
        workspace_id: "ws-3".to_string(),
        epoch: "ep-1".to_string(),
    };
    let b3_bind = b3.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            bind_user_state_workspace_with_options_in_tx(conn, ctx, &b3_bind, Some(false), None)
                .await
        })
    })
    .await
    .unwrap();
    let b3_prep = b3.clone();
    let ws3_ops = with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            prepare_user_state_operations_in_tx(
                None,
                conn,
                ctx,
                &b3_prep,
                &PrepareUserStateOperationsLimitsDto::default(),
            )
            .await
        })
    })
    .await
    .unwrap()
    .value;
    assert!(ws3_ops.is_empty());

    // 2. Mode A idempotent rebind clears seed_cutoff_at to NULL when seed_cutoff_ms transitions Some(ts) -> None.
    let b2_re1 = b2.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            rebind_user_state_workspace_in_tx(
                conn,
                ctx,
                &b2_re1,
                UserStateRebindMode::Reseed,
                None,
                Some(1_700_000_000_000),
                Some(true),
            )
            .await
        })
    })
    .await
    .unwrap();
    let b2_re2 = b2.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            rebind_user_state_workspace_in_tx(
                conn,
                ctx,
                &b2_re2,
                UserStateRebindMode::Reseed,
                None,
                None,
                Some(true),
            )
            .await
        })
    })
    .await
    .unwrap();
    let cleared_cutoff: Option<i64> = sqlx::query_scalar(
        "SELECT seed_cutoff_at FROM user_state_workspace WHERE server_url = ?1",
    )
    .bind(&b2.server_url)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(cleared_cutoff, None);

    // 3. Opt-in 2-B and 2-A preserve user_state_private without leaking intents (even after source_novel_id upgrade).
    sqlx::query(
        "INSERT INTO novel(id, plugin_id, source_novel_id, path, name, in_library, last_read_at) \
         VALUES (2, 'priv-src', NULL, '/priv', 'Private Book', 0, 1600000000)",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position, progress, read_at) \
         VALUES (21, 2, '/chapter/1', 'One', '1', 1, 85.0, 1600000000)",
    )
    .execute(pool)
    .await
    .unwrap();
    with_write_tx(pool, opts.clone(), |conn, _ctx| {
        Box::pin(async move { mark_private_chapter_progress_in_tx(conn, 21).await })
    })
    .await
    .unwrap();
    sqlx::query("UPDATE novel SET source_novel_id = 'priv-id' WHERE id = 2")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM user_state_intent; DELETE FROM user_state_progress; DELETE FROM user_state_operation;")
        .execute(pool)
        .await
        .unwrap();

    with_write_tx(pool, opts.clone(), |conn, ctx| {
        Box::pin(async move {
            apply_local_user_state_retention_in_tx(conn, ctx, None, Some(30), 1_755_000_000_000)
                .await
        })
    })
    .await
    .unwrap();
    let ch21_after_2b: (f64, Option<i64>) =
        sqlx::query_as("SELECT CAST(progress AS REAL), read_at FROM chapter WHERE id = 21")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(ch21_after_2b, (85.0, None));
    let priv_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_state_private")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(priv_count, 1);
    let priv_intent_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM user_state_intent WHERE entity_key LIKE '%priv-src%'",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(priv_intent_count, 0);

    // 2-A runs before 2-B when both enabled with strip < prune.
    sqlx::query("UPDATE chapter SET progress = 85.0, read_at = 1600000000 WHERE id = 21")
        .execute(pool)
        .await
        .unwrap();
    with_write_tx(pool, opts.clone(), |conn, ctx| {
        Box::pin(async move {
            apply_local_user_state_retention_in_tx(
                conn,
                ctx,
                Some(100),
                Some(10),
                1_755_000_000_000,
            )
            .await
        })
    })
    .await
    .unwrap();
    let ch21_after_2a: (f64, Option<i64>) =
        sqlx::query_as("SELECT CAST(progress AS REAL), read_at FROM chapter WHERE id = 21")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(ch21_after_2a, (0.0, None));
    let priv_count_after_2a: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_state_private")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(priv_count_after_2a, 1);
    let priv_intent_count_after_2a: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM user_state_intent WHERE entity_key LIKE '%priv-src%'",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(priv_intent_count_after_2a, 0);

    // 4. reconcile_user_state_snapshot_in_tx promotes path-keyed user_state_private before loading private keys.
    sqlx::query("DELETE FROM user_state_private; UPDATE novel SET source_novel_id = NULL WHERE id = 2; UPDATE chapter SET progress = 90.0, read_at = 1750000000 WHERE id = 21;")
        .execute(pool)
        .await
        .unwrap();
    with_write_tx(pool, opts.clone(), |conn, _ctx| {
        Box::pin(async move { mark_private_chapter_progress_in_tx(conn, 21).await })
    })
    .await
    .unwrap();
    sqlx::query("UPDATE novel SET source_novel_id = 'priv-id' WHERE id = 2")
        .execute(pool)
        .await
        .unwrap();
    let priv_ent = json!({
        "kind": "reading",
        "work": { "pluginId": "priv-src", "sourceNovelId": "priv-id", "novelPath": "/priv", "name": "Private Book" },
        "chapter": { "chapterPath": "/chapter/1", "name": "One" },
    });
    let b1_read = b1.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            apply_user_state_read_page_in_tx(
                conn,
                ctx,
                &b1_read,
                &json!({
                    "version": 1,
                    "workspaceId": b1_read.workspace_id,
                    "epoch": b1_read.epoch,
                    "headRevision": 10,
                    "through": 10,
                    "nextCursor": 10,
                    "hasMore": false,
                    "records": [shared_record(priv_ent, json!({ "progress": 10.0, "readAt": 1750000000 }), 10, "r-10")],
                }),
            )
            .await
        })
    })
    .await
    .unwrap();
    let b1_rec = b1.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            reconcile_user_state_snapshot_in_tx(
                None,
                conn,
                ctx,
                &b1_rec,
                &[],
                11,
                Some(false),
                None,
                &HashSet::new(),
            )
            .await
        })
    })
    .await
    .unwrap();
    let ch21_after_snap: (f64, Option<i64>) =
        sqlx::query_as("SELECT CAST(progress AS REAL), read_at FROM chapter WHERE id = 21")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(ch21_after_snap, (90.0, Some(1_750_000_000)));

    // 5. rebase_pending_progress_to_zero_in_tx clears stale status='pending' user_state_operation rows.
    sqlx::query("DELETE FROM user_state_intent; DELETE FROM user_state_progress; DELETE FROM user_state_operation;")
        .execute(pool)
        .await
        .unwrap();
    let bm_ent = json!({
        "kind": "bookmark",
        "work": sample_work(),
        "chapter": { "chapterPath": "/chapter/1", "name": "One" },
    });
    let bm_rec = shared_record(bm_ent.clone(), json!({ "bookmarked": false }), 12, "r-12");
    let b1_read2 = b1.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            apply_user_state_read_page_in_tx(
                conn,
                ctx,
                &b1_read2,
                &json!({
                    "version": 1,
                    "workspaceId": b1_read2.workspace_id,
                    "epoch": b1_read2.epoch,
                    "headRevision": 12,
                    "through": 12,
                    "nextCursor": 12,
                    "hasMore": false,
                    "records": [bm_rec],
                }),
            )
            .await
        })
    })
    .await
    .unwrap();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            record_user_state_changes_in_tx(
                conn,
                ctx,
                &[(bm_ent, json!({ "bookmarked": true }))],
                false,
            )
            .await
        })
    })
    .await
    .unwrap();
    let b1_prep1 = b1.clone();
    let before_gc = with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            prepare_user_state_operations_in_tx(
                None,
                conn,
                ctx,
                &b1_prep1,
                &PrepareUserStateOperationsLimitsDto::default(),
            )
            .await
        })
    })
    .await
    .unwrap()
    .value;
    assert_eq!(before_gc.len(), 1);
    assert_eq!(before_gc[0]["baseRevision"], json!(12));

    let b1_rec2 = b1.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            reconcile_user_state_snapshot_in_tx(
                None,
                conn,
                ctx,
                &b1_rec2,
                &[],
                13,
                Some(false),
                None,
                &HashSet::new(),
            )
            .await
        })
    })
    .await
    .unwrap();
    let b1_prep2 = b1.clone();
    let after_gc = with_write_tx(pool, opts, move |conn, ctx| {
        Box::pin(async move {
            prepare_user_state_operations_in_tx(
                None,
                conn,
                ctx,
                &b1_prep2,
                &PrepareUserStateOperationsLimitsDto::default(),
            )
            .await
        })
    })
    .await
    .unwrap()
    .value;
    assert_eq!(after_gc.len(), 1);
    assert_eq!(after_gc[0]["baseRevision"], json!(0));
    assert_ne!(after_gc[0]["operationId"], before_gc[0]["operationId"]);
}

#[tokio::test]
async fn snapshot_gc_preserves_promoted_private_reading_for_path_keyed_record() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    let opts = TxOptions {
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };

    let b = sample_binding();
    let b_bind = b.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            bind_user_state_workspace_with_options_in_tx(conn, ctx, &b_bind, Some(false), None)
                .await
        })
    })
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO novel(id, plugin_id, source_novel_id, path, name, in_library, last_read_at) \
         VALUES (2, 'priv-src', NULL, '/priv', 'Private Book', 0, 1750000000)",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position, progress, read_at) \
         VALUES (21, 2, '/chapter/1', 'One', '1', 1, 91.0, 1750000000), \
                (22, 2, '/chapter/2', 'Two', '2', 2, 65.0, 1740000000)",
    )
    .execute(pool)
    .await
    .unwrap();

    // Mark chapter 21 private while source_novel_id is NULL (stores path-keyed user_state_private).
    with_write_tx(pool, opts.clone(), |conn, _ctx| {
        Box::pin(async move { mark_private_chapter_progress_in_tx(conn, 21).await })
    })
    .await
    .unwrap();

    // Store legacy path-keyed reading records (sourceNovelId: null) for both chapters before ID upgrade.
    let path_work = json!({
        "pluginId": "priv-src",
        "sourceNovelId": null,
        "novelPath": "/priv",
        "name": "Private Book",
    });
    let priv_path_ent = json!({
        "kind": "reading",
        "work": path_work,
        "chapter": { "chapterPath": "/chapter/1", "name": "One" },
    });
    let pub_path_ent = json!({
        "kind": "reading",
        "work": path_work,
        "chapter": { "chapterPath": "/chapter/2", "name": "Two" },
    });
    let b_read = b.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            apply_user_state_read_page_in_tx(
                conn,
                ctx,
                &b_read,
                &json!({
                    "version": 1,
                    "workspaceId": b_read.workspace_id,
                    "epoch": b_read.epoch,
                    "headRevision": 10,
                    "through": 10,
                    "nextCursor": 10,
                    "hasMore": false,
                    "records": [
                        shared_record(priv_path_ent, json!({ "progress": 10.0, "readAt": 1750000000 }), 9, "r-9"),
                        shared_record(pub_path_ent, json!({ "progress": 65.0, "readAt": 1740000000 }), 10, "r-10"),
                    ],
                }),
            )
            .await
        })
    })
    .await
    .unwrap();

    // Novel acquires source_novel_id before snapshot GC runs.
    sqlx::query("UPDATE novel SET source_novel_id = 'priv-p-id' WHERE id = 2")
        .execute(pool)
        .await
        .unwrap();

    let b_rec = b.clone();
    with_write_tx(pool, opts, move |conn, ctx| {
        Box::pin(async move {
            reconcile_user_state_snapshot_in_tx(
                None,
                conn,
                ctx,
                &b_rec,
                &[],
                11,
                Some(false),
                None,
                &HashSet::new(),
            )
            .await
        })
    })
    .await
    .unwrap();

    let ch21_after: (f64, Option<i64>) =
        sqlx::query_as("SELECT CAST(progress AS REAL), read_at FROM chapter WHERE id = 21")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(ch21_after, (91.0, Some(1_750_000_000)));

    let ch22_after: (f64, Option<i64>) =
        sqlx::query_as("SELECT CAST(progress AS REAL), read_at FROM chapter WHERE id = 22")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(ch22_after, (0.0, None));
}

#[tokio::test]
async fn retention_mixed_public_and_private_novel_emits_resume_clear_without_leaking_private() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    let opts = TxOptions {
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };

    // Novel 3: mixed (old public chapter 31 + fresh private chapter 32).
    // Novel 4: purely private (old private chapter 41).
    // Novel 5: mixed for 2-B timestamp strip (mid-age public chapter 51 + fresh private chapter 52).
    sqlx::query(
        "INSERT INTO novel(id, plugin_id, source_novel_id, path, name, in_library, last_read_at) \
         VALUES (3, 'mixed-src', 'mixed-id', '/mixed', 'Mixed Book', 0, 1754999000), \
                (4, 'allpriv-src', 'allpriv-id', '/allpriv', 'All Priv Book', 0, 1600000000), \
                (5, 'mixed2b-src', 'mixed2b-id', '/mixed2b', 'Mixed 2B Book', 1, 1754999000)",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position, progress, read_at) \
         VALUES (31, 3, '/chapter/1', 'One', '1', 1, 50.0, 1600000000), \
                (32, 3, '/chapter/2', 'Two', '2', 2, 80.0, 1754999000), \
                (41, 4, '/chapter/1', 'One', '1', 1, 75.0, 1600000000), \
                (51, 5, '/chapter/1', 'One', '1', 1, 70.0, 1750000000), \
                (52, 5, '/chapter/2', 'Two', '2', 2, 85.0, 1754999000)",
    )
    .execute(pool)
    .await
    .unwrap();

    with_write_tx(pool, opts.clone(), |conn, _ctx| {
        Box::pin(async move {
            mark_private_chapter_progress_in_tx(conn, 32).await?;
            mark_private_chapter_progress_in_tx(conn, 41).await?;
            mark_private_chapter_progress_in_tx(conn, 52).await
        })
    })
    .await
    .unwrap();
    sqlx::query("DELETE FROM user_state_intent; DELETE FROM user_state_progress;")
        .execute(pool)
        .await
        .unwrap();

    with_write_tx(pool, opts, |conn, ctx| {
        Box::pin(async move {
            apply_local_user_state_retention_in_tx(
                conn,
                ctx,
                Some(100),
                Some(10),
                1_755_000_000_000,
            )
            .await
        })
    })
    .await
    .unwrap();

    // Mixed 2-A novel: public chapter 31 pruned, private chapter 32 untouched.
    let ch31: (f64, Option<i64>) =
        sqlx::query_as("SELECT CAST(progress AS REAL), read_at FROM chapter WHERE id = 31")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(ch31, (0.0, None));
    let ch32: (f64, Option<i64>) =
        sqlx::query_as("SELECT CAST(progress AS REAL), read_at FROM chapter WHERE id = 32")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(ch32, (80.0, Some(1_754_999_000)));

    // Purely private novel: chapter 41 pruned locally, zero intents emitted.
    let ch41: (f64, Option<i64>) =
        sqlx::query_as("SELECT CAST(progress AS REAL), read_at FROM chapter WHERE id = 41")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(ch41, (0.0, None));
    let allpriv_intents: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM user_state_intent WHERE entity_key LIKE '%allpriv-src%'",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(allpriv_intents, 0);

    // Mixed 2-B novel: public chapter 51 stripped (progress preserved), private chapter 52 untouched.
    let ch51: (f64, Option<i64>) =
        sqlx::query_as("SELECT CAST(progress AS REAL), read_at FROM chapter WHERE id = 51")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(ch51, (70.0, None));
    let ch52: (f64, Option<i64>) =
        sqlx::query_as("SELECT CAST(progress AS REAL), read_at FROM chapter WHERE id = 52")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(ch52, (85.0, Some(1_754_999_000)));

    // Both mixed novels emitted clean resume clears without leaking private chapters.
    let mixed_rows = sqlx::query(
        "SELECT entity_json, value_json FROM user_state_intent \
         WHERE entity_key LIKE '%mixed-src%' OR entity_key LIKE '%mixed2b-src%'",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    let mut saw_mixed_resume = false;
    let mut saw_mixed2b_resume = false;
    for r in mixed_rows {
        let ent: JsonValue = serde_json::from_str(r.get("entity_json")).unwrap();
        let val: JsonValue = serde_json::from_str(r.get("value_json")).unwrap();
        if ent["kind"] == "reading" {
            assert_eq!(ent["chapter"]["chapterPath"], "/chapter/1");
        } else if ent["kind"] == "resume" {
            assert_eq!(val, json!({ "chapter": null, "anchor": null, "openedAt": null }));
            if ent["work"]["pluginId"] == "mixed-src" {
                saw_mixed_resume = true;
            } else if ent["work"]["pluginId"] == "mixed2b-src" {
                saw_mixed2b_resume = true;
            }
        }
    }
    assert!(saw_mixed_resume);
    assert!(saw_mixed2b_resume);
}

#[test]
fn snapshot_parser_rejects_revision_inversion_and_multibyte_key_over_utf8_cap() {
    let rec = shared_record(
        json!({ "kind": "bookmark", "work": sample_work(), "chapter": { "chapterPath": "/ch/1", "name": "One" } }),
        json!({ "bookmarked": true }),
        5,
        "op-5",
    );
    assert!(parse_user_state_snapshot_response(&json!({
        "version": 1,
        "workspaceId": "ws-1",
        "epoch": "ep-1",
        "headRevision": 4,
        "snapshotRevision": 5,
        "nextEntityKey": null,
        "hasMore": false,
        "seedAllowed": true,
        "seedCutoffAt": null,
        "records": [rec],
    }))
    .is_err());

    assert!(parse_user_state_snapshot_response(&json!({
        "version": 1,
        "workspaceId": "ws-1",
        "epoch": "ep-1",
        "headRevision": 5,
        "snapshotRevision": 4,
        "nextEntityKey": null,
        "hasMore": false,
        "seedAllowed": true,
        "seedCutoffAt": null,
        "records": [rec],
    }))
    .is_err());

    assert!(parse_user_state_snapshot_response(&json!({
        "version": 1,
        "workspaceId": "ws-1",
        "epoch": "ep-1",
        "headRevision": 5,
        "snapshotRevision": 5,
        "nextEntityKey": "가".repeat(70_000),
        "hasMore": true,
        "seedAllowed": true,
        "seedCutoffAt": null,
        "records": [rec],
    }))
    .is_err());
}

#[tokio::test]
async fn rebind_start_fresh_post_edit_mode_a_same_epoch_and_validation_guards() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    let opts = TxOptions {
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };

    seed_sample_work(pool).await;
    sqlx::query("UPDATE chapter SET progress = 75.0, read_at = 1750000000 WHERE id = 11")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position) \
         VALUES (12, 1, '/chapter/2', 'Two', '2', 2)",
    )
    .execute(pool)
    .await
    .unwrap();

    let b1 = sample_binding();
    let b1_bind = b1.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { bind_user_state_workspace_in_tx(conn, ctx, &b1_bind).await })
    })
    .await
    .unwrap();
    let ns1 = super::types::namespace_for(&b1);
    sqlx::query("INSERT INTO user_state_conflict(id, namespace, entity_key, reason) VALUES ('c1', ?1, 'k1', 'revision-mismatch')")
        .bind(&ns1).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO user_state_alias(namespace, alias_id, canonical_id) VALUES (?1, 'a1', 'cat-1')")
        .bind(&ns1).execute(pool).await.unwrap();

    let bad_rev = b1.clone();
    assert!(with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            rebind_user_state_workspace_in_tx(conn, ctx, &bad_rev, UserStateRebindMode::StartFresh, Some(-1), None, None).await
        })
    }).await.is_err());
    let bad_cutoff = b1.clone();
    assert!(with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            rebind_user_state_workspace_in_tx(conn, ctx, &bad_cutoff, UserStateRebindMode::Reseed, None, Some(-1), None).await
        })
    }).await.is_err());
    assert!(with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            rebind_user_state_workspace_in_tx(
                conn,
                ctx,
                &UserStateBindingDto { server_url: "".into(), workspace_id: "ws".into(), epoch: "ep".into() },
                UserStateRebindMode::StartFresh,
                Some(0),
                None,
                None,
            ).await
        })
    }).await.is_err());

    sqlx::query("UPDATE user_state_restore_state SET paused = 1 WHERE id = 1").execute(pool).await.unwrap();
    let b2 = UserStateBindingDto { epoch: "epoch-2".into(), ..sample_binding() };
    let b2_paused = b2.clone();
    assert!(with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            rebind_user_state_workspace_in_tx(conn, ctx, &b2_paused, UserStateRebindMode::StartFresh, Some(10), None, None).await
        })
    }).await.is_err());
    sqlx::query("UPDATE user_state_restore_state SET paused = 0 WHERE id = 1").execute(pool).await.unwrap();

    let b2_fresh = b2.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            rebind_user_state_workspace_in_tx(conn, ctx, &b2_fresh, UserStateRebindMode::StartFresh, Some(10), None, None).await
        })
    }).await.unwrap();

    for table in ["user_state_conflict", "user_state_alias", "user_state_intent", "user_state_progress", "user_state_operation", "user_state_record"] {
        let count: i64 = sqlx::query_scalar(AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}"))).fetch_one(pool).await.unwrap();
        assert_eq!(count, 0, "{table} must be empty after Mode B");
    }

    let b2_rebind_check = b2.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            bind_user_state_workspace_with_options_in_tx(conn, ctx, &b2_rebind_check, Some(true), None).await
        })
    }).await.unwrap();
    let intent_after_bind: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_state_intent").fetch_one(pool).await.unwrap();
    assert_eq!(intent_after_bind, 0);

    with_write_tx(pool, opts.clone(), |conn, ctx| {
        Box::pin(async move {
            record_user_state_changes_in_tx(
                conn,
                ctx,
                &[(
                    json!({ "kind": "bookmark", "work": sample_work(), "chapter": { "chapterPath": "/chapter/2", "name": "Two" } }),
                    json!({ "bookmarked": true }),
                )],
                false,
            ).await
        })
    }).await.unwrap();
    let b2_prep = b2.clone();
    let post_edit_ops = with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            prepare_user_state_operations_in_tx(None, conn, ctx, &b2_prep, &PrepareUserStateOperationsLimitsDto::default()).await
        })
    }).await.unwrap().value;
    assert_eq!(post_edit_ops.len(), 1);
    assert_eq!(post_edit_ops[0]["entity"]["kind"], "bookmark");
    assert_eq!(post_edit_ops[0]["entity"]["chapter"]["chapterPath"], "/chapter/2");
    assert!(post_edit_ops[0].get("seed").is_none());

    let b2_reseed = b2.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            rebind_user_state_workspace_in_tx(conn, ctx, &b2_reseed, UserStateRebindMode::Reseed, None, None, Some(true)).await
        })
    }).await.unwrap();
    let b2_prep2 = b2.clone();
    let reseed_ops = with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            prepare_user_state_operations_in_tx(None, conn, ctx, &b2_prep2, &PrepareUserStateOperationsLimitsDto::default()).await
        })
    }).await.unwrap().value;
    assert!(reseed_ops.iter().any(|op| op["entity"]["kind"] == "reading"
        && op["entity"]["chapter"]["chapterPath"] == "/chapter/1"
        && op["seed"] == json!(true)));

    let b3 = UserStateBindingDto { epoch: "epoch-3".into(), ..sample_binding() };
    let b3_reseed_blocked = b3.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            rebind_user_state_workspace_in_tx(conn, ctx, &b3_reseed_blocked, UserStateRebindMode::Reseed, None, None, Some(false)).await
        })
    }).await.unwrap();
    let b3_prep = b3.clone();
    let blocked_ops = with_write_tx(pool, opts, move |conn, ctx| {
        Box::pin(async move {
            prepare_user_state_operations_in_tx(None, conn, ctx, &b3_prep, &PrepareUserStateOperationsLimitsDto::default()).await
        })
    }).await.unwrap().value;
    assert!(blocked_ops.is_empty());
}

#[tokio::test]
async fn reconcile_snapshot_held_vs_revoked_lineage_dirty_set_cutoff_seed_purge_and_alias_rebase() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    let opts = TxOptions {
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };

    sqlx::query(
        "INSERT INTO novel(id, plugin_id, source_novel_id, path, name, in_library) VALUES \
           (1, 'source', 'book', '/book', 'Held Book', 1), \
           (2, 'rev-src', 'rev-id', '/rev', 'Revoked Book', 1), \
           (3, 'cut-src', 'cut-id', '/cut', 'Cutoff Book', 1)",
    ).execute(pool).await.unwrap();
    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, position, progress, read_at, bookmark) VALUES \
           (11, 1, '/ch/1', 'H1', 1, 50, 1750000000, 1), \
           (21, 2, '/ch/1', 'R1', 1, 0, NULL, 1), \
           (31, 3, '/ch/1', 'C1', 1, 88, 1600000000, 0)",
    ).execute(pool).await.unwrap();

    sqlx::query(
        "INSERT INTO content_sync_cache(cache_key, payload) VALUES \
           ('norea-content-novel-migration:mig-held', ?1), \
           ('norea-content-novel-migration:mig-rev', ?2), \
           ('norea-content-incoming-migration:inc-rev', ?3)",
    )
    .bind(json!({ "operationId": "mig-held", "serverUrl": "https://state.example", "status": "completed", "source": { "pluginId": "source", "novelId": "book", "novelPath": "/book" } }).to_string())
    .bind(json!({ "operationId": "mig-rev", "serverUrl": "https://state.example", "status": "completed", "source": { "pluginId": "rev-src", "novelId": "rev-id", "novelPath": "/rev" } }).to_string())
    .bind(json!({ "operationId": "inc-rev", "serverUrl": "https://state.example", "status": "inactive", "lineage": { "legacyOperationId": "mig-rev" }, "source": { "pluginId": "rev-src", "novelId": "rev-id", "novelPath": "/rev" } }).to_string())
    .execute(pool).await.unwrap();

    let b = sample_binding();
    let b_bind = b.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { bind_user_state_workspace_with_options_in_tx(conn, ctx, &b_bind, Some(true), None).await })
    }).await.unwrap();

    let held_ent = json!({ "kind": "bookmark", "work": sample_work(), "chapter": { "chapterPath": "/ch/1", "name": "H1" } });
    let rev_ent = json!({ "kind": "bookmark", "work": { "pluginId": "rev-src", "sourceNovelId": "rev-id", "novelPath": "/rev", "name": "Revoked Book" }, "chapter": { "chapterPath": "/ch/1", "name": "R1" } });
    let cut_ent = json!({ "kind": "reading", "work": { "pluginId": "cut-src", "sourceNovelId": "cut-id", "novelPath": "/cut", "name": "Cutoff Book" }, "chapter": { "chapterPath": "/ch/1", "name": "C1" } });
    let cat_kept = json!({ "kind": "category", "categoryId": "cat-kept" });
    let cat_gone = json!({ "kind": "category", "categoryId": "cat-gone" });
    let b_read = b.clone();
    let cat_kept_for_read = cat_kept.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            apply_user_state_read_page_in_tx(conn, ctx, &b_read, &json!({
                "version": 1, "workspaceId": b_read.workspace_id, "epoch": b_read.epoch,
                "headRevision": 5, "through": 5, "nextCursor": 5, "hasMore": false,
                "records": [
                    shared_record(held_ent, json!({ "bookmarked": true }), 1, "r1"),
                    shared_record(rev_ent, json!({ "bookmarked": true }), 2, "r2"),
                    shared_record(cut_ent, json!({ "progress": 88, "readAt": 1600000000 }), 3, "r3"),
                    shared_record(cat_kept_for_read, json!({ "name": "Kept", "sort": 0, "deleted": false }), 4, "r4"),
                    shared_record(cat_gone, json!({ "name": "Gone", "sort": 1, "deleted": false }), 5, "r5"),
                ],
            })).await
        })
    }).await.unwrap();

    let ns = super::types::namespace_for(&b);
    sqlx::query("INSERT INTO user_state_alias(namespace, alias_id, canonical_id) VALUES (?1, 'alias-kept', 'cat-kept'), (?1, 'alias-gone', 'cat-gone'), (?1, 'alias-dead', 'cat-missing')")
        .bind(&ns).execute(pool).await.unwrap();
    with_write_tx(pool, opts.clone(), |conn, ctx| {
        Box::pin(async move {
            record_user_state_changes_in_tx(
                conn,
                ctx,
                &[(json!({ "kind": "category", "categoryId": "alias-gone" }), json!({ "name": "Renamed", "sort": 2, "deleted": false }))],
                false,
            ).await
        })
    }).await.unwrap();

    sqlx::query("INSERT INTO user_state_intent(entity_key, entity_json, value_json, seed) VALUES ('[\"bookmark\",\"[\\\"cut-src\\\",\\\"id\\\",\\\"cut-id\\\"]\",\"/ch/1\"]', ?1, '{\"bookmarked\":true}', 1)")
        .bind(json!({ "kind": "bookmark", "work": { "pluginId": "cut-src", "sourceNovelId": "cut-id", "novelPath": "/cut", "name": "Cutoff Book" }, "chapter": { "chapterPath": "/ch/1", "name": "C1" } }).to_string())
        .execute(pool).await.unwrap();
    sqlx::query("INSERT INTO user_state_progress(namespace, entity_key, local_sequence, acknowledged_sequence, base_revision) VALUES (?1, '[\"bookmark\",\"[\\\"cut-src\\\",\\\"id\\\",\\\"cut-id\\\"]\",\"/ch/1\"]', 999, 0, -1)")
        .bind(&ns).execute(pool).await.unwrap();

    sqlx::query("DELETE FROM work_metadata_dirty; INSERT INTO work_metadata_dirty(plugin_id, path) VALUES ('sentinel', '/keep');")
        .execute(pool).await.unwrap();

    let kept_rec = shared_record(cat_kept, json!({ "name": "Kept", "sort": 0, "deleted": false }), 4, "r4");
    let b_rec = b.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            reconcile_user_state_snapshot_in_tx(
                None, conn, ctx, &b_rec, &[kept_rec], 6, Some(false), Some(1_700_000_000_000), &HashSet::new(),
            ).await
        })
    }).await.unwrap();

    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT bookmark FROM chapter WHERE id = 11").fetch_one(pool).await.unwrap(), 1);
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT bookmark FROM chapter WHERE id = 21").fetch_one(pool).await.unwrap(), 0);
    assert_eq!(sqlx::query_as::<_, (i64, Option<i64>)>("SELECT progress, read_at FROM chapter WHERE id = 31").fetch_one(pool).await.unwrap(), (88, Some(1_600_000_000)));

    let dirty: Vec<(String, String)> = sqlx::query_as("SELECT plugin_id, path FROM work_metadata_dirty").fetch_all(pool).await.unwrap();
    assert_eq!(dirty, vec![("sentinel".into(), "/keep".into())]);

    // alias-kept retained; alias-gone & alias-dead cleaned (canonical categories absent from snapshot);
    // aliased pending edit rebased to base_revision = 0 before alias cleanup.
    let aliases: Vec<String> = sqlx::query_scalar("SELECT alias_id FROM user_state_alias ORDER BY alias_id").fetch_all(pool).await.unwrap();
    assert_eq!(aliases, vec!["alias-kept".to_string()]);
    let aliased_base: i64 = sqlx::query_scalar("SELECT base_revision FROM user_state_progress WHERE entity_key = '[\"category\",\"alias-gone\"]'")
        .fetch_one(pool).await.unwrap();
    assert_eq!(aliased_base, 0);

    let b_prep = b.clone();
    let ops = with_write_tx(pool, opts, move |conn, ctx| {
        Box::pin(async move {
            prepare_user_state_operations_in_tx(None, conn, ctx, &b_prep, &PrepareUserStateOperationsLimitsDto::default()).await
        })
    }).await.unwrap().value;
    assert!(!ops.iter().any(|op| op.get("seed") == Some(&json!(true))));
}

#[tokio::test]
async fn promote_private_skips_empty_source_id_and_retention_validates_boundaries() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    let opts = TxOptions {
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };

    assert_eq!(
        with_write_tx(pool, opts.clone(), |conn, ctx| {
            Box::pin(async move { apply_local_user_state_retention_in_tx(conn, ctx, None, None, 1_755_000_000_000).await })
        }).await.unwrap().value,
        0
    );
    assert!(with_write_tx(pool, opts.clone(), |conn, ctx| {
        Box::pin(async move { apply_local_user_state_retention_in_tx(conn, ctx, Some(0), None, 1_755_000_000_000).await })
    }).await.is_err());
    assert!(with_write_tx(pool, opts.clone(), |conn, ctx| {
        Box::pin(async move { apply_local_user_state_retention_in_tx(conn, ctx, None, Some(0), 1_755_000_000_000).await })
    }).await.is_err());

    sqlx::query(
        "INSERT INTO novel(id, plugin_id, source_novel_id, path, name, in_library, is_local) VALUES \
           (1, 'priv-empty', '', '/priv-empty', 'Empty Source ID', 0, 0), \
           (2, 'local', NULL, '/local', 'Local Book', 0, 1), \
           (3, 'pub-src', 'pub-id', '/pub', 'Pub Book', 0, 0), \
           (4, 'priv-ws', '   ', '/priv-ws', 'Whitespace Source ID', 0, 0)",
    ).execute(pool).await.unwrap();
    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, position, progress, read_at) VALUES \
           (11, 1, '/ch/1', 'Priv', 1, 77, 1600000000), \
           (21, 2, '/ch/1', 'Loc', 1, 66, 1600000000), \
           (31, 3, '/ch/exact', 'Exact', 1, 55, 1754136000), \
           (32, 3, '/ch/older', 'Older', 2, 55, 1754135999)",
    ).execute(pool).await.unwrap();
    let path_key = serde_json::to_string(&(
        "reading",
        super::types::user_state_work_key_parts("priv-empty", None, "/priv-empty"),
        "/ch/1",
    )).unwrap();
    let ws_path_key = serde_json::to_string(&(
        "reading",
        super::types::user_state_work_key_parts("priv-ws", None, "/priv-ws"),
        "/ch/1",
    )).unwrap();
    sqlx::query("INSERT INTO user_state_private(entity_key, public_value_json) VALUES (?1, '{\"progress\":0,\"readAt\":null}'), (?2, '{\"progress\":0,\"readAt\":null}')")
        .bind(&path_key).bind(&ws_path_key).execute(pool).await.unwrap();

    with_write_tx(pool, opts.clone(), |conn, _ctx| {
        Box::pin(async move { promote_private_work_identities_in_tx(conn).await })
    }).await.unwrap();
    let kept_keys: Vec<String> = sqlx::query_scalar("SELECT entity_key FROM user_state_private ORDER BY entity_key").fetch_all(pool).await.unwrap();
    let mut expected_keys = vec![path_key, ws_path_key];
    expected_keys.sort();
    assert_eq!(kept_keys, expected_keys);

    with_write_tx(pool, opts, |conn, ctx| {
        Box::pin(async move {
            apply_local_user_state_retention_in_tx(conn, ctx, Some(10), None, 1_755_000_000_000).await
        })
    }).await.unwrap();

    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT progress FROM chapter WHERE id = 21").fetch_one(pool).await.unwrap(), 66);
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT progress FROM chapter WHERE id = 31").fetch_one(pool).await.unwrap(), 55);
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT progress FROM chapter WHERE id = 32").fetch_one(pool).await.unwrap(), 0);
}

#[tokio::test]
async fn refresh_and_materialize_normalize_empty_and_whitespace_source_novel_ids() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    let opts = TxOptions {
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };

    sqlx::query(
        "INSERT INTO novel(id, plugin_id, source_novel_id, path, name, in_library, library_added_at, is_local) VALUES \
           (1, 'src-empty', '', '/empty', 'Empty Source Book', 1, 1000, 0), \
           (2, 'src-ws', '   ', '/ws', 'Whitespace Source Book', 1, 2000, 0)",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO chapter(id, novel_id, path, name, position, progress, read_at) VALUES \
           (11, 1, '/ch/1', 'E1', 1, 40, 1750000000), \
           (21, 2, '/ch/1', 'W1', 1, 80, 1750000001)",
    )
    .execute(pool)
    .await
    .unwrap();

    let b = sample_binding();
    let b_bind = b.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            bind_user_state_workspace_with_options_in_tx(conn, ctx, &b_bind, Some(false), None)
                .await
        })
    })
    .await
    .unwrap();

    with_write_tx(pool, opts.clone(), |conn, ctx| {
        Box::pin(async move {
            let rows = load_user_chapter_rows_by_ids_in_tx(conn, &[11, 21]).await?;
            record_chapter_rows_in_tx(conn, ctx, &rows, "reading", false).await
        })
    })
    .await
    .unwrap();

    with_write_tx(pool, opts.clone(), |conn, ctx| {
        Box::pin(async move {
            refresh_unattempted_user_state_identities_in_tx(conn, None).await?;
            defer_user_state_for_novel_in_tx(conn, ctx, 2).await?;
            Ok(())
        })
    })
    .await
    .unwrap();

    let intent_entities: Vec<String> =
        sqlx::query_scalar("SELECT entity_json FROM user_state_intent ORDER BY sequence")
            .fetch_all(pool)
            .await
            .unwrap();
    assert_eq!(intent_entities.len(), 2);
    for raw in &intent_entities {
        let entity: JsonValue = serde_json::from_str(raw).unwrap();
        assert!(
            entity["work"]["sourceNovelId"].is_null(),
            "expected sourceNovelId to remain null, got {entity}"
        );
    }

    let b_prep = b.clone();
    let default_ops = with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            prepare_user_state_operations_in_tx(
                None,
                conn,
                ctx,
                &b_prep,
                &PrepareUserStateOperationsLimitsDto::default(),
            )
            .await
        })
    })
    .await
    .unwrap()
    .value;
    assert!(default_ops.is_empty());

    let b_prep_opaque = b.clone();
    let ops = with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            prepare_user_state_operations_in_tx(
                None,
                conn,
                ctx,
                &b_prep_opaque,
                &PrepareUserStateOperationsLimitsDto {
                    allow_opaque_identity: Some(true),
                    ..PrepareUserStateOperationsLimitsDto::default()
                },
            )
            .await
        })
    })
    .await
    .unwrap()
    .value;
    assert_eq!(ops.len(), 2);
    for op in &ops {
        assert!(op["entity"]["work"]["sourceNovelId"].is_null());
    }

    let ns = super::types::namespace_for(&b);
    let ns_clone = ns.clone();
    with_write_tx(pool, opts, move |conn, _ctx| {
        Box::pin(async move {
            let empty_comp = ChapterCompositionV1Dto {
                version: 1,
                updated_at: 1,
                entries: Vec::new(),
            };
            for novel_id in [1_i64, 2_i64] {
                let err = apply_shared_composition_in_tx(
                    None,
                    conn,
                    novel_id,
                    &empty_comp,
                    &ns_clone,
                    &HashSet::new(),
                )
                .await
                .unwrap_err();
                match err {
                    MaterializeError::Deferred(d) => {
                        assert_eq!(d.reason, "missing-work-identity");
                    }
                    MaterializeError::Fatal(msg) => {
                        panic!("expected deferred missing-work-identity, got fatal: {msg}")
                    }
                }
            }

            let found = find_user_state_work_in_tx(
                conn,
                &UserStateWorkReferenceDto {
                    plugin_id: "src-ws".to_string(),
                    source_novel_id: None,
                    novel_path: "/ws".to_string(),
                    name: "Whitespace Source Book".to_string(),
                },
            )
            .await
            .map_err(|err| match err {
                MaterializeError::Deferred(d) => d.reason,
                MaterializeError::Fatal(msg) => msg,
            })?
            .expect("expected work by path");
            assert_eq!(found.source_novel_id, None);
            Ok(())
        })
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn library_membership_stays_device_local_and_purges_legacy_library_intents() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    seed_sample_work(pool).await;
    sqlx::query("UPDATE novel SET in_library = 1, library_added_at = 100 WHERE id = 1")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO novel_download_goal(novel_id, kind, count, updated_at) VALUES (1, 'keep_ahead', 5, 100)",
    )
    .execute(pool)
    .await
    .unwrap();

    let work = sample_work();
    let library_ent = json!({ "kind": "library", "work": work });
    let library_key = super::types::user_state_entity_key(&library_ent).unwrap();
    let binding = sample_binding();
    let ns = super::types::namespace_for(&binding);

    // Seed legacy pre-upgrade library intent, operation, and conflict rows.
    sqlx::query(
        "INSERT INTO user_state_intent(sequence, entity_key, entity_json, value_json, seed) \
         VALUES (1, ?1, ?2, ?3, 0)",
    )
    .bind(&library_key)
    .bind(library_ent.to_string())
    .bind(r#"{"inLibrary":false,"addedAt":null}"#)
    .execute(pool)
    .await
    .unwrap();

    let opts = TxOptions {
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };

    // Unlinked status must ignore pre-upgrade library intents.
    let mut read_conn = pool.acquire().await.unwrap();
    let unlinked = get_user_state_ledger_status_in_tx(&mut read_conn, None)
        .await
        .unwrap();
    drop(read_conn);
    assert_eq!(unlinked.pending, 0);

    // Binding purges legacy library intents and does not seed library entries.
    let b1 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { bind_user_state_workspace_in_tx(conn, ctx, &b1).await })
    })
    .await
    .unwrap();

    let intent_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_state_intent")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(intent_count, 0);

    // Remote library removal must not remove this device's work or clear its download goal.
    let remove_page = json!({
        "version": 1,
        "workspaceId": binding.workspace_id,
        "epoch": binding.epoch,
        "headRevision": 1,
        "through": 1,
        "nextCursor": 1,
        "hasMore": false,
        "records": [shared_record(library_ent.clone(), json!({ "inLibrary": false, "addedAt": null }), 1, "op-rm")],
    });
    let b2 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { apply_user_state_read_page_in_tx(conn, ctx, &b2, &remove_page).await })
    })
    .await
    .unwrap();
    let b3 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            project_pending_user_state_in_tx(None, conn, ctx, &b3, &HashSet::new()).await
        })
    })
    .await
    .unwrap();
    let lib_after_rm: (i64, Option<i64>) =
        sqlx::query_as("SELECT in_library, library_added_at FROM novel WHERE id = 1")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(lib_after_rm, (1, Some(100)));
    let goal_after_rm: Option<(String, Option<i64>)> =
        sqlx::query_as("SELECT kind, count FROM novel_download_goal WHERE novel_id = 1")
            .fetch_optional(pool)
            .await
            .unwrap();
    assert_eq!(goal_after_rm, Some(("keep_ahead".to_string(), Some(5))));

    // Snapshot GC of a retired library record must not remove the work from this device's library.
    let b4 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move {
            reconcile_user_state_snapshot_in_tx(
                None,
                conn,
                ctx,
                &b4,
                &[],
                2,
                Some(true),
                None,
                &HashSet::new(),
            )
            .await
        })
    })
    .await
    .unwrap();
    let lib_after_gc: i64 = sqlx::query_scalar("SELECT in_library FROM novel WHERE id = 1")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(lib_after_gc, 1);

    // Local removal emits no library intent, and remote library addition must not re-add it.
    with_write_tx(pool, opts.clone(), |conn, ctx| {
        Box::pin(async move {
            crate::db::novel::set_novel_in_library_in_tx(conn, ctx, 1, false).await
        })
    })
    .await
    .unwrap();
    let intent_after_local_rm: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_state_intent")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(intent_after_local_rm, 0);

    let add_page = json!({
        "version": 1,
        "workspaceId": binding.workspace_id,
        "epoch": binding.epoch,
        "headRevision": 3,
        "through": 3,
        "nextCursor": 3,
        "hasMore": false,
        "records": [shared_record(library_ent, json!({ "inLibrary": true, "addedAt": 200 }), 3, "op-add")],
    });
    let b5 = binding.clone();
    with_write_tx(pool, opts.clone(), move |conn, ctx| {
        Box::pin(async move { apply_user_state_read_page_in_tx(conn, ctx, &b5, &add_page).await })
    })
    .await
    .unwrap();
    let b6 = binding.clone();
    with_write_tx(pool, opts, move |conn, ctx| {
        Box::pin(async move {
            project_pending_user_state_in_tx(None, conn, ctx, &b6, &HashSet::new()).await
        })
    })
    .await
    .unwrap();
    let lib_after_add: (i64, Option<i64>) =
        sqlx::query_as("SELECT in_library, library_added_at FROM novel WHERE id = 1")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(lib_after_add, (0, None));

    // Verify stored remote library record is settled with no deferred reason.
    let rec_state: (i64, i64, Option<String>) = sqlx::query_as(
        "SELECT revision, applied_revision, deferred_reason FROM user_state_record \
         WHERE namespace = ?1 AND entity_key = ?2",
    )
    .bind(&ns)
    .bind(&library_key)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(rec_state, (3, 3, None));
}

#[tokio::test]
async fn sendable_pending_excludes_opaque_identity_pending_operations() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    seed_sample_work(pool).await;

    let binding = sample_binding();
    let ns = super::types::namespace_for(&binding);
    let opts = TxOptions {
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };
    let b1 = binding.clone();
    with_write_tx(pool, opts, move |conn, ctx| {
        Box::pin(async move { bind_user_state_workspace_in_tx(conn, ctx, &b1).await })
    })
    .await
    .unwrap();

    let work = sample_work();
    let opaque_ops = [
        (
            "op-missing-work-id",
            "k-missing-work-id",
            1_i64,
            json!({
                "operationId": "op-missing-work-id",
                "entity": {
                    "kind": "reading",
                    "work": { "pluginId": "source", "sourceNovelId": null, "novelPath": "/book", "name": "Book" },
                    "chapter": { "chapterPath": "/chapter/1" },
                },
                "value": { "progress": 50, "readAt": null },
                "baseRevision": 0,
            }),
        ),
        (
            "op-norea-folder",
            "k-norea-folder",
            2_i64,
            json!({
                "operationId": "op-norea-folder",
                "entity": {
                    "kind": "reading",
                    "work": work,
                    "chapter": { "chapterPath": "norea-folder:slot-1" },
                },
                "value": { "progress": 50, "readAt": null },
                "baseRevision": 0,
            }),
        ),
        (
            "op-local-folder-resume",
            "k-local-folder-resume",
            3_i64,
            json!({
                "operationId": "op-local-folder-resume",
                "entity": { "kind": "resume", "work": work },
                "value": { "chapter": { "chapterPath": "local-folder:slot-2", "name": "Two" }, "anchor": null, "openedAt": 10 },
                "baseRevision": 0,
            }),
        ),
    ];

    for (op_id, key, seq, payload) in opaque_ops {
        sqlx::query(
            "INSERT INTO user_state_operation(operation_id, namespace, entity_key, intent_sequence, payload, status) \
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending')",
        )
        .bind(op_id)
        .bind(&ns)
        .bind(key)
        .bind(seq)
        .bind(payload.to_string())
        .execute(pool)
        .await
        .unwrap();
    }

    let mut read_conn = pool.acquire().await.unwrap();
    let opaque_status = get_user_state_ledger_status_in_tx(&mut read_conn, Some(&binding))
        .await
        .unwrap();
    drop(read_conn);
    assert_eq!(opaque_status.sendable_pending, 0);

    let sendable_ops = [
        (
            "op-sendable-reading",
            "k-sendable-reading",
            4_i64,
            json!({
                "operationId": "op-sendable-reading",
                "entity": {
                    "kind": "reading",
                    "work": work,
                    "chapter": { "chapterPath": "/chapter/1" },
                },
                "value": { "progress": 80, "readAt": null },
                "baseRevision": 0,
            }),
        ),
        (
            "op-sendable-category",
            "k-sendable-category",
            5_i64,
            json!({
                "operationId": "op-sendable-category",
                "entity": { "kind": "category", "categoryId": "cat-1" },
                "value": { "name": "Favorites", "sort": 1, "deleted": false },
                "baseRevision": 0,
            }),
        ),
    ];

    for (op_id, key, seq, payload) in sendable_ops {
        sqlx::query(
            "INSERT INTO user_state_operation(operation_id, namespace, entity_key, intent_sequence, payload, status) \
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending')",
        )
        .bind(op_id)
        .bind(&ns)
        .bind(key)
        .bind(seq)
        .bind(payload.to_string())
        .execute(pool)
        .await
        .unwrap();
    }

    let mut read_conn = pool.acquire().await.unwrap();
    let sendable_status = get_user_state_ledger_status_in_tx(&mut read_conn, Some(&binding))
        .await
        .unwrap();
    drop(read_conn);
    assert_eq!(sendable_status.sendable_pending, 2);
}

#[tokio::test]
async fn user_state_cursor_query_and_pending_migration_intents_use_indexed_lookups() {
    let test = open_test_db().await;
    let pool = test.db.writer();
    let binding = sample_binding();
    let ns = super::types::namespace_for(&binding);
    let opts = TxOptions {
        publish_metadata: false,
        notify_content_sync: false,
        ..TxOptions::default()
    };

    let b1 = binding.clone();
    with_write_tx(pool, opts, move |conn, ctx| {
        Box::pin(async move { bind_user_state_workspace_in_tx(conn, ctx, &b1).await })
    })
    .await
    .unwrap();

    sqlx::query("UPDATE user_state_workspace SET cursor = 42, read_through = 50 WHERE namespace = ?1")
        .bind(&ns)
        .execute(pool)
        .await
        .unwrap();

    let mut read_conn = pool.acquire().await.unwrap();
    let cursor = super::ledger::get_user_state_cursor_in_tx(&mut read_conn, &binding)
        .await
        .unwrap();
    assert_eq!(cursor.cursor, 42);
    assert_eq!(cursor.through, Some(50));

    let source_work = json!({
        "pluginId": "source",
        "sourceNovelId": "src-1",
        "novelPath": "/src-1",
        "name": "Source Work",
    });
    let target_work = json!({
        "pluginId": "source",
        "sourceNovelId": "tgt-2",
        "novelPath": "/tgt-2",
        "name": "Target Work",
    });
    let other_work = json!({
        "pluginId": "source",
        "sourceNovelId": "other-3",
        "novelPath": "/other-3",
        "name": "Other Work",
    });
    let src_read_ent = json!({
        "kind": "reading",
        "work": source_work,
        "chapter": { "chapterPath": "/c1" },
    });
    let tgt_resume_ent = json!({
        "kind": "resume",
        "work": target_work,
    });
    let other_read_ent = json!({
        "kind": "reading",
        "work": other_work,
        "chapter": { "chapterPath": "/c9" },
    });

    let src_read_key = user_state_entity_key(&src_read_ent).unwrap();
    let tgt_resume_key = user_state_entity_key(&tgt_resume_ent).unwrap();
    let other_read_key = user_state_entity_key(&other_read_ent).unwrap();

    for (seq, key, ent, val) in [
        (1_i64, &src_read_key, &src_read_ent, json!({ "progress": 50, "readAt": 100 })),
        (2_i64, &tgt_resume_key, &tgt_resume_ent, json!({ "chapter": null, "anchor": null, "openedAt": 200 })),
        (3_i64, &other_read_key, &other_read_ent, json!({ "progress": 80, "readAt": 300 })),
    ] {
        sqlx::query(
            "INSERT INTO user_state_intent(sequence, entity_key, entity_json, value_json, seed) \
             VALUES (?1, ?2, ?3, ?4, 0)",
        )
        .bind(seq)
        .bind(key)
        .bind(ent.to_string())
        .bind(val.to_string())
        .execute(&mut *read_conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO user_state_progress(namespace, entity_key, local_sequence, acknowledged_sequence, base_revision) \
             VALUES (?1, ?2, ?3, 0, 0)",
        )
        .bind(&ns)
        .bind(key)
        .bind(seq)
        .execute(&mut *read_conn)
        .await
        .unwrap();
    }

    let source_work_key = super::types::user_state_work_key_parts("source", Some("src-1"), "/src-1");
    let target_work_key = super::types::user_state_work_key_parts("source", Some("tgt-2"), "/tgt-2");
    let pending = super::migration::pending_intents_for_works_in_tx(
        &mut read_conn,
        &[&source_work_key, &target_work_key],
    )
    .await
    .unwrap();
    let keys: Vec<String> = pending.into_iter().map(|r| r.entity_key).collect();
    assert_eq!(keys, vec![src_read_key.clone(), tgt_resume_key.clone()]);

    // Mark source reading acknowledged -> only target resume remains pending.
    sqlx::query(
        "UPDATE user_state_progress SET acknowledged_sequence = 1 WHERE namespace = ?1 AND entity_key = ?2",
    )
    .bind(&ns)
    .bind(&src_read_key)
    .execute(&mut *read_conn)
    .await
    .unwrap();
    let after_ack = super::migration::pending_intents_for_works_in_tx(
        &mut read_conn,
        &[&source_work_key, &target_work_key],
    )
    .await
    .unwrap();
    assert_eq!(
        after_ack.into_iter().map(|r| r.entity_key).collect::<Vec<_>>(),
        vec![tgt_resume_key]
    );

    // Verify EXPLAIN QUERY PLAN for pending migration range query uses indexed lookups without scanning user_state_progress.
    let encoded_work = serde_json::to_string(&source_work_key).unwrap();
    let plan_rows = sqlx::query(
        "EXPLAIN QUERY PLAN \
         SELECT i.sequence, i.entity_key, i.entity_json, i.value_json, i.seed \
         FROM user_state_intent i \
         WHERE i.entity_key >= ?1 AND i.entity_key < ?2 \
           AND i.seed = 0 \
           AND EXISTS(SELECT 1 FROM user_state_workspace w \
                      CROSS JOIN user_state_progress p \
                        ON p.namespace = w.namespace \
                       AND p.entity_key = i.entity_key \
                      WHERE i.sequence > p.acknowledged_sequence)",
    )
    .bind(format!(r#"["reading",{encoded_work},"#))
    .bind(format!(r#"["reading",{encoded_work}-"#))
    .fetch_all(&mut *read_conn)
    .await
    .unwrap();
    let details: Vec<String> = plan_rows.into_iter().map(|r| r.get("detail")).collect();
    assert!(
        !details.iter().any(|d| d.contains("SCAN p")),
        "expected user_state_progress PK search, got: {details:?}"
    );
    assert!(
        details.iter().any(|d| d.contains("SEARCH i USING INDEX")),
        "expected user_state_intent index range search, got: {details:?}"
    );

    // Verify ledger status sendable_intents NOT EXISTS uses covering index user_state_operation_pending_entity_idx.
    let status_plan_rows = sqlx::query(
        "EXPLAIN QUERY PLAN \
         SELECT \
           COUNT(*) AS pending, \
           COALESCE(SUM(CASE WHEN ?2 = 0 \
             AND NOT EXISTS(SELECT 1 FROM user_state_conflict c \
                            WHERE c.namespace = ?1 AND c.entity_key = i.entity_key) \
             AND NOT EXISTS(SELECT 1 FROM user_state_operation o \
                            WHERE o.namespace = ?1 AND o.status = 'pending' AND o.entity_key = i.entity_key) \
           THEN 1 ELSE 0 END), 0) AS sendable_intents \
         FROM user_state_intent i \
         JOIN user_state_progress p ON p.entity_key = i.entity_key AND p.namespace = ?1 \
         WHERE i.sequence > p.acknowledged_sequence",
    )
    .bind(&ns)
    .bind(0_i64)
    .fetch_all(&mut *read_conn)
    .await
    .unwrap();
    let status_details: Vec<String> = status_plan_rows.into_iter().map(|r| r.get("detail")).collect();
    assert!(
        status_details
            .iter()
            .any(|d| d.contains("SEARCH o USING COVERING INDEX user_state_operation_pending_entity_idx")),
        "expected covering index seek on user_state_operation_pending_entity_idx, got: {status_details:?}"
    );
}
