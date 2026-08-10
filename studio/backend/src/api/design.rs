//! Design mockup endpoints — list, serve, approve/reject, generate.
//!
//! HTML mockups live in `<project>/.dc/design/*.html` (one self-contained
//! file per screen). Approval state lives in `<project>/.dc/design/approval.json`.

use axum::{
    Json,
    body::Body,
    extract::{Path, State},
    http::{StatusCode, header},
    response::Response,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use crate::AppState;
use crate::ws::WsMessage;

// ── Types ──

#[derive(Serialize)]
pub struct MockupInfo {
    /// Filename with subdir prefix, e.g. "atoms/button.html" or "login.html"
    pub name: String,
    pub title: String,
    /// Category: "atoms" | "molecules" | "organisms" | "pages" | "root"
    pub category: String,
    pub size_bytes: u64,
    pub modified_at: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct StitchScreen {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub slug: String,
}

#[derive(Serialize)]
pub struct DesignListResponse {
    pub mockups: Vec<MockupInfo>,
    pub approval: Option<ApprovalState>,
    pub tokens: Option<serde_json::Value>,
    /// URL of the design in Google Stitch — the source of truth for the design.
    pub stitch_url: Option<String>,
    /// Stitch project id (needed to pull screen htmlCode during code regeneration).
    pub stitch_project_id: Option<String>,
    /// Screens generated in Stitch (id + display name).
    pub stitch_screens: Vec<StitchScreen>,
    /// Free-form summary of the design direction, written by the design agent.
    pub design_brief: Option<String>,
    /// References pulled from Mobbin MCP during pre-design research.
    pub mobbin_refs: Vec<MobbinRef>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct MobbinRef {
    pub screen: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub refs: Vec<String>,
    #[serde(default)]
    pub takeaways: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ApprovalState {
    pub status: String,           // "pending" | "approved" | "rejected"
    pub signer: Option<String>,
    pub at: String,               // ISO timestamp
    pub notes: Option<String>,
}

#[derive(Deserialize)]
pub struct ApprovalInput {
    pub signer: Option<String>,
    pub notes: Option<String>,
}

#[derive(Deserialize)]
pub struct GenerateInput {
    pub prompt_override: Option<String>,
}

#[derive(Deserialize, Default)]
pub struct AddScreensInput {
    /// How many new screens to add. Defaults to 4. Capped at 6.
    #[serde(default)]
    pub count: Option<u32>,
    /// Optional explicit list of screen slugs/names the user wants added.
    /// When set, the agent prioritizes these.
    #[serde(default)]
    pub screens: Vec<String>,
}

// ── List ──

pub async fn list(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Result<Json<DesignListResponse>, StatusCode> {
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let design_dir = resolve_design_dir(&project.path);

    let mockups = if design_dir.exists() {
        scan_mockups(&design_dir)
    } else {
        Vec::new()
    };

    let approval = read_approval(&design_dir);
    let tokens = read_tokens(&design_dir);
    let stitch_url = read_stitch_url(&design_dir);
    let stitch_project_id = read_stitch_project_id(&design_dir);
    let stitch_screens = read_stitch_screens(&design_dir);
    let design_brief = read_design_brief(&design_dir);
    let mobbin_refs = read_mobbin_refs(&design_dir);

    Ok(Json(DesignListResponse {
        mockups, approval, tokens, stitch_url, stitch_project_id,
        stitch_screens, design_brief, mobbin_refs,
    }))
}

fn read_stitch_project_id(design_dir: &std::path::Path) -> Option<String> {
    let path = design_dir.join("approval.json");
    let content = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;
    v.get("stitch_project_id")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty() && *s != "null")
        .map(|s| s.to_string())
}

fn read_stitch_screens(design_dir: &std::path::Path) -> Vec<StitchScreen> {
    let path = design_dir.join("approval.json");
    let Ok(content) = std::fs::read_to_string(&path) else { return Vec::new() };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) else { return Vec::new() };
    v.get("stitch_screens")
        .and_then(|x| serde_json::from_value::<Vec<StitchScreen>>(x.clone()).ok())
        .unwrap_or_default()
}

fn read_design_brief(design_dir: &std::path::Path) -> Option<String> {
    let path = design_dir.join("approval.json");
    let content = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;
    v.get("design_brief")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Build the Stitch web URL for a project. The Stitch MCP does NOT expose a
/// canonical `url` field, so we always derive it from `stitch_project_id`.
/// The canonical pattern is `https://stitch.withgoogle.com/projects/<id>`.
fn read_stitch_url(design_dir: &std::path::Path) -> Option<String> {
    let path = design_dir.join("approval.json");
    let content = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;

    let pid = v.get("stitch_project_id")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty() && *s != "null")?;
    Some(format!("https://stitch.withgoogle.com/projects/{}", pid))
}

/// Load Mobbin research from `.dc/design/research/*.json` (one file per screen)
/// or the legacy `mobbin-refs.json` aggregate file.
fn read_mobbin_refs(design_dir: &std::path::Path) -> Vec<MobbinRef> {
    let research_dir = design_dir.join("research");

    // Legacy aggregate file
    let aggregate = research_dir.join("mobbin-refs.json");
    if let Ok(content) = std::fs::read_to_string(&aggregate) {
        if let Ok(refs) = serde_json::from_str::<Vec<MobbinRef>>(&content) {
            return refs;
        }
    }

    // New per-screen layout
    let mut out: Vec<MobbinRef> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&research_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
            // Skip the aggregate file if it failed to parse above
            if p.file_name().and_then(|s| s.to_str()) == Some("mobbin-refs.json") { continue; }
            let Ok(content) = std::fs::read_to_string(&p) else { continue };
            if let Ok(r) = serde_json::from_str::<MobbinRef>(&content) {
                out.push(r);
            }
        }
    }
    out.sort_by(|a, b| a.screen.cmp(&b.screen));
    out
}

/// During an active pipeline run, design files live in the active worktree's
/// `.dc/design/`. After merge (or when no run is active), they're in the project
/// root's `.dc/design/`.
///
/// Heuristic for picking the "live" dir: among the root and every worktree,
/// pick whichever `approval.json` was modified most recently. This rescues the
/// common case where a stale worktree is left behind by a killed run and would
/// otherwise mask the real (root) design state.
///
/// Falls back to the root dir if no `approval.json` exists anywhere.
fn resolve_design_dir(project_path: &str) -> PathBuf {
    let root_dir = PathBuf::from(project_path).join(".dc").join("design");
    let worktrees = PathBuf::from(project_path).join(".dc").join("worktrees");

    let mut candidates: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();

    let consider = |dir: PathBuf, out: &mut Vec<(PathBuf, std::time::SystemTime)>| {
        let approval = dir.join("approval.json");
        if let Ok(meta) = std::fs::metadata(&approval) {
            if let Ok(modified) = meta.modified() {
                out.push((dir, modified));
            }
        }
    };

    consider(root_dir.clone(), &mut candidates);

    if let Ok(entries) = std::fs::read_dir(&worktrees) {
        for entry in entries.flatten() {
            consider(entry.path().join(".dc").join("design"), &mut candidates);
        }
    }

    // Most recently modified approval.json wins.
    candidates.sort_by(|a, b| b.1.cmp(&a.1));

    if let Some((dir, _)) = candidates.into_iter().next() {
        return dir;
    }

    // No approval.json anywhere — fall back to the root dir (it might still have
    // mockups even without approval).
    root_dir
}

fn scan_mockups(dir: &std::path::Path) -> Vec<MockupInfo> {
    let mut out = Vec::new();
    walk_html(dir, dir, &mut out);
    // Order pages > organisms > molecules > atoms > root for natural reading
    fn category_rank(c: &str) -> u8 {
        match c {
            "pages" => 0,
            "organisms" => 1,
            "molecules" => 2,
            "atoms" => 3,
            "root" => 4,
            _ => 5,
        }
    }
    out.sort_by(|a, b| {
        category_rank(&a.category).cmp(&category_rank(&b.category))
            .then(a.name.cmp(&b.name))
    });
    out
}

fn walk_html(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<MockupInfo>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            // Recurse, but skip dotted dirs and node_modules etc.
            let dirname = entry.file_name().to_string_lossy().to_string();
            if dirname.starts_with('.') || dirname == "node_modules" {
                continue;
            }
            walk_html(root, &path, out);
            continue;
        }
        let filename = entry.file_name().to_string_lossy().to_string();
        if !filename.ends_with(".html") {
            continue;
        }

        let meta = entry.metadata().ok();
        let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified_at = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|d| chrono::DateTime::<Utc>::from_timestamp(d.as_secs() as i64, 0))
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_else(|| Utc::now().to_rfc3339());

        // Relative path from .dc/design/
        let rel = path.strip_prefix(root).map(|p| p.to_path_buf()).unwrap_or(path.clone());
        let rel_str = rel.to_string_lossy().to_string();

        // Category = first path component when nested, else "root"
        let category = rel.components().next()
            .and_then(|c| {
                let s = c.as_os_str().to_string_lossy().to_string();
                if s.ends_with(".html") { None } else { Some(s) }
            })
            .unwrap_or_else(|| "root".to_string());

        let title = extract_title(&path).unwrap_or_else(|| pretty_name(&filename));

        out.push(MockupInfo {
            name: rel_str,
            title,
            category,
            size_bytes,
            modified_at,
        });
    }
}

