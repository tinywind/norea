use std::collections::HashSet;
use std::fs;

use serde_json::{json, Value as JsonValue};
use sqlx::Row;
use tempfile::TempDir;

use crate::db::test_support::open_test_db;
use crate::db::tx::{with_write_tx, MetadataRoot, TxOptions};
use crate::db::ReadMode;

use super::core::record_user_state_changes_in_tx;
use super::current::{
    apply_current_snapshot_at, bind_current_workspace_in_tx, current_category_id,
    export_current_snapshot_in_tx, get_current_status_in_tx, prepare_deferred_current_retry_in_tx,
};
use super::ledger::{
    acknowledge_user_state_operations_in_tx, apply_user_state_read_page_in_tx,
    bind_user_state_workspace_in_tx, get_user_state_ledger_status_in_tx,
    list_user_state_conflicts_in_tx, prepare_user_state_operations_in_tx,
    project_pending_user_state_in_tx, resolve_user_state_ledger_conflict_in_tx,
    PrepareUserStateOperationsLimitsDto, ADVANCE_ACKNOWLEDGED_PROGRESS_SQL,
    MARK_ACKNOWLEDGED_RECORDS_APPLIED_SQL,
};
use super::materialize::{
    defer_user_state_for_novel_in_tx, refresh_unattempted_user_state_identities_in_tx,
};
use super::types::{
    sha256_hex, stored_chapter_path, user_state_entity_key, CurrentSnapshotRetryDto,
    ResolveUserStateLedgerConflictInputDto, UserStateBindingDto,
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
        let rows = sqlx::query(&format!("EXPLAIN QUERY PLAN {sql}"))
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
            json!({ "progress": 10 * revision, "unread": false, "readAt": 100 + revision }),
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
    sqlx::query("UPDATE chapter SET progress = 100, unread = 0 WHERE id = 11")
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

    let c1 = (reading_ent.clone(), json!({ "progress": 100, "unread": false, "readAt": null }));
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

    assert_eq!(baseline.len(), 5);
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
            json!({ "progress": 0, "unread": true, "readAt": null }),
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
    assert_eq!(status_before.projection_pending, 5);

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

    let ch_state = sqlx::query("SELECT CAST(progress AS REAL) AS progress, unread FROM chapter WHERE id = 11")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(ch_state.get::<f64, _>("progress"), 0.0);
    assert_eq!(ch_state.get::<i64, _>("unread"), 1);

    let in_lib: i64 = sqlx::query_scalar("SELECT in_library FROM novel WHERE id = 1")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(in_lib, 0);

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
    let local_val = json!({ "progress": 75, "unread": true, "readAt": 100 });
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
async fn current_snapshot_exports_applies_and_retries_deferred_metadata() {
    let test_db = open_test_db().await;
    let pool = test_db.db.pool_for(ReadMode::Queued);
    seed_sample_work(pool).await;
    sqlx::query("UPDATE novel SET in_library = 1 WHERE id = 1")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE chapter SET progress = 80, unread = 0, bookmark = 1, read_at = 50 WHERE id = 11")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO category(id, name, sort, is_system) VALUES (7, 'Completed', 0, 0)")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO novel_category(novel_id, category_id) VALUES (1, 7)")
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
        Box::pin(async move { bind_current_workspace_in_tx(conn, ctx, &b1).await })
    })
    .await
    .unwrap();

    let b2 = binding.clone();
    let exported = with_write_tx(pool, opts.clone(), move |conn, _ctx| {
        Box::pin(async move {
            export_current_snapshot_in_tx(None, conn, &b2, &HashSet::new()).await
        })
    })
    .await
    .unwrap()
    .value;

    let items = exported["items"].as_array().unwrap();
    assert!(items.iter().any(|i| i["entity"]["kind"] == "library"));
    assert!(items.iter().any(|i| i["entity"]["kind"] == "reading"));
    assert!(items.iter().any(|i| i["entity"]["kind"] == "bookmark"));
    assert!(items.iter().any(|i| {
        i["entity"]["kind"] == "category"
            && i["entity"]["categoryId"] == json!(current_category_id("Completed"))
    }));

    // Apply onto an empty peer DB where chapter /chapter/1 does not exist yet -> missingMetadataCount > 0
    let peer_db = open_test_db().await;
    let peer_pool = peer_db.db.pool_for(ReadMode::Queued);
    let pb1 = binding.clone();
    with_write_tx(peer_pool, opts, move |conn, ctx| {
        Box::pin(async move { bind_current_workspace_in_tx(conn, ctx, &pb1).await })
    })
    .await
    .unwrap();

    let applied = apply_current_snapshot_at(
        peer_pool,
        MetadataRoot::None,
        &binding,
        &exported,
        None,
        &HashSet::new(),
    )
    .await
    .unwrap()
    .value;
    assert!(applied.changed);
    assert!(applied.missing_metadata_count > 0);

    // Insert the missing chapter on peer DB and run deferred retry
    let peer_novel_id: i64 =
        sqlx::query_scalar("SELECT id FROM novel WHERE plugin_id = 'source' AND source_novel_id = 'book'")
            .fetch_one(peer_pool)
            .await
            .unwrap();
    sqlx::query(
        "INSERT INTO chapter(novel_id, path, name, chapter_number, position) \
         VALUES (?1, '/chapter/1', 'One', '1', 1)",
    )
    .bind(peer_novel_id)
    .execute(peer_pool)
    .await
    .unwrap();

    let mut read_conn = peer_pool.acquire().await.unwrap();
    let (_, retry_plan) = prepare_deferred_current_retry_in_tx(
        &mut read_conn,
        &binding.server_url,
        &[peer_novel_id],
    )
    .await
    .unwrap()
    .unwrap();
    drop(read_conn);

    let retried = apply_current_snapshot_at(
        peer_pool,
        MetadataRoot::None,
        &binding,
        &retry_plan.snapshot,
        Some(CurrentSnapshotRetryDto {
            work_keys: retry_plan.work_keys,
            previous_missing: retry_plan.missing_keys,
        }),
        &HashSet::new(),
    )
    .await
    .unwrap()
    .value;
    assert_eq!(retried.missing_metadata_count, 0);

    let mut read_conn = peer_pool.acquire().await.unwrap();
    let status = get_current_status_in_tx(&mut read_conn, Some(&binding.server_url))
        .await
        .unwrap();
    assert_eq!(status.missing_metadata_count, 0);
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
            json!({ "progress": 64, "unread": false, "readAt": 250 }),
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
        "SELECT n.in_library, n.last_read_at, CAST(c.progress AS REAL) AS progress, c.unread, c.read_at \
         FROM novel n JOIN chapter c ON c.novel_id = n.id WHERE n.id = 1 AND c.id = 19",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(row.get::<i64, _>("in_library"), 1);
    assert_eq!(row.get::<Option<i64>, _>("last_read_at"), Some(250));
    assert_eq!(row.get::<f64, _>("progress"), 64.0);
    assert_eq!(row.get::<i64, _>("unread"), 0);
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
        "INSERT INTO chapter(id, novel_id, path, name, chapter_number, position, progress, unread, bookmark) \
         VALUES (101, 10, 'local-ch-1', 'Local One', '1', 1, 88, 0, 1)",
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
