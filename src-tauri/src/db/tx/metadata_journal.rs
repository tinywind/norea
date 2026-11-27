//! Undo records for metadata files published before the SQLite commit.
//! All journal operations run under the database's BEGIN IMMEDIATE lock.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use crate::chapter_media::{
    read_work_metadata_bytes_at, remove_work_metadata_file_at, restore_work_metadata_bytes_at,
};

#[derive(Serialize, Deserialize)]
struct Record {
    root: PathBuf,
    relative: String,
    previous: Option<String>,
    intended: Option<String>,
}

pub(super) fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[derive(Debug)]
pub(super) struct MetadataJournal {
    directory: PathBuf,
    token: Option<String>,
    sequence: usize,
}

impl MetadataJournal {
    pub(super) fn new(database: &Path) -> Self {
        let mut name = database.as_os_str().to_owned();
        name.push(".metadata-undo");
        Self {
            directory: PathBuf::from(name),
            token: None,
            sequence: 0,
        }
    }

    pub(super) fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    pub(super) fn record(
        &mut self,
        root: &Path,
        relative: &str,
        previous: Option<&[u8]>,
        intended: Option<&[u8]>,
    ) -> Result<(), String> {
        let token = match &self.token {
            Some(token) => token,
            None => {
                let mut random = [0; 16];
                getrandom::fill(&mut random)
                    .map_err(|err| format!("metadata undo token: {err}"))?;
                let token = u128::from_be_bytes(random);
                let mut builder = fs::DirBuilder::new();
                #[cfg(unix)]
                std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
                builder
                    .create(&self.directory)
                    .map_err(|err| format!("create metadata undo directory: {err}"))?;
                self.token.insert(format!("{token:032x}"))
            }
        };
        let path = self
            .directory
            .join(format!("{token}-{:016x}", self.sequence));
        self.sequence += 1;
        let record = Record {
            root: root.to_owned(),
            relative: relative.to_owned(),
            previous: previous.map(digest),
            intended: intended.map(digest),
        };
        let header =
            serde_json::to_vec(&record).map_err(|err| format!("encode metadata undo: {err}"))?;
        let temporary = self.directory.join("pending");
        let mut file =
            fs::File::create(&temporary).map_err(|err| format!("create metadata undo: {err}"))?;
        file.write_all(&header)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.write_all(previous.unwrap_or_default()))
            .and_then(|_| file.sync_all())
            .map_err(|err| format!("write metadata undo: {err}"))?;
        drop(file);
        fs::rename(temporary, path).map_err(|err| format!("publish metadata undo: {err}"))
    }

    pub(super) async fn recover(&self, conn: &mut SqliteConnection) -> Result<(), String> {
        let entries = match fs::read_dir(&self.directory) {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(format!("open metadata undo: {err}")),
        };
        let committed: Option<String> =
            sqlx::query_scalar("SELECT token FROM work_metadata_commit WHERE id = 1")
                .fetch_optional(conn)
                .await
                .map_err(|err| format!("read metadata commit: {err}"))?;
        let mut records = entries
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("list metadata undo: {err}"))?;
        records.sort_unstable();
        for path in records.into_iter().rev() {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or("invalid metadata undo filename")?;
            if name != "pending" {
                let (token, sequence) = name
                    .split_once('-')
                    .ok_or("invalid metadata undo filename")?;
                if token.len() != 32
                    || sequence.len() != 16
                    || !token
                        .bytes()
                        .chain(sequence.bytes())
                        .all(|b| b.is_ascii_hexdigit())
                {
                    return Err("invalid metadata undo filename".into());
                }
                if Some(token) != committed.as_deref() {
                    restore(&path)?;
                }
            }
            fs::remove_file(&path).map_err(|err| format!("clear metadata undo: {err}"))?;
        }
        fs::remove_dir(&self.directory)
            .map_err(|err| format!("clear metadata undo directory: {err}"))
    }
}

