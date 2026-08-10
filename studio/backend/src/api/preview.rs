//! Preview endpoints — detect how to run a generated app and optionally
//! spawn `npm install` + `npm run dev` for local preview.
//!
//! After Don Cheli's pipeline merges code into the project, the user
//! wants a single click to actually SEE the app running. This module
//! detects the framework and exposes the run commands.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::{Path as StdPath, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::AsyncBufReadExt;

use crate::AppState;
use crate::ws::WsMessage;

// ── Types ──

#[derive(Serialize, Clone)]
pub struct PreviewInfo {
    pub detected: bool,
    /// Framework name shown to the user: "Next.js", "Vite + React", "Python (Flask)", etc.
    pub framework: String,
    /// Absolute path of the folder containing package.json / pyproject.toml / etc.
    pub root: String,
    /// Relative path from project root → app root, e.g. "medelink/" or "."
    pub relative_root: String,
    pub package_manager: String,    // "npm" | "pnpm" | "yarn" | "pip" | "?"
    pub install_cmd: Option<String>,
    pub dev_cmd: Option<String>,
    pub build_cmd: Option<String>,
    pub default_port: Option<u16>,
    pub env_required: Vec<EnvVar>,
    /// Services detected from npm deps / env vars (Mapbox, Supabase, Stripe, etc.)
    pub services: Vec<crate::api::service_catalog::ServiceSpec>,
    /// Current values present in .env.local (only the KEY names, no values).
    /// Used by the frontend to know which keys still need to be filled in.
    pub env_keys_filled: Vec<String>,
    pub notes: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct EnvVar {
    pub name: String,
    pub example: Option<String>,
    pub description: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct PreviewStatus {
    pub running: bool,
    pub url: Option<String>,
    pub started_at: Option<String>,
    pub last_line: Option<String>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
pub struct StartInput {
    pub install: Option<bool>,
}

#[derive(Deserialize)]
pub struct WriteEnvInput {
    /// Map of KEY -> value
    pub vars: std::collections::HashMap<String, String>,
    /// Filename (default ".env.local"). Cannot contain "/" or "..".
    #[serde(default)]
    pub filename: Option<String>,
}

#[derive(Serialize)]
pub struct WriteEnvResponse {
    pub path: String,
    pub written_keys: Vec<String>,
}

// ── In-memory registry of running previews ──

#[derive(Default)]
pub struct PreviewRegistry {
    /// project_id -> running pid
    inner: Mutex<std::collections::HashMap<String, RunningPreview>>,
}

#[derive(Clone, Debug)]
struct RunningPreview {
    pid: u32,
    url: Option<String>,
    port: u16,
    started_at: String,
    last_line: String,
}

impl PreviewRegistry {
    pub fn new() -> Self { Self::default() }

    fn set(&self, project_id: String, p: RunningPreview) {
        self.inner.lock().unwrap().insert(project_id, p);
    }
    fn get(&self, project_id: &str) -> Option<RunningPreview> {
        self.inner.lock().unwrap().get(project_id).cloned()
    }
    fn update_line(&self, project_id: &str, line: String, url: Option<String>) {
        let mut g = self.inner.lock().unwrap();
        if let Some(p) = g.get_mut(project_id) {
            p.last_line = line;
            if let Some(u) = url { p.url = Some(u); }
        }
    }
    fn remove(&self, project_id: &str) -> Option<RunningPreview> {
        self.inner.lock().unwrap().remove(project_id)
    }
}

// ── Detection ──

pub async fn info(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Result<Json<PreviewInfo>, StatusCode> {
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let project_root = PathBuf::from(&project.path);
    Ok(Json(detect(&project_root)))
}

/// Lightweight info struct used by `projects::scan` / `projects::import_project`.
/// Built from the same detection logic as the full preview but without the
/// runnable-app fields the Ejecutar tab needs.
#[derive(Clone, Default)]
pub struct ScanInfo {
    pub framework: Option<String>,
    pub package_manager: Option<String>,
    pub deps: Vec<String>,
    pub services: Vec<crate::api::service_catalog::ServiceSpec>,
    pub file_count: u64,
    pub has_dc_artifacts: bool,
    pub git_remote: Option<String>,
}

/// Public wrapper around the internal detector — exposes a simplified shape
/// (Vec<String> deps, no commands) for the Import flow. Safe to call on any
/// folder; returns empty fields when nothing is detected.
pub fn detect_for_scan(project_root: &StdPath) -> ScanInfo {
    let info = detect(project_root);
    let deps_from_manifest = read_node_deps(project_root);
    let services = crate::api::service_catalog::detect_services(
        &deps_from_manifest,
        &info.env_required.iter().map(|e| e.name.clone()).collect::<Vec<_>>(),
    );
    let deps: Vec<String> = deps_from_manifest.keys().cloned().collect();
    let has_dc_artifacts = project_root.join(".dc").join("specs").exists()
        || project_root.join(".dc").join("blueprints").exists()
        || project_root.join(".dc").join("design").exists();
    let git_remote = std::process::Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(project_root)
        .output().ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    let file_count = count_files(project_root, 0, 3);

    ScanInfo {
        framework: if info.detected { Some(info.framework) } else { None },
        package_manager: if info.detected { Some(info.package_manager) } else { None },
        deps,
        services,
        file_count,
        has_dc_artifacts,
        git_remote,
    }
}

fn read_node_deps(root: &StdPath) -> std::collections::HashMap<String, String> {
    let Some(manifest) = find_manifest(root, 3) else { return Default::default() };
    if !manifest.ends_with("package.json") { return Default::default() }
    let Ok(content) = std::fs::read_to_string(&manifest) else { return Default::default() };
    let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) else { return Default::default() };
    let mut out = std::collections::HashMap::new();
    for key in ["dependencies", "devDependencies"] {
        if let Some(m) = pkg.get(key).and_then(|v| v.as_object()) {
            for (k, v) in m {
                out.insert(k.clone(), v.as_str().unwrap_or("").to_string());
            }
        }
    }
    out
}

fn count_files(dir: &StdPath, depth: u32, max_depth: u32) -> u64 {
    let mut count = 0;
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target"
            || name == "dist" || name == "build" || name == "__pycache__" { continue }
        let p = entry.path();
        if p.is_file() { count += 1; }
        else if p.is_dir() && depth < max_depth { count += count_files(&p, depth + 1, max_depth); }
    }
    count
}

fn detect(project_root: &StdPath) -> PreviewInfo {
    // Search for a runnable manifest up to 3 levels deep
    if let Some(found) = find_manifest(project_root, 3) {
        let rel = found.strip_prefix(project_root)
            .ok()
            .and_then(|p| p.parent())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let rel = if rel.is_empty() { ".".to_string() } else { rel };

        let manifest_name = found.file_name().and_then(|n| n.to_str()).unwrap_or("");
        return match manifest_name {
            "package.json" => detect_node(&found, &rel),
            "pyproject.toml" | "requirements.txt" => detect_python(&found, &rel),
            "Cargo.toml" => detect_rust(&found, &rel),
            _ => not_detected(),
        };
    }

    // Static HTML fallback: if there's an index.html at root, point to it
    if project_root.join("index.html").exists() {
        return PreviewInfo {
            detected: true,
            framework: "Sitio estático (HTML)".to_string(),
            root: project_root.to_string_lossy().to_string(),
            relative_root: ".".to_string(),
            package_manager: "—".to_string(),
            install_cmd: None,
            dev_cmd: Some("python3 -m http.server 3000".to_string()),
            build_cmd: None,
            default_port: Some(3000),
            env_required: vec![],
            services: vec![],
            env_keys_filled: vec![],
            notes: vec!["Sitio estático — el comando dev sirve index.html en localhost:3000".to_string()],
        };
    }

    not_detected()
}

fn not_detected() -> PreviewInfo {
    PreviewInfo {
        detected: false,
        framework: "No detectado".to_string(),
        root: String::new(),
        relative_root: ".".to_string(),
        package_manager: "—".to_string(),
        install_cmd: None,
        dev_cmd: None,
        build_cmd: None,
        default_port: None,
        env_required: vec![],
        services: vec![],
        env_keys_filled: vec![],
        notes: vec![
            "No se encontró package.json, pyproject.toml, ni Cargo.toml en los primeros 3 niveles del proyecto.".to_string(),
            "Una vez Don Cheli termine de generar código, esta sección se actualizará automáticamente.".to_string(),
        ],
    }
}

fn find_manifest(root: &StdPath, max_depth: u32) -> Option<PathBuf> {
    // BFS up to max_depth, prefer package.json > pyproject > Cargo
    let priorities = ["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml"];
    let mut queue: Vec<(PathBuf, u32)> = vec![(root.to_path_buf(), 0)];
    let mut best: Option<(usize, PathBuf)> = None;

    while let Some((dir, depth)) = queue.pop() {
        for (i, name) in priorities.iter().enumerate() {
            let candidate = dir.join(name);
            if candidate.exists() {
                match &best {
                    Some((j, _)) if *j <= i => {}
                    _ => best = Some((i, candidate)),
                }
            }
        }
        if depth >= max_depth { continue }
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let p = e.path();
                if !p.is_dir() { continue }
                let n = e.file_name().to_string_lossy().to_string();
                // Skip hidden, dependency, and Don Cheli folders
                if n.starts_with('.') || n == "node_modules" || n == "target" || n == "dist" || n == "build" || n == "venv" || n == "__pycache__" { continue }
                queue.push((p, depth + 1));
            }
        }
    }

