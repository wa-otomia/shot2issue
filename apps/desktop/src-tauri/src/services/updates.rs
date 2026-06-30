//! Lightweight update check against the GitHub Releases API.
//!
//! Reads /repos/wa-otomia/shot2issue/releases/latest, extracts the
//! tag_name, body and html_url, and compares the tag to this build's
//! CARGO_PKG_VERSION. Returns enough metadata for the UI to decide
//! whether to nudge the user toward the release page.

use super::{Result, ServiceError};
use serde::Serialize;
use std::time::Duration;

const RELEASES_API: &str =
    "https://api.github.com/repos/wa-otomia/shot2issue/releases/latest";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub is_outdated: bool,
    pub release_url: String,
    pub release_notes: String,
    pub published_at: Option<String>,
}

pub async fn check() -> Result<UpdateInfo> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("shot2issue/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| ServiceError::Other(format!("http client: {e}")))?;

    let resp = client
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| ServiceError::Other(format!("fetch failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(ServiceError::Other(format!(
            "GitHub API returned {}; rate limit reached or no releases yet",
            resp.status()
        )));
    }

    let payload: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| ServiceError::Other(format!("parse failed: {e}")))?;

    let latest_version = payload["tag_name"]
        .as_str()
        .map(|s| s.trim_start_matches('v').to_string())
        .unwrap_or_default();
    let release_url = payload["html_url"].as_str().unwrap_or("").to_string();
    let release_notes = payload["body"].as_str().unwrap_or("").to_string();
    let published_at = payload["published_at"].as_str().map(String::from);

    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let is_outdated = is_outdated(&current_version, &latest_version);

    Ok(UpdateInfo {
        current_version,
        latest_version,
        is_outdated,
        release_url,
        release_notes,
        published_at,
    })
}

fn parse_semver(s: &str) -> Vec<u32> {
    s.split('.')
        .filter_map(|p| p.split(|c: char| !c.is_ascii_digit()).next())
        .filter_map(|p| p.parse::<u32>().ok())
        .collect()
}

fn is_outdated(current: &str, latest: &str) -> bool {
    if latest.is_empty() {
        return false;
    }
    let c = parse_semver(current);
    let l = parse_semver(latest);
    l > c
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_outdated() {
        assert!(is_outdated("0.1.10", "0.1.14"));
        assert!(is_outdated("0.1.9", "0.1.10"));
        assert!(is_outdated("0.1.0", "1.0.0"));
    }

    #[test]
    fn detects_current_or_newer() {
        assert!(!is_outdated("0.1.14", "0.1.14"));
        assert!(!is_outdated("0.2.0", "0.1.99"));
        assert!(!is_outdated("0.1.14", ""));
    }
}