fn extract_title(path: &std::path::Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    // Look for <title>…</title>, take first 100 chars
    let head = &content[..content.len().min(2048)];
    let start = head.to_lowercase().find("<title>")?;
    let after = &head[start + 7..];
    let end = after.to_lowercase().find("</title>")?;
    Some(after[..end].trim().chars().take(100).collect())
}

fn pretty_name(name: &str) -> String {
    let stem = name.trim_end_matches(".html");
    stem.replace('-', " ").replace('_', " ")
}

fn read_approval(dir: &std::path::Path) -> Option<ApprovalState> {
    let path = dir.join("approval.json");
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

fn read_tokens(dir: &std::path::Path) -> Option<serde_json::Value> {
    let path = dir.join("design-tokens.json");
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

// ── Serve one mockup (HTML inline, sandboxed by iframe on the frontend) ──

pub async fn get_file(
    State(state): State<Arc<AppState>>,
    Path((project_id, filename)): Path<(String, String)>,
) -> Result<Response, StatusCode> {
    // Allow one subdir level (atoms/, molecules/, organisms/, pages/) but
    // refuse anything trying to escape with ".." or absolute paths.
    if !filename.ends_with(".html") || filename.contains("..") || filename.starts_with('/') {
        return Err(StatusCode::BAD_REQUEST);
    }

    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let file_path = resolve_design_dir(&project.path).join(&filename);

    let content = std::fs::read(&file_path).map_err(|_| StatusCode::NOT_FOUND)?;

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        // Allow iframing only from the Studio (frontend) origin.
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(content))
        .unwrap())
}

// ── Approve / Reject ──

pub async fn approve(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Json(payload): Json<ApprovalInput>,
) -> Result<Json<ApprovalState>, StatusCode> {
    write_approval(&state, &project_id, "approved", payload).await
}

pub async fn reject(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Json(payload): Json<ApprovalInput>,
) -> Result<Json<ApprovalState>, StatusCode> {
    write_approval(&state, &project_id, "rejected", payload).await
}