    best.map(|(_, p)| p)
}

fn detect_node(manifest: &StdPath, rel: &str) -> PreviewInfo {
    let content = std::fs::read_to_string(manifest).unwrap_or_default();
    let pkg: serde_json::Value = serde_json::from_str(&content).unwrap_or(serde_json::Value::Null);
    let root = manifest.parent().map(|p| p.to_path_buf()).unwrap_or_default();

    let scripts = pkg.get("scripts").cloned().unwrap_or(serde_json::Value::Object(Default::default()));
    let deps = merge_deps(&pkg);

    let package_manager = if root.join("pnpm-lock.yaml").exists() { "pnpm" }
        else if root.join("yarn.lock").exists() { "yarn" }
        else { "npm" }.to_string();

    // Detect framework from deps
    let (framework, default_port) =
        if deps.contains_key("next") { ("Next.js", 3000) }
        else if deps.contains_key("nuxt") { ("Nuxt", 3000) }
        else if deps.contains_key("@remix-run/react") { ("Remix", 3000) }
        else if deps.contains_key("astro") { ("Astro", 4321) }
        else if deps.contains_key("vite") { ("Vite", 5173) }
        else if deps.contains_key("@sveltejs/kit") { ("SvelteKit", 5173) }
        else if deps.contains_key("@angular/core") { ("Angular", 4200) }
        else if deps.contains_key("express") { ("Express (Node)", 3000) }
        else if deps.contains_key("fastify") { ("Fastify (Node)", 3000) }
        else if deps.contains_key("react") { ("React", 3000) }
        else if deps.contains_key("vue") { ("Vue", 5173) }
        else { ("Node.js", 3000) };

    // Pick the dev script
    let dev_script_name = ["dev", "start", "serve"].iter()
        .find(|s| scripts.get(*s).is_some())
        .map(|s| s.to_string());
    let dev_cmd = dev_script_name.as_ref()
        .map(|s| format!("{} run {}", package_manager, s))
        .or_else(|| Some(format!("{} start", package_manager)));

    let build_cmd = scripts.get("build").map(|_| format!("{} run build", package_manager));

    let install_cmd = match package_manager.as_str() {
        "pnpm" => "pnpm install",
        "yarn" => "yarn install",
        _ => "npm install",
    }.to_string();

    let env_required = read_env_example(&root);
    let env_var_names: Vec<String> = env_required.iter().map(|e| e.name.clone()).collect();
    let services = crate::api::service_catalog::detect_services(&deps, &env_var_names);
    let env_keys_filled = read_env_filled(&root);

    let mut notes = Vec::new();
    if rel != "." {
        notes.push(format!("La app está en la subcarpeta {}/. Los comandos se ejecutan desde ahí.", rel));
    }

    PreviewInfo {
        detected: true,
        framework: framework.to_string(),
        root: root.to_string_lossy().to_string(),
        relative_root: rel.to_string(),
        package_manager,
        install_cmd: Some(install_cmd),
        dev_cmd,
        build_cmd,
        default_port: Some(default_port),
        env_required,
        services,
        env_keys_filled,
        notes,
    }
}

