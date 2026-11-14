pub mod repository;
pub mod tx;

#[cfg(test)]
pub mod test_support;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReadMode {
    #[default]
    Queued,
    Committed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UserStateCommitPriority {
    Normal,
    Reading,
}

impl UserStateCommitPriority {
    pub fn merge(self, next: Self) -> Self {
        // Normal priority has a shorter debounce (1.5s) than reading progress (20s),
        // so normal wins when both occur inside the same transaction.
        match (self, next) {
            (Self::Normal, _) | (_, Self::Normal) => Self::Normal,
            (Self::Reading, Self::Reading) => Self::Reading,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkDirectoryUpdateDto {
    pub novel_id: i64,
    pub plugin_id: String,
    pub novel_path: String,
    pub directory: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterDirectoryUpdateDto {
    pub chapter_id: i64,
    pub directory: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbMutationEffects {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_state_priority: Option<UserStateCommitPriority>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub user_state_ledger_changed: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub user_state_deferred_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_sync_max_sequence: Option<i64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub work_metadata_changed: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cover_changed_novel_ids: Vec<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub work_directories: Vec<WorkDirectoryUpdateDto>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chapter_directories: Vec<ChapterDirectoryUpdateDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbMutationEnvelope<T> {
    pub value: T,
    pub effects: DbMutationEffects,
}