fn restore(path: &Path) -> Result<(), String> {
    let data = fs::read(path).map_err(|err| format!("read metadata undo: {err}"))?;
    let split = data
        .iter()
        .position(|&b| b == b'\n')
        .ok_or("incomplete metadata undo header")?;
    let record: Record = serde_json::from_slice(&data[..split])
        .map_err(|err| format!("decode metadata undo: {err}"))?;
    let previous = &data[split + 1..];
    if record
        .previous
        .as_ref()
        .is_some_and(|hash| *hash != digest(previous))
        || (record.previous.is_none() && !previous.is_empty())
    {
        return Err("metadata undo checksum mismatch".into());
    }
    if !record.root.is_dir() {
        return Err(format!(
            "metadata undo needs storage folder '{}'",
            record.root.display()
        ));
    }
    let current = read_work_metadata_bytes_at(&record.root, &record.relative)?;
    let current_hash = current.as_deref().map(digest);
    if current_hash == record.previous {
        return Ok(());
    }
    if current_hash != record.intended {
        return Err(format!("work metadata: '{}' changed outside the transaction. Existing files and the recovery backup were retained.", record.relative));
    }
    match record.previous {
        Some(_) => restore_work_metadata_bytes_at(&record.root, &record.relative, previous),
        None => remove_work_metadata_file_at(&record.root, &record.relative),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chapter_media::write_work_metadata_bytes_at;
    use crate::database::open_and_migrate_pools;
    use crate::db::tx::{with_write_tx, TxOptions};
    use std::process::Command;

    const NOVEL: &str = "contents/demo/work/novel.json";
    const COVER: &str = "contents/demo/work/cover.png";
    const OVERRIDE: &str = "contents/demo/work/override.json";

    #[tokio::test]
    async fn interrupted_publication_recovers_on_open() {
        const CHILD_ROOT: &str = "NOREA_TEST_METADATA_CRASH_ROOT";
        if let Some(root) = std::env::var_os(CHILD_ROOT) {
            let root = PathBuf::from(root);
            let db = open_and_migrate_pools(&root.join("norea.db"))
                .await
                .unwrap();
            with_write_tx::<(), _>(db.writer(), TxOptions::default(), move |conn, ctx| {
                Box::pin(async move {
                    sqlx::query(
                        "INSERT INTO novel(plugin_id,path,name) VALUES('demo','/work','New')",
                    )
                    .execute(conn)
                    .await
                    .map_err(|err| err.to_string())?;
                    ctx.write_metadata_file(&root, NOVEL, b"1")?;
                    ctx.write_metadata_file(&root, NOVEL, b"2")?;
                    ctx.remove_metadata_file(&root, COVER)?;
                    ctx.write_metadata_file(&root, OVERRIDE, b"{}")?;
                    std::process::exit(86)
                })
            })
            .await
            .unwrap();
            unreachable!();
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let database = root.join("norea.db");
        fs::create_dir_all(root.join("contents/demo/work")).unwrap();
        fs::write(root.join(NOVEL), b"prior malformed JSON").unwrap();
        fs::write(root.join(COVER), b"cover").unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "db::tx::metadata_journal::tests::interrupted_publication_recovers_on_open",
            ])
            .env(CHILD_ROOT, root)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(86));
        assert_eq!(fs::read(root.join(NOVEL)).unwrap(), b"2");
        assert!(!root.join(COVER).exists());
        assert!(root.join(OVERRIDE).exists());

        fs::write(root.join(NOVEL), b"3").unwrap();
        assert!(open_and_migrate_pools(&database)
            .await
            .err()
            .unwrap()
            .contains("changed outside"));
        assert_eq!(fs::read(root.join(NOVEL)).unwrap(), b"3");
        fs::write(root.join(NOVEL), b"2").unwrap();
        let db = open_and_migrate_pools(&database).await.unwrap();
        assert_eq!(fs::read(root.join(NOVEL)).unwrap(), b"prior malformed JSON");
        assert_eq!(fs::read(root.join(COVER)).unwrap(), b"cover");
        assert!(!root.join(OVERRIDE).exists());
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM novel")
            .fetch_one(db.reader())
            .await
            .unwrap();
        assert_eq!(rows, 0);
        db.close().await;
        open_and_migrate_pools(&database)
            .await
            .unwrap()
            .close()
            .await;
    }

    #[tokio::test]
    async fn committed_publication_survives_interrupted_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let database = root.join("norea.db");
        let db = open_and_migrate_pools(&database).await.unwrap();
        let mut journal = MetadataJournal::new(&database);
        let mut tx = db.writer().begin_with("BEGIN IMMEDIATE").await.unwrap();
        journal.record(root, NOVEL, None, Some(b"1")).unwrap();
        write_work_metadata_bytes_at(root, NOVEL, b"1").unwrap();
        sqlx::query("INSERT INTO work_metadata_commit VALUES(1, ?1)")
            .bind(journal.token().unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        db.close().await;
        open_and_migrate_pools(&database)
            .await
            .unwrap()
            .close()
            .await;
        assert_eq!(fs::read(root.join(NOVEL)).unwrap(), b"1");
        assert!(!journal.directory.exists());
    }
}
