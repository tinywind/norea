use std::{fs, time::Duration};

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;
use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{DbInstances, DbPool, Migration, MigrationKind};

const DB_URL: &str = "sqlite:norea.db";
const READ_DB_URL: &str = "sqlite:norea-readonly.db";
const DB_FILE: &str = "norea.db";
const DB_BUSY_TIMEOUT_MS: u64 = 5000;

fn sqlite_pool_options() -> SqlitePoolOptions {
    // Frontend transactions span IPC calls, so the shared connection must not expire between them.
    SqlitePoolOptions::new()
        .max_connections(1)
        .max_lifetime(None)
        .idle_timeout(None)
}

fn run_async_command<F: std::future::Future>(command: F) -> F::Output {
    if tokio::runtime::Handle::try_current().is_ok() {
        tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(command))
    } else {
        tauri::async_runtime::block_on(command)
    }
}

pub fn schema_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create current application schema",
            sql: include_str!("schema.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "persist immutable VPN download plans",
            sql: include_str!("migrations/0002_vpn_download_plans.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "persist batch-wide VPN profile exclusions",
            sql: include_str!("migrations/0003_vpn_download_profile_issues.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "persist chapter download failures and retry budgets",
            sql: include_str!("migrations/0004_chapter_download_failures.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "persist novel download goals",
            sql: include_str!("migrations/0005_novel_download_goals.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "allow an explicit no-download goal and persist goal exclusions",
            sql: include_str!("migrations/0006_download_goal_opt_out.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "record novel freshness and chapters found by checks",
            sql: include_str!("migrations/0007_novel_freshness.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "allow several plugin repositories and record plugin publishers",
            sql: include_str!("migrations/0008_plugin_repositories.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "record VPN download page timeouts and site refusals as profile problems",
            sql: include_str!("migrations/0009_vpn_profile_issue_page_causes.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "preserve source chapter provenance and user composition",
            sql: include_str!("migrations/0010_novel_chapter_composition.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "persist cross-device personal state intents and receipts",
            sql: include_str!("migrations/0011_user_state_journal.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

async fn open_sqlite_pools(path: &std::path::Path) -> Result<(SqlitePool, SqlitePool), sqlx::Error> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_millis(DB_BUSY_TIMEOUT_MS));
    let writer = sqlite_pool_options().connect_with(options.clone()).await?;
    let reader = SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(options.read_only(true))
        .await?;
    Ok((writer, reader))
}

pub fn install_sqlite_pools(app: &AppHandle) -> Result<(), String> {
    run_async_command(async move {
        let db_dir = app
            .path()
            .app_config_dir()
            .map_err(|err| format!("database: app config dir: {err}"))?;
        fs::create_dir_all(&db_dir).map_err(|err| format!("database: create db dir: {err}"))?;

        let (writer, reader) = open_sqlite_pools(&db_dir.join(DB_FILE))
            .await
            .map_err(|err| format!("database: open sqlite pools: {err}"))?;

        {
            let instances = app.state::<DbInstances>();
            let mut guard = instances.0.write().await;
            let _ = guard.insert(DB_URL.to_string(), DbPool::Sqlite(writer));
            let _ = guard.insert(READ_DB_URL.to_string(), DbPool::Sqlite(reader));
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::migrate::{Migration as SqlxMigration, MigrationType, Migrator};
    use std::borrow::Cow;

    fn schema(sql: &str) -> SqlxMigration {
        SqlxMigration::new(
            1,
            "fixture".into(),
            MigrationType::ReversibleUp,
            sql.to_owned().into(),
            false,
        )
    }

    async fn bootstrap(path: &std::path::Path, expected: &[SqlxMigration]) -> Result<sqlx::SqlitePool, sqlx::migrate::MigrateError> {
        let pool = sqlite_pool_options()
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(true),
            )
            .await?;
        let migration = Migrator {
            migrations: Cow::Owned(expected.to_vec()),
            ..Migrator::DEFAULT
        }
        .run(&pool)
        .await;
        if let Err(error) = migration {
            pool.close().await;
            return Err(error);
        }
        Ok(pool)
    }

    const CURRENT: &str = "CREATE TABLE sample (value INTEGER);";

    #[tokio::test]
    async fn registered_v2_upgrade_preserves_vpn_jobs_and_batch_issue_history_on_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations().into_iter().map(|migration| {
            SqlxMigration::new(migration.version, migration.description.into(),
                MigrationType::ReversibleUp, migration.sql.into(), false)
        }).collect();
        let pool = bootstrap(&path, &migrations[..2]).await.unwrap();
        sqlx::query("INSERT INTO novel(id,plugin_id,path,name) VALUES(1,'source','/work','Work')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapter(id,novel_id,path,name,position) VALUES(1,1,'/chapter','Chapter',1)").execute(&pool).await.unwrap();
        let payload = r#"{"id":"plan","revision":3,"ranges":[{"checkpoint":1,"attemptedProfileIds":["failed"],"userPaused":true}]}"#;
        let job = r#"{"id":1,"vpnPlanId":"plan","batchId":"shared-batch"}"#;
        sqlx::query("INSERT INTO vpn_download_plan VALUES('plan',?1,3)").bind(payload).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapter_download_queue VALUES(1,?1,10,20,30,4)").bind(job).execute(&pool).await.unwrap();
        pool.close().await;
        let pool = bootstrap(&path, &migrations).await.unwrap();
        let migrated: String = sqlx::query_scalar("SELECT payload FROM vpn_download_plan").fetch_one(&pool).await.unwrap();
        let mut expected: serde_json::Value = serde_json::from_str(payload).unwrap();
        expected["batchId"] = "shared-batch".into();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&migrated).unwrap(), expected);
        assert_eq!(sqlx::query_as::<_, (String, i64, i64, Option<i64>, i64)>(
            "SELECT job_json,created_at_ms,updated_at_ms,leased_at_ms,attempt_count FROM chapter_download_queue")
            .fetch_one(&pool).await.unwrap(), (job.into(),10,20,Some(30),4));
        sqlx::query("INSERT INTO vpn_download_profile_issue VALUES('shared-batch','192.0.2.1','failed','hash','plan','range',4,'captcha',100,1,1)")
            .execute(&pool).await.unwrap();
        pool.close().await;
        let pool = bootstrap(&path, &migrations).await.unwrap();
        assert_eq!(sqlx::query_as::<_, (String, i64, i64)>("SELECT cause,excluded,revision FROM vpn_download_profile_issue")
            .fetch_one(&pool).await.unwrap(), ("captcha".into(),1,1));
        pool.close().await;
    }

    #[tokio::test]
    async fn registered_v8_upgrade_keeps_vpn_profile_issues_and_accepts_page_causes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations().into_iter().map(|migration| {
            SqlxMigration::new(migration.version, migration.description.into(),
                MigrationType::ReversibleUp, migration.sql.into(), false)
        }).collect();
        let pool = bootstrap(&path, &migrations[..8]).await.unwrap();
        sqlx::query("INSERT INTO vpn_download_profile_issue VALUES('batch','192.0.2.1','profile','hash','plan','range',4,'tunnel-lost',100,0,3)")
            .execute(&pool).await.unwrap();
        pool.close().await;
        let pool = bootstrap(&path, &migrations).await.unwrap();
        assert_eq!(sqlx::query_as::<_, (String, String, String, String, String, String, i64, String, i64, i64, i64)>(
            "SELECT * FROM vpn_download_profile_issue").fetch_one(&pool).await.unwrap(),
            ("batch".into(), "192.0.2.1".into(), "profile".into(), "hash".into(), "plan".into(), "range".into(), 4, "tunnel-lost".into(), 100, 0, 3));
        for (ip, cause) in [("192.0.2.2", "page-unresponsive"), ("192.0.2.3", "site-forbidden")] {
            sqlx::query("INSERT INTO vpn_download_profile_issue VALUES('batch',?1,'profile','hash','plan','range',4,?2,200,1,1)")
                .bind(ip).bind(cause).execute(&pool).await.unwrap();
        }
        assert!(sqlx::query("INSERT INTO vpn_download_profile_issue VALUES('batch','192.0.2.4','profile','hash','plan','range',4,'unknown',200,1,1)")
            .execute(&pool).await.is_err());
        pool.close().await;
        let pool = bootstrap(&path, &migrations).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM vpn_download_profile_issue").fetch_one(&pool).await.unwrap(), 3);
        pool.close().await;
    }

    #[tokio::test]
    async fn registered_v3_upgrade_preserves_queue_and_plans_and_tracks_failures_per_chapter() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations().into_iter().map(|migration| {
            SqlxMigration::new(migration.version, migration.description.into(),
                MigrationType::ReversibleUp, migration.sql.into(), false)
        }).collect();
        let pool = bootstrap(&path, &migrations[..3]).await.unwrap();
        sqlx::query("INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/work','Work',1)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapter(id,novel_id,path,name,position,progress) VALUES(1,1,'/one','One',1,40),(2,1,'/two','Two',2,0)")
            .execute(&pool).await.unwrap();
        let job = r#"{"id":1,"pluginId":"source","chapterPath":"/one","title":"One"}"#;
        sqlx::query("INSERT INTO chapter_download_queue VALUES(1,?1,10,20,NULL,0)").bind(job).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO vpn_download_plan VALUES('plan','{\"batchId\":\"batch\"}',2)").execute(&pool).await.unwrap();
        pool.close().await;
        for _ in 0..2 {
            let pool = bootstrap(&path, &migrations).await.unwrap();
            assert_eq!(sqlx::query_as::<_, (String, i64)>("SELECT job_json,attempt_count FROM chapter_download_queue")
                .fetch_one(&pool).await.unwrap(), (job.into(), 0));
            assert_eq!(sqlx::query_scalar::<_, i64>("SELECT progress FROM chapter WHERE id=1").fetch_one(&pool).await.unwrap(), 40);
            assert_eq!(sqlx::query_scalar::<_, i64>("SELECT revision FROM vpn_download_plan").fetch_one(&pool).await.unwrap(), 2);
            pool.close().await;
        }
        let pool = bootstrap(&path, &migrations).await.unwrap();
        sqlx::query("INSERT INTO chapter_download_failure VALUES(2,'source','transient','Timed out',NULL,1,30000,'{}',10)")
            .execute(&pool).await.unwrap();
        assert!(sqlx::query("INSERT INTO chapter_download_failure VALUES(1,'source','unknown','x',NULL,1,NULL,'{}',10)")
            .execute(&pool).await.is_err());
        assert!(sqlx::query("INSERT INTO chapter_download_failure VALUES(99,'source','content','x',NULL,1,NULL,'{}',10)")
            .execute(&pool).await.is_err());
        sqlx::query("DELETE FROM chapter WHERE id=2").execute(&pool).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM chapter_download_failure").fetch_one(&pool).await.unwrap(), 0);
        pool.close().await;
    }

    #[tokio::test]
    async fn registered_v4_upgrade_preserves_failures_and_stores_one_goal_per_novel() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations().into_iter().map(|migration| {
            SqlxMigration::new(migration.version, migration.description.into(),
                MigrationType::ReversibleUp, migration.sql.into(), false)
        }).collect();
        let pool = bootstrap(&path, &migrations[..4]).await.unwrap();
        sqlx::query("INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/work','Work',1),(2,'source','/other','Other',0)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapter(id,novel_id,path,name,position,progress) VALUES(1,1,'/one','One',1,40)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapter_download_failure VALUES(1,'source','transient','Timed out',NULL,2,500,'{}',10)").execute(&pool).await.unwrap();
        pool.close().await;
        for _ in 0..2 {
            let pool = bootstrap(&path, &migrations).await.unwrap();
            assert_eq!(sqlx::query_as::<_, (i64, i64)>("SELECT progress,(SELECT attempts FROM chapter_download_failure) FROM chapter")
                .fetch_one(&pool).await.unwrap(), (40, 2));
            pool.close().await;
        }
        let pool = bootstrap(&path, &migrations).await.unwrap();
        sqlx::query("INSERT INTO novel_download_goal VALUES(1,'keep_ahead',3,10),(2,'entire',NULL,10)").execute(&pool).await.unwrap();
        for invalid in ["(1,'entire',NULL,11)", "(2,'keep_ahead',NULL,10)", "(2,'all_remaining',5,10)", "(2,'unknown',NULL,10)", "(99,'entire',NULL,10)"] {
            assert!(sqlx::query(&format!("INSERT INTO novel_download_goal VALUES{invalid}")).execute(&pool).await.is_err(), "{invalid}");
        }
        sqlx::query("DELETE FROM novel WHERE id=2").execute(&pool).await.unwrap();
        assert_eq!(sqlx::query_as::<_, (i64, String, Option<i64>)>("SELECT novel_id,kind,count FROM novel_download_goal")
            .fetch_all(&pool).await.unwrap(), [(1, "keep_ahead".into(), Some(3))]);
        pool.close().await;
    }

    #[tokio::test]
    async fn registered_v5_upgrade_keeps_goals_and_allows_an_explicit_opt_out() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations().into_iter().map(|migration| {
            SqlxMigration::new(migration.version, migration.description.into(),
                MigrationType::ReversibleUp, migration.sql.into(), false)
        }).collect();
        let pool = bootstrap(&path, &migrations[..5]).await.unwrap();
        sqlx::query("INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/work','Work',1),(2,'source','/other','Other',1),(3,'source','/third','Third',1)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapter(id,novel_id,path,name,position,progress) VALUES(1,1,'/one','One',1,40),(2,2,'/two','Two',1,0)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO novel_download_goal VALUES(1,'keep_ahead',5,10),(2,'entire',NULL,20)").execute(&pool).await.unwrap();
        assert!(sqlx::query("INSERT INTO novel_download_goal VALUES(3,'none',NULL,30)").execute(&pool).await.is_err());
        pool.close().await;
        for _ in 0..2 {
            let pool = bootstrap(&path, &migrations).await.unwrap();
            assert_eq!(sqlx::query_as::<_, (i64, String, Option<i64>, i64)>("SELECT novel_id,kind,count,updated_at FROM novel_download_goal ORDER BY novel_id")
                .fetch_all(&pool).await.unwrap(), [(1, "keep_ahead".into(), Some(5), 10), (2, "entire".into(), None, 20)]);
            assert_eq!(sqlx::query_scalar::<_, i64>("SELECT progress FROM chapter WHERE id=1").fetch_one(&pool).await.unwrap(), 40);
            pool.close().await;
        }
        let pool = bootstrap(&path, &migrations).await.unwrap();
        sqlx::query("INSERT INTO novel_download_goal VALUES(3,'none',NULL,30)").execute(&pool).await.unwrap();
        assert!(sqlx::query("UPDATE novel_download_goal SET count=2 WHERE novel_id=3").execute(&pool).await.is_err());
        assert!(sqlx::query("UPDATE novel_download_goal SET kind='skip' WHERE novel_id=3").execute(&pool).await.is_err());
        sqlx::query("INSERT INTO chapter_download_goal_exclusion VALUES(1,50),(2,60)").execute(&pool).await.unwrap();
        assert!(sqlx::query("INSERT INTO chapter_download_goal_exclusion VALUES(99,70)").execute(&pool).await.is_err());
        sqlx::query("DELETE FROM novel WHERE id IN (2,3)").execute(&pool).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT chapter_id FROM chapter_download_goal_exclusion").fetch_all(&pool).await.unwrap(), [1]);
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT novel_id FROM novel_download_goal").fetch_all(&pool).await.unwrap(), [1]);
        pool.close().await;
    }

    #[tokio::test]
    async fn registered_v6_upgrade_flags_no_existing_chapter_and_records_freshness_per_novel() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations().into_iter().map(|migration| {
            SqlxMigration::new(migration.version, migration.description.into(),
                MigrationType::ReversibleUp, migration.sql.into(), false)
        }).collect();
        let pool = bootstrap(&path, &migrations[..6]).await.unwrap();
        sqlx::query("INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/work','Work',1),(2,'source','/other','Other',1)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapter(id,novel_id,path,name,position,progress,found_at) VALUES(1,1,'/one','One',1,40,500),(2,2,'/two','Two',1,0,600)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO novel_download_goal VALUES(1,'none',NULL,10)").execute(&pool).await.unwrap();
        pool.close().await;
        for _ in 0..2 {
            let pool = bootstrap(&path, &migrations).await.unwrap();
            assert_eq!(sqlx::query_as::<_, (i64, i64, i64, i64)>("SELECT id,progress,found_at,found_by_check FROM chapter ORDER BY id")
                .fetch_all(&pool).await.unwrap(), [(1, 40, 500, 0), (2, 0, 600, 0)]);
            assert_eq!(sqlx::query_scalar::<_, String>("SELECT kind FROM novel_download_goal").fetch_one(&pool).await.unwrap(), "none");
            pool.close().await;
        }
        let pool = bootstrap(&path, &migrations).await.unwrap();
        sqlx::query("INSERT INTO chapter(id,novel_id,path,name,position,found_by_check) VALUES(3,1,'/three','Three',2,1)").execute(&pool).await.unwrap();
        assert!(sqlx::query("UPDATE chapter SET found_by_check=2 WHERE id=3").execute(&pool).await.is_err());
        sqlx::query("INSERT INTO novel_freshness(novel_id,last_checked_at,last_success_at) VALUES(1,100,100),(2,200,NULL)").execute(&pool).await.unwrap();
        assert!(sqlx::query("INSERT INTO novel_freshness(novel_id) VALUES(99)").execute(&pool).await.is_err());
        assert!(sqlx::query("UPDATE novel_freshness SET consecutive_failures=-1 WHERE novel_id=2").execute(&pool).await.is_err());
        sqlx::query("DELETE FROM novel WHERE id=2").execute(&pool).await.unwrap();
        assert_eq!(sqlx::query_as::<_, (i64, i64)>("SELECT novel_id,consecutive_failures FROM novel_freshness").fetch_all(&pool).await.unwrap(), [(1, 0)]);
        pool.close().await;
    }

    #[tokio::test]
    async fn registered_v7_upgrade_keeps_the_repository_first_and_binds_publishers_by_source_url() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations().into_iter().map(|migration| {
            SqlxMigration::new(migration.version, migration.description.into(),
                MigrationType::ReversibleUp, migration.sql.into(), false)
        }).collect();
        let pool = bootstrap(&path, &migrations[..7]).await.unwrap();
        sqlx::query("INSERT INTO repository(id,url,name,added_at) VALUES(1,'https://repo.test/plugins.json','Saved',50)")
            .execute(&pool).await.unwrap();
        sqlx::query(r#"INSERT INTO repository_index_cache(repo_url,items_json) VALUES('https://repo.test/plugins.json','[{"id":"bound","url":"https://repo.test/bound.js"},7,{"id":"github","url":"https://repo.test/github.js"},{"id":"moved","url":"https://repo.test/new-moved.js"}]')"#)
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO installed_plugin(id,name,lang,version,icon_url,source_url,source_code) VALUES
            ('bound','Bound','en','1','','https://repo.test/bound.js','a'),
            ('github:shelf','Shelf','en','1','','https://repo.test/github.js','b'),
            ('moved','Moved','en','1','','https://repo.test/old-moved.js','c'),
            ('local','Local','en','1','','local:local.js','d')")
            .execute(&pool).await.unwrap();
        pool.close().await;
        for _ in 0..2 {
            let pool = bootstrap(&path, &migrations).await.unwrap();
            assert_eq!(sqlx::query_as::<_, (i64, String, Option<String>, i64, i64, i64)>(
                "SELECT id,url,name,added_at,priority,enabled FROM repository").fetch_all(&pool).await.unwrap(),
                [(1, "https://repo.test/plugins.json".to_string(), Some("Saved".to_string()), 50, 1, 1)]);
            assert_eq!(sqlx::query_as::<_, (String, Option<String>, String)>(
                "SELECT id,repository_url,source_code FROM installed_plugin ORDER BY id").fetch_all(&pool).await.unwrap(), [
                ("bound".to_string(), Some("https://repo.test/plugins.json".to_string()), "a".to_string()),
                ("github:shelf".to_string(), Some("https://repo.test/plugins.json".to_string()), "b".to_string()),
                ("local".to_string(), None, "d".to_string()),
                ("moved".to_string(), None, "c".to_string()),
            ]);
            pool.close().await;
        }
        let pool = bootstrap(&path, &migrations).await.unwrap();
        sqlx::query("INSERT INTO repository(url,priority,enabled) VALUES('https://second.test/plugins.json',2,0)")
            .execute(&pool).await.unwrap();
        assert!(sqlx::query("INSERT INTO repository(url) VALUES('https://second.test/plugins.json')").execute(&pool).await.is_err());
        assert!(sqlx::query("UPDATE repository SET enabled=2 WHERE id=1").execute(&pool).await.is_err());
        assert!(sqlx::query("UPDATE repository SET priority=0 WHERE id=1").execute(&pool).await.is_err());
        pool.close().await;
    }

    #[tokio::test]
    async fn registered_v1_upgrade_preserves_library_chapters_and_ordinary_queue() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations().into_iter().map(|migration| {
            SqlxMigration::new(migration.version, migration.description.into(),
                MigrationType::ReversibleUp, migration.sql.into(), false)
        }).collect();
        let pool = bootstrap(&path, &migrations[..1]).await.unwrap();
        sqlx::query("INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/work','Retained work',1)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapter(id,novel_id,path,name,position,is_downloaded,progress,content_bytes) VALUES(1,1,'/chapter','Retained chapter',1,1,73,456)")
            .execute(&pool).await.unwrap();
        let job = r#"{"id":1,"pluginId":"source","chapterPath":"/chapter","title":"Ordinary"}"#;
        sqlx::query("INSERT INTO chapter_download_queue VALUES(1,?1,10,20,30,4)").bind(job)
            .execute(&pool).await.unwrap();
        pool.close().await;
        for _ in 0..2 {
            let pool = bootstrap(&path, &migrations).await.unwrap();
            assert_eq!(sqlx::query_as::<_, (i64, String, i64, i64, i64)>(
                "SELECT n.in_library,c.name,c.is_downloaded,c.progress,c.content_bytes FROM novel n JOIN chapter c ON c.novel_id=n.id")
                .fetch_one(&pool).await.unwrap(), (1,"Retained chapter".into(),1,73,456));
            assert_eq!(sqlx::query_as::<_, (String, i64, i64, Option<i64>, i64)>(
                "SELECT job_json,created_at_ms,updated_at_ms,leased_at_ms,attempt_count FROM chapter_download_queue")
                .fetch_one(&pool).await.unwrap(), (job.into(),10,20,Some(30),4));
            assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM vpn_download_plan")
                .fetch_one(&pool).await.unwrap(), 0);
            assert_eq!(sqlx::query_scalar::<_, i64>("SELECT version FROM _sqlx_migrations ORDER BY version")
                .fetch_all(&pool).await.unwrap(), vec![1,2,3,4,5,6,7,8,9]);
            pool.close().await;
        }
    }

    #[tokio::test]
    async fn registered_app_migrations_preserve_library_and_downloads_on_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations().into_iter().map(|migration| {
            SqlxMigration::new(migration.version, migration.description.into(),
                MigrationType::ReversibleUp, migration.sql.into(), false)
        }).collect();
        let pool = bootstrap(&path, &migrations).await.unwrap();
        sqlx::query("INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/work','Retained work',1)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapter(novel_id,path,name,position,is_downloaded,stored_content_type) VALUES(1,'/chapter','Retained chapter',1,1,'html')")
            .execute(&pool).await.unwrap();
        pool.close().await;
        let pool = bootstrap(&path, &migrations).await.unwrap();
        assert_eq!(sqlx::query_as::<_, (String, i64, String, i64)>(
            "SELECT n.name,n.in_library,c.name,c.is_downloaded FROM novel n JOIN chapter c ON c.novel_id=n.id")
            .fetch_one(&pool).await.unwrap(), ("Retained work".into(),1,"Retained chapter".into(),1));
        pool.close().await;
    }

    #[tokio::test]
    async fn current_schema_reopens_without_changing_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let pool = bootstrap(&path, &[schema(CURRENT)]).await.unwrap();
        sqlx::query("INSERT INTO sample VALUES (42)")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let pool = bootstrap(&path, &[schema(CURRENT)]).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT value FROM sample")
                .fetch_one(&pool)
                .await
                .unwrap(),
            42
        );
        pool.close().await;
    }

    #[tokio::test]
    async fn changed_checksum_preserves_database_and_media() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let media = dir.path().join("content.html");
        fs::write(&media, "chapter content").unwrap();
        let pool = bootstrap(&path, &[schema(CURRENT)]).await.unwrap();
        sqlx::query("INSERT INTO sample VALUES (42)").execute(&pool).await.unwrap();
        pool.close().await;
        assert!(bootstrap(&path, &[schema("CREATE TABLE sample (value TEXT);")]).await.is_err());
        let pool = bootstrap(&path, &[schema(CURRENT)]).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT value FROM sample").fetch_one(&pool).await.unwrap(), 42);
        assert_eq!(fs::read_to_string(media).unwrap(), "chapter content");
        pool.close().await;
    }

    #[tokio::test]
    async fn appended_migration_preserves_rows_and_reopens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let first = schema(CURRENT);
        let second = SqlxMigration::new(2, "add label".into(), MigrationType::ReversibleUp,
            "ALTER TABLE sample ADD COLUMN label TEXT NOT NULL DEFAULT 'retained';".into(), false);
        let pool = bootstrap(&path, &[first.clone()]).await.unwrap();
        sqlx::query("INSERT INTO sample VALUES (42)").execute(&pool).await.unwrap();
        pool.close().await;
        for _ in 0..2 {
            let pool = bootstrap(&path, &[first.clone(), second.clone()]).await.unwrap();
            assert_eq!(sqlx::query_as::<_, (i64, String)>("SELECT value, label FROM sample").fetch_one(&pool).await.unwrap(),
                (42, "retained".into()));
            assert_eq!(sqlx::query_scalar::<_, i64>("SELECT version FROM _sqlx_migrations ORDER BY version").fetch_all(&pool).await.unwrap(), vec![1, 2]);
            pool.close().await;
        }
    }

    #[tokio::test]
    async fn invalid_or_newer_history_preserves_database() {
        for change in [
            "UPDATE _sqlx_migrations SET version = 2",
            "UPDATE _sqlx_migrations SET success = 0",
            "INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) \
             SELECT 2,description,success,checksum,execution_time FROM _sqlx_migrations",
            "DELETE FROM _sqlx_migrations",
            "DROP TABLE _sqlx_migrations",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join(DB_FILE);
            let pool = bootstrap(&path, &[schema(CURRENT)]).await.unwrap();
            sqlx::query("INSERT INTO sample VALUES (42)").execute(&pool).await.unwrap();
            sqlx::query(change).execute(&pool).await.unwrap();
            pool.close().await;
            assert!(bootstrap(&path, &[schema(CURRENT)]).await.is_err(), "{change}");
            let pool = sqlite_pool_options().connect_with(SqliteConnectOptions::new().filename(&path).create_if_missing(false)).await.unwrap();
            assert_eq!(sqlx::query_scalar::<_, i64>("SELECT value FROM sample").fetch_one(&pool).await.unwrap(), 42);
            pool.close().await;
        }
    }

    #[tokio::test]
    async fn failed_upgrade_rolls_back_and_keeps_the_previous_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let first = schema(CURRENT);
        let pool = bootstrap(&path, &[first.clone()]).await.unwrap();
        sqlx::query("INSERT INTO sample VALUES (42)").execute(&pool).await.unwrap();
        pool.close().await;
        let second = SqlxMigration::new(2, "broken upgrade".into(), MigrationType::ReversibleUp,
            "UPDATE sample SET value = 99; INSERT INTO missing_table VALUES (1);".into(), false);
        assert!(bootstrap(&path, &[first.clone(), second]).await.is_err());
        let pool = bootstrap(&path, &[first]).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT value FROM sample").fetch_one(&pool).await.unwrap(), 42);
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT version FROM _sqlx_migrations").fetch_all(&pool).await.unwrap(), vec![1]);
        pool.close().await;
    }

    #[tokio::test]
    async fn unreadable_database_is_not_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let contents = b"not a SQLite database";
        fs::write(&path, contents).unwrap();
        assert!(bootstrap(&path, &[schema(CURRENT)]).await.is_err());
        assert_eq!(fs::read(path).unwrap(), contents);
    }

    #[tokio::test]
    async fn connection_expiry_interrupts_manual_transactions() {
        let pool = sqlite_pool_options()
            .max_lifetime(Duration::from_millis(20))
            .idle_timeout(None)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("BEGIN IMMEDIATE").execute(&pool).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let error = sqlx::query("COMMIT").execute(&pool).await.unwrap_err();
        assert!(error.to_string().contains("no transaction is active"));
        pool.close().await;
    }

    #[tokio::test]
    async fn work_home_reads_committed_metadata_during_publication() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrated = bootstrap(&path, &[schema(CURRENT)]).await.unwrap();
        let mut migrated_connection = migrated.acquire().await.unwrap();
        sqlx::query("INSERT INTO sample VALUES (1)").execute(&mut *migrated_connection).await.unwrap();
        migrated_connection.close().await.unwrap();
        migrated.close().await;
        let (writer, reader) = open_sqlite_pools(&path).await.unwrap();
        let mut writer_connection = writer.acquire().await.unwrap();
        let mut reader_connection = reader.acquire().await.unwrap();
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *writer_connection).await.unwrap();
        sqlx::query("UPDATE sample SET value=2").execute(&mut *writer_connection).await.unwrap();
        let saved = tokio::time::timeout(Duration::from_secs(1),
            sqlx::query_scalar::<_, i64>("SELECT value FROM sample").fetch_one(&mut *reader_connection))
            .await.unwrap().unwrap();
        assert_eq!(saved, 1);
        sqlx::query("COMMIT").execute(&mut *writer_connection).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT value FROM sample").fetch_one(&mut *reader_connection).await.unwrap(), 2);
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *writer_connection).await.unwrap();
        sqlx::query("UPDATE sample SET value=3").execute(&mut *writer_connection).await.unwrap();
        sqlx::query("ROLLBACK").execute(&mut *writer_connection).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT value FROM sample").fetch_one(&mut *reader_connection).await.unwrap(), 2);
        assert!(sqlx::query("UPDATE sample SET value=4").execute(&mut *reader_connection).await.is_err());
        reader_connection.close().await.unwrap();
        writer_connection.close().await.unwrap();
        reader.close().await;
        writer.close().await;
        fs::remove_file(&path).unwrap();
    }

    #[tokio::test]
    async fn app_pool_preserves_transactions_between_ipc_calls() {
        let options = sqlite_pool_options();
        assert_eq!(options.get_max_lifetime(), None);
        assert_eq!(options.get_idle_timeout(), None);
        let pool = options.connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE sample (value INTEGER)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("BEGIN IMMEDIATE").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO sample VALUES (42)")
            .execute(&pool)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        sqlx::query("COMMIT").execute(&pool).await.unwrap();
        let value: i64 = sqlx::query_scalar("SELECT value FROM sample")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(value, 42);
        pool.close().await;
    }
}
