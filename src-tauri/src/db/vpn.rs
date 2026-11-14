use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::Url;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use sqlx::{FromRow, QueryBuilder, Sqlite, SqliteConnection};
use tauri::State;

use crate::database::AppDatabase;
use crate::db::tx::{with_write_tx, TxOptions};
use crate::db::{DbMutationEnvelope, ReadMode};

const BYTES_PER_MIB: usize = 1024 * 1024;
const MAX_INLINE_IPC_BYTES: usize = 128 * BYTES_PER_MIB;
const MAX_CHAPTER_TITLE_BYTES: usize = 8 * 1024;
const MAX_CHAPTER_URL_BYTES: usize = 32 * 1024;
const MAX_ROUTE_QUERY_ROWS: usize = 500;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

fn vpn_tx_options() -> TxOptions {
    TxOptions {
        remote_content_sync: false,
        notify_content_sync: false,
        busy_begin_retries: 0,
        ..TxOptions::default()
    }
}

fn now_ms() -> Result<i64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("system clock before unix epoch: {err}"))?
        .as_millis();
    i64::try_from(millis).map_err(|_| "timestamp overflow".to_string())
}

fn assert_byte_budget(byte_len: usize, max_bytes: usize, label: &str) -> Result<(), String> {
    if byte_len > max_bytes {
        return Err(format!(
            "{label} is {byte_len} bytes, which exceeds the {max_bytes} byte limit."
        ));
    }
    Ok(())
}

fn serialize_checked<T: Serialize + ?Sized>(value: &T, label: &str) -> Result<String, String> {
    let payload =
        serde_json::to_string(value).map_err(|err| format!("serialize {label}: {err}"))?;
    assert_byte_budget(payload.len(), MAX_INLINE_IPC_BYTES, label)?;
    Ok(payload)
}

fn is_identity_str(value: &str) -> bool {
    !value.trim().is_empty()
}

fn as_identity_str(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| is_identity_str(text))
        .map(ToOwned::to_owned)
}

fn as_counter_i64(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(Value::as_i64)
        .filter(|&number| (0..=MAX_SAFE_INTEGER).contains(&number))
}

