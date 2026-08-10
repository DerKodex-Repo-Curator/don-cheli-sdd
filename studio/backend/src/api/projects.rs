use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;
use crate::db::Project;

#[derive(Deserialize)]
pub struct CreateProject {
    pub name: String,
    pub path: String,
}

#[derive(Deserialize)]
pub struct ScanQuery {
    pub path: String,
}

#[derive(Serialize)]
pub struct ScanResult {
    pub path: String,
    pub exists: bool,
    pub is_directory: bool,
    pub is_empty: bool,
    pub suggested_name: String,
    /// Has Don Cheli artifacts from a previous run (.dc/specs, blueprints, etc.)
    pub has_dc_artifacts: bool,
    pub has_git: bool,
    pub git_remote: Option<String>,
    pub framework: Option<String>,
    pub package_manager: Option<String>,
    pub dependencies: Vec<String>,
    pub services_detected: Vec<crate::api::service_catalog::ServiceSpec>,
    pub file_count: u64,
    pub readme_excerpt: Option<String>,
    pub already_imported: bool,
    pub already_imported_as: Option<String>,
}

#[derive(Deserialize)]
pub struct ImportProject {
    pub name: String,
    pub path: String,
    /// If true (default), write `.dc/blueprints/imported.md` with detected context
    /// so the next `+ Nuevo trabajo` has full project awareness.
    #[serde(default = "default_true")]
    pub generate_blueprint: bool,
}

fn default_true() -> bool { true }

#[derive(Serialize)]
pub struct ImportResponse {
    pub project: Project,
    pub blueprint_path: Option<String>,
    pub framework: Option<String>,
    pub services_detected: usize,
}

#[derive(Serialize)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub path: String,
    pub editor: String,
    pub status: &'static str,         // active | done | paused | pending
    pub current_step: String,         // Diseñando, Construyendo, Especificando…
    pub total_cost: f64,
    pub total_runs: i64,
    pub success_runs: i64,
    pub last_used_iso: Option<String>,
    pub last_used_human: String,      // "hace 4 minutos"
}

