use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::AppHandle;

const FEEDBACK_API_URL: &str = "https://www.nebutra.com/pebble/v1/feedback";
const FEEDBACK_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_FEEDBACK_CHARS: usize = 64 * 1024;
const MAX_IDENTITY_CHARS: usize = 320;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSubmitInput {
    feedback: String,
    #[serde(default)]
    submit_anonymously: bool,
    github_login: Option<String>,
    github_email: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", untagged)]
pub enum FeedbackSubmitResult {
    Ok {
        ok: bool,
    },
    Error {
        ok: bool,
        status: Option<u16>,
        error: String,
    },
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FeedbackSubmitBody {
    feedback: String,
    submission_type: &'static str,
    github_login: Option<String>,
    github_email: Option<String>,
    app_version: String,
    platform: String,
    os_release: String,
    arch: String,
}

#[tauri::command]
pub async fn feedback_submit(app: AppHandle, input: FeedbackSubmitInput) -> FeedbackSubmitResult {
    let body = match build_submit_body(&app, input) {
        Ok(body) => body,
        Err(error) => return failure(None, error),
    };
    let client = match reqwest::Client::builder()
        .timeout(FEEDBACK_REQUEST_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(error) => return failure(None, error.to_string()),
    };
    match client.post(FEEDBACK_API_URL).json(&body).send().await {
        Ok(response) if response.status().is_success() => FeedbackSubmitResult::Ok { ok: true },
        Ok(response) => {
            let status = response.status().as_u16();
            failure(Some(status), format!("status {status}"))
        }
        Err(error) => failure(None, error.to_string()),
    }
}

fn build_submit_body(
    app: &AppHandle,
    input: FeedbackSubmitInput,
) -> Result<FeedbackSubmitBody, String> {
    let feedback = bounded_required(input.feedback, MAX_FEEDBACK_CHARS, "feedback")?;
    let identity = sanitize_identity(
        input.submit_anonymously,
        input.github_login,
        input.github_email,
    )?;
    Ok(FeedbackSubmitBody {
        feedback,
        submission_type: "feedback",
        github_login: identity.0,
        github_email: identity.1,
        app_version: app.package_info().version.to_string(),
        platform: node_platform().to_string(),
        os_release: sysinfo::System::kernel_version().unwrap_or_else(|| "unknown".to_string()),
        arch: node_arch().to_string(),
    })
}

fn sanitize_identity(
    anonymous: bool,
    github_login: Option<String>,
    github_email: Option<String>,
) -> Result<(Option<String>, Option<String>), String> {
    // Why: anonymity is enforced at the trusted host boundary, not by renderer-provided identity.
    if anonymous {
        return Ok((None, None));
    }
    Ok((
        bounded_optional(github_login, MAX_IDENTITY_CHARS, "GitHub login")?,
        bounded_optional(github_email, MAX_IDENTITY_CHARS, "GitHub email")?,
    ))
}

fn bounded_required(value: String, max_chars: usize, label: &str) -> Result<String, String> {
    let value = value.trim().to_string();
    let length = value.chars().count();
    if length == 0 || length > max_chars {
        return Err(format!("{label} must contain 1 to {max_chars} characters"));
    }
    Ok(value)
}

fn bounded_optional(
    value: Option<String>,
    max_chars: usize,
    label: &str,
) -> Result<Option<String>, String> {
    match value.map(|value| value.trim().to_string()) {
        None => Ok(None),
        Some(value) if value.is_empty() => Ok(None),
        Some(value) if value.chars().count() <= max_chars => Ok(Some(value)),
        Some(_) => Err(format!("{label} exceeds {max_chars} characters")),
    }
}

fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

fn failure(status: Option<u16>, error: String) -> FeedbackSubmitResult {
    FeedbackSubmitResult::Error {
        ok: false,
        status,
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anonymous_input_drops_all_renderer_identity() {
        let identity = sanitize_identity(
            true,
            Some("trusted-user".to_string()),
            Some("trusted@example.com".to_string()),
        )
        .unwrap();
        assert_eq!(identity, (None, None));
    }

    #[test]
    fn feedback_and_identity_fields_are_bounded() {
        assert_eq!(
            bounded_required(" report ".to_string(), 16, "feedback").unwrap(),
            "report"
        );
        assert!(bounded_required("".to_string(), 16, "feedback").is_err());
        assert!(bounded_required("12345".to_string(), 4, "feedback").is_err());
        assert_eq!(
            bounded_optional(Some(" user ".to_string()), 8, "login").unwrap(),
            Some("user".to_string())
        );
        assert_eq!(
            bounded_optional(Some(" ".to_string()), 8, "login").unwrap(),
            None
        );
    }

    #[test]
    fn reports_node_compatible_platform_and_architecture() {
        assert!(!node_platform().is_empty());
        assert!(!node_arch().is_empty());
        #[cfg(target_os = "macos")]
        assert_eq!(node_platform(), "darwin");
        #[cfg(target_arch = "aarch64")]
        assert_eq!(node_arch(), "arm64");
    }
}
