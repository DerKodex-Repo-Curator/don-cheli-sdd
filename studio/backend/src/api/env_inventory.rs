//! Env-var inventory for a project — scans all `.env*` and `local.properties`
//! files, lists keys (NEVER values, for security), and detects which services
//! are configured using the service catalog.

use axum::{Json, extract::{Path, State}, http::StatusCode};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Arc;

use crate::AppState;
use crate::api::service_catalog::{catalog, ServiceSpec};

#[derive(Serialize)]
pub struct EnvFile {
    /// Path relative to the project root.
    pub path: String,
    /// Stack/sub-dir this file belongs to (e.g. "next", "web", "android", "root").
    pub stack: String,
    /// `true` if this is an example/template file (e.g. `.env.example`) — those
    /// don't have real secrets and are usually safe to commit.
    pub is_example: bool,
    /// Just the key names — values are NEVER read or returned.
    pub keys: Vec<String>,
}

#[derive(Serialize)]
pub struct ServiceMatch {
    pub id: String,
    pub name: String,
    pub category: String,
    pub dashboard_url: String,
    pub docs_url: String,
    /// Sub-dirs/stacks where this service is configured.
    pub stacks: Vec<String>,
    /// Keys the catalog defines for this service.
    pub expected_keys: Vec<String>,
    /// Keys found in the env files that matched this service.
    pub configured_keys: Vec<String>,
    /// Keys from `expected_keys` that are NOT configured anywhere.
    pub missing_keys: Vec<String>,
}

#[derive(Serialize)]
pub struct SuggestionItem {
    pub id: String,
    pub name: String,
    pub reason: String,
}

#[derive(Serialize)]
pub struct EnvInventoryResponse {
    pub files: Vec<EnvFile>,
    pub services_detected: Vec<ServiceMatch>,
    /// Keys present in env files that didn't match any known service.
    pub orphan_keys: Vec<String>,
    pub suggestions: Vec<SuggestionItem>,
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Result<Json<EnvInventoryResponse>, StatusCode> {
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let root = PathBuf::from(&project.path);
    let mut files: Vec<EnvFile> = Vec::new();
    let mut all_keys: BTreeSet<String> = BTreeSet::new();

    // Walk top-level + 1 level deep (typical "stacks" layout).
    if root.is_dir() {
        collect_env_files(&root, &root, 0, 2, &mut files, &mut all_keys);
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));

    // Match each service in the catalog against the collected key names.
    let services = catalog();
    let mut services_detected: Vec<ServiceMatch> = Vec::new();
    let mut matched_keys: BTreeSet<String> = BTreeSet::new();

    // Build a per-service stack map: which sub-dirs have at least one matching key.
    for svc in &services {
        let mut configured_keys: BTreeSet<String> = BTreeSet::new();
        let mut stacks: BTreeSet<String> = BTreeSet::new();

        for f in &files {
            for k in &f.keys {
                if svc.env_var_patterns.iter().any(|pat| k.contains(pat)) {
                    configured_keys.insert(k.clone());
                    matched_keys.insert(k.clone());
                    stacks.insert(f.stack.clone());
                }
            }
        }

        if configured_keys.is_empty() { continue; }

        let expected_keys: Vec<String> = svc.env_keys.iter().map(|k| k.name.clone()).collect();
        let missing_keys: Vec<String> = expected_keys.iter()
            .filter(|expected| {
                // missing = not present in ANY of the env files we scanned
                !all_keys.iter().any(|k| k.eq_ignore_ascii_case(expected))
            })
            .cloned()
            .collect();

        services_detected.push(ServiceMatch {
            id: svc.id.clone(),
            name: svc.name.clone(),
            category: svc.category.clone(),
            dashboard_url: svc.dashboard_url.clone(),
            docs_url: svc.docs_url.clone(),
            stacks: stacks.into_iter().collect(),
            expected_keys,
            configured_keys: configured_keys.into_iter().collect(),
            missing_keys,
        });
    }
    services_detected.sort_by(|a, b| a.name.cmp(&b.name));

    let orphan_keys: Vec<String> = all_keys.iter()
        .filter(|k| !matched_keys.contains(*k))
        .cloned()
        .collect();

    // Heuristic suggestions: cross-reference design `approval.json` for hints
    // about features that imply additional services (e.g. a "Premium" screen
    // implies Stripe).
    let suggestions = build_suggestions(&root, &services_detected, &services);

    Ok(Json(EnvInventoryResponse {
        files,
        services_detected,
        orphan_keys,
        suggestions,
    }))
}

