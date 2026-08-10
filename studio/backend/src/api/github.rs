//! GitHub repository management for Don Cheli projects.
//!
//! Uses the `gh` CLI (must be installed and authenticated) to:
//!  - Detect if a project already has a GitHub remote (`status`).
//!  - Initialize a brand new repo and push the initial commit (`init`).
//!
//! We avoid auto-pushing every runtime commit — only the initial setup. The
//! user owns the push cadence after that.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

use crate::AppState;

// ── Types ──

#[derive(Serialize)]
pub struct GithubStatus {
    pub has_repo: bool,
    pub repo_url: Option<String>,
    pub owner: Option<String>,
    pub name: Option<String>,
    pub visibility: Option<String>,
    pub default_branch: Option<String>,
    pub gh_authenticated: bool,
    pub authenticated_user: Option<String>,
}

#[derive(Deserialize)]
pub struct InitInput {
    /// "public" or "private"
    pub visibility: String,
    pub description: Option<String>,
    /// Optional override for the repo name. Defaults to the project name.
    pub name: Option<String>,
}

#[derive(Serialize)]
pub struct InitResponse {
    pub repo_url: String,
    pub owner: String,
    pub name: String,
    pub visibility: String,
}

// ── Status ──

pub async fn status(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Result<Json<GithubStatus>, StatusCode> {
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let path = PathBuf::from(&project.path);
    let (gh_authenticated, authenticated_user) = gh_auth_status();

    // Read git remote origin (if any)
    let remote_url = git(&path, &["remote", "get-url", "origin"]).ok();
    if let Some(url) = remote_url {
        let url = url.trim().to_string();
        if let Some((owner, name)) = parse_github_url(&url) {
            // Try to fetch visibility + default branch via gh (fast, cached). Tolerate failure.
            let (visibility, default_branch) = gh_repo_meta(&owner, &name).unwrap_or((None, None));
            return Ok(Json(GithubStatus {
                has_repo: true,
                repo_url: Some(canonical_https_url(&owner, &name)),
                owner: Some(owner),
                name: Some(name),
                visibility,
                default_branch,
                gh_authenticated,
                authenticated_user,
            }));
        }
    }

    Ok(Json(GithubStatus {
        has_repo: false,
        repo_url: None, owner: None, name: None,
        visibility: None, default_branch: None,
        gh_authenticated, authenticated_user,
    }))
}

// ── Init ──

pub async fn init(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Json(payload): Json<InitInput>,
) -> Result<Json<InitResponse>, StatusCode> {
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let visibility = match payload.visibility.to_lowercase().as_str() {
        "public" => "public",
        "private" => "private",
        _ => return Err(StatusCode::BAD_REQUEST),
    };

    let path = PathBuf::from(&project.path);
    if !path.exists() {
        return Err(StatusCode::NOT_FOUND);
    }

    let (gh_authenticated, _user) = gh_auth_status();
    if !gh_authenticated {
        tracing::error!("gh CLI not authenticated — run `gh auth login`");
        return Err(StatusCode::UNAUTHORIZED);
    }

    // Already has origin? Bail out — we don't want to overwrite an existing setup.
    if git(&path, &["remote", "get-url", "origin"]).is_ok() {
        tracing::warn!("Project {} already has an origin remote", project.id);
        return Err(StatusCode::CONFLICT);
    }

    let name = payload.name.unwrap_or_else(|| sanitize_repo_name(&project.name));
    let description = payload.description.unwrap_or_else(||
        format!("Generated with Don Cheli SDD — {}", project.name)
    );

    // 1. Make sure the dir is a git repo
    if !path.join(".git").exists() {
        git(&path, &["init"]).map_err(|e| {
            tracing::error!("git init failed: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    }

    // 2. Make sure there's at least one commit (gh repo create requires a commit
    //    when using --push). If there isn't, write a starter README and commit.
    let has_commits = git(&path, &["rev-parse", "--verify", "HEAD"]).is_ok();
    if !has_commits {
        // Write a minimal README so the initial commit isn't empty.
        let readme_path = path.join("README.md");
        if !readme_path.exists() {
            let body = format!(
                "# {}\n\n{}\n\nGenerated with [Don Cheli SDD](https://github.com/doncheli/don-cheli-sdd).\n",
                project.name, description,
            );
            std::fs::write(&readme_path, body)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
        git(&path, &["add", "README.md"]).ok();
        git(&path, &["commit", "-m", "chore: initial commit (Don Cheli)"])
            .map_err(|e| {
                tracing::error!("git commit failed: {}", e);
                StatusCode::INTERNAL_SERVER_ERROR
            })?;
    }

    // 3. Create the GitHub repo and push.
    // We avoid --source=. because that scans the cwd; we cd into path via `current_dir`.
    let visibility_flag = format!("--{}", visibility);
    let args = vec![
        "repo", "create", &name,
        &visibility_flag,
        "--description", &description,
        "--source=.",
        "--remote=origin",
        "--push",
    ];
    let output = Command::new("gh")
        .args(&args)
        .current_dir(&path)
        .output()
        .map_err(|e| {
            tracing::error!("Failed to spawn gh: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        tracing::error!("gh repo create failed: {}", stderr);
        // Common error: name conflict → 409
        if stderr.contains("already exists") || stderr.contains("Name already exists") {
            return Err(StatusCode::CONFLICT);
        }
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }

    // 4. Capture the URL from the remote we just set up.
    let remote_url = git(&path, &["remote", "get-url", "origin"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let (owner, parsed_name) = parse_github_url(&remote_url)
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(InitResponse {
        repo_url: canonical_https_url(&owner, &parsed_name),
        owner,
        name: parsed_name,
        visibility: visibility.to_string(),
    }))
}

// ── Helpers ──

/// Runs `git <args>` in `cwd`. Returns stdout on success, error string on failure.
fn git(cwd: &PathBuf, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("spawn failed: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Check if `gh` is installed AND the user is authenticated. Returns `(ok, login)`.
fn gh_auth_status() -> (bool, Option<String>) {
    let output = match Command::new("gh").args(["auth", "status"]).output() {
        Ok(o) => o,
        Err(_) => return (false, None),
    };
    if !output.status.success() {
        return (false, None);
    }
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    // Look for "Logged in to github.com account <user>"
    let login = combined
        .lines()
        .find_map(|line| {
            let l = line.trim();
            l.strip_prefix("✓ Logged in to github.com account ")
                .and_then(|rest| rest.split_whitespace().next())
                .map(|s| s.to_string())
        });
    (true, login)
}

/// Parse a github.com URL into `(owner, name)`. Handles ssh + https forms.
fn parse_github_url(url: &str) -> Option<(String, String)> {
    let url = url.trim().trim_end_matches('/').trim_end_matches(".git");
    // git@github.com:owner/repo
    if let Some(rest) = url.strip_prefix("git@github.com:") {
        let mut parts = rest.splitn(2, '/');
        let owner = parts.next()?.to_string();
        let name = parts.next()?.to_string();
        if owner.is_empty() || name.is_empty() { return None }
        return Some((owner, name));
    }
    // https://github.com/owner/repo
    for prefix in ["https://github.com/", "http://github.com/"] {
        if let Some(rest) = url.strip_prefix(prefix) {
            let mut parts = rest.splitn(2, '/');
            let owner = parts.next()?.to_string();
            let name = parts.next()?.to_string();
            if owner.is_empty() || name.is_empty() { return None }
            return Some((owner, name));
        }
    }
    None
}

fn canonical_https_url(owner: &str, name: &str) -> String {
    format!("https://github.com/{}/{}", owner, name)
}

/// Ask gh for the repo's visibility and default branch. Cheap call, cached by gh.
fn gh_repo_meta(owner: &str, name: &str) -> Option<(Option<String>, Option<String>)> {
    let slug = format!("{}/{}", owner, name);
    let output = Command::new("gh")
        .args(["repo", "view", &slug, "--json", "visibility,defaultBranchRef"])
        .output()
        .ok()?;
    if !output.status.success() { return None }
    let v: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let visibility = v.get("visibility")
        .and_then(|x| x.as_str())
        .map(|s| s.to_lowercase());
    let default_branch = v.get("defaultBranchRef")
        .and_then(|x| x.get("name"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    Some((visibility, default_branch))
}

/// Make a project name safe for use as a GitHub repo name.
fn sanitize_repo_name(name: &str) -> String {
    let n = name.trim().to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c }
            else if c.is_whitespace() { '-' }
            else { '-' }
        })
        .collect::<String>();
    // Collapse runs of dashes
    let mut out = String::with_capacity(n.len());
    let mut prev_dash = false;
    for c in n.chars() {
        if c == '-' {
            if !prev_dash { out.push(c); }
            prev_dash = true;
        } else {
            out.push(c);
            prev_dash = false;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() { "don-cheli-project".to_string() } else { trimmed }
}