/// Read .env.local and return the names of keys that already have a non-empty value.
fn read_env_filled(root: &std::path::Path) -> Vec<String> {
    let candidates = [".env.local", ".env"];
    let mut out = Vec::new();
    for name in candidates {
        let path = root.join(name);
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
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
                    out.push(k.trim().to_string());
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

fn merge_deps(pkg: &serde_json::Value) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    for key in ["dependencies", "devDependencies", "peerDependencies"] {
        if let Some(map) = pkg.get(key).and_then(|v| v.as_object()) {
            for (k, v) in map {
                out.insert(k.clone(), v.as_str().unwrap_or("").to_string());
            }
        }
    }
    out
}

fn read_env_example(root: &StdPath) -> Vec<EnvVar> {
    let candidates = [".env.example", ".env.sample", ".env.local.example"];
    for name in candidates {
        let path = root.join(name);
        if !path.exists() { continue }
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        let mut out = Vec::new();
        let mut last_comment: Option<String> = None;
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() { last_comment = None; continue }
            if let Some(rest) = line.strip_prefix('#') {
                last_comment = Some(rest.trim().to_string());
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                let k = k.trim().to_string();
                let example = if v.trim().is_empty() { None } else { Some(v.trim().trim_matches(|c| c == '"' || c == '\'').to_string()) };
                out.push(EnvVar {
                    name: k,
                    example,
                    description: last_comment.take(),
                });
            }
        }
        return out;
    }
    Vec::new()
}