fn collect_env_files(
    root: &std::path::Path,
    dir: &std::path::Path,
    depth: usize,
    max_depth: usize,
    out: &mut Vec<EnvFile>,
    all_keys: &mut BTreeSet<String>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else { continue };

        if path.is_dir() {
            // Skip noise
            if matches!(name, "node_modules" | ".git" | ".next" | ".dc" | "target" | "build" | ".gradle" | "dist" | ".idea") {
                continue;
            }
            if depth < max_depth {
                collect_env_files(root, &path, depth + 1, max_depth, out, all_keys);
            }
            continue;
        }

        let interesting = name.starts_with(".env")
            || name == "local.properties"
            || name == ".firebaserc";
        if !interesting { continue; }

        let rel_path = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().to_string();
        let stack = stack_for_path(&rel_path);
        let is_example = name.contains(".example") || name.contains(".sample");

        let keys = parse_keys(&path);
        for k in &keys { all_keys.insert(k.clone()); }

        out.push(EnvFile { path: rel_path, stack, is_example, keys });
    }
}

fn stack_for_path(rel_path: &str) -> String {
    let parts: Vec<&str> = rel_path.split('/').collect();
    if parts.len() == 1 { return "root".to_string(); }
    parts[0].to_string()
}

fn parse_keys(path: &std::path::Path) -> Vec<String> {
    let Ok(content) = std::fs::read_to_string(path) else { return Vec::new() };
    let mut keys: BTreeMap<String, ()> = BTreeMap::new();

    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') || line.starts_with("//") {
            continue;
        }
        // Look for `KEY=...` patterns. Be permissive — could be KEY = "value", export KEY=value, etc.
        let unprefixed = line.strip_prefix("export ").unwrap_or(line);
        let Some((key_part, _)) = unprefixed.split_once('=') else { continue };
        let key = key_part.trim();
        if key.is_empty() { continue; }
        // Require ALL-CAPS-ish (avoid YAML lines, json fragments, etc.)
        let mostly_upper = key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.');
        let has_upper = key.chars().any(|c| c.is_ascii_uppercase());
        if !(mostly_upper && has_upper && key.len() <= 80) { continue; }
        keys.insert(key.to_string(), ());
    }
    keys.into_keys().collect()
}

fn build_suggestions(
    root: &std::path::Path,
    detected: &[ServiceMatch],
    catalog: &[ServiceSpec],
) -> Vec<SuggestionItem> {
    let detected_ids: BTreeSet<&str> = detected.iter().map(|s| s.id.as_str()).collect();
    let mut out: Vec<SuggestionItem> = Vec::new();

    // Heuristic: read approval.json for stitch_screens; if any screen mentions
    // "premium", "paywall", "checkout", "billing", suggest Stripe (if absent).
    let approval_path = root.join(".dc").join("design").join("approval.json");
    let mentions_payment = std::fs::read_to_string(&approval_path)
        .ok()
        .map(|t| {
            let lower = t.to_lowercase();
            lower.contains("premium") || lower.contains("paywall")
                || lower.contains("checkout") || lower.contains("billing")
                || lower.contains("subscription") || lower.contains("paid")
        })
        .unwrap_or(false);

    if mentions_payment && !detected_ids.contains("stripe") {
        if let Some(svc) = catalog.iter().find(|s| s.id == "stripe") {
            out.push(SuggestionItem {
                id: svc.id.clone(),
                name: svc.name.clone(),
                reason: "Detecté pantallas de Premium / Paywall en el diseño pero no veo Stripe configurado.".to_string(),
            });
        }
    }

    // If Firebase is used but Sentry isn't, suggest error tracking.
    if detected_ids.contains("firebase") && !detected_ids.contains("sentry") {
        if let Some(svc) = catalog.iter().find(|s| s.id == "sentry") {
            out.push(SuggestionItem {
                id: svc.id.clone(),
                name: svc.name.clone(),
                reason: "Usás Firebase pero no detecto error tracking. Sentry es el estándar.".to_string(),
            });
        }
    }

    // If using AdSense (monetization with ads) but no analytics, suggest PostHog.
    if detected_ids.contains("adsense") && !detected_ids.contains("posthog") {
        if let Some(svc) = catalog.iter().find(|s| s.id == "posthog") {
            out.push(SuggestionItem {
                id: svc.id.clone(),
                name: svc.name.clone(),
                reason: "Tenés monetización (AdSense) pero no veo product analytics. PostHog mide eventos sin tracking de ads.".to_string(),
            });
        }
    }

    out
}
