//! Service detection endpoints — let the frontend ask "what services does this
//! text mention?" so the user can be guided to configure API keys ahead of time
//! (Layer 1: in NuevoTrabajo as you type; Layer 2: in Ahora once the runtime
//! has written blueprint.md / spec.md).

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

use crate::AppState;
use crate::api::service_catalog::{self, ServiceSpec};

#[derive(Deserialize)]
pub struct DetectInput {
    pub text: String,
}

#[derive(Serialize)]
pub struct DetectResponse {
    pub services: Vec<ServiceSpec>,
}

#[derive(Serialize)]
pub struct ContextResponse {
    pub services: Vec<ServiceSpec>,
    /// Names of env keys that already have a value (so the UI can show which
    /// services still need configuration).
    pub env_keys_filled: Vec<String>,
    /// Where we read the context from (for debugging / UI hint).
    pub sources: Vec<String>,
}

pub async fn detect(
    Json(payload): Json<DetectInput>,
) -> Result<Json<DetectResponse>, StatusCode> {
    let text = payload.text.trim();
    if text.is_empty() {
        return Ok(Json(DetectResponse { services: Vec::new() }));
    }
    let services = service_catalog::detect_in_text(text);
    Ok(Json(DetectResponse { services }))
}

/// Read the project's task, spec.feature, blueprint.md and any other planning
/// artifacts produced by Don Cheli, cross-reference with the service catalog
/// and return the services the upcoming code will likely need. Also returns
/// which env keys are already filled in `.env.local`.
pub async fn from_context(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Result<Json<ContextResponse>, StatusCode> {
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let mut combined = String::new();
    let mut sources = Vec::new();

    // Search the worktree first (where the runtime writes during a run), then
    // the project root (where files end up after a successful merge).
    let project_path = PathBuf::from(&project.path);
    let dc_paths = collect_dc_paths(&project_path);

    let candidate_files = [
        ".dc/specs/spec.feature",
        ".dc/specs/spec.md",
        ".dc/blueprints/blueprint.md",
        ".dc/plans/plan.md",
        ".dc/specs/clarifications.md",
    ];

    for dc_root in &dc_paths {
        for rel in &candidate_files {
            let full = dc_root.join(rel.strip_prefix(".dc/").unwrap_or(rel));
            if let Ok(content) = std::fs::read_to_string(&full) {
                combined.push_str(&content);
                combined.push('\n');
                sources.push(format!("{}", full.display()));
            }
        }
    }

    // Also pull the most recent run's task description if available
    if let Ok(runs) = state.db.get_runs_for_project(&project_id) {
        if let Some(run) = runs.into_iter().next() {
            combined.push_str(&run.task);
            sources.push("task".to_string());
        }
    }

    // Detect services from the combined context
    let mut services = service_catalog::detect_in_text(&combined);

    // Also detect from package.json deps if the app already exists
    if let Some(pkg_path) = find_package_json(&project_path) {
        if let Ok(content) = std::fs::read_to_string(&pkg_path) {
            if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) {
                let mut deps = std::collections::HashMap::new();
                for key in ["dependencies", "devDependencies"] {
                    if let Some(m) = pkg.get(key).and_then(|v| v.as_object()) {
                        for (k, v) in m {
                            deps.insert(k.clone(), v.as_str().unwrap_or("").to_string());
                        }
                    }
                }
                let from_deps = service_catalog::detect_services(&deps, &[]);
                // Merge — avoid duplicates by id
                for s in from_deps {
                    if !services.iter().any(|x| x.id == s.id) {
                        services.push(s);
                    }
                }
                sources.push(pkg_path.to_string_lossy().to_string());
            }
        }
    }

    // Check which env keys are already filled in .env.local
    let env_keys_filled = read_env_filled_anywhere(&project_path);

    Ok(Json(ContextResponse { services, env_keys_filled, sources }))
}

fn collect_dc_paths(project_root: &std::path::Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    // 1. project_root/.dc
    let primary = project_root.join(".dc");
    if primary.exists() { paths.push(primary); }
    // 2. each worktree's .dc
    let worktrees = project_root.join(".dc").join("worktrees");
    if let Ok(entries) = std::fs::read_dir(&worktrees) {
        for entry in entries.flatten() {
            let candidate = entry.path().join(".dc");
            if candidate.exists() { paths.push(candidate); }
        }
    }
    paths
}

fn find_package_json(project_root: &std::path::Path) -> Option<PathBuf> {
    // Look up to 3 levels deep (the app may be in a subfolder)
    let mut queue: Vec<(PathBuf, u32)> = vec![(project_root.to_path_buf(), 0)];
    while let Some((dir, depth)) = queue.pop() {
        let pkg = dir.join("package.json");
        if pkg.exists() { return Some(pkg); }
        if depth >= 3 { continue }
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let p = e.path();
                if !p.is_dir() { continue }
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || name == "node_modules" || name == "target" { continue }
                queue.push((p, depth + 1));
            }
        }
    }
    None
}

fn read_env_filled_anywhere(project_root: &std::path::Path) -> Vec<String> {
    // Look in worktree first, then project root, then app subfolder
    let mut found = Vec::new();
    let mut dirs_to_check: Vec<PathBuf> = Vec::new();

    // App folder (where package.json is)
    if let Some(pkg) = find_package_json(project_root) {
        if let Some(parent) = pkg.parent() {
            dirs_to_check.push(parent.to_path_buf());
        }
    }
    dirs_to_check.push(project_root.to_path_buf());

    for dir in dirs_to_check {
        for name in [".env.local", ".env"] {
            let path = dir.join(name);
            if let Ok(content) = std::fs::read_to_string(&path) {
                for line in content.lines() {
                    let line = line.trim();
                    if line.is_empty() || line.starts_with('#') { continue }
                    if let Some((k, v)) = line.split_once('=') {
                        let value = v.trim().trim_matches(|c| c == '"' || c == '\'');
                        if !value.is_empty()
                            && !value.contains("your-")
                            && !value.contains("YOUR_")
                            && value != "xxx"
                            && value != "TODO"
                            && value != "<replace>"
                        {
                            found.push(k.trim().to_string());
                        }
                    }
                }
            }
        }
    }
    found.sort();
    found.dedup();
    found
}