fn detect_python(manifest: &StdPath, rel: &str) -> PreviewInfo {
    let root = manifest.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let mut framework = "Python".to_string();
    let mut dev_cmd: Option<String> = None;
    let mut port = 8000;

    if let Ok(content) = std::fs::read_to_string(manifest) {
        let lower = content.to_lowercase();
        if lower.contains("fastapi") {
            framework = "FastAPI".to_string();
            dev_cmd = Some("uvicorn main:app --reload --port 8000".to_string());
            port = 8000;
        } else if lower.contains("flask") {
            framework = "Flask".to_string();
            dev_cmd = Some("flask --app app run --debug --port 5000".to_string());
            port = 5000;
        } else if lower.contains("django") {
            framework = "Django".to_string();
            dev_cmd = Some("python manage.py runserver 0.0.0.0:8000".to_string());
            port = 8000;
        }
    }

    let env_required = read_env_example(&root);
    let env_var_names: Vec<String> = env_required.iter().map(|e| e.name.clone()).collect();
    let services = crate::api::service_catalog::detect_services(&std::collections::HashMap::new(), &env_var_names);
    let env_keys_filled = read_env_filled(&root);

    PreviewInfo {
        detected: true,
        framework,
        root: root.to_string_lossy().to_string(),
        relative_root: rel.to_string(),
        package_manager: "pip".to_string(),
        install_cmd: Some("pip install -r requirements.txt".to_string()),
        dev_cmd,
        build_cmd: None,
        default_port: Some(port),
        env_required,
        services,
        env_keys_filled,
        notes: vec!["Recomendado crear un virtualenv antes: python3 -m venv venv && source venv/bin/activate".to_string()],
    }
}

fn detect_rust(manifest: &StdPath, rel: &str) -> PreviewInfo {
    let root = manifest.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let env_required = read_env_example(&root);
    let env_keys_filled = read_env_filled(&root);
    PreviewInfo {
        detected: true,
        framework: "Rust (Cargo)".to_string(),
        root: root.to_string_lossy().to_string(),
        relative_root: rel.to_string(),
        package_manager: "cargo".to_string(),
        install_cmd: Some("cargo build".to_string()),
        dev_cmd: Some("cargo run".to_string()),
        build_cmd: Some("cargo build --release".to_string()),
        default_port: None,
        env_required,
        services: vec![],
        env_keys_filled,
        notes: vec![],
    }
}