async fn write_approval(
    state: &Arc<AppState>,
    project_id: &str,
    status: &str,
    payload: ApprovalInput,
) -> Result<Json<ApprovalState>, StatusCode> {
    let project = state
        .db
        .get_project(project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let design_dir = resolve_design_dir(&project.path);
    std::fs::create_dir_all(&design_dir).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Build approval payload in the SHAPE the runtime gate expects (`approver`,
    // `approved_at`, plus our own `status/signer/notes/at` fields). The gate
    // reads `status` and is happy with anything additional.
    let approval = ApprovalState {
        status: status.to_string(),
        signer: payload.signer.clone(),
        at: Utc::now().to_rfc3339(),
        notes: payload.notes.clone(),
    };

    // Preserve the original approval.json shape (which the runtime wrote with
    // `version`, `link`, `screens_count`, `design_system`, `history`, etc.)
    // by merging onto it.
    let approval_path = design_dir.join("approval.json");
    let mut merged = std::fs::read_to_string(&approval_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = merged.as_object_mut() {
        obj.insert("status".to_string(), serde_json::json!(status));
        obj.insert("approver".to_string(), serde_json::json!(payload.signer));
        obj.insert("approved_at".to_string(), serde_json::json!(Utc::now().to_rfc3339()));
        obj.insert("notes".to_string(), serde_json::json!(payload.notes));
        // Append to history
        let history = obj.entry("history".to_string()).or_insert(serde_json::json!([]));
        if let Some(arr) = history.as_array_mut() {
            arr.push(serde_json::json!({
                "action": status,
                "at": Utc::now().to_rfc3339(),
                "by": payload.signer,
                "notes": payload.notes,
            }));
        }
    }

    let json = serde_json::to_string_pretty(&merged).unwrap();
    std::fs::write(&approval_path, json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Broadcast over WS so the UI updates immediately
    let _ = state.tx.send(WsMessage {
        msg_type: "design_approval".to_string(),
        data: serde_json::json!({
            "project_id": project_id,
            "status": status,
            "signer": approval.signer,
            "notes": approval.notes,
            "at": approval.at,
        }),
    });

    // When the user approves and the design lives in Stitch, automatically
    // kick off the "Stitch → code" regeneration. Reject does nothing.
    if status == "approved" {
        if let Some(project_id) = serde_json::Value::String(project_id.to_string()).as_str() {
            spawn_code_regeneration_if_applicable(state.clone(), project_id.to_string());
        }
    }

    Ok(Json(approval))
}

// ── Screen previews (Stitch thumbnails cached locally) ──

#[derive(Serialize, Deserialize, Clone)]
pub struct ScreenPreview {
    pub id: String,
    pub name: String,
    pub slug: String,
    /// CDN URL of the screenshot. May expire — re-fetch if stale.
    pub screenshot_url: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Serialize, Deserialize)]
pub struct ScreenPreviewsResponse {
    pub previews: Vec<ScreenPreview>,
    pub generated_at: String,
    pub stitch_project_id: String,
}

pub async fn screen_previews(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Result<Json<ScreenPreviewsResponse>, StatusCode> {
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let design_dir = resolve_design_dir(&project.path);
    let Some(stitch_project_id) = read_stitch_project_id(&design_dir) else {
        return Err(StatusCode::BAD_REQUEST);
    };

    let cache_path = design_dir.join("screen-previews.json");
    let screenshots_dir = design_dir.join("screenshots");
    let _ = std::fs::create_dir_all(&screenshots_dir);

    // The list of screens authorized for display — must match approval.json.
    let approved_ids: std::collections::HashSet<String> = read_stitch_screens(&design_dir)
        .into_iter()
        .map(|s| s.id)
        .collect();

    // Serve cached version if it exists, all screenshot files are present, and
    // the cache is reasonably fresh (< 24 hours).
    if let Ok(meta) = std::fs::metadata(&cache_path) {
        if let Ok(modified) = meta.modified() {
            let age = std::time::SystemTime::now()
                .duration_since(modified)
                .unwrap_or(std::time::Duration::from_secs(u64::MAX));
            if age.as_secs() < 24 * 3600 {
                if let Ok(content) = std::fs::read_to_string(&cache_path) {
                    if let Ok(cached) = serde_json::from_str::<ScreenPreviewsResponse>(&content) {
                        let all_files_exist = cached.previews.iter()
                            .filter(|p| p.screenshot_url.is_some())
                            .all(|p| screenshots_dir.join(format!("{}.png", p.id)).exists());
                        if all_files_exist && !cached.previews.is_empty() {
                            return Ok(Json(cached));
                        }
                    }
                }
            }
        }
    }

    // Cold path: write the raw MCP response to a temp file. We download the
    // images to disk and rewrite the JSON with local URLs before returning.
    let raw_path = design_dir.join("screen-previews.raw.json");
    let prompt = format!(
        "Call mcp__stitch__list_screens with projectId `{}`. For EACH screen returned, \
         call mcp__stitch__get_screen with that screenId. Collect: id (the screenId), \
         name (screen title), slug (lowercase-kebab from name), screenshot_url (the \
         `thumbnailScreenshot.downloadUrl` field), width and height. Write the result \
         to `{}` as a JSON object of EXACTLY this shape:\n\n\
         ```json\n\
         {{\n\
           \"previews\": [\n\
             {{ \"id\": \"...\", \"name\": \"...\", \"slug\": \"...\", \"screenshot_url\": \"...\", \"width\": 390, \"height\": 844 }}\n\
           ],\n\
           \"generated_at\": \"<ISO timestamp now>\",\n\
           \"stitch_project_id\": \"{}\"\n\
         }}\n\
         ```\n\
         If a screen has no screenshot, set screenshot_url to null. Use the \
         field name `screenshot_url` (snake_case), NOT camelCase. Be concise — no other output. \
         At the end output the literal `DC_PREVIEWS_DONE`.",
        stitch_project_id,
        raw_path.display(),
        stitch_project_id,
    );

    let spawn = tokio::process::Command::new("claude")
        .args([
            "-p",
            "--model", "haiku",
            "--dangerously-skip-permissions",
            "--output-format", "json",
            &prompt,
        ])
        .current_dir(&project.path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = spawn.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = child.wait().await;

    let content = std::fs::read_to_string(&raw_path)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut raw: ScreenPreviewsResponse = serde_json::from_str(&content)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Filter: keep ONLY screens that appear in approval.json. This is what the
    // user explicitly approved — anything else in the Stitch project is noise.
    if !approved_ids.is_empty() {
        raw.previews.retain(|p| approved_ids.contains(&p.id));
    }

    // De-dup by id, preferring entries with a screenshot URL.
    {
        let mut by_id: std::collections::BTreeMap<String, ScreenPreview> = std::collections::BTreeMap::new();
        for p in raw.previews.drain(..) {
            match by_id.get(&p.id) {
                Some(existing) if existing.screenshot_url.is_some() && p.screenshot_url.is_none() => { /* keep existing */ }
                _ => { by_id.insert(p.id.clone(), p); }
            }
        }
        raw.previews = by_id.into_values().collect();
    }

    // Download each screenshot to disk and rewrite the URL as a local route.
    for p in raw.previews.iter_mut() {
        let Some(url) = p.screenshot_url.clone() else { continue };
        if url.is_empty() || url == "null" {
            p.screenshot_url = None;
            continue;
        }
        let local_file = screenshots_dir.join(format!("{}.png", p.id));
        let ok = tokio::process::Command::new("curl")
            .args([
                "--silent", "--show-error",
                "--fail",
                "--max-time", "20",
                "--location",
                "--user-agent", "DonCheliStudio/1.0",
                "--output", local_file.to_string_lossy().as_ref(),
                &url,
            ])
            .status()
            .await
            .ok()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok && local_file.exists() {
            p.screenshot_url = Some(format!("/api/pipeline/{}/design/screen-preview-image/{}", project_id, p.id));
        } else {
            p.screenshot_url = None;
        }
    }

    // Persist the rewritten payload as the canonical cache.
    let json = serde_json::to_string_pretty(&raw).unwrap_or_default();
    let _ = std::fs::write(&cache_path, &json);
    let _ = std::fs::remove_file(&raw_path);

    Ok(Json(raw))
}

// ── Design assets (logo + future brand assets) ────────────────────────────

#[derive(Deserialize)]
pub struct UploadAssetInput {
    /// e.g. "logo". Final filename = `{name}.{ext}`.
    pub name: String,
    /// "png" | "jpg" | "jpeg" | "svg" | "webp"
    pub ext: String,
    /// Base64 (no data: prefix). Max ~5 MB before encoding.
    pub data_base64: String,
}

#[derive(Serialize)]
pub struct AssetInfo {
    pub name: String,
    pub ext: String,
    pub url: String,
    pub size_bytes: u64,
}

#[derive(Serialize)]
pub struct ListAssetsResponse {
    pub assets: Vec<AssetInfo>,
}

const ALLOWED_ASSET_EXTS: &[&str] = &["png", "jpg", "jpeg", "svg", "webp"];

pub async fn upload_asset(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Json(payload): Json<UploadAssetInput>,
) -> Result<Json<AssetInfo>, StatusCode> {
    if !is_safe_asset_name(&payload.name) || !ALLOWED_ASSET_EXTS.contains(&payload.ext.to_lowercase().as_str()) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.data_base64.trim())
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    // Cap at 5 MB
    if bytes.len() > 5 * 1024 * 1024 {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }

    let assets_dir = resolve_design_dir(&project.path).join("assets");
    std::fs::create_dir_all(&assets_dir).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Remove any previous extensions for the same name (overwrite logo regardless of ext).
    if let Ok(entries) = std::fs::read_dir(&assets_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                if stem == payload.name {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
    }

    let ext = payload.ext.to_lowercase();
    let file_path = assets_dir.join(format!("{}.{}", payload.name, ext));
    std::fs::write(&file_path, &bytes).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(AssetInfo {
        name: payload.name.clone(),
        ext: ext.clone(),
        url: format!("/api/pipeline/{}/design/asset/{}.{}", project_id, payload.name, ext),
        size_bytes: bytes.len() as u64,
    }))
}

pub async fn list_assets(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Result<Json<ListAssetsResponse>, StatusCode> {
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let assets_dir = resolve_design_dir(&project.path).join("assets");
    let mut out: Vec<AssetInfo> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&assets_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_file() { continue; }
            let Some(name) = p.file_stem().and_then(|s| s.to_str()) else { continue };
            let Some(ext) = p.extension().and_then(|s| s.to_str()) else { continue };
            if !ALLOWED_ASSET_EXTS.contains(&ext.to_lowercase().as_str()) { continue; }
            let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            out.push(AssetInfo {
                name: name.to_string(),
                ext: ext.to_lowercase(),
                url: format!("/api/pipeline/{}/design/asset/{}.{}", project_id, name, ext),
                size_bytes: size,
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Json(ListAssetsResponse { assets: out }))
}

pub async fn delete_asset(
    State(state): State<Arc<AppState>>,
    Path((project_id, filename)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err(StatusCode::BAD_REQUEST);
    }
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let path = resolve_design_dir(&project.path).join("assets").join(&filename);
    let existed = path.exists();
    let _ = std::fs::remove_file(&path);
    Ok(Json(serde_json::json!({ "removed": existed })))
}

pub async fn get_asset(
    State(state): State<Arc<AppState>>,
    Path((project_id, filename)): Path<(String, String)>,
) -> Result<Response, StatusCode> {
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err(StatusCode::BAD_REQUEST);
    }
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let path = resolve_design_dir(&project.path).join("assets").join(&filename);
    let bytes = std::fs::read(&path).map_err(|_| StatusCode::NOT_FOUND)?;
    let mime = match path.extension().and_then(|s| s.to_str()).map(|s| s.to_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    };
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "private, max-age=60")
        .body(Body::from(bytes))
        .unwrap())
}

fn is_safe_asset_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Serve a cached screen screenshot from `.dc/design/screenshots/<id>.png`.
pub async fn screen_preview_image(
    State(state): State<Arc<AppState>>,
    Path((project_id, screen_id)): Path<(String, String)>,
) -> Result<Response, StatusCode> {
    if screen_id.contains("..") || screen_id.contains('/') || screen_id.contains('\\') {
        return Err(StatusCode::BAD_REQUEST);
    }
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let path = resolve_design_dir(&project.path)
        .join("screenshots")
        .join(format!("{}.png", screen_id));
    let bytes = std::fs::read(&path).map_err(|_| StatusCode::NOT_FOUND)?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, "private, max-age=86400")
        .body(Body::from(bytes))
        .unwrap())
}

// ── Step 6: Stitch → code regeneration ──

/// Look up the project, check for a `stitch_project_id` in approval.json, and
/// if present spawn a `claude -p` that pulls each screen's htmlCode from Stitch
/// and rewrites `src/components/` + `src/app/`. No-op if no stitch metadata.
fn spawn_code_regeneration_if_applicable(state: Arc<AppState>, project_id: String) {
    tokio::spawn(async move {
        let Ok(Some(project)) = state.db.get_project(&project_id) else {
            tracing::warn!("Code regen skipped: project {} not found", project_id);
            return;
        };
        let design_dir = resolve_design_dir(&project.path);
        let Some(stitch_project_id) = read_stitch_project_id(&design_dir) else {
            tracing::info!("Code regen skipped for {}: no stitch_project_id in approval.json (legacy approval, nothing to do)", project_id);
            return;
        };
        run_code_regeneration(state, project.path.clone(), project_id.clone(), stitch_project_id).await;
    });
}

/// Auto-fix HIGH/CRITICAL findings from the most recent OWASP audit, then
/// re-run verification. Reads `.dc/audits/security.md` and dispatches a
/// focused sub-Claude with permission to write source files.
pub async fn security_autofix(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let audit_path = PathBuf::from(&project.path).join(".dc").join("audits").join("security.md");
    if !audit_path.exists() {
        return Ok(Json(serde_json::json!({
            "status": "rejected",
            "reason": "No `.dc/audits/security.md` to fix from. Run verification first.",
        })));
    }

    let st = state.clone();
    let project_path = project.path.clone();
    let pid = project_id.clone();

    let prompt = format!(
        "You are the SECURITY AUTOFIX agent for project `{}` (cwd: `{}`).\n\n\
         INPUT: `.dc/audits/security.md` contains a full OWASP Top 10 audit with \
         FINDING blocks. Each finding has a severity, file:line reference, description, \
         and a suggested remediation (often with code snippet).\n\n\
         YOUR JOB\n\
         1. Read the audit IN FULL.\n\
         2. Identify EVERY finding with severity `HIGH` or `CRITICAL`. Ignore MEDIUM/LOW \
            for this run (the user can address those later).\n\
         3. For each HIGH/CRITICAL, apply the suggested remediation. Use Edit/Write tools \
            on the exact files referenced. If the audit's snippet is sound, use it nearly \
            verbatim — adapt only to match the project's actual imports/conventions.\n\
         4. After EACH fix, briefly note what you did inline as a 1-line comment so the \
            diff is readable.\n\
         5. Do NOT touch findings of severity MEDIUM or LOW.\n\
         6. Do NOT modify `.dc/` files.\n\
         7. Do NOT downgrade dependencies or remove features. The goal is targeted security \
            patches, not refactors.\n\
         8. If a finding's suggested fix requires a new package, install it via the project's \
            package manager (npm/yarn/pnpm — infer from lockfile).\n\n\
         OUTPUT: when done, output the literal string `DC_SECURITY_AUTOFIX_DONE` followed by \
         a one-line summary: `fixed=N skipped=N` (N counts).\n",
        project.name, project.path,
    );

    let tx = st.tx.clone();
    tokio::spawn(async move {
        let _ = tx.send(WsMessage {
            msg_type: "security_autofix".to_string(),
            data: serde_json::json!({
                "project_id": pid,
                "status": "starting",
                "at": Utc::now().to_rfc3339(),
            }),
        });

        let result = crate::api::stream::stream_claude(
            st.clone(),
            crate::api::stream::StreamOpts {
                project_id: &pid,
                log_type: "security_autofix_log",
                status_type: "security_autofix",
                model: "sonnet",
                cwd: &project_path,
                prompt: &prompt,
            },
        ).await;

        let success = result.success;

        let _ = tx.send(WsMessage {
            msg_type: "security_autofix".to_string(),
            data: serde_json::json!({
                "project_id": pid,
                "status": if success { "fixed" } else { "failed" },
                "at": Utc::now().to_rfc3339(),
            }),
        });

        if !success { return; }

        // Re-run verification automatically so the user sees the new audit.
        crate::api::verification::verify_project(st, project_path, pid).await;
    });

    Ok(Json(serde_json::json!({ "status": "started" })))
}

/// Run ONLY the post-codegen verification (install + build + smoke + OWASP)
/// against whatever code is already on disk. Does NOT re-translate Stitch.
/// Useful when step 6 succeeded but verification was interrupted.
pub async fn verify_only(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let st = state.clone();
    let path = project.path.clone();
    let pid = project_id.clone();
    tokio::spawn(async move {
        crate::api::verification::verify_project(st, path, pid).await;
    });

    Ok(Json(serde_json::json!({ "status": "started" })))
}

/// Public entry point — used by the retry endpoint to force a re-run.
pub async fn apply_to_code(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let design_dir = resolve_design_dir(&project.path);
    let Some(stitch_project_id) = read_stitch_project_id(&design_dir) else {
        return Ok(Json(serde_json::json!({
            "status": "skipped",
            "reason": "no stitch_project_id in approval.json",
        })));
    };

    let st = state.clone();
    let path = project.path.clone();
    let pid = project_id.clone();
    tokio::spawn(async move {
        run_code_regeneration(st, path, pid, stitch_project_id).await;
    });

    Ok(Json(serde_json::json!({ "status": "started" })))
}

async fn run_code_regeneration(
    state: Arc<AppState>,
    project_path: String,
    project_id: String,
    stitch_project_id: String,
) {
    let prompt = code_regen_prompt(&project_path, &stitch_project_id);
    let tx = state.tx.clone();

    let _ = tx.send(WsMessage {
        msg_type: "code_regeneration".to_string(),
        data: serde_json::json!({
            "project_id": project_id,
            "status": "starting",
            "stitch_project_id": stitch_project_id,
            "at": Utc::now().to_rfc3339(),
        }),
    });

    let result = crate::api::stream::stream_claude(
        state.clone(),
        crate::api::stream::StreamOpts {
            project_id: &project_id,
            log_type: "code_regeneration_log",
            status_type: "code_regeneration",
            model: "sonnet",
            cwd: &project_path,
            prompt: &prompt,
        },
    ).await;

    let success = result.success;

    if !success {
        let _ = tx.send(WsMessage {
            msg_type: "code_regeneration".to_string(),
            data: serde_json::json!({
                "project_id": project_id,
                "status": "failed",
                "at": Utc::now().to_rfc3339(),
            }),
        });
        return;
    }

    // Code was written; emit `code_written` so the UI knows the implementation
    // agent is done — verification runs next as its own visible stage.
    let _ = tx.send(WsMessage {
        msg_type: "code_regeneration".to_string(),
        data: serde_json::json!({
            "project_id": project_id,
            "status": "code_written",
            "at": Utc::now().to_rfc3339(),
        }),
    });

    // Post-codegen verification: install + build + smoke test + OWASP scan.
    // Emits its own `code_verification` + `code_verification_log` WS events.
    crate::api::verification::verify_project(
        state.clone(),
        project_path.clone(),
        project_id.clone(),
    ).await;

    // Final completion signal once verification has resolved (passed/blocked/failed).
    let _ = tx.send(WsMessage {
        msg_type: "code_regeneration".to_string(),
        data: serde_json::json!({
            "project_id": project_id,
            "status": "completed",
            "at": Utc::now().to_rfc3339(),
        }),
    });
}

fn code_regen_prompt(project_path: &str, stitch_project_id: &str) -> String {
    format!(
        "You are the IMPLEMENTATION agent translating an approved Stitch design into \
         working React/Next.js code. The user has already reviewed and approved the \
         design in Stitch.\n\n\
         CONTEXT\n\
         - Project path (cwd): `{project_path}`\n\
         - Approved Stitch projectId: `{stitch_project_id}`\n\
         - Approval data (read it): `.dc/design/approval.json`\n\
         - Mobbin research (already used during design): `.dc/design/research/`\n\
         - Spec & blueprint: `.dc/specs/spec.feature`, `.dc/blueprints/blueprint.md`\n\n\
         STEP 1 — PULL SCREENS FROM STITCH\n\
         A) Call `stitch.list_screens(projectId=\"{stitch_project_id}\")` to get every \
            screen in the approved design.\n\
         B) For each screen, call `stitch.get_screen(...)` to retrieve its `htmlCode` \
            and `screenshot` URL. Cache the results in memory — do NOT write the raw \
            htmlCode to disk; we generate React components from it.\n\n\
         STEP 2 — READ CURRENT STACK\n\
         - Read `package.json` to identify the framework, UI kit, styling system.\n\
         - List `src/components/`, `src/app/` (or equivalent: `app/`, `pages/`, `components/`).\n\
         - Read 2–3 existing component files to learn naming conventions, import \
           patterns, file structure. Match them precisely.\n\n\
         STEP 3 — TRANSLATE HTML → REACT\n\
         For each Stitch screen:\n\
         1. Pick the correct target path. Default mapping for Next.js App Router:\n\
            - Page screens (login, dashboard, …) → `src/app/<slug>/page.tsx`\n\
            - Modal/dialog screens → `src/components/<slug>-modal.tsx`\n\
            - Reusable atoms detected in htmlCode → `src/components/ui/<name>.tsx`\n\
         2. Convert Stitch `htmlCode` to idiomatic React+Tailwind that matches the \
            existing codebase conventions. Specifically:\n\
            - Replace inline styles with Tailwind classes when possible.\n\
            - Reuse existing components from `src/components/` instead of duplicating \
              (e.g. if there's already a `Button` component, use it).\n\
            - Convert anchors with hrefs to `next/link`.\n\
            - Hook up form fields to the right state libraries already in use \
              (zustand, react-hook-form, etc.).\n\
            - Preserve semantic HTML (header, main, nav, button, label, …).\n\
         3. Wire up data: if the spec mentions Supabase / Mapbox / etc, plumb the \
            relevant client calls into the new components (do NOT just hard-code).\n\n\
         STEP 4 — UPDATE SHARED ASSETS\n\
         - If Stitch returned design tokens (or you can derive them from the screens), \
           update `tailwind.config.ts` colors / spacing / typography to match.\n\
         - If new Radix or lucide-react imports are needed, add them — but do NOT \
           introduce new top-level dependencies without need.\n\n\
         STEP 5 — VERIFY\n\
         - Do NOT run `npm install` or `npm run build`. Just write the files.\n\
         - At the end, list (for the user) every file you created/modified, grouped \
           by purpose.\n\n\
         WHAT NOT TO DO\n\
         - DO NOT touch `.dc/` files (specs, blueprints, design metadata).\n\
         - DO NOT delete files the user wrote. If a screen has no clear target, write \
           a new component rather than overwriting an unrelated one.\n\
         - DO NOT touch tests under `__tests__/` unless directly affected.\n\
         - DO NOT commit. The user reviews diffs.\n\n\
         OUTPUT: when finished, output the literal string `DC_CODE_REGEN_COMPLETE`.\n"
    )
}

// ── Generate mockups (one-shot, outside the pipeline) ──

pub async fn generate(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Json(payload): Json<GenerateInput>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let project_path = project.path.clone();
    let tx = state.tx.clone();

    // Build the prompt for design-html skill
    // If the caller passed a `prompt_override` we treat it as either:
    // (a) extra instructions to ADD to the default prompt (most common — the
    //     "Pedir cambios" modal sends user feedback as natural language), or
    // (b) a complete replacement (legacy path). We disambiguate: anything
    //     under ~400 chars and without "STEP 1" is treated as extra instructions.
    let prompt = match payload.prompt_override {
        Some(text) if text.trim().is_empty() => default_design_prompt(&project),
        Some(text) if text.len() < 400 && !text.contains("STEP 1") => {
            format!(
                "{}\n\nCHANGE REQUEST FROM THE USER (CRITICAL — apply these on top of the design):\n{}\n",
                default_design_prompt(&project),
                text.trim(),
            )
        }
        Some(text) => text,
        None => default_design_prompt(&project),
    };

    tokio::spawn(async move {
        let _ = tx.send(WsMessage {
            msg_type: "design_generation".to_string(),
            data: serde_json::json!({
                "project_id": project_id,
                "status": "starting",
                "at": Utc::now().to_rfc3339(),
            }),
        });

        // Ensure design dir exists
        let design_dir = PathBuf::from(&project_path).join(".dc").join("design");
        let _ = std::fs::create_dir_all(&design_dir);

        // Do NOT delete approval.json — keep the previous Stitch project visible
        // while regeneration runs. We just (a) snapshot it as `approval.previous.json`
        // for recovery and (b) flip `status` to "regenerating" so the UI can show
        // the right banner without losing stitch_url/stitch_project_id/screens.
        let approval = design_dir.join("approval.json");
        if approval.exists() {
            let _ = std::fs::copy(&approval, design_dir.join("approval.previous.json"));
            if let Ok(text) = std::fs::read_to_string(&approval) {
                if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(obj) = v.as_object_mut() {
                        obj.insert("status".to_string(), serde_json::json!("regenerating"));
                        obj.insert("regen_started_at".to_string(), serde_json::json!(Utc::now().to_rfc3339()));
                        if let Ok(pretty) = serde_json::to_string_pretty(&v) {
                            let _ = std::fs::write(&approval, pretty);
                        }
                    }
                }
            }
        }

        let result = crate::api::stream::stream_claude(
            state.clone(),
            crate::api::stream::StreamOpts {
                project_id: &project_id,
                log_type: "design_log",
                status_type: "design_generation",
                model: "sonnet",
                cwd: &project_path,
                prompt: &prompt,
            },
        ).await;

        let ok = result.success;

        let _ = tx.send(WsMessage {
            msg_type: "design_generation".to_string(),
            data: serde_json::json!({
                "project_id": project_id,
                "status": if ok { "done" } else { "failed" },
                "at": Utc::now().to_rfc3339(),
            }),
        });
    });

    Ok(Json(serde_json::json!({ "status": "started" })))
}

