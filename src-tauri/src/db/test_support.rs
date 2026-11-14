use tempfile::TempDir;

use crate::database::{open_and_migrate_pools, AppDatabase};

pub struct TestDb {
    pub dir: TempDir,
    pub db: AppDatabase,
}

pub async fn open_test_db() -> TestDb {
    let dir = tempfile::tempdir().expect("create temp test db dir");
    let path = dir.path().join("norea.db");
    let db = open_and_migrate_pools(&path)
        .await
        .expect("open and migrate test db pools");
    TestDb { dir, db }
}