// ── Start / Stop ──

pub async fn start(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Json(payload): Json<StartInput>,
) -> Result<Json<PreviewStatus>, StatusCode> {
    let project = state.db.get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let info = detect(StdPath::new(&project.path));
    if !info.detected {
        return Err(StatusCode::BAD_REQUEST);
    }

    // If already running, return current status
    if let Some(p) = state.previews.get(&project_id) {
        return Ok(Json(PreviewStatus {
            running: true,
            url: p.url.clone().or_else(|| Some(format!("http://localhost:{}", p.port))),
            started_at: Some(p.started_at),
            last_line: Some(p.last_line),
            error: None,
        }));
    }

    let dev_cmd = info.dev_cmd.clone().ok_or(StatusCode::BAD_REQUEST)?;
    let cwd = info.root.clone();
    let port = info.default_port.unwrap_or(3000);
    let install = payload.install.unwrap_or(false);

    let started_at = Utc::now().to_rfc3339();

    // Build a shell command: optionally install first then run dev
    let install_cmd = info.install_cmd.clone().unwrap_or_default();
    let full = if install && !install_cmd.is_empty() {
        format!("{} && {}", install_cmd, dev_cmd)
    } else {
        dev_cmd.clone()
    };

    // Spawn via `sh -c` so we can chain && and reuse user's PATH
    let spawn = tokio::process::Command::new("sh")
        .args(["-c", &full])
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match spawn {
        Ok(c) => c,
        Err(e) => return Ok(Json(PreviewStatus {
            running: false, url: None, started_at: None, last_line: None,
            error: Some(format!("spawn failed: {}", e)),
        })),
    };

    let pid = child.id().unwrap_or(0);
    state.previews.set(project_id.clone(), RunningPreview {
        pid,
        url: None,
        port,
        started_at: started_at.clone(),
        last_line: format!("starting: {}", full),
    });

    let tx = state.tx.clone();
    let pid_str = project_id.clone();
    let port_for_task = port;
    let previews = state.previews.clone();

    // Forward stdout to WS and detect ready URL
    if let Some(stdout) = child.stdout.take() {
        let tx_out = tx.clone();
        let pid_out = pid_str.clone();
        let previews_out = previews.clone();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let url = extract_url(&line, port_for_task);
                previews_out.update_line(&pid_out, line.clone(), url.clone());
                let _ = tx_out.send(WsMessage {
                    msg_type: "preview_log".to_string(),
                    data: serde_json::json!({
                        "project_id": pid_out,
                        "line": line,
                        "url": url,
                        "stream": "stdout",
                    }),
                });
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let tx_err = tx.clone();
        let pid_err = pid_str.clone();
        let previews_err = previews.clone();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                previews_err.update_line(&pid_err, line.clone(), None);
                let _ = tx_err.send(WsMessage {
                    msg_type: "preview_log".to_string(),
                    data: serde_json::json!({
                        "project_id": pid_err,
                        "line": line,
                        "stream": "stderr",
                    }),
                });
            }
        });
    }

    // Reap the child when it exits, clean up registry
    let pid_exit = pid_str.clone();
    let previews_exit = previews.clone();
    let tx_exit = tx.clone();
    tokio::spawn(async move {
        let _ = child.wait().await;
        previews_exit.remove(&pid_exit);
        let _ = tx_exit.send(WsMessage {
            msg_type: "preview_stopped".to_string(),
            data: serde_json::json!({ "project_id": pid_exit }),
        });
    });

    Ok(Json(PreviewStatus {
        running: true,
        url: Some(format!("http://localhost:{}", port)),
        started_at: Some(started_at),
        last_line: Some(format!("starting: {}", full)),
        error: None,
    }))
}