// ── Add screens (incremental, never resets approval) ──

pub async fn add_screens(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Json(payload): Json<AddScreensInput>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let project_path = project.path.clone();
    let design_dir = resolve_design_dir(&project_path);

    // Look up the existing Stitch project — without it there's nothing to add to.
    let Some(stitch_project_id) = read_stitch_project_id(&design_dir) else {
        return Ok(Json(serde_json::json!({
            "status": "rejected",
            "reason": "No existing Stitch project. Run /design/generate first.",
        })));
    };

    let existing_screens = read_stitch_screens(&design_dir);
    let count = payload.count.unwrap_or(4).min(6);
    let prompt = add_screens_prompt(
        &project.name,
        &stitch_project_id,
        &existing_screens,
        &payload.screens,
        count,
    );

    let tx = state.tx.clone();
    let pid = project_id.clone();
    tokio::spawn(async move {
        let _ = tx.send(WsMessage {
            msg_type: "design_generation".to_string(),
            data: serde_json::json!({
                "project_id": pid,
                "status": "starting",
                "mode": "add_screens",
                "at": Utc::now().to_rfc3339(),
            }),
        });

        let result = crate::api::stream::stream_claude(
            state.clone(),
            crate::api::stream::StreamOpts {
                project_id: &pid,
                log_type: "design_log",
                status_type: "design_generation",
                model: "sonnet",
                cwd: &project_path,
                prompt: &prompt,
            },
        ).await;

        let ok = result.success;
        let _ = tx.send(WsMessage {
            msg_type: "design_generation".to_string(),
            data: serde_json::json!({
                "project_id": pid,
                "status": if ok { "done" } else { "failed" },
                "mode": "add_screens",
                "at": Utc::now().to_rfc3339(),
            }),
        });
    });

    Ok(Json(serde_json::json!({ "status": "started" })))
}

