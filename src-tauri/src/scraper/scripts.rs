//! Browser-executed scripts and their JSON argument serialization.

use super::FetchInit;

pub(super) const SCRAPER_INIT_SCRIPT: &str = include_str!("scripts/initialization.js");

pub(super) fn build_webview_fetch_start_script(
    request_id: &str,
    url: &str,
    init: &FetchInit,
) -> Result<String, String> {
    let request_json = serde_json::to_string(&serde_json::json!({
        "url": url,
        "init": init,
    }))
    .map_err(|err| format!("scraper: serialize fetch request: {err}"))?;
    let request_id_json = serde_json::to_string(request_id)
        .map_err(|err| format!("scraper: serialize fetch request id: {err}"))?;

    Ok(format!(
        "({})({request_json}, {request_id_json});",
        include_str!("scripts/fetch-start.js"),
    ))
}

pub(super) fn build_webview_fetch_poll_script(request_id: &str) -> Result<String, String> {
    let request_id_json = serde_json::to_string(request_id)
        .map_err(|err| format!("scraper: serialize fetch request id: {err}"))?;
    Ok(format!(
        "({})({request_id_json})",
        include_str!("scripts/fetch-poll.js"),
    ))
}

pub(super) fn build_webview_fetch_cleanup_script(request_id: &str) -> Result<String, String> {
    let request_id_json = serde_json::to_string(request_id)
        .map_err(|err| format!("scraper: serialize fetch request id: {err}"))?;
    Ok(format!(
        "({})({request_id_json});",
        include_str!("scripts/fetch-cleanup.js"),
    ))
}

pub(super) fn build_webview_fetch_cancel_script(message: &str) -> Result<String, String> {
    let message_json = serde_json::to_string(message)
        .map_err(|err| format!("scraper: serialize cancel message: {err}"))?;
    Ok(format!(
        "({})({message_json})",
        include_str!("scripts/fetch-cancel.js"),
    ))
}