pub async fn list(State(state): State<Arc<AppState>>) -> Result<Json<Vec<Project>>, StatusCode> {
    state.db.list_projects().map(Json).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub async fn get_one(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Project>, StatusCode> {
    state
        .db
        .get_project(&id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateProject>,
) -> Result<(StatusCode, Json<Project>), StatusCode> {
    // Validate path exists
    if !std::path::Path::new(&payload.path).is_dir() {
        return Err(StatusCode::BAD_REQUEST);
    }
    state
        .db
        .create_project(&payload.name, &payload.path)
        .map(|p| (StatusCode::CREATED, Json(p)))
        .map_err(|_| StatusCode::CONFLICT)
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> StatusCode {
    match state.db.delete_project(&id) {
        Ok(true) => StatusCode::NO_CONTENT,
        Ok(false) => StatusCode::NOT_FOUND,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

// ── Scan an external folder before importing ──

pub async fn scan(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ScanQuery>,
) -> Result<Json<ScanResult>, StatusCode> {
    let path = std::path::PathBuf::from(&q.path);

    let exists = path.exists();
    if !exists {
        return Ok(Json(empty_scan(&q.path)));
    }
    let is_directory = path.is_dir();
    if !is_directory {
        return Ok(Json(empty_scan(&q.path)));
    }

    // Already imported as another project?
    let (already_imported, already_imported_as) = state.db.list_projects()
        .ok()
        .and_then(|projects| {
            projects.into_iter().find(|p| {
                std::fs::canonicalize(&p.path).ok() ==
                std::fs::canonicalize(&path).ok()
            }).map(|p| (true, Some(p.name)))
        })
        .unwrap_or((false, None));

    // Basic file scan
    let is_empty = std::fs::read_dir(&path)
        .ok()
        .map(|it| it.flatten().count() == 0)
        .unwrap_or(true);
    let file_count = count_files_shallow(&path, 0, 3);
    let suggested_name = path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "imported-project".to_string());

    // Git detection
    let has_git = path.join(".git").exists();
    let git_remote = if has_git {
        std::process::Command::new("git")
            .args(["remote", "get-url", "origin"])
            .current_dir(&path)
            .output().ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
    } else { None };

    // .dc/ artifacts
    let has_dc_artifacts = path.join(".dc").join("specs").exists()
        || path.join(".dc").join("blueprints").exists()
        || path.join(".dc").join("design").exists();

    // package.json detection (Node)
    let preview_info = crate::api::preview::detect_for_scan(&path);

    // Services detection — cross deps with catalog, also scan blueprint/spec
    let mut combined_text = String::new();
    if let Some(readme) = read_truncated(&path.join("README.md"), 4_000) {
        combined_text.push_str(&readme);
    }
    if let Some(content) = read_truncated(&path.join(".dc/specs/spec.feature"), 6_000) {
        combined_text.push_str("\n");
        combined_text.push_str(&content);
    }
    if let Some(content) = read_truncated(&path.join(".dc/blueprints/blueprint.md"), 6_000) {
        combined_text.push_str("\n");
        combined_text.push_str(&content);
    }
    let services_from_text = crate::api::service_catalog::detect_in_text(&combined_text);
    let mut services_detected = services_from_text;
    // Merge services_detected with what preview's framework detection found
    for svc in &preview_info.services {
        if !services_detected.iter().any(|s| s.id == svc.id) {
            services_detected.push(svc.clone());
        }
    }

    let readme_excerpt = read_truncated(&path.join("README.md"), 280);

    Ok(Json(ScanResult {
        path: q.path,
        exists, is_directory, is_empty,
        suggested_name,
        has_dc_artifacts, has_git, git_remote,
        framework: preview_info.framework,
        package_manager: preview_info.package_manager,
        dependencies: preview_info.deps,
        services_detected,
        file_count,
        readme_excerpt,
        already_imported,
        already_imported_as,
    }))
}

fn empty_scan(path: &str) -> ScanResult {
    ScanResult {
        path: path.to_string(),
        exists: false, is_directory: false, is_empty: true,
        suggested_name: "".to_string(),
        has_dc_artifacts: false, has_git: false, git_remote: None,
        framework: None, package_manager: None,
        dependencies: vec![], services_detected: vec![],
        file_count: 0, readme_excerpt: None,
        already_imported: false, already_imported_as: None,
    }
}

fn count_files_shallow(dir: &std::path::Path, depth: u32, max_depth: u32) -> u64 {
    let mut count = 0;
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target"
            || name == "dist" || name == "build" || name == "__pycache__" {
            continue;
        }
        let path = entry.path();
        if path.is_file() {
            count += 1;
        } else if path.is_dir() && depth < max_depth {
            count += count_files_shallow(&path, depth + 1, max_depth);
        }
    }
    count
}

fn read_truncated(path: &std::path::Path, max_bytes: usize) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    if content.len() > max_bytes {
        Some(format!("{}…", &content[..max_bytes]))
    } else {
        Some(content)
    }
}

// ── Import an existing folder as a Don Cheli project ──

pub async fn import_project(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ImportProject>,
) -> Result<Json<ImportResponse>, StatusCode> {
    let path = std::path::PathBuf::from(&payload.path);
    if !path.exists() || !path.is_dir() {
        return Err(StatusCode::BAD_REQUEST);
    }

    // Refuse if already imported (caller can show a friendly error)
    let already = state.db.list_projects()
        .ok()
        .and_then(|projects| projects.into_iter().find(|p|
            std::fs::canonicalize(&p.path).ok() ==
            std::fs::canonicalize(&path).ok()
        ));
    if let Some(existing) = already {
        return Ok(Json(ImportResponse {
            project: existing,
            blueprint_path: None,
            framework: None,
            services_detected: 0,
        }));
    }

    // Create DB entry
    let project = state.db.create_project(&payload.name, &payload.path)
        .map_err(|_| StatusCode::CONFLICT)?;

    let preview_info = crate::api::preview::detect_for_scan(&path);
    let mut combined = String::new();
    if let Some(r) = read_truncated(&path.join("README.md"), 8_000) { combined.push_str(&r); }
    if let Some(r) = read_truncated(&path.join(".dc/specs/spec.feature"), 6_000) {
        combined.push_str("\n"); combined.push_str(&r);
    }
    let services = crate::api::service_catalog::detect_in_text(&combined);
    let services_detected = services.len() + preview_info.services.len();

    let blueprint_path = if payload.generate_blueprint {
        write_import_blueprint(&path, &payload.name, &preview_info, &services)
            .map(|p| p.to_string_lossy().to_string())
    } else { None };

    Ok(Json(ImportResponse {
        project,
        blueprint_path,
        framework: preview_info.framework,
        services_detected,
    }))
}

/// Write `.dc/blueprints/imported.md` summarizing what we detected on import.
/// This becomes context for the first `+ Nuevo trabajo` so Claude knows it's
/// working on an existing codebase, not a greenfield project.
fn write_import_blueprint(
    project_path: &std::path::Path,
    project_name: &str,
    preview: &crate::api::preview::ScanInfo,
    services: &[crate::api::service_catalog::ServiceSpec],
) -> Option<std::path::PathBuf> {
    let bp_dir = project_path.join(".dc").join("blueprints");
    std::fs::create_dir_all(&bp_dir).ok()?;
    let bp_path = bp_dir.join("imported.md");

    let mut body = String::new();
    body.push_str(&format!("# {} — Imported project context\n\n", project_name));
    body.push_str(&format!("This project was imported into Don Cheli SDD Studio on {}.\n\n",
        chrono::Utc::now().format("%Y-%m-%d %H:%M UTC")));

    body.push_str("## Detected stack\n\n");
    body.push_str(&format!("- **Framework**: {}\n",
        preview.framework.as_deref().unwrap_or("Unknown")));
    body.push_str(&format!("- **Package manager**: {}\n",
        preview.package_manager.as_deref().unwrap_or("—")));
    body.push_str(&format!("- **File count (shallow, no node_modules)**: {}\n",
        preview.file_count));
    if let Some(remote) = &preview.git_remote {
        body.push_str(&format!("- **Git remote**: {}\n", remote));
    }
    if preview.has_dc_artifacts {
        body.push_str("- **Don Cheli artifacts**: previously generated (.dc/ exists)\n");
    }
    body.push('\n');

    if !preview.deps.is_empty() {
        body.push_str("## Notable dependencies\n\n");
        for d in preview.deps.iter().take(20) {
            body.push_str(&format!("- `{}`\n", d));
        }
        body.push('\n');
    }

    if !services.is_empty() {
        body.push_str("## External services detected\n\n");
        for s in services {
            body.push_str(&format!("- **{}** ({}) — {}\n", s.name, s.category, s.description));
        }
        body.push('\n');
    }

    body.push_str("## Guidance for future phases\n\n");
    body.push_str("- This is an EXISTING codebase — do NOT generate a Next.js / Vite / etc. from scratch.\n");
    body.push_str("- Read existing files before proposing changes. Match the code style already present.\n");
    body.push_str("- New features should extend the current architecture, not replace it.\n");
    body.push_str("- For any service mentioned above, check the corresponding `.env.example` or env vars already configured before re-asking the user.\n");

    std::fs::write(&bp_path, body).ok()?;
    Some(bp_path)
}

pub async fn summary(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<ProjectSummary>>, StatusCode> {
    let projects = state.db.list_projects().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut out = Vec::with_capacity(projects.len());

    for project in projects {
        let runs = state.db.get_runs_for_project(&project.id).unwrap_or_default();

        let total_runs = runs.len() as i64;
        let success_runs = runs.iter().filter(|r| r.status == "passed").count() as i64;
        let total_cost: f64 = runs.iter().map(|r| r.total_cost).sum();

        let latest = runs.first(); // list_runs returns DESC by started_at
        let editor = latest
            .map(|r| provider_label(&r.provider))
            .unwrap_or_else(|| "Claude Code".to_string());

        let status = derive_status(&runs);
        let current_step = latest
            .and_then(|r| r.current_phase.as_deref())
            .map(spanish_step)
            .unwrap_or_else(|| {
                if status == "pending" { "Sin empezar".to_string() } else { "—".to_string() }
            });

        let last_used_iso = latest.map(|r| r.started_at.clone());
        let last_used_human = last_used_iso
            .as_deref()
            .map(human_relative)
            .unwrap_or_else(|| "—".to_string());

        out.push(ProjectSummary {
            id: project.id,
            name: project.name,
            path: project.path,
            editor,
            status,
            current_step,
            total_cost,
            total_runs,
            success_runs,
            last_used_iso,
            last_used_human,
        });
    }

    // Sort by most recent first
    out.sort_by(|a, b| b.last_used_iso.cmp(&a.last_used_iso));

    Ok(Json(out))
}

fn provider_label(provider: &str) -> String {
    match provider.to_lowercase().as_str() {
        "claude" => "Claude Code",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        "gemini" => "Gemini",
        "cursor" => "Cursor",
        other => return capitalize(other),
    }.to_string()
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn derive_status(runs: &[crate::db::PipelineRun]) -> &'static str {
    if runs.is_empty() {
        return "pending";
    }
    if runs.iter().any(|r| r.status == "running") {
        return "active";
    }
    let latest = &runs[0];
    match latest.status.as_str() {
        "passed" => "done",
        "failed" | "cancelled" => "paused",
        "pending" => "pending",
        _ => "pending",
    }
}

/// Translate phase name to Spanish gerund.
fn spanish_step(phase: &str) -> String {
    match phase {
        "specify" => "Especificando",
        "clarify" => "Clarificando",
        "plan" => "Planificando",
        "design" => "Diseñando",
        "breakdown" => "Desglosando",
        "implement" => "Construyendo",
        "review" => "Revisando",
        other => return other.to_string(),
    }.to_string()
}

/// Human-friendly relative time: "hace 4 minutos", "hace 2 horas", "ayer", etc.
fn human_relative(iso: &str) -> String {
    let parsed = chrono::DateTime::parse_from_rfc3339(iso);
    let Ok(parsed) = parsed else { return "—".to_string() };
    let now = chrono::Utc::now();
    let delta = now.signed_duration_since(parsed.with_timezone(&chrono::Utc));
    let secs = delta.num_seconds();

    if secs < 60 { return "hace unos segundos".to_string(); }
    let mins = secs / 60;
    if mins < 60 { return format!("hace {} minuto{}", mins, if mins == 1 { "" } else { "s" }); }
    let hours = mins / 60;
    if hours < 24 { return format!("hace {} hora{}", hours, if hours == 1 { "" } else { "s" }); }
    let days = hours / 24;
    if days == 1 { return "ayer".to_string(); }
    if days < 7 { return format!("hace {} días", days); }
    let weeks = days / 7;
    if weeks < 4 { return format!("hace {} semana{}", weeks, if weeks == 1 { "" } else { "s" }); }
    let months = days / 30;
    if months < 12 { return format!("hace {} mes{}", months, if months == 1 { "" } else { "es" }); }
    let years = days / 365;
    format!("hace {} año{}", years, if years == 1 { "" } else { "s" })
}
