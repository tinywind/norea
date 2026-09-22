//! Stable command payload and result contracts for media persistence.

#[derive(Debug, Clone)]
pub(crate) struct ChapterMediaClearContext {
    pub chapter_id: i64,
    pub novel_id: Option<i64>,
    pub source_id: Option<String>,
    pub novel_name: Option<String>,
    pub novel_path: Option<String>,
    pub chapter_number: Option<String>,
    pub chapter_name: Option<String>,
    pub chapter_position: Option<i64>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterContentInspection {
    pub(super) status: String,
    pub(super) content_file: Option<String>,
    pub(super) content_bytes: u64,
    pub(super) media_bytes: u64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelCoverReadResult {
    pub(super) manifest: String,
    pub(super) relative_path: String,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterStorageTransferEntry {
    pub entry_id: String,
    pub source_relative_dir: String,
    pub target_relative_dir: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChapterStorageTransferOutcome {
    CopiedSource,
    KeptTarget,
    SourceNotDownloaded,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterStorageTransferPreparedEntry {
    pub entry_id: String,
    pub source_relative_dir: String,
    pub target_relative_dir: String,
    pub outcome: ChapterStorageTransferOutcome,
    pub replaced_target: bool,
    pub content_file: Option<String>,
    pub content_bytes: u64,
    pub media_bytes: u64,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterStorageTransferPreparation {
    pub token: String,
    pub entries: Vec<ChapterStorageTransferPreparedEntry>,
}