pub async fn stop(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Result<Json<PreviewStatus>, StatusCode> {
    let removed = state.previews.remove(&project_id);
    if let Some(p) = &removed {
        // Try SIGTERM first via shell to also kill child shell descendants
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &p.pid.to_string()])
            .output();
    }
    Ok(Json(PreviewStatus {
        running: false,
        url: None,
        started_at: removed.as_ref().map(|p| p.started_at.clone()),
        last_line: removed.map(|p| p.last_line),
        error: None,
    }))
}

pub async fn status(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Json<PreviewStatus> {
    if let Some(p) = state.previews.get(&project_id) {
        Json(PreviewStatus {
            running: true,
            url: p.url.clone().or_else(|| Some(format!("http://localhost:{}", p.port))),
            started_at: Some(p.started_at),
            last_line: Some(p.last_line),
            error: None,
        })
    } else {
        Json(PreviewStatus {
            running: false, url: None, started_at: None, last_line: None, error: None,
        })
    }
}

/// Write a .env.local (or chosen filename) into the detected app root with the
/// values supplied by the user. This is the single point where API keys and
/// other secrets get persisted — Don Cheli itself never asks for them.
pub async fn write_env(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Json(payload): Json<WriteEnvInput>,
) -> Result<Json<WriteEnvResponse>, StatusCode> {
    let project = state.db.get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let info = detect(StdPath::new(&project.path));
    if !info.detected {
        return Err(StatusCode::BAD_REQUEST);
    }

    let filename = payload.filename.unwrap_or_else(|| ".env.local".to_string());
    if filename.contains('/') || filename.contains("..") {
        return Err(StatusCode::BAD_REQUEST);
    }

    let dest = PathBuf::from(&info.root).join(&filename);

    // Build a deterministic .env file: existing values stay, new keys appended,
    // existing keys overwritten. Comments survive.
    let existing = std::fs::read_to_string(&dest).unwrap_or_default();
    let mut output = String::new();
    let mut written: std::collections::HashSet<String> = std::collections::HashSet::new();

    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            output.push_str(line); output.push('\n');
            continue;
        }
        if let Some((k, _)) = trimmed.split_once('=') {
            let key = k.trim();
            if let Some(v) = payload.vars.get(key) {
                output.push_str(&format!("{}={}\n", key, escape_env_value(v)));
                written.insert(key.to_string());
                continue;
            }
        }
        output.push_str(line); output.push('\n');
    }

    // Append any keys not already present
    let mut new_keys: Vec<&String> = payload.vars.keys()
        .filter(|k| !written.contains(*k))
        .collect();
    new_keys.sort();
    if !new_keys.is_empty() {
        if !output.ends_with('\n') { output.push('\n'); }
        if !output.is_empty() && !output.ends_with("\n\n") { output.push('\n'); }
        output.push_str("# Added by Don Cheli Studio\n");
        for k in new_keys {
            output.push_str(&format!("{}={}\n", k, escape_env_value(&payload.vars[k])));
            written.insert(k.clone());
        }
    }

    std::fs::write(&dest, output).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(WriteEnvResponse {
        path: dest.to_string_lossy().to_string(),
        written_keys: written.into_iter().collect(),
    }))
}

fn escape_env_value(v: &str) -> String {
    if v.is_empty() { return String::new() }
    let needs_quotes = v.contains(' ') || v.contains('#') || v.contains('"') || v.contains('\'') || v.contains('\n');
    if !needs_quotes { return v.to_string() }
    let escaped = v.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n");
    format!("\"{}\"", escaped)
}

/// Look for a localhost URL in a log line.
fn extract_url(line: &str, port: u16) -> Option<String> {
    // Common patterns: "Local:   http://localhost:3000", "ready - started server on 0.0.0.0:3000"
    let lower = line.to_lowercase();
    for needle in ["http://localhost:", "http://127.0.0.1:", "http://0.0.0.0:"] {
        if let Some(idx) = lower.find(needle) {
            let after = &line[idx..];
            // Read until whitespace, comma, or ANSI escape
            let end = after.find(|c: char| c.is_whitespace() || c == ',' || c == '\x1b').unwrap_or(after.len());
            return Some(after[..end].to_string());
        }
    }
    if lower.contains(&format!(":{}", port)) || lower.contains("ready") {
        return Some(format!("http://localhost:{}", port));
    }
    None
}
