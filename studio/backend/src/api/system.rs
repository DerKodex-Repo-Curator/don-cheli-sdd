//! System info endpoint — framework version, paths, configured providers.

use axum::{Json, extract::State, http::StatusCode};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;

use crate::AppState;

#[derive(Serialize)]
pub struct SystemInfo {
    pub framework_version: Option<String>,
    pub framework_root: Option<String>,
    pub studio_db_path: String,
    pub hooks_installed: HooksInstalled,
}

#[derive(Serialize)]
pub struct HooksInstalled {
    pub claude: bool,
    pub codex: bool,
    pub opencode: bool,
}

pub async fn info(State(_state): State<Arc<AppState>>) -> Result<Json<SystemInfo>, StatusCode> {
    let root = resolve_framework_root();
    let version = root.as_ref()
        .and_then(|r| std::fs::read_to_string(r.join("VERSION")).ok())
        .map(|s| s.trim().to_string());

    let home = std::env::var("HOME").ok().map(PathBuf::from);
    let hooks_installed = HooksInstalled {
        claude: home.as_ref().map(|h| has_doncheli_hook(&h.join(".claude").join("settings.json"))).unwrap_or(false),
        codex: home.as_ref().map(|h| has_doncheli_hook(&h.join(".codex").join("hooks.json"))).unwrap_or(false),
        opencode: home.as_ref().map(|h| has_doncheli_hook(&h.join(".config").join("opencode").join("config.json"))).unwrap_or(false),
    };

    Ok(Json(SystemInfo {
        framework_version: version,
        framework_root: root.map(|p| p.to_string_lossy().to_string()),
        studio_db_path: "studio.db".to_string(),
        hooks_installed,
    }))
}

fn has_doncheli_hook(path: &std::path::Path) -> bool {
    let Ok(content) = std::fs::read_to_string(path) else { return false };
    content.contains("dc-hook.sh") || content.contains("\"managed_by\":\"don-cheli\"") || content.contains("managed_by: don-cheli")
}

fn resolve_framework_root() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Ok(canonical) = exe.canonicalize() {
            let mut root = canonical;
            for _ in 0..5 {
                if let Some(p) = root.parent() { root = p.to_path_buf(); }
            }
            if root.join("VERSION").exists() { return Some(root); }
        }
    }
    if let Ok(home) = std::env::var("FRAMEWORK_HOME") {
        let p = PathBuf::from(home);
        if p.join("VERSION").exists() { return Some(p); }
    }
    None
}