fn add_screens_prompt(
    project_name: &str,
    stitch_project_id: &str,
    existing: &[StitchScreen],
    requested: &[String],
    count: u32,
) -> String {
    let existing_list = if existing.is_empty() {
        "  (none)".to_string()
    } else {
        existing.iter()
            .map(|s| format!("  · {} (slug: {})", s.name, s.slug))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let requested_block = if requested.is_empty() {
        "The user did NOT specify which screens — pick the most impactful screens \
         from the journey that are NOT already in the existing list."
            .to_string()
    } else {
        format!(
            "**REQUIRED — DO NOT SUBSTITUTE**\n\
             The user EXPLICITLY listed these {} screen slugs and ONLY these screens \
             must be created in this run (no others, no extras, no substitutions):\n\n\
             {}\n\n\
             RULES:\n\
             - Use these exact slugs in the `stitch_screens[].slug` field.\n\
             - You MAY choose a descriptive display name (e.g. slug `sos` → name \
               'Botón SOS — Emergencia en ruta'). Use the audit/blueprint to inform \
               the display name.\n\
             - If you think a different screen would be more valuable, you are WRONG \
               in this run — the user picked these. They can ask for more later.\n\
             - Do NOT pick screens like `descubrir`, `mi-contenido`, `convoy-activo` \
               unless they appear in the list above. The user already saw those \
               or rejected them.\n\
             - DO NOT exceed {} screens. Hit that exact target.",
            requested.len(),
            requested.iter().map(|s| format!("  · `{}`", s)).collect::<Vec<_>>().join("\n"),
            requested.len(),
        )
    };

    format!(
        "You are EXPANDING the existing design in Google Stitch for project \
         `{project_name}`. The user reviewed the first batch and asked for more screens. \
         You are NOT recreating anything — you are ADDING.\n\n\
         EXISTING STITCH PROJECT\n\
         - projectId: `{stitch_project_id}` (DO NOT call create_project — this project \
           already exists)\n\
         - Screens already in the project (DO NOT recreate these):\n{existing_list}\n\n\
         WHAT TO ADD\n\
         {requested_block}\n\n\
         Target: exactly {count} new screens. Sources of truth for picking them:\n\
         1. `.dc/blueprints/blueprint.md` — the journey + incomplete features.\n\
         2. `.dc/design/audit.md` — gaps the audit flagged.\n\
         3. `.dc/design/research/*.json` — Mobbin refs already gathered. Reuse them \
            if they match a new screen. Add more research only if needed.\n\
         4. `.dc/specs/spec.feature` — features that need a screen.\n\n\
         STEPS\n\
         1. Read those four sources. Pick {count} new screens that COMPLETE the journey \
            best. Output a short list of the names you chose BEFORE generating anything.\n\
         2. **BRAND ASSETS** — list `.dc/design/assets/`. If a `logo.*` file exists, \
            read it (Read tool supports images) and capture a 2-4 sentence description \
            (shape, main letter/icon, hex color(s), style). Include this verbatim in \
            every screen prompt so branding stays consistent with previous screens.\n\
         3. For each new screen, call `mcp__stitch__generate_screen_from_text` with \
            projectId `{stitch_project_id}` and a rich prompt that includes screen name, \
            purpose, UI elements, Mobbin takeaways, AND (if applicable) the logo \
            description from step 2. NEVER call create_project.\n\
         4. After ALL screens are created, UPDATE `.dc/design/approval.json`:\n\
            - Read the existing file.\n\
            - APPEND your new screens to the `stitch_screens` array (do NOT replace \
              the existing entries).\n\
            - Increment `mobbin_research_count` if you added new research files.\n\
            - Update `at` to the current ISO-8601 timestamp.\n\
            - Reset `status` to `\"in_review\"` (the user must re-approve after seeing \
              the expanded set).\n\
            - Keep `signer`, `notes`, `design_brief` as they are.\n\n\
         BUDGET DISCIPLINE\n\
         - {count} screens. Not more, not less. If you analyze the journey and pick 8, \
            cut down to {count}.\n\
         - Write the approval.json IMMEDIATELY after the last screen is created. If you \
            sense you are running out of turns/tokens, STOP creating screens and \
            UPDATE approval.json with whatever you successfully added.\n\
         - DO NOT write any `.html` files.\n\n\
         OUTPUT: when done, output `DC_DESIGN_ADD_COMPLETE` followed by a one-line \
         summary: added=N, total=M.\n",
    )
}

fn default_design_prompt(project: &crate::db::Project) -> String {
    let name = &project.name;
    format!(
        "You are the DESIGN phase for the project `{name}`.\n\n\
         GOAL: Produce a real, interactive design in Google Stitch (NOT local HTML files). \
         Stitch is the source of truth for the visual design; later, after the user \
         approves, another agent will translate the Stitch designs into React/Next code.\n\n\
         STEP 1 — READ CONTEXT (do this carefully, this is your map)\n\
         A) Read `.dc/specs/spec.feature` (or `spec.md`) for the canonical features.\n\
         B) Read `.dc/blueprints/blueprint.md` for vision, audience, stack, current vs \
            incomplete features.\n\
         C) **If `.dc/design/audit.md` exists, READ IT IN FULL**. It contains the most \
            recent expert analysis of any existing designs and TELLS YOU WHAT TO IMPROVE \
            screen by screen. Treat it as a strict requirements doc for the new design \
            — every concrete improvement listed there MUST be addressed.\n\
         D) **If `.dc/design/*.html` files exist**, open the 2–3 most central ones to \
            see the current direction (you are improving on this, not throwing it out).\n\
         E) **BRAND ASSETS — IMPORTANT** — list `.dc/design/assets/`. If a file named \
            `logo.png|jpg|svg|webp` exists, **READ THE IMAGE FILE** (Read tool supports \
            images) and write a 2–4 sentence description of it: shape, main letter/icon, \
            dominant color hex(es), style (flat / 3D / gradient), aspect ratio. You will \
            include this description in EVERY `generate_screen_from_text` prompt so Stitch \
            renders a consistent logo placement (top-left header, splash, etc.) across \
            screens. Stitch's MCP cannot upload the image directly; rich description is \
            the bridge.\n\
         F) List the project's UI surface (`src/`, `app/`, `web/`, `components/`, etc.) \
            to understand stack + conventions.\n\
         G) Identify **MAX 6 critical screens** for the user journey. Quality over \
            quantity. Pick the screens that move the product forward the most. If the \
            audit lists 10 screens, pick the 6 with highest impact — DO NOT try to do \
            all of them in one run. The user can iterate later.\n\n\
         STEP 2 — MOBBIN RESEARCH (REQUIRED)\n\
         For EACH screen, use the `mobbin` MCP to search for 2–3 real-world references. \
         Write the results to `.dc/design/research/<screen-slug>.json` with shape:\n\
         ```json\n\
         {{\n\
           \"screen\": \"<slug>\",\n\
           \"query\": \"<search query you used>\",\n\
           \"refs\": [\"<mobbin url>\", ...],\n\
           \"takeaways\": \"<2-3 sentences: layout, hierarchy, components to reuse>\"\n\
         }}\n\
         ```\n\
         DO NOT copy designs verbatim — use them as inspiration only.\n\n\
         STEP 3 — STITCH PROJECT (REQUIRED, IN THIS ORDER)\n\
         A) Call `stitch.create_project` with name `\"{name}\"` (or similar). \
            Capture the returned `projectId` and project URL.\n\
         B) Call `stitch.create_design_system` with a design-system object derived \
            from the project's stated aesthetic (color palette, typography, spacing). \
            Capture the returned design system identifier.\n\
         C) For EACH screen identified in step 1:\n\
            - Build a RICH text prompt for `stitch.generate_screen_from_text`. The \
              prompt MUST include: screen name, purpose, key UI elements, content \
              hints (use realistic placeholders — NO Lorem Ipsum), and references \
              to Mobbin takeaways for that screen.\n\
            - **If you captured a logo description in step 1E, include it verbatim** \
              with a placement directive (e.g. \"Top-left header includes the brand \
              logo: <description>\"). This keeps branding consistent across screens.\n\
            - Call `stitch.generate_screen_from_text(projectId, prompt)`. Capture the \
              returned `screenId` and `screenName`.\n\
         D) (Optional) Call `stitch.apply_design_system` to enforce consistency \
            across the generated screens.\n\n\
         STEP 4 — WRITE APPROVAL METADATA (REQUIRED — DO THIS IMMEDIATELY AFTER STEP 3)\n\
         This step is CRITICAL. Do not skip it. Do not run out of turns before writing \
         this file. If you have created the project and at least 3 screens, STOP further \
         screen generation and write the approval.json NOW with whatever you have so far. \
         Better an incomplete-but-recorded run than a complete-but-lost one.\n\n\
         Write `.dc/design/approval.json` with EXACTLY this shape:\n\
         ```json\n\
         {{\n\
           \"version\": 2,\n\
           \"status\": \"in_review\",\n\
           \"signer\": null,\n\
           \"at\": \"<ISO-8601 timestamp>\",\n\
           \"notes\": null,\n\
           \"stitch_project_id\": \"<projectId returned by stitch.create_project — REQUIRED>\",\n\
           \"stitch_screens\": [\n\
             {{ \"id\": \"<screenId>\", \"name\": \"<screen name>\", \"slug\": \"<slug>\" }}\n\
           ],\n\
           \"mobbin_research_count\": <number of files written to .dc/design/research/>,\n\
           \"design_brief\": \"<3-5 sentence summary of the design direction>\"\n\
         }}\n\
         ```\n\
         CRITICAL:\n\
         - `status` MUST be `in_review` — never `approved`. The user approves \
           manually from the Studio UI.\n\
         - DO NOT write `stitch_url` — the Studio backend builds the canonical URL \
           from `stitch_project_id`. Any URL you invent will be wrong.\n\
         - After approval, another agent reads `stitch_project_id` and pulls each \
           screen's `htmlCode` via `stitch.get_screen` to regenerate the React code.\n\n\
         WHAT NOT TO DO\n\
         - DO NOT write any `.html` files to `.dc/design/`. Stitch is the source of truth.\n\
         - DO NOT mark `status: approved`. Only the user can.\n\
         - DO NOT use Lorem Ipsum.\n\n\
         OUTPUT: when finished, output the literal string `DC_DESIGN_COMPLETE`.\n"
    )
}