fn as_chapter_id_i64(value: Option<&Value>) -> Option<i64> {
    as_counter_i64(value).filter(|&number| number > 0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VpnGateServerVerdictValueDto {
    Works,
    Fails,
}

impl TryFrom<&str> for VpnGateServerVerdictValueDto {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "works" => Ok(Self::Works),
            "fails" => Ok(Self::Fails),
            other => Err(format!("Invalid VPN Gate server verdict '{other}'.")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VpnGateServerVerdictDto {
    pub ip: String,
    pub verdict: VpnGateServerVerdictValueDto,
    pub updated_at: i64,
}

#[derive(Debug, FromRow)]
struct RawVpnGateServerVerdictRow {
    ip: String,
    verdict: String,
    updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VpnDownloadModeDto {
    Single,
    Parallel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VpnDownloadChallengePolicyDto {
    Pause,
    NextProfile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VpnDownloadPoliciesDto {
    pub captcha: VpnDownloadChallengePolicyDto,
    pub cloudflare: VpnDownloadChallengePolicyDto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VpnDownloadRangePhaseDto {
    Paused,
    Connecting,
    Running,
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceAccessChallengeKindDto {
    Captcha,
    Cloudflare,
    Forbidden,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceAccessChallengeDto {
    pub kind: SourceAccessChallengeKindDto,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VpnDownloadRangeStateDto {
    pub id: String,
    pub profile_id: Option<String>,
    pub profile_hash: Option<String>,
    pub chapter_ids: Vec<i64>,
    pub selected_chapter_ids: Vec<i64>,
    pub start_chapter_id: i64,
    pub end_chapter_id: i64,
    pub checkpoint: i64,
    pub phase: VpnDownloadRangePhaseDto,
    pub user_paused: bool,
    pub pause_reason: Option<String>,
    pub attempted_profile_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consumed_reallow_revisions: Option<BTreeMap<String, i64>>,
    pub attempt_profile_id: Option<String>,
    pub generation: i64,
    pub challenge: Option<SourceAccessChallengeDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VpnDownloadPlanDto {
    pub id: String,
    pub batch_id: String,
    pub plugin_id: String,
    pub novel_id: i64,
    pub title: String,
    pub mode: VpnDownloadModeDto,
    pub policies: VpnDownloadPoliciesDto,
    pub created_at: i64,
    pub revision: i64,
    pub ranges: Vec<VpnDownloadRangeStateDto>,
}

impl<'de> Deserialize<'de> for VpnDownloadPlanDto {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        parse_plan_value(&value).map_err(serde::de::Error::custom)
    }
}

fn parse_policy(value: Option<&Value>) -> Option<VpnDownloadChallengePolicyDto> {
    match value.and_then(Value::as_str)? {
        "pause" => Some(VpnDownloadChallengePolicyDto::Pause),
        "nextProfile" => Some(VpnDownloadChallengePolicyDto::NextProfile),
        _ => None,
    }
}

fn parse_mode(value: Option<&Value>) -> Option<VpnDownloadModeDto> {
    match value.and_then(Value::as_str)? {
        "single" => Some(VpnDownloadModeDto::Single),
        "parallel" => Some(VpnDownloadModeDto::Parallel),
        _ => None,
    }
}

fn parse_phase(value: Option<&Value>) -> Option<VpnDownloadRangePhaseDto> {
    match value.and_then(Value::as_str)? {
        "paused" => Some(VpnDownloadRangePhaseDto::Paused),
        "connecting" => Some(VpnDownloadRangePhaseDto::Connecting),
        "running" => Some(VpnDownloadRangePhaseDto::Running),
        "completed" => Some(VpnDownloadRangePhaseDto::Completed),
        "cancelled" => Some(VpnDownloadRangePhaseDto::Cancelled),
        _ => None,
    }
}

fn parse_plan_value(value: &Value) -> Result<VpnDownloadPlanDto, String> {
    let invalid_plan = || "Invalid VPN download plan identity, policies or ranges.".to_string();
    let Some(obj) = value.as_object() else {
        return Err(invalid_plan());
    };
    let Some(id) = as_identity_str(obj.get("id")) else {
        return Err(invalid_plan());
    };
    let Some(batch_id) = as_identity_str(obj.get("batchId")) else {
        return Err(invalid_plan());
    };
    let Some(plugin_id) = as_identity_str(obj.get("pluginId")) else {
        return Err(invalid_plan());
    };
    let Some(novel_id) = as_chapter_id_i64(obj.get("novelId")) else {
        return Err(invalid_plan());
    };
    let Some(title) = as_identity_str(obj.get("title")) else {
        return Err(invalid_plan());
    };
    let Some(mode) = parse_mode(obj.get("mode")) else {
        return Err(invalid_plan());
    };
    let Some(created_at) = as_counter_i64(obj.get("createdAt")) else {
        return Err(invalid_plan());
    };
    let Some(revision) = as_counter_i64(obj.get("revision")) else {
        return Err(invalid_plan());
    };
    let Some(policies_obj) = obj.get("policies").and_then(Value::as_object) else {
        return Err(invalid_plan());
    };
    let Some(captcha) = parse_policy(policies_obj.get("captcha")) else {
        return Err(invalid_plan());
    };
    let Some(cloudflare) = parse_policy(policies_obj.get("cloudflare")) else {
        return Err(invalid_plan());
    };
    let Some(raw_ranges) = obj.get("ranges").and_then(Value::as_array) else {
        return Err(invalid_plan());
    };
    if raw_ranges.is_empty() {
        return Err(invalid_plan());
    }

    let invalid_range = || "Invalid VPN download range state.".to_string();
    let mut range_ids = HashSet::with_capacity(raw_ranges.len());
    let mut chapter_ids_seen = HashSet::new();
    let mut selected_count: usize = 0;
    let mut ranges = Vec::with_capacity(raw_ranges.len());

    for raw_range in raw_ranges {
        let Some(range_obj) = raw_range.as_object() else {
            return Err(invalid_range());
        };
        let Some(range_id) = as_identity_str(range_obj.get("id")) else {
            return Err(invalid_range());
        };
        let (profile_id, profile_hash) = match (range_obj.get("profileId"), range_obj.get("profileHash")) {
            (Some(Value::Null), Some(Value::Null)) => (None, None),
            (Some(pid), Some(phash)) => {
                let Some(pid_str) = as_identity_str(Some(pid)) else {
                    return Err(invalid_range());
                };
                let Some(phash_str) = as_identity_str(Some(phash)) else {
                    return Err(invalid_range());
                };
                (Some(pid_str), Some(phash_str))
            }
            _ => return Err(invalid_range()),
        };
        let Some(checkpoint) = as_counter_i64(range_obj.get("checkpoint")) else {
            return Err(invalid_range());
        };
        let Some(generation) = as_counter_i64(range_obj.get("generation")) else {
            return Err(invalid_range());
        };
        let Some(user_paused) = range_obj.get("userPaused").and_then(Value::as_bool) else {
            return Err(invalid_range());
        };
        let pause_reason = match range_obj.get("pauseReason") {
            Some(Value::Null) => None,
            Some(Value::String(reason)) => Some(reason.clone()),
            _ => return Err(invalid_range()),
        };
        let Some(phase) = parse_phase(range_obj.get("phase")) else {
            return Err(invalid_range());
        };
        let Some(raw_chapter_ids) = range_obj.get("chapterIds").and_then(Value::as_array) else {
            return Err(invalid_range());
        };
        if raw_chapter_ids.is_empty() {
            return Err(invalid_range());
        }
        let mut chapter_ids = Vec::with_capacity(raw_chapter_ids.len());
        for raw_cid in raw_chapter_ids {
            let Some(cid) = as_chapter_id_i64(Some(raw_cid)) else {
                return Err(invalid_range());
            };
            chapter_ids.push(cid);
        }

        let Some(raw_selected_ids) = range_obj.get("selectedChapterIds").and_then(Value::as_array) else {
            return Err(invalid_range());
        };
        let mut selected_chapter_ids = Vec::with_capacity(raw_selected_ids.len());
        for raw_cid in raw_selected_ids {
            let Some(cid) = as_chapter_id_i64(Some(raw_cid)) else {
                return Err(invalid_range());
            };
            selected_chapter_ids.push(cid);
        }

        let Some(raw_attempted) = range_obj.get("attemptedProfileIds").and_then(Value::as_array) else {
            return Err(invalid_range());
        };
        let mut attempted_profile_ids = Vec::with_capacity(raw_attempted.len());
        let mut attempted_seen = HashSet::with_capacity(raw_attempted.len());
        for raw_pid in raw_attempted {
            let Some(pid) = as_identity_str(Some(raw_pid)) else {
                return Err(invalid_range());
            };
            if !attempted_seen.insert(pid.clone()) {
                return Err(invalid_range());
            }
            attempted_profile_ids.push(pid);
        }

        let attempt_profile_id = match range_obj.get("attemptProfileId") {
            Some(Value::Null) => None,
            Some(raw_attempt) => {
                let Some(attempt_str) = as_identity_str(Some(raw_attempt)) else {
                    return Err(invalid_range());
                };
                Some(attempt_str)
            }
            None => return Err(invalid_range()),
        };

        let consumed_reallow_revisions = match range_obj.get("consumedReallowRevisions") {
            None => None,
            Some(Value::Object(revs_map)) => {
                let mut parsed = BTreeMap::new();
                for (profile_key, rev_val) in revs_map {
                    if !is_identity_str(profile_key) {
                        return Err("Invalid VPN download reallow revisions.".to_string());
                    }
                    let Some(rev) = as_counter_i64(Some(rev_val)) else {
                        return Err("Invalid VPN download reallow revisions.".to_string());
                    };
                    parsed.insert(profile_key.clone(), rev);
                }
                Some(parsed)
            }
            Some(_) => return Err("Invalid VPN download reallow revisions.".to_string()),
        };

        if !range_ids.insert(range_id.clone()) {
            return Err("VPN download range IDs must be distinct.".to_string());
        }
        for &cid in &chapter_ids {
            if !chapter_ids_seen.insert(cid) {
                return Err("VPN download ranges overlap or repeat a chapter.".to_string());
            }
        }

        let selected_set: HashSet<i64> = selected_chapter_ids.iter().copied().collect();
        selected_count = selected_count.saturating_add(selected_chapter_ids.len());
        let filtered_selected: Vec<i64> = chapter_ids
            .iter()
            .copied()
            .filter(|cid| selected_set.contains(cid))
            .collect();
        let start_chapter_id = as_chapter_id_i64(range_obj.get("startChapterId"));
        let end_chapter_id = as_chapter_id_i64(range_obj.get("endChapterId"));
        let checkpoint_usize = usize::try_from(checkpoint).unwrap_or(usize::MAX);

        if start_chapter_id != chapter_ids.first().copied()
            || end_chapter_id != chapter_ids.last().copied()
            || selected_chapter_ids != filtered_selected
            || checkpoint_usize > selected_chapter_ids.len()
            || (phase == VpnDownloadRangePhaseDto::Completed
                && checkpoint_usize != selected_chapter_ids.len())
        {
            return Err(
                "Invalid VPN download range boundaries, selection order or checkpoint.".to_string(),
            );
        }

        let challenge = match range_obj.get("challenge") {
            Some(Value::Null) => None,
            Some(Value::Object(ch_obj)) => {
                let kind = match ch_obj.get("kind").and_then(Value::as_str) {
                    Some("captcha") => SourceAccessChallengeKindDto::Captcha,
                    Some("cloudflare") => SourceAccessChallengeKindDto::Cloudflare,
                    Some("forbidden") => SourceAccessChallengeKindDto::Forbidden,
                    _ => return Err("Invalid VPN download source challenge.".to_string()),
                };
                let Some(url_str) = ch_obj.get("url").and_then(Value::as_str) else {
                    return Err("Invalid VPN download source challenge.".to_string());
                };
                let parsed_url = Url::parse(url_str)
                    .map_err(|err| format!("Invalid VPN download source challenge URL: {err}"))?;
                if (parsed_url.scheme() != "http" && parsed_url.scheme() != "https")
                    || !parsed_url.username().is_empty()
                    || parsed_url.password().is_some()
                {
                    return Err("Invalid VPN download source challenge URL.".to_string());
                }
                Some(SourceAccessChallengeDto {
                    kind,
                    url: url_str.to_string(),
                })
            }
            _ => return Err("Invalid VPN download source challenge.".to_string()),
        };

        ranges.push(VpnDownloadRangeStateDto {
            id: range_id,
            profile_id,
            profile_hash,
            start_chapter_id: start_chapter_id.expect("validated startChapterId"),
            end_chapter_id: end_chapter_id.expect("validated endChapterId"),
            chapter_ids,
            selected_chapter_ids,
            checkpoint,
            phase,
            user_paused,
            pause_reason,
            attempted_profile_ids,
            consumed_reallow_revisions,
            attempt_profile_id,
            generation,
            challenge,
        });
    }

    if selected_count == 0 {
        return Err("A VPN download plan requires at least one selected chapter.".to_string());
    }

    Ok(VpnDownloadPlanDto {
        id,
        batch_id,
        plugin_id,
        novel_id,
        title,
        mode,
        policies: VpnDownloadPoliciesDto {
            captcha,
            cloudflare,
        },
        created_at,
        revision,
        ranges,
    })
}

#[derive(Debug, FromRow)]
struct RawPlanRow {
    id: String,
    payload: String,
    revision: i64,
}

fn parse_stored_plan(row: &RawPlanRow) -> Result<VpnDownloadPlanDto, String> {
    let parsed: Result<VpnDownloadPlanDto, String> = (|| {
        let value: Value = serde_json::from_str(&row.payload).map_err(|err| err.to_string())?;
        let plan = parse_plan_value(&value)?;
        if plan.id != row.id || plan.revision != row.revision {
            return Err("Payload identity or revision differs from its row.".to_string());
        }
        Ok(plan)
    })();
    parsed.map_err(|err| format!("Invalid stored VPN download plan {}: {err}", row.id))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChapterDownloadJobDto(Map<String, Value>);

impl Serialize for ChapterDownloadJobDto {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ChapterDownloadJobDto {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        parse_job_value(&value).map_err(serde::de::Error::custom)
    }
}

impl ChapterDownloadJobDto {
    pub fn id(&self) -> i64 {
        self.0
            .get("id")
            .and_then(Value::as_i64)
            .expect("validated chapter job id")
    }

    pub fn plugin_id(&self) -> &str {
        self.0
            .get("pluginId")
            .and_then(Value::as_str)
            .expect("validated chapter job pluginId")
    }

    pub fn novel_id(&self) -> Option<i64> {
        match self.0.get("novelId") {
            None | Some(Value::Null) => None,
            Some(value) => value.as_i64(),
        }
    }

    pub fn chapter_path(&self) -> &str {
        self.0
            .get("chapterPath")
            .and_then(Value::as_str)
            .expect("validated chapter job chapterPath")
    }

    pub fn novel_path(&self) -> Option<&str> {
        self.field_str_or_null("novelPath")
    }

    pub fn batch_id(&self) -> Option<&str> {
        self.field_str_or_null("batchId")
    }

    pub fn vpn_batch_id(&self) -> Option<&str> {
        self.field_str_or_null("vpnBatchId")
    }

    pub fn vpn_plan_id(&self) -> Option<&str> {
        self.field_str_or_null("vpnPlanId")
    }

    pub fn vpn_range_id(&self) -> Option<&str> {
        self.field_str_or_null("vpnRangeId")
    }

    fn field_str_or_null(&self, key: &str) -> Option<&str> {
        match self.0.get(key) {
            None | Some(Value::Null) => None,
            Some(value) => value.as_str(),
        }
    }
}

const STRING_JOB_FIELDS: [&str; 10] = [
    "batchId",
    "batchTitle",
    "pluginName",
    "chapterName",
    "chapterNumber",
    "novelName",
    "novelPath",
    "vpnBatchId",
    "vpnPlanId",
    "vpnRangeId",
];

const ENROLLMENT_CONTRACT_FIELDS: [&str; 8] = [
    "pluginName",
    "chapterName",
    "chapterNumber",
    "contentType",
    "novelName",
    "novelPath",
    "priority",
    "title",
];

pub fn parse_job_value(value: &Value) -> Result<ChapterDownloadJobDto, String> {
    let invalid_payload = || "Invalid VPN download queue payload.".to_string();
    let Some(obj) = value.as_object() else {
        return Err(invalid_payload());
    };
    if as_chapter_id_i64(obj.get("id")).is_none()
        || as_identity_str(obj.get("pluginId")).is_none()
        || as_identity_str(obj.get("chapterPath")).is_none()
        || as_identity_str(obj.get("title")).is_none()
    {
        return Err(invalid_payload());
    }
    match obj.get("novelId") {
        None | Some(Value::Null) => {}
        Some(raw_novel_id) if as_chapter_id_i64(Some(raw_novel_id)).is_some() => {}
        Some(_) => return Err(invalid_payload()),
    }
    if let Some(paused_val) = obj.get("vpnWorkPaused") {
        if !paused_val.is_boolean() {
            return Err("Invalid pending VPN work pause.".to_string());
        }
    }
    for key in STRING_JOB_FIELDS {
        match obj.get(key) {
            None | Some(Value::Null) | Some(Value::String(_)) => {}
            Some(_) => return Err(format!("Invalid download queue payload field {key}.")),
        }
    }
    match obj.get("vpnBatchId") {
        None | Some(Value::Null) => {}
        Some(Value::String(batch_id)) if is_identity_str(batch_id) => {}
        Some(_) => return Err("Invalid pending VPN batch ownership.".to_string()),
    }
    match obj.get("priority") {
        None | Some(Value::Null) => {}
        Some(Value::String(priority))
            if matches!(
                priority.as_str(),
                "interactive" | "user" | "normal" | "deferred" | "background"
            ) => {}
        Some(_) => return Err("Invalid download queue priority.".to_string()),
    }
    match obj.get("contentType") {
        None | Some(Value::Null) => {}
        Some(Value::String(content_type))
            if matches!(
                content_type.as_str(),
                "html" | "text" | "markdown" | "pdf" | "epub"
            ) => {}
        Some(_) => return Err("Invalid download queue content type.".to_string()),
    }

    let chapter_path = obj
        .get("chapterPath")
        .and_then(Value::as_str)
        .expect("checked chapterPath");
    let title = obj
        .get("title")
        .and_then(Value::as_str)
        .expect("checked title");
    assert_byte_budget(chapter_path.len(), MAX_CHAPTER_URL_BYTES, "Chapter path")?;
    assert_byte_budget(title.len(), MAX_CHAPTER_TITLE_BYTES, "Chapter title")?;

    Ok(ChapterDownloadJobDto(obj.clone()))
}

#[derive(Debug, FromRow)]
struct RawQueueRow {
    chapter_id: i64,
    job_json: String,
}

pub fn parse_stored_chapter_download_job(
    chapter_id: i64,
    job_json: &str,
) -> Result<ChapterDownloadJobDto, String> {
    let parsed: Result<ChapterDownloadJobDto, String> = (|| {
        let value: Value = serde_json::from_str(job_json).map_err(|err| err.to_string())?;
        let job = parse_job_value(&value)?;
        if job.id() != chapter_id {
            return Err("Queue chapter identity differs from its payload.".to_string());
        }
        Ok(job)
    })();
    parsed.map_err(|err| format!("Invalid stored download queue chapter {chapter_id}: {err}"))
}

fn assert_job_owner(
    job: &ChapterDownloadJobDto,
    plan: &VpnDownloadPlanDto,
    range: &VpnDownloadRangeStateDto,
) -> Result<(), String> {
    if job.vpn_plan_id() != Some(plan.id.as_str())
        || job.vpn_range_id() != Some(range.id.as_str())
        || job.vpn_batch_id().is_some_and(|batch| batch != plan.batch_id)
        || job.plugin_id() != plan.plugin_id
        || job.novel_id() != Some(plan.novel_id)
    {
        return Err(format!(
            "Download queue chapter {} ownership differs from its enrolled VPN range.",
            job.id()
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum VpnDownloadProfileIssueCauseDto {
    #[serde(rename = "captcha")]
    Captcha,
    #[serde(rename = "cloudflare")]
    Cloudflare,
    #[serde(rename = "connection-failed")]
    ConnectionFailed,
    #[serde(rename = "authentication-required")]
    AuthenticationRequired,
    #[serde(rename = "tunnel-lost")]
    TunnelLost,
}

impl VpnDownloadProfileIssueCauseDto {
    fn as_str(self) -> &'static str {
        match self {
            Self::Captcha => "captcha",
            Self::Cloudflare => "cloudflare",
            Self::ConnectionFailed => "connection-failed",
            Self::AuthenticationRequired => "authentication-required",
            Self::TunnelLost => "tunnel-lost",
        }
    }
}

impl TryFrom<&str> for VpnDownloadProfileIssueCauseDto {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "captcha" => Ok(Self::Captcha),
            "cloudflare" => Ok(Self::Cloudflare),
            "connection-failed" => Ok(Self::ConnectionFailed),
            "authentication-required" => Ok(Self::AuthenticationRequired),
            "tunnel-lost" => Ok(Self::TunnelLost),
            other => Err(format!("Invalid VPN profile issue cause '{other}'.")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VpnDownloadProfileIssueDto {
    pub batch_id: String,
    pub ip: String,
    pub profile_id: String,
    pub profile_hash: String,
    pub plan_id: String,
    pub range_id: String,
    pub generation: i64,
    pub cause: VpnDownloadProfileIssueCauseDto,
    pub recorded_at: i64,
    pub excluded: bool,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VpnDownloadProfileIssueInput {
    pub batch_id: String,
    pub ip: String,
    pub profile_id: String,
    pub profile_hash: String,
    pub plan_id: String,
    pub range_id: String,
    pub generation: i64,
    pub cause: VpnDownloadProfileIssueCauseDto,
}

#[derive(Debug, FromRow)]
struct RawProfileIssueRow {
    batch_id: String,
    ip: String,
    profile_id: String,
    profile_hash: String,
    plan_id: String,
    range_id: String,
    generation: i64,
    cause: String,
    recorded_at: i64,
    excluded: i64,
    revision: i64,
}

impl TryFrom<RawProfileIssueRow> for VpnDownloadProfileIssueDto {
    type Error = String;

    fn try_from(row: RawProfileIssueRow) -> Result<Self, Self::Error> {
        Ok(Self {
            batch_id: row.batch_id,
            ip: row.ip,
            profile_id: row.profile_id,
            profile_hash: row.profile_hash,
            plan_id: row.plan_id,
            range_id: row.range_id,
            generation: row.generation,
            cause: VpnDownloadProfileIssueCauseDto::try_from(row.cause.as_str())?,
            recorded_at: row.recorded_at,
            excluded: row.excluded == 1,
            revision: row.revision,
        })
    }
}

#[derive(Debug, Clone, Copy, FromRow)]
struct CatalogRow {
    id: i64,
    position: i64,
}

#[derive(Debug, FromRow)]
struct CatalogPathRow {
    id: i64,
    path: String,
    position: i64,
}

async fn read_plan_in_conn(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<VpnDownloadPlanDto>, String> {
    let row = sqlx::query_as::<_, RawPlanRow>(
        "SELECT id, payload, revision FROM vpn_download_plan WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(|err| format!("db_vpn_plan_read: {err}"))?;
    row.as_ref().map(parse_stored_plan).transpose()
}

async fn require_plan_in_conn(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<VpnDownloadPlanDto, String> {
    read_plan_in_conn(conn, id)
        .await?
        .ok_or_else(|| format!("VPN download plan {id} not found."))
}

fn find_range_index(plan: &VpnDownloadPlanDto, range_id: &str) -> Result<usize, String> {
    plan.ranges
        .iter()
        .position(|range| range.id == range_id)
        .ok_or_else(|| format!("VPN download range {range_id} not found in plan {}.", plan.id))
}

async fn read_queue_in_conn(
    conn: &mut SqliteConnection,
    ids: &[i64],
) -> Result<Vec<RawQueueRow>, String> {
    let mut rows = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(MAX_ROUTE_QUERY_ROWS) {
        let mut builder = QueryBuilder::<Sqlite>::new(
            "SELECT chapter_id, job_json FROM chapter_download_queue WHERE chapter_id IN (",
        );
        let mut separated = builder.separated(",");
        for &id in chunk {
            separated.push_bind(id);
        }
        separated.push_unseparated(")");
        let part = builder
            .build_query_as::<RawQueueRow>()
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("read chapter_download_queue: {err}"))?;
        rows.extend(part);
    }
    Ok(rows)
}

async fn publication_catalog(
    conn: &mut SqliteConnection,
    plan: &VpnDownloadPlanDto,
) -> Result<(String, HashMap<i64, CatalogPathRow>), String> {
    let novel_path = sqlx::query_scalar::<_, String>(
        "SELECT path FROM novel WHERE id = ?1 AND plugin_id = ?2 AND is_local = 0",
    )
    .bind(plan.novel_id)
    .bind(&plan.plugin_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("read source novel: {err}"))?
    .ok_or_else(|| {
        "VPN download source/work identity does not match an existing source novel.".to_string()
    })?;

    let all_ids: Vec<i64> = plan
        .ranges
        .iter()
        .flat_map(|range| range.chapter_ids.iter().copied())
        .collect();
    let mut chapters = HashMap::with_capacity(all_ids.len());
    let chunk_size = MAX_ROUTE_QUERY_ROWS - 1;
    for chunk in all_ids.chunks(chunk_size) {
        let mut builder = QueryBuilder::<Sqlite>::new(
            "SELECT id, path, position FROM chapter WHERE novel_id = ",
        );
        builder.push_bind(plan.novel_id);
        builder.push(" AND id IN (");
        let mut separated = builder.separated(",");
        for &id in chunk {
            separated.push_bind(id);
        }
        separated.push_unseparated(")");
        let rows = builder
            .build_query_as::<CatalogPathRow>()
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("read catalog chapters: {err}"))?;
        for row in rows {
            chapters.insert(row.id, row);
        }
    }
    if chapters.len() != all_ids.len() {
        return Err("VPN range contains a missing chapter or another work's chapter.".to_string());
    }

    let mut previous_end: Option<CatalogRow> = None;
    for range in &plan.ranges {
        let start_entry = &chapters[&range.start_chapter_id];
        let end_entry = &chapters[&range.end_chapter_id];
        let start = CatalogRow {
            id: start_entry.id,
            position: start_entry.position,
        };
        let end = CatalogRow {
            id: end_entry.id,
            position: end_entry.position,
        };
        if let Some(prev) = previous_end {
            if prev.position > start.position
                || (prev.position == start.position && prev.id >= start.id)
            {
                return Err("VPN ranges are not in canonical catalog order.".to_string());
            }
        }

        let mut cursor = CatalogRow {
            position: start.position,
            id: start.id - 1,
        };
        let mut index = 0_usize;
        loop {
            let rows = sqlx::query_as::<_, CatalogRow>(
                "SELECT id, position FROM chapter
                 WHERE novel_id = ?1
                   AND (position, id) >= (?2, ?3)
                   AND (position, id) <= (?4, ?5)
                   AND (position, id) > (?6, ?7)
                 ORDER BY position, id
                 LIMIT ?8",
            )
            .bind(plan.novel_id)
            .bind(start.position)
            .bind(start.id)
            .bind(end.position)
            .bind(end.id)
            .bind(cursor.position)
            .bind(cursor.id)
            .bind(i64::try_from(MAX_ROUTE_QUERY_ROWS).expect("limit fits i64"))
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("verify canonical catalog range: {err}"))?;

            for row in &rows {
                if range.chapter_ids.get(index) != Some(&row.id) {
                    return Err(
                        "VPN range must preserve the full contiguous canonical catalog."
                            .to_string(),
                    );
                }
                index += 1;
            }
            if rows.len() < MAX_ROUTE_QUERY_ROWS {
                break;
            }
            cursor = *rows.last().expect("non-empty chunk");
        }
        if index != range.chapter_ids.len() {
            return Err("VPN range is reversed or missing canonical chapters.".to_string());
        }
        previous_end = Some(end);
    }

    Ok((novel_path, chapters))
}

async fn write_plan_in_conn(
    conn: &mut SqliteConnection,
    mut plan: VpnDownloadPlanDto,
    expected_revision: i64,
) -> Result<VpnDownloadPlanDto, String> {
    plan.revision = expected_revision
        .checked_add(1)
        .ok_or_else(|| "VPN download plan revision overflow.".to_string())?;
    let serialized = serialize_checked(&plan, "VPN download plan")?;
    // Re-validate serialized form identically to JS assertPlan.
    let validated = parse_stored_plan(&RawPlanRow {
        id: plan.id.clone(),
        payload: serialized.clone(),
        revision: plan.revision,
    })?;
    let result = sqlx::query(
        "UPDATE vpn_download_plan SET payload = ?1, revision = ?2 WHERE id = ?3 AND revision = ?4",
    )
    .bind(&serialized)
    .bind(validated.revision)
    .bind(&validated.id)
    .bind(expected_revision)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("update vpn_download_plan: {err}"))?;

    if result.rows_affected() != 1 {
        return Err(format!(
            "VPN download plan {} has a stale revision or is missing.",
            validated.id
        ));
    }
    Ok(validated)
}

async fn remove_owned_jobs_in_conn(
    conn: &mut SqliteConnection,
    plan: &VpnDownloadPlanDto,
    ranges: &[VpnDownloadRangeStateDto],
) -> Result<(), String> {
    let mut owners: HashMap<i64, &VpnDownloadRangeStateDto> = HashMap::new();
    let mut candidate_ids = Vec::new();
    for range in ranges {
        for &cid in &range.selected_chapter_ids {
            owners.insert(cid, range);
            candidate_ids.push(cid);
        }
    }
    let rows = read_queue_in_conn(conn, &candidate_ids).await?;
    let mut owned_ids = Vec::new();
    for row in rows {
        let job = parse_stored_chapter_download_job(row.chapter_id, &row.job_json)?;
        let range = owners[&row.chapter_id];
        if job.vpn_plan_id() != Some(plan.id.as_str())
            || job.vpn_range_id() != Some(range.id.as_str())
        {
            continue;
        }
        assert_job_owner(&job, plan, range)?;
        owned_ids.push(row.chapter_id);
    }
    for chunk in owned_ids.chunks(MAX_ROUTE_QUERY_ROWS) {
        let mut builder = QueryBuilder::<Sqlite>::new(
            "DELETE FROM chapter_download_queue WHERE chapter_id IN (",
        );
        let mut separated = builder.separated(",");
        for &id in chunk {
            separated.push_bind(id);
        }
        separated.push_unseparated(")");
        builder
            .build()
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("delete owned chapter_download_queue rows: {err}"))?;
    }
    Ok(())
}

pub async fn list_vpn_gate_server_verdicts(
    db: &AppDatabase,
    read_mode: ReadMode,
) -> Result<Vec<VpnGateServerVerdictDto>, String> {
    let rows = sqlx::query_as::<_, RawVpnGateServerVerdictRow>(
        "SELECT ip, verdict, updated_at FROM vpn_gate_server_verdict ORDER BY ip",
    )
    .fetch_all(db.pool_for(read_mode))
    .await
    .map_err(|err| format!("db_vpn_list_verdicts: {err}"))?;

    rows.into_iter()
        .map(|row| {
            Ok(VpnGateServerVerdictDto {
                ip: row.ip,
                verdict: VpnGateServerVerdictValueDto::try_from(row.verdict.as_str())?,
                updated_at: row.updated_at,
            })
        })
        .collect()
}

pub async fn read_vpn_download_plan(
    db: &AppDatabase,
    id: &str,
    read_mode: ReadMode,
) -> Result<Option<VpnDownloadPlanDto>, String> {
    let row = sqlx::query_as::<_, RawPlanRow>(
        "SELECT id, payload, revision FROM vpn_download_plan WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(db.pool_for(read_mode))
    .await
    .map_err(|err| format!("db_vpn_plan_read: {err}"))?;
    row.as_ref().map(parse_stored_plan).transpose()
}

pub async fn list_vpn_download_plans(
    db: &AppDatabase,
    read_mode: ReadMode,
) -> Result<Vec<VpnDownloadPlanDto>, String> {
    let rows = sqlx::query_as::<_, RawPlanRow>(
        "SELECT id, payload, revision FROM vpn_download_plan ORDER BY id",
    )
    .fetch_all(db.pool_for(read_mode))
    .await
    .map_err(|err| format!("db_vpn_plan_list: {err}"))?;
    rows.iter().map(parse_stored_plan).collect()
}

pub async fn create_vpn_download_plan(
    db: &AppDatabase,
    plan: VpnDownloadPlanDto,
    jobs: Vec<ChapterDownloadJobDto>,
) -> Result<DbMutationEnvelope<()>, String> {
    let plan_payload = serialize_checked(&plan, "VPN download plan")?;
    if plan.revision != 0 {
        return Err("A new VPN download plan must start at revision zero.".to_string());
    }
    let _ = serialize_checked(&jobs, "VPN download jobs")?;

    let mut enrolled: HashMap<i64, &VpnDownloadRangeStateDto> = HashMap::new();
    for range in &plan.ranges {
        if range.phase == VpnDownloadRangePhaseDto::Cancelled {
            continue;
        }
        let checkpoint = usize::try_from(range.checkpoint).expect("validated non-negative");
        for &cid in &range.selected_chapter_ids[checkpoint..] {
            enrolled.insert(cid, range);
        }
    }
    if jobs.len() != enrolled.len() {
        return Err("VPN jobs must cover exactly the unfinished selected chapters.".to_string());
    }
    let mut queued = HashSet::with_capacity(jobs.len());
    for job in &jobs {
        let Some(range) = enrolled.get(&job.id()) else {
            return Err("VPN jobs contain an unselected or duplicate chapter.".to_string());
        };
        if !queued.insert(job.id()) {
            return Err("VPN jobs contain an unselected or duplicate chapter.".to_string());
        }
        assert_job_owner(job, &plan, range)?;
        if job.batch_id() != Some(plan.batch_id.as_str()) {
            return Err("VPN download job belongs to another batch.".to_string());
        }
    }

    with_write_tx(db.writer(), vpn_tx_options(), move |conn, _ctx| {
        Box::pin(async move {
            let (novel_path, chapters) = publication_catalog(conn, &plan).await?;
            for job in &jobs {
                let catalog_chapter = &chapters[&job.id()];
                if job.chapter_path() != catalog_chapter.path
                    || job.novel_path().is_some_and(|path| path != novel_path)
                {
                    return Err(format!(
                        "VPN download chapter {} source/work path does not match its catalog.",
                        job.id()
                    ));
                }
            }

            sqlx::query(
                "INSERT INTO vpn_download_plan (id, payload, revision) VALUES (?1, ?2, ?3)",
            )
            .bind(&plan.id)
            .bind(&plan_payload)
            .bind(plan.revision)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("insert vpn_download_plan: {err}"))?;

            let now = now_ms()?;
            let job_ids: Vec<i64> = jobs.iter().map(ChapterDownloadJobDto::id).collect();
            let existing: HashMap<i64, RawQueueRow> = read_queue_in_conn(conn, &job_ids)
                .await?
                .into_iter()
                .map(|row| (row.chapter_id, row))
                .collect();

            let mut fresh_jobs: Vec<(i64, String)> = Vec::new();
            for job in &jobs {
                let serialized_job = serialize_checked(job, "VPN download queue job")?;
                let existing_row = existing.get(&job.id());
                if job.vpn_batch_id().is_none() {
                    if existing_row.is_some() {
                        return Err(format!(
                            "Queued chapter {} already has a download owner.",
                            job.id()
                        ));
                    }
                    fresh_jobs.push((job.id(), serialized_job));
                    continue;
                }

                let Some(row) = existing_row else {
                    return Err(format!(
                        "Pending VPN chapter {} is missing or was cancelled.",
                        job.id()
                    ));
                };
                let pending = parse_stored_chapter_download_job(row.chapter_id, &row.job_json)?;
                if pending.vpn_batch_id() != Some(plan.batch_id.as_str())
                    || pending.vpn_plan_id().is_some()
                    || pending.vpn_range_id().is_some()
                    || pending.plugin_id() != job.plugin_id()
                    || pending.novel_id() != job.novel_id()
                    || pending.chapter_path() != job.chapter_path()
                {
                    return Err(format!(
                        "Chapter {} has a different pending download owner.",
                        job.id()
                    ));
                }
                if ENROLLMENT_CONTRACT_FIELDS
                    .iter()
                    .any(|key| pending.field_str_or_null(key) != job.field_str_or_null(key))
                {
                    return Err(format!(
                        "Pending chapter {} content payload changed during VPN enrollment.",
                        job.id()
                    ));
                }

                let result = sqlx::query(
                    "UPDATE chapter_download_queue
                     SET job_json = ?1, updated_at_ms = ?2, leased_at_ms = NULL
                     WHERE chapter_id = ?3 AND job_json = ?4",
                )
                .bind(&serialized_job)
                .bind(now)
                .bind(job.id())
                .bind(&row.job_json)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("enroll pending chapter {}: {err}", job.id()))?;

                if result.rows_affected() != 1 {
                    return Err(format!("Pending VPN chapter {} changed owners.", job.id()));
                }
            }

            let chunk_size = MAX_ROUTE_QUERY_ROWS / 4;
            for chunk in fresh_jobs.chunks(chunk_size) {
                let mut builder = QueryBuilder::<Sqlite>::new(
                    "INSERT INTO chapter_download_queue (chapter_id, job_json, created_at_ms, updated_at_ms, leased_at_ms, attempt_count) ",
                );
                builder.push_values(chunk, |mut b, (chapter_id, job_json)| {
                    b.push_bind(*chapter_id)
                        .push_bind(job_json)
                        .push_bind(now)
                        .push_bind(now)
                        .push("NULL")
                        .push("0");
                });
                builder
                    .build()
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| format!("insert fresh VPN download jobs: {err}"))?;
            }

            Ok(())
        })
    })
    .await
}

pub async fn get_vpn_download_range_jobs(
    db: &AppDatabase,
    plan_id: &str,
    range_id: &str,
    read_mode: ReadMode,
) -> Result<Vec<ChapterDownloadJobDto>, String> {
    let mut tx = db
        .pool_for(read_mode)
        .begin()
        .await
        .map_err(|err| format!("db_vpn_plan_get_range_jobs begin: {err}"))?;

    let plan = require_plan_in_conn(&mut tx, plan_id).await?;
    let range_idx = find_range_index(&plan, range_id)?;
    let range = &plan.ranges[range_idx];
    if range.phase == VpnDownloadRangePhaseDto::Cancelled {
        return Ok(Vec::new());
    }
    let checkpoint = usize::try_from(range.checkpoint).expect("validated non-negative");
    let ids = &range.selected_chapter_ids[checkpoint..];
    let rows_map: HashMap<i64, RawQueueRow> = read_queue_in_conn(&mut tx, ids)
        .await?
        .into_iter()
        .map(|row| (row.chapter_id, row))
        .collect();

    let mut jobs = Vec::with_capacity(ids.len());
    for &id in ids {
        let row = rows_map
            .get(&id)
            .ok_or_else(|| format!("VPN download range {range_id} is missing queued chapter {id}."))?;
        let job = parse_stored_chapter_download_job(row.chapter_id, &row.job_json)?;
        assert_job_owner(&job, &plan, range)?;
        jobs.push(job);
    }
    Ok(jobs)
}

pub async fn update_vpn_download_plan(
    db: &AppDatabase,
    plan: VpnDownloadPlanDto,
    expected_revision: i64,
    restart_pass_range_id: Option<String>,
) -> Result<DbMutationEnvelope<VpnDownloadPlanDto>, String> {
    let _ = serialize_checked(&plan, "VPN download plan")?;
    if expected_revision < 0 {
        return Err(format!("VPN download plan {} has a stale revision.", plan.id));
    }
    if let Some(ref range_id) = restart_pass_range_id {
        if !is_identity_str(range_id) {
            return Err("An explicit VPN profile pass restart requires a range ID.".to_string());
        }
    }

    with_write_tx(db.writer(), vpn_tx_options(), move |conn, _ctx| {
        Box::pin(async move {
            let stored = require_plan_in_conn(conn, &plan.id).await?;
            if stored.revision != expected_revision || plan.revision != expected_revision {
                return Err(format!(
                    "VPN download plan {} has a stale revision.",
                    plan.id
                ));
            }
            if let Some(ref restart_id) = restart_pass_range_id {
                let idx = find_range_index(&stored, restart_id)?;
                if stored.ranges[idx].phase != VpnDownloadRangePhaseDto::Paused {
                    return Err(
                        "Stop the VPN range and persist its paused state before restarting its profile pass."
                            .to_string(),
                    );
                }
            }
            if plan.batch_id != stored.batch_id
                || plan.plugin_id != stored.plugin_id
                || plan.novel_id != stored.novel_id
                || plan.title != stored.title
                || plan.mode != stored.mode
                || plan.created_at != stored.created_at
                || plan.policies != stored.policies
                || plan.ranges.len() != stored.ranges.len()
            {
                return Err("VPN download plan identity and configuration are immutable.".to_string());
            }

            for (range, previous) in plan.ranges.iter().zip(stored.ranges.iter()) {
                if range.id != previous.id
                    || range.start_chapter_id != previous.start_chapter_id
                    || range.end_chapter_id != previous.end_chapter_id
                    || range.chapter_ids != previous.chapter_ids
                    || range.selected_chapter_ids != previous.selected_chapter_ids
                    || range.checkpoint != previous.checkpoint
                    || range.generation < previous.generation
                {
                    return Err(
                        "VPN range membership and checkpoints are immutable outside settlement; generation cannot regress."
                            .to_string(),
                    );
                }

                let same_challenge = range.challenge == previous.challenge;
                if restart_pass_range_id.as_deref() == Some(range.id.as_str()) {
                    let empty_reallows = range
                        .consumed_reallow_revisions
                        .as_ref()
                        .is_none_or(BTreeMap::is_empty);
                    if range.phase != VpnDownloadRangePhaseDto::Paused
                        || range.generation <= previous.generation
                        || !range.attempted_profile_ids.is_empty()
                        || !empty_reallows
                        || range.attempt_profile_id.is_some()
                        || !same_challenge
                        || range.profile_id != previous.profile_id
                        || range.profile_hash != previous.profile_hash
                    {
                        return Err(
                            "A VPN profile pass restart requires a paused target, a higher generation and an empty attempt state; profile and challenge must be preserved."
                                .to_string(),
                        );
                    }
                } else {
                    let attempts_regressed = previous
                        .attempted_profile_ids
                        .iter()
                        .enumerate()
                        .any(|(idx, pid)| range.attempted_profile_ids.get(idx) != Some(pid));
                    let reallows_regressed = previous
                        .consumed_reallow_revisions
                        .iter()
                        .flat_map(|map| map.iter())
                        .any(|(pid, &rev)| {
                            range
                                .consumed_reallow_revisions
                                .as_ref()
                                .and_then(|map| map.get(pid))
                                .copied()
                                .unwrap_or(-1)
                                < rev
                        });
                    let cleared_challenge = previous.challenge.is_some() && range.challenge.is_none();
                    if attempts_regressed || reallows_regressed || cleared_challenge {
                        return Err(
                            "VPN recovery attempts and challenges can only be cleared by full chapter settlement."
                                .to_string(),
                        );
                    }
                }

                if let Some(ref restart_id) = restart_pass_range_id {
                    if range.id != *restart_id {
                        let empty_map = BTreeMap::new();
                        let range_reallows =
                            range.consumed_reallow_revisions.as_ref().unwrap_or(&empty_map);
                        let prev_reallows = previous
                            .consumed_reallow_revisions
                            .as_ref()
                            .unwrap_or(&empty_map);
                        let sibling_changed = range.profile_id != previous.profile_id
                            || range.profile_hash != previous.profile_hash
                            || range.phase != previous.phase
                            || range.user_paused != previous.user_paused
                            || range.pause_reason != previous.pause_reason
                            || range.attempt_profile_id != previous.attempt_profile_id
                            || range.generation != previous.generation
                            || !same_challenge
                            || range.attempted_profile_ids != previous.attempted_profile_ids
                            || range_reallows != prev_reallows;
                        if sibling_changed {
                            return Err(
                                "An explicit VPN profile pass restart cannot change sibling range state."
                                    .to_string(),
                            );
                        }
                    }
                }
            }

            write_plan_in_conn(conn, plan, expected_revision).await
        })
    })
    .await
}

pub async fn settle_vpn_download_chapter(
    db: &AppDatabase,
    plan_id: String,
    range_id: String,
    chapter_id: i64,
    expected_generation: i64,
) -> Result<DbMutationEnvelope<VpnDownloadPlanDto>, String> {
    with_write_tx(db.writer(), vpn_tx_options(), move |conn, _ctx| {
        Box::pin(async move {
            let mut plan = require_plan_in_conn(conn, &plan_id).await?;
            let range_idx = find_range_index(&plan, &range_id)?;
            if plan.ranges[range_idx].generation != expected_generation {
                return Err("Stale VPN download worker generation.".to_string());
            }
            let checkpoint_usize =
                usize::try_from(plan.ranges[range_idx].checkpoint).expect("validated non-negative");
            if plan.ranges[range_idx].phase == VpnDownloadRangePhaseDto::Cancelled
                || plan.ranges[range_idx]
                    .selected_chapter_ids
                    .get(checkpoint_usize)
                    != Some(&chapter_id)
            {
                return Err(
                    "VPN chapter settlement must match the next selected chapter in its range."
                        .to_string(),
                );
            }
            let rows = read_queue_in_conn(conn, &[chapter_id]).await?;
            let row = rows
                .first()
                .ok_or_else(|| format!("VPN range is missing queued chapter {chapter_id}."))?;
            let job = parse_stored_chapter_download_job(row.chapter_id, &row.job_json)?;
            assert_job_owner(&job, &plan, &plan.ranges[range_idx])?;

            {
                let range = &mut plan.ranges[range_idx];
                range.checkpoint += 1;
                range.attempted_profile_ids.clear();
                range.consumed_reallow_revisions = None;
                range.attempt_profile_id = None;
                range.challenge = None;
                if usize::try_from(range.checkpoint).ok() == Some(range.selected_chapter_ids.len())
                {
                    range.phase = VpnDownloadRangePhaseDto::Completed;
                }
            }

            sqlx::query("DELETE FROM chapter_download_queue WHERE chapter_id = ?1")
                .bind(chapter_id)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("delete settled chapter {chapter_id}: {err}"))?;

            let current_revision = plan.revision;
            write_plan_in_conn(conn, plan, current_revision).await
        })
    })
    .await
}

pub async fn cancel_vpn_download_range(
    db: &AppDatabase,
    plan_id: String,
    range_id: String,
) -> Result<DbMutationEnvelope<VpnDownloadPlanDto>, String> {
    with_write_tx(db.writer(), vpn_tx_options(), move |conn, _ctx| {
        Box::pin(async move {
            let mut plan = require_plan_in_conn(conn, &plan_id).await?;
            let range_idx = find_range_index(&plan, &range_id)?;
            let target_range = plan.ranges[range_idx].clone();
            remove_owned_jobs_in_conn(conn, &plan, &[target_range]).await?;
            if plan.ranges[range_idx].phase == VpnDownloadRangePhaseDto::Cancelled {
                return Ok(plan);
            }
            plan.ranges[range_idx].phase = VpnDownloadRangePhaseDto::Cancelled;
            let current_revision = plan.revision;
            write_plan_in_conn(conn, plan, current_revision).await
        })
    })
    .await
}

pub async fn cancel_vpn_download_plan(
    db: &AppDatabase,
    plan_id: String,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(db.writer(), vpn_tx_options(), move |conn, _ctx| {
        Box::pin(async move {
            let Some(plan) = read_plan_in_conn(conn, &plan_id).await? else {
                return Ok(());
            };
            remove_owned_jobs_in_conn(conn, &plan, &plan.ranges).await?;
            sqlx::query("DELETE FROM vpn_download_plan WHERE id = ?1")
                .bind(&plan.id)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("delete vpn_download_plan {}: {err}", plan.id))?;
            Ok(())
        })
    })
    .await
}

async fn read_issue_in_conn(
    conn: &mut SqliteConnection,
    batch_id: &str,
    ip: &str,
) -> Result<VpnDownloadProfileIssueDto, String> {
    let row = sqlx::query_as::<_, RawProfileIssueRow>(
        "SELECT
           batch_id, ip, profile_id, profile_hash, plan_id, range_id,
           generation, cause, recorded_at, excluded, revision
         FROM vpn_download_profile_issue
         WHERE batch_id = ?1 AND ip = ?2",
    )
    .bind(batch_id)
    .bind(ip)
    .fetch_optional(conn)
    .await
    .map_err(|err| format!("read vpn_download_profile_issue: {err}"))?
    .ok_or_else(|| "VPN profile issue is missing.".to_string())?;
    row.try_into()
}

pub async fn list_vpn_download_profile_issues(
    db: &AppDatabase,
    batch_id: Option<&str>,
    read_mode: ReadMode,
) -> Result<Vec<VpnDownloadProfileIssueDto>, String> {
    let rows = match batch_id {
        Some(batch) => {
            sqlx::query_as::<_, RawProfileIssueRow>(
                "SELECT
                   batch_id, ip, profile_id, profile_hash, plan_id, range_id,
                   generation, cause, recorded_at, excluded, revision
                 FROM vpn_download_profile_issue
                 WHERE batch_id = ?1
                 ORDER BY recorded_at DESC, batch_id, ip",
            )
            .bind(batch)
            .fetch_all(db.pool_for(read_mode))
            .await
        }
        None => {
            sqlx::query_as::<_, RawProfileIssueRow>(
                "SELECT
                   batch_id, ip, profile_id, profile_hash, plan_id, range_id,
                   generation, cause, recorded_at, excluded, revision
                 FROM vpn_download_profile_issue
                 ORDER BY recorded_at DESC, batch_id, ip",
            )
            .fetch_all(db.pool_for(read_mode))
            .await
        }
    }
    .map_err(|err| format!("db_vpn_profile_issue_list: {err}"))?;

    rows.into_iter().map(TryInto::try_into).collect()
}

pub async fn record_vpn_download_profile_issue(
    db: &AppDatabase,
    issue: VpnDownloadProfileIssueInput,
) -> Result<DbMutationEnvelope<VpnDownloadProfileIssueDto>, String> {
    with_write_tx(db.writer(), vpn_tx_options(), move |conn, _ctx| {
        Box::pin(async move {
            let plan = read_plan_in_conn(conn, &issue.plan_id).await?;
            let valid_owner = plan.as_ref().is_some_and(|p| {
                p.batch_id == issue.batch_id
                    && p.ranges.iter().any(|range| {
                        range.id == issue.range_id
                            && range.generation == issue.generation
                            && range.profile_id.as_deref() == Some(issue.profile_id.as_str())
                            && range.profile_hash.as_deref() == Some(issue.profile_hash.as_str())
                            && range.phase != VpnDownloadRangePhaseDto::Completed
                            && range.phase != VpnDownloadRangePhaseDto::Cancelled
                    })
            });
            if !valid_owner || !is_identity_str(&issue.ip) {
                return Err("Stale VPN profile issue owner, identity or generation.".to_string());
            }

            let recorded_at = now_ms()?;
            sqlx::query(
                "INSERT INTO vpn_download_profile_issue
                   (batch_id, ip, profile_id, profile_hash, plan_id, range_id, generation, cause, recorded_at, excluded, revision)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, 1)
                 ON CONFLICT(batch_id, ip) DO UPDATE SET
                   profile_id = excluded.profile_id,
                   profile_hash = excluded.profile_hash,
                   plan_id = excluded.plan_id,
                   range_id = excluded.range_id,
                   generation = excluded.generation,
                   cause = excluded.cause,
                   recorded_at = excluded.recorded_at,
                   excluded = 1,
                   revision = vpn_download_profile_issue.revision + 1",
            )
            .bind(&issue.batch_id)
            .bind(&issue.ip)
            .bind(&issue.profile_id)
            .bind(&issue.profile_hash)
            .bind(&issue.plan_id)
            .bind(&issue.range_id)
            .bind(issue.generation)
            .bind(issue.cause.as_str())
            .bind(recorded_at)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db_vpn_profile_issue_record: {err}"))?;

            read_issue_in_conn(conn, &issue.batch_id, &issue.ip).await
        })
    })
    .await
}

pub async fn reallow_vpn_download_profile(
    db: &AppDatabase,
    batch_id: String,
    ip: String,
    expected_revision: i64,
) -> Result<DbMutationEnvelope<VpnDownloadProfileIssueDto>, String> {
    with_write_tx(db.writer(), vpn_tx_options(), move |conn, _ctx| {
        Box::pin(async move {
            let result = sqlx::query(
                "UPDATE vpn_download_profile_issue
                 SET excluded = 0, revision = revision + 1
                 WHERE batch_id = ?1 AND ip = ?2 AND revision = ?3 AND excluded = 1",
            )
            .bind(&batch_id)
            .bind(&ip)
            .bind(expected_revision)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db_vpn_profile_issue_reallow: {err}"))?;

            if result.rows_affected() != 1 {
                return Err(
                    "VPN profile issue has a stale revision or is no longer excluded.".to_string(),
                );
            }
            read_issue_in_conn(conn, &batch_id, &ip).await
        })
    })
    .await
}

#[tauri::command]
pub async fn db_vpn_list_verdicts(
    db: State<'_, AppDatabase>,
    read_mode: Option<ReadMode>,
) -> Result<Vec<VpnGateServerVerdictDto>, String> {
    list_vpn_gate_server_verdicts(db.inner(), read_mode.unwrap_or(ReadMode::Committed)).await
}

#[tauri::command]
pub async fn db_vpn_plan_read(
    db: State<'_, AppDatabase>,
    id: String,
    read_mode: Option<ReadMode>,
) -> Result<Option<VpnDownloadPlanDto>, String> {
    read_vpn_download_plan(db.inner(), &id, read_mode.unwrap_or(ReadMode::Committed)).await
}

#[tauri::command]
pub async fn db_vpn_plan_list(
    db: State<'_, AppDatabase>,
    read_mode: Option<ReadMode>,
) -> Result<Vec<VpnDownloadPlanDto>, String> {
    list_vpn_download_plans(db.inner(), read_mode.unwrap_or(ReadMode::Committed)).await
}

#[tauri::command]
pub async fn db_vpn_plan_create(
    db: State<'_, AppDatabase>,
    plan: VpnDownloadPlanDto,
    jobs: Vec<ChapterDownloadJobDto>,
) -> Result<DbMutationEnvelope<()>, String> {
    create_vpn_download_plan(db.inner(), plan, jobs).await
}

#[tauri::command]
pub async fn db_vpn_plan_get_range_jobs(
    db: State<'_, AppDatabase>,
    plan_id: String,
    range_id: String,
    read_mode: Option<ReadMode>,
) -> Result<Vec<ChapterDownloadJobDto>, String> {
    get_vpn_download_range_jobs(
        db.inner(),
        &plan_id,
        &range_id,
        read_mode.unwrap_or(ReadMode::Committed),
    )
    .await
}

#[tauri::command]
pub async fn db_vpn_plan_update(
    db: State<'_, AppDatabase>,
    plan: VpnDownloadPlanDto,
    expected_revision: i64,
    restart_pass_range_id: Option<String>,
) -> Result<DbMutationEnvelope<VpnDownloadPlanDto>, String> {
    update_vpn_download_plan(db.inner(), plan, expected_revision, restart_pass_range_id).await
}

#[tauri::command]
pub async fn db_vpn_plan_settle_chapter(
    db: State<'_, AppDatabase>,
    plan_id: String,
    range_id: String,
    chapter_id: i64,
    expected_generation: i64,
) -> Result<DbMutationEnvelope<VpnDownloadPlanDto>, String> {
    settle_vpn_download_chapter(db.inner(), plan_id, range_id, chapter_id, expected_generation)
        .await
}

#[tauri::command]
pub async fn db_vpn_plan_cancel_range(
    db: State<'_, AppDatabase>,
    plan_id: String,
    range_id: String,
) -> Result<DbMutationEnvelope<VpnDownloadPlanDto>, String> {
    cancel_vpn_download_range(db.inner(), plan_id, range_id).await
}

#[tauri::command]
pub async fn db_vpn_plan_cancel(
    db: State<'_, AppDatabase>,
    plan_id: String,
) -> Result<DbMutationEnvelope<()>, String> {
    cancel_vpn_download_plan(db.inner(), plan_id).await
}

#[tauri::command]
pub async fn db_vpn_profile_issue_list(
    db: State<'_, AppDatabase>,
    batch_id: Option<String>,
    read_mode: Option<ReadMode>,
) -> Result<Vec<VpnDownloadProfileIssueDto>, String> {
    list_vpn_download_profile_issues(
        db.inner(),
        batch_id.as_deref(),
        read_mode.unwrap_or(ReadMode::Committed),
    )
    .await
}

#[tauri::command]
pub async fn db_vpn_profile_issue_record(
    db: State<'_, AppDatabase>,
    input: VpnDownloadProfileIssueInput,
) -> Result<DbMutationEnvelope<VpnDownloadProfileIssueDto>, String> {
    record_vpn_download_profile_issue(db.inner(), input).await
}

#[tauri::command]
pub async fn db_vpn_profile_issue_reallow(
    db: State<'_, AppDatabase>,
    batch_id: String,
    ip: String,
    expected_revision: i64,
) -> Result<DbMutationEnvelope<VpnDownloadProfileIssueDto>, String> {
    reallow_vpn_download_profile(db.inner(), batch_id, ip, expected_revision).await
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;

    use super::*;
    use crate::db::test_support::open_test_db;

    async fn seed_catalog(db: &AppDatabase) {
        sqlx::query(
            "INSERT INTO novel (id, plugin_id, path, name, in_library)
             VALUES (42, 'source', '/work', 'Work', 1),
                    (99, 'other-source', '/other', 'Other work', 1)",
        )
        .execute(db.writer())
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO chapter (id, novel_id, path, name, position)
             VALUES (31, 42, '/31', 'One', 1),
                    (7, 42, '/7', 'Extra', 2),
                    (22, 42, '/22', 'Three', 3),
                    (4, 42, '/4', 'Four', 4),
                    (19, 42, '/19', 'Extra', 5),
                    (12, 42, '/12', 'Six', 6),
                    (90, 99, '/90', 'Other', 1)",
        )
        .execute(db.writer())
        .await
        .unwrap();
    }

    fn sample_plan() -> VpnDownloadPlanDto {
        serde_json::from_value(json!({
            "id": "plan-1",
            "batchId": "batch-1",
            "pluginId": "source",
            "novelId": 42,
            "title": "Work",
            "mode": "parallel",
            "policies": { "captcha": "nextProfile", "cloudflare": "pause" },
            "createdAt": 100,
            "revision": 0,
            "ranges": [
                {
                    "id": "lane-a",
                    "profileId": "profile-a",
                    "profileHash": "a".repeat(64),
                    "chapterIds": [31, 7, 22],
                    "selectedChapterIds": [31, 22],
                    "startChapterId": 31,
                    "endChapterId": 22,
                    "checkpoint": 0,
                    "phase": "paused",
                    "userPaused": false,
                    "pauseReason": null,
                    "attemptedProfileIds": [],
                    "attemptProfileId": null,
                    "generation": 2,
                    "challenge": null
                },
                {
                    "id": "lane-b",
                    "profileId": "profile-b",
                    "profileHash": "a".repeat(64),
                    "chapterIds": [4, 19, 12],
                    "selectedChapterIds": [4, 12],
                    "startChapterId": 4,
                    "endChapterId": 12,
                    "checkpoint": 0,
                    "phase": "paused",
                    "userPaused": false,
                    "pauseReason": null,
                    "attemptedProfileIds": [],
                    "attemptProfileId": null,
                    "generation": 2,
                    "challenge": null
                }
            ]
        }))
        .unwrap()
    }

    fn sample_jobs(plan: &VpnDownloadPlanDto) -> Vec<ChapterDownloadJobDto> {
        let mut jobs = Vec::new();
        for range in &plan.ranges {
            if range.phase == VpnDownloadRangePhaseDto::Cancelled {
                continue;
            }
            let cp = usize::try_from(range.checkpoint).unwrap();
            for &id in &range.selected_chapter_ids[cp..] {
                jobs.push(
                    serde_json::from_value(json!({
                        "id": id,
                        "pluginId": plan.plugin_id,
                        "novelId": plan.novel_id,
                        "novelPath": if plan.novel_id == 42 { "/work" } else { "/other" },
                        "chapterPath": format!("/{id}"),
                        "title": format!("Chapter {id}"),
                        "batchId": plan.batch_id,
                        "vpnPlanId": plan.id,
                        "vpnRangeId": range.id
                    }))
                    .unwrap(),
                );
            }
        }
        jobs
    }

    #[tokio::test]
    async fn verdicts_and_profile_issues_enforce_owner_and_cas_revision() {
        let test_db = open_test_db().await;
        let db = &test_db.db;
        seed_catalog(db).await;

        sqlx::query(
            "INSERT INTO vpn_gate_server_verdict (ip, verdict, updated_at)
             VALUES ('203.0.113.9', 'fails', 456), ('198.51.100.4', 'works', 123)",
        )
        .execute(db.writer())
        .await
        .unwrap();

        let verdicts = list_vpn_gate_server_verdicts(db, ReadMode::Committed)
            .await
            .unwrap();
        assert_eq!(
            verdicts,
            vec![
                VpnGateServerVerdictDto {
                    ip: "198.51.100.4".to_string(),
                    verdict: VpnGateServerVerdictValueDto::Works,
                    updated_at: 123,
                },
                VpnGateServerVerdictDto {
                    ip: "203.0.113.9".to_string(),
                    verdict: VpnGateServerVerdictValueDto::Fails,
                    updated_at: 456,
                },
            ]
        );

        let plan = sample_plan();
        create_vpn_download_plan(db, plan.clone(), sample_jobs(&plan))
            .await
            .unwrap();

        let stale_err = record_vpn_download_profile_issue(
            db,
            VpnDownloadProfileIssueInput {
                batch_id: "batch-1".to_string(),
                ip: "192.0.2.1".to_string(),
                profile_id: "profile-a".to_string(),
                profile_hash: "a".repeat(64),
                plan_id: "plan-1".to_string(),
                range_id: "lane-a".to_string(),
                generation: 1,
                cause: VpnDownloadProfileIssueCauseDto::Captcha,
            },
        )
        .await
        .unwrap_err();
        assert!(stale_err.contains("Stale VPN profile issue"));

        let recorded = record_vpn_download_profile_issue(
            db,
            VpnDownloadProfileIssueInput {
                batch_id: "batch-1".to_string(),
                ip: "192.0.2.1".to_string(),
                profile_id: "profile-a".to_string(),
                profile_hash: "a".repeat(64),
                plan_id: "plan-1".to_string(),
                range_id: "lane-a".to_string(),
                generation: 2,
                cause: VpnDownloadProfileIssueCauseDto::Captcha,
            },
        )
        .await
        .unwrap()
        .value;
        assert!(recorded.excluded);
        assert_eq!(recorded.revision, 1);

        let reallowed = reallow_vpn_download_profile(
            db,
            "batch-1".to_string(),
            "192.0.2.1".to_string(),
            recorded.revision,
        )
        .await
        .unwrap()
        .value;
        assert!(!reallowed.excluded);
        assert_eq!(reallowed.revision, 2);

        let repeat_err = reallow_vpn_download_profile(
            db,
            "batch-1".to_string(),
            "192.0.2.1".to_string(),
            reallowed.revision,
        )
        .await
        .unwrap_err();
        assert!(repeat_err.contains("stale revision or is no longer excluded"));

        // Deleting the plan retains batch issue history.
        cancel_vpn_download_plan(db, "plan-1".to_string())
            .await
            .unwrap();
        let issues = list_vpn_download_profile_issues(db, Some("batch-1"), ReadMode::Committed)
            .await
            .unwrap();
        assert_eq!(issues, vec![reallowed]);

        test_db.db.close().await;
    }

    #[tokio::test]
    async fn plan_lifecycle_cas_restart_settlement_and_range_cancel() {
        let test_db = open_test_db().await;
        let db = &test_db.db;
        seed_catalog(db).await;

        let mut initial = sample_plan();
        initial.ranges[0].attempted_profile_ids = vec!["profile-a".to_string()];
        initial.ranges[0].consumed_reallow_revisions =
            Some(BTreeMap::from([("profile-a".to_string(), 2)]));
        initial.ranges[0].challenge = Some(SourceAccessChallengeDto {
            kind: SourceAccessChallengeKindDto::Cloudflare,
            url: "https://source.test/work".to_string(),
        });

        let mut reversed_jobs = sample_jobs(&initial);
        reversed_jobs.reverse();
        create_vpn_download_plan(db, initial.clone(), reversed_jobs)
            .await
            .unwrap();

        let lane_a_jobs =
            get_vpn_download_range_jobs(db, "plan-1", "lane-a", ReadMode::Committed)
                .await
                .unwrap();
        assert_eq!(
            lane_a_jobs.iter().map(ChapterDownloadJobDto::id).collect::<Vec<_>>(),
            vec![31, 22]
        );

        // Ordinary update cannot clear recovery attempts, consumed reallows, or challenges.
        let mut illegal_clear = initial.clone();
        illegal_clear.ranges[0].attempted_profile_ids.clear();
        assert!(update_vpn_download_plan(db, illegal_clear, 0, None)
            .await
            .unwrap_err()
            .contains("only be cleared by full chapter settlement"));

        // Explicit pass restart succeeds on paused target with higher generation.
        let mut restart = initial.clone();
        restart.ranges[0].generation = 3;
        restart.ranges[0].attempted_profile_ids.clear();
        restart.ranges[0].consumed_reallow_revisions = None;
        let restarted = update_vpn_download_plan(
            db,
            restart,
            0,
            Some("lane-a".to_string()),
        )
        .await
        .unwrap()
        .value;
        assert_eq!(restarted.revision, 1);
        assert!(restarted.ranges[0].consumed_reallow_revisions.is_none());
        let serialized_restarted = serde_json::to_value(&restarted).unwrap();
        assert!(
            serialized_restarted["ranges"][0]
                .get("consumedReallowRevisions")
                .is_none()
        );

        // Stale generation settlement is rejected.
        assert!(
            settle_vpn_download_chapter(db, "plan-1".to_string(), "lane-a".to_string(), 31, 2)
                .await
                .unwrap_err()
                .contains("generation")
        );

        // Settle chapters 31 and 22 to complete lane-a.
        let after_31 =
            settle_vpn_download_chapter(db, "plan-1".to_string(), "lane-a".to_string(), 31, 3)
                .await
                .unwrap()
                .value;
        assert_eq!(after_31.ranges[0].checkpoint, 1);
        assert!(after_31.ranges[0].challenge.is_none());

        let after_22 =
            settle_vpn_download_chapter(db, "plan-1".to_string(), "lane-a".to_string(), 22, 3)
                .await
                .unwrap()
                .value;
        assert_eq!(after_22.ranges[0].checkpoint, 2);
        assert_eq!(after_22.ranges[0].phase, VpnDownloadRangePhaseDto::Completed);

        // Cancel lane-b while preserving an ordinary job that replaced chapter 4.
        sqlx::query("DELETE FROM chapter_download_queue WHERE chapter_id = 4")
            .execute(db.writer())
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO chapter_download_queue (chapter_id, job_json, created_at_ms, updated_at_ms, leased_at_ms, attempt_count)
             VALUES (4, '{\"id\":4,\"pluginId\":\"source\",\"chapterPath\":\"/4\",\"title\":\"Ordinary\"}', 10, 20, NULL, 0)",
        )
        .execute(db.writer())
        .await
        .unwrap();

        let cancelled_b =
            cancel_vpn_download_range(db, "plan-1".to_string(), "lane-b".to_string())
                .await
                .unwrap()
                .value;
        assert_eq!(
            cancelled_b.ranges[1].phase,
            VpnDownloadRangePhaseDto::Cancelled
        );

        let remaining_queue: Vec<i64> =
            sqlx::query_scalar("SELECT chapter_id FROM chapter_download_queue ORDER BY chapter_id")
                .fetch_all(db.writer())
                .await
                .unwrap();
        assert_eq!(remaining_queue, vec![4]);

        test_db.db.close().await;
    }

    #[tokio::test]
    async fn pending_enrollment_rollback_and_nonblocking_committed_reads() {
        let test_db = open_test_db().await;
        let db = &test_db.db;
        seed_catalog(db).await;

        let plan = sample_plan();
        let enrolled_jobs: Vec<ChapterDownloadJobDto> = sample_jobs(&plan)
            .into_iter()
            .map(|mut job| {
                job.0
                    .insert("vpnBatchId".to_string(), Value::String("batch-1".to_string()));
                job.0.insert("serverOnly".to_string(), Value::Bool(true));
                job
            })
            .collect();

        for job in &enrolled_jobs {
            let mut pending_map = job.0.clone();
            pending_map.remove("vpnPlanId");
            pending_map.remove("vpnRangeId");
            sqlx::query(
                "INSERT INTO chapter_download_queue (chapter_id, job_json, created_at_ms, updated_at_ms, leased_at_ms, attempt_count)
                 VALUES (?1, ?2, 10, 20, 30, 4)",
            )
            .bind(job.id())
            .bind(serde_json::to_string(&pending_map).unwrap())
            .execute(db.writer())
            .await
            .unwrap();
        }

        create_vpn_download_plan(db, plan.clone(), enrolled_jobs.clone())
            .await
            .unwrap();

        // Native queue history (created_at_ms=10, attempt_count=4) and extra fields are preserved.
        let history: Vec<(i64, Option<i64>, i64)> = sqlx::query_as(
            "SELECT created_at_ms, leased_at_ms, attempt_count FROM chapter_download_queue ORDER BY chapter_id",
        )
        .fetch_all(db.writer())
        .await
        .unwrap();
        assert!(history.iter().all(|&(created, leased, attempts)| {
            created == 10 && leased.is_none() && attempts == 4
        }));

        let lane_a = get_vpn_download_range_jobs(db, "plan-1", "lane-a", ReadMode::Committed)
            .await
            .unwrap();
        assert_eq!(lane_a[0].0.get("serverOnly"), Some(&Value::Bool(true)));

        // Verify reader pool never blocks while writer holds BEGIN IMMEDIATE.
        let mut active_tx = db.writer().begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query(
            "INSERT INTO vpn_gate_server_verdict (ip, verdict, updated_at) VALUES ('192.0.2.55', 'works', 999)",
        )
        .execute(&mut *active_tx)
        .await
        .unwrap();

        let committed_plans = tokio::time::timeout(
            Duration::from_millis(500),
            list_vpn_download_plans(db, ReadMode::Committed),
        )
        .await
        .expect("reader pool must not block behind writer BEGIN IMMEDIATE")
        .unwrap();
        assert_eq!(committed_plans.len(), 1);

        let committed_verdicts = tokio::time::timeout(
            Duration::from_millis(500),
            list_vpn_gate_server_verdicts(db, ReadMode::Committed),
        )
        .await
        .expect("verdict read must not block behind writer BEGIN IMMEDIATE")
        .unwrap();
        assert!(committed_verdicts.is_empty());

        active_tx.rollback().await.unwrap();
        test_db.db.close().await;
    }
}
