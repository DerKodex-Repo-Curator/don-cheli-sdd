//! MCP servers — list configured servers and suggest useful ones.
//!
//! Reads `~/.claude.json` (mcpServers) and `~/.claude/mcp.json`.
//! Sensitive fields (headers, env values) are stripped before serializing.

use axum::{Json, extract::Path, http::StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

#[derive(Serialize)]
pub struct McpServer {
    pub name: String,
    /// "http" | "stdio" | "sse"
    pub transport: String,
    pub url: Option<String>,
    pub command: Option<String>,
    pub scope: String, // "user" | "global"
    pub status: String, // "connected" | "needs_auth" | "unknown" | "disabled"
    pub requires_auth: bool,
    pub source_file: String,
    /// false if this server lives in `disabledMcpServers` (stash) — Claude
    /// ignores it but the config is preserved.
    pub enabled: bool,
}

#[derive(Serialize)]
pub struct McpSuggestion {
    pub id: String,
    pub name: String,
    pub category: String,
    pub description: String,
    pub install_hint: String,
    pub docs_url: Option<String>,
}

#[derive(Serialize)]
pub struct McpListResponse {
    pub installed: Vec<McpServer>,
    pub suggestions: Vec<McpSuggestion>,
    pub mobbin_auth_command: String,
}

pub async fn list() -> Result<Json<McpListResponse>, StatusCode> {
    let mut installed: Vec<McpServer> = Vec::new();
    let home = std::env::var("HOME").map(PathBuf::from).ok();

    // Source 1: ~/.claude.json — `mcpServers` (enabled) and `disabledMcpServers` (stashed).
    if let Some(h) = home.as_ref() {
        let path = h.join(".claude.json");
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(json) = serde_json::from_str::<Value>(&text) {
                if let Some(servers) = json.get("mcpServers").and_then(|v| v.as_object()) {
                    for (name, cfg) in servers {
                        installed.push(parse_server(name, cfg, "user", path.to_string_lossy().as_ref(), true));
                    }
                }
                if let Some(servers) = json.get("disabledMcpServers").and_then(|v| v.as_object()) {
                    for (name, cfg) in servers {
                        if installed.iter().any(|s| s.name == *name) { continue; }
                        installed.push(parse_server(name, cfg, "user", path.to_string_lossy().as_ref(), false));
                    }
                }
            }
        }
    }

    // Source 2: ~/.claude/mcp.json (project-bag config)
    if let Some(h) = home.as_ref() {
        let path = h.join(".claude").join("mcp.json");
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(json) = serde_json::from_str::<Value>(&text) {
                if let Some(servers) = json.get("mcpServers").and_then(|v| v.as_object()) {
                    for (name, cfg) in servers {
                        if installed.iter().any(|s| s.name == *name) { continue; }
                        installed.push(parse_server(name, cfg, "global", path.to_string_lossy().as_ref(), true));
                    }
                }
            }
        }
    }

    // Enrich with live status from `claude mcp list` (best-effort, 3s timeout)
    if let Some(statuses) = query_claude_status() {
        for s in installed.iter_mut() {
            if let Some(st) = statuses.iter().find(|(n, _, _)| n.eq_ignore_ascii_case(&s.name)) {
                s.status = st.1.clone();
                s.requires_auth = st.2;
            }
        }
    }

    let suggestions = curated_suggestions();

    Ok(Json(McpListResponse {
        installed,
        suggestions,
        mobbin_auth_command: "claude mcp list  # luego en el CLI interactivo: /mcp → mobbin → Auth".to_string(),
    }))
}

fn parse_server(name: &str, cfg: &Value, scope: &str, source: &str, enabled: bool) -> McpServer {
    let transport = cfg
        .get("type").and_then(|v| v.as_str())
        .or_else(|| if cfg.get("url").is_some() { Some("http") } else if cfg.get("command").is_some() { Some("stdio") } else { None })
        .unwrap_or("unknown")
        .to_string();

    let url = cfg.get("url").and_then(|v| v.as_str()).map(String::from);
    let command = cfg.get("command").and_then(|v| v.as_str()).map(String::from);

    // Heuristic: HTTP MCPs without `X-Goog-Api-Key` or `Authorization` headers likely need OAuth
    let requires_auth = url.is_some()
        && cfg.get("headers")
            .and_then(|h| h.as_object())
            .map(|h| h.is_empty()
                || !(h.contains_key("X-Goog-Api-Key")
                    || h.contains_key("Authorization")
                    || h.contains_key("authorization")))
            .unwrap_or(true);

    McpServer {
        name: name.to_string(),
        transport,
        url,
        command,
        scope: scope.to_string(),
        status: if enabled { "unknown".to_string() } else { "disabled".to_string() },
        requires_auth,
        source_file: source.to_string(),
        enabled,
    }
}

/// Returns Vec<(name, status, requires_auth)> by parsing `claude mcp list`.
fn query_claude_status() -> Option<Vec<(String, String, bool)>> {
    let claude_bin = locate_claude_bin()?;
    let mut child = Command::new(&claude_bin)
        .arg("mcp")
        .arg("list")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    // poll for up to 6s (claude mcp list typically takes ~3s)
    let deadline = std::time::Instant::now() + Duration::from_millis(6000);
    loop {
        if let Some(_status) = child.try_wait().ok().flatten() { break; }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            return None;
        }
        std::thread::sleep(Duration::from_millis(80));
    }

    let output = child.wait_with_output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);

    let mut out: Vec<(String, String, bool)> = Vec::new();
    for line in stdout.lines() {
        // Format: "name: url - status"
        let Some((left, right)) = line.split_once(':') else { continue };
        let name_raw = left.trim();
        if name_raw.is_empty() || name_raw.starts_with('#') || name_raw.contains(' ') && !name_raw.contains('.') {
            // Allow "claude.ai Gmail" style names, but skip the section header
            if name_raw.eq_ignore_ascii_case("Checking MCP server health") { continue; }
        }

        let after_url = right.rsplit_once(" - ").map(|(_, s)| s).unwrap_or("");
        let lower = after_url.to_lowercase();
        let (status, needs_auth) = if lower.contains("connected") {
            ("connected".to_string(), false)
        } else if lower.contains("needs authentication") || lower.contains("authentication") {
            ("needs_auth".to_string(), true)
        } else {
            ("unknown".to_string(), false)
        };

        out.push((name_raw.to_string(), status, needs_auth));
    }
    Some(out)
}

fn locate_claude_bin() -> Option<PathBuf> {
    // 1) PATH inherited
    if let Ok(path_env) = std::env::var("PATH") {
        for dir in path_env.split(':') {
            let candidate = PathBuf::from(dir).join("claude");
            if candidate.is_file() { return Some(candidate); }
        }
    }
    // 2) Common locations
    let home = std::env::var("HOME").ok().map(PathBuf::from)?;
    let candidates = [
        home.join(".local").join("bin").join("claude"),
        home.join(".claude").join("local").join("claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

fn curated_suggestions() -> Vec<McpSuggestion> {
    // CLI syntax (current): `claude mcp add [options] <name> <commandOrUrl> [args...]`
    //   - HTTP/SSE servers: positional URL + `-t http|sse`
    //   - stdio servers: command after `--` (e.g. `-- npx pkg --flag`)
    //   - We default to `-s user` so MCPs are visible across all projects/sessions.
    vec![
        McpSuggestion {
            id: "linear".to_string(),
            name: "Linear".to_string(),
            category: "Project management".to_string(),
            description: "Lee y crea issues, sprints y proyectos en Linear. Útil para que Don Cheli sincronice tareas con tu backlog.".to_string(),
            install_hint: "claude mcp add -s user -t sse linear https://mcp.linear.app/sse".to_string(),
            docs_url: Some("https://linear.app/integrations/claude".to_string()),
        },
        McpSuggestion {
            id: "github".to_string(),
            name: "GitHub".to_string(),
            category: "Code".to_string(),
            description: "Acceso a PRs, issues, reviews y workflows. Complementa el `gh` CLI con consultas más amplias.".to_string(),
            install_hint: "claude mcp add -s user -t http github https://api.githubcopilot.com/mcp/".to_string(),
            docs_url: Some("https://github.com/github/github-mcp-server".to_string()),
        },
        McpSuggestion {
            id: "sentry".to_string(),
            name: "Sentry".to_string(),
            category: "Observability".to_string(),
            description: "Trae errores y traces de Sentry directamente al chat — útil al diagnosticar bugs en producción.".to_string(),
            install_hint: "claude mcp add -s user -t http sentry https://mcp.sentry.dev/mcp".to_string(),
            docs_url: Some("https://docs.sentry.io/product/sentry-mcp/".to_string()),
        },
        McpSuggestion {
            id: "slack".to_string(),
            name: "Slack".to_string(),
            category: "Comunicación".to_string(),
            description: "Lee mensajes y publica resúmenes en canales. Conviene para reportar avances del pipeline.".to_string(),
            install_hint: "claude mcp add -s user -t sse slack https://mcp.slack.com/sse".to_string(),
            docs_url: Some("https://api.slack.com/docs".to_string()),
        },
        McpSuggestion {
            id: "notion".to_string(),
            name: "Notion".to_string(),
            category: "Documentación".to_string(),
            description: "Lee y escribe páginas en Notion. Útil para mantener documentación de proyecto al día.".to_string(),
            install_hint: "claude mcp add -s user -t http notion https://mcp.notion.com/mcp".to_string(),
            docs_url: Some("https://developers.notion.com/docs/mcp".to_string()),
        },
        McpSuggestion {
            id: "figma".to_string(),
            name: "Figma".to_string(),
            category: "Diseño".to_string(),
            description: "Extrae specs y assets de Figma. Requiere FIGMA_KEY en el entorno. Complementa Stitch para diseño dirigido por mockups existentes.".to_string(),
            install_hint: "claude mcp add -s user figma -- npx -y figma-developer-mcp --figma-api-key=$FIGMA_KEY".to_string(),
            docs_url: Some("https://www.framelink.ai/docs/quickstart".to_string()),
        },
        McpSuggestion {
            id: "playwright".to_string(),
            name: "Playwright".to_string(),
            category: "Testing".to_string(),
            description: "Automatiza navegadores para tests E2E. Ideal para que Don Cheli verifique flujos UI antes de mergear.".to_string(),
            install_hint: "claude mcp add -s user playwright -- npx @playwright/mcp@latest".to_string(),
            docs_url: Some("https://github.com/microsoft/playwright-mcp".to_string()),
        },
        McpSuggestion {
            id: "context7".to_string(),
            name: "Context7".to_string(),
            category: "Documentación".to_string(),
            description: "Trae documentación oficial actualizada de librerías al contexto. Reduce alucinaciones en código.".to_string(),
            install_hint: "claude mcp add -s user -t http context7 https://mcp.context7.com/mcp".to_string(),
            docs_url: Some("https://github.com/upstash/context7".to_string()),
        },
        McpSuggestion {
            id: "mobile-next".to_string(),
            name: "Mobile Next".to_string(),
            category: "Mobile".to_string(),
            description: "Automatización de iOS y Android (simuladores, devices reales, taps, screenshots). Útil para que Don Cheli pruebe apps móviles end-to-end.".to_string(),
            install_hint: "claude mcp add -s user mobile-next -- npx -y @mobilenext/mobile-mcp@latest".to_string(),
            docs_url: Some("https://github.com/mobile-next/mobile-mcp".to_string()),
        },
        McpSuggestion {
            id: "firebase-studio".to_string(),
            name: "Firebase Studio".to_string(),
            category: "Backend".to_string(),
            description: "Acceso a Firebase: Firestore, Auth, Storage, Functions y Hosting. Permite a Don Cheli configurar y operar tu backend serverless.".to_string(),
            install_hint: "claude mcp add -s user firebase -- npx -y firebase-tools@latest experimental:mcp".to_string(),
            docs_url: Some("https://firebase.google.com/docs/studio/mcp-server".to_string()),
        },
    ]
}

// ── Install / Uninstall / Enable / Disable ────────────────────────────────

#[derive(Deserialize)]
pub struct InstallInput {
    /// Id of a curated suggestion (e.g. "linear", "github"). Only curated
    /// suggestions are installable — arbitrary commands are rejected to avoid
    /// shell injection.
    pub suggestion_id: String,
}

#[derive(Serialize)]
pub struct OpResult {
    pub status: String,
    pub message: String,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
}

pub async fn install(Json(payload): Json<InstallInput>) -> Result<Json<OpResult>, StatusCode> {
    let suggestion = curated_suggestions()
        .into_iter()
        .find(|s| s.id == payload.suggestion_id);
    let Some(s) = suggestion else {
        return Ok(Json(OpResult {
            status: "rejected".to_string(),
            message: format!("Unknown suggestion id: {}", payload.suggestion_id),
            stdout: None,
            stderr: None,
        }));
    };

    let Some(claude_bin) = locate_claude_bin() else {
        return Ok(Json(OpResult {
            status: "failed".to_string(),
            message: "`claude` CLI not found on PATH or in common locations.".to_string(),
            stdout: None, stderr: None,
        }));
    };

    // install_hint is hardcoded in curated_suggestions() so passing through `sh -c` is safe.
    // We replace the leading "claude" with the resolved binary path.
    let cmd = s.install_hint.replacen("claude", &format!("'{}'", claude_bin.display()), 1);

    let output = match Command::new("sh").arg("-c").arg(&cmd).output() {
        Ok(o) => o,
        Err(e) => {
            return Ok(Json(OpResult {
                status: "failed".to_string(),
                message: format!("Failed to spawn shell: {}", e),
                stdout: None, stderr: None,
            }));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(Json(OpResult {
            status: "installed".to_string(),
            message: format!("{} installed.", s.name),
            stdout: Some(stdout), stderr: Some(stderr),
        }))
    } else {
        Ok(Json(OpResult {
            status: "failed".to_string(),
            message: format!("Install failed for {}.", s.name),
            stdout: Some(stdout), stderr: Some(stderr),
        }))
    }
}

pub async fn uninstall(Path(name): Path<String>) -> Result<Json<OpResult>, StatusCode> {
    if !is_safe_mcp_name(&name) {
        return Ok(Json(OpResult {
            status: "rejected".to_string(),
            message: "Invalid MCP name.".to_string(),
            stdout: None, stderr: None,
        }));
    }
    let Some(claude_bin) = locate_claude_bin() else {
        return Ok(Json(OpResult {
            status: "failed".to_string(),
            message: "`claude` CLI not found.".to_string(),
            stdout: None, stderr: None,
        }));
    };

    let output = match Command::new(&claude_bin).args(["mcp", "remove", &name]).output() {
        Ok(o) => o,
        Err(e) => return Ok(Json(OpResult {
            status: "failed".to_string(),
            message: format!("Spawn failed: {}", e),
            stdout: None, stderr: None,
        })),
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        // Also remove from any disabledMcpServers stash so a deleted server
        // doesn't reappear after a restart.
        let _ = move_between_buckets(&name, "disabledMcpServers", None);
        Ok(Json(OpResult {
            status: "uninstalled".to_string(),
            message: format!("{} uninstalled.", name),
            stdout: Some(stdout), stderr: Some(stderr),
        }))
    } else {
        Ok(Json(OpResult {
            status: "failed".to_string(),
            message: format!("Uninstall failed for {}.", name),
            stdout: Some(stdout), stderr: Some(stderr),
        }))
    }
}

pub async fn disable(Path(name): Path<String>) -> Result<Json<OpResult>, StatusCode> {
    if !is_safe_mcp_name(&name) {
        return Ok(Json(OpResult {
            status: "rejected".to_string(),
            message: "Invalid MCP name.".to_string(),
            stdout: None, stderr: None,
        }));
    }
    match move_between_buckets(&name, "mcpServers", Some("disabledMcpServers")) {
        Ok(true) => Ok(Json(OpResult {
            status: "disabled".to_string(),
            message: format!("{} disabled.", name),
            stdout: None, stderr: None,
        })),
        Ok(false) => Ok(Json(OpResult {
            status: "not_found".to_string(),
            message: format!("{} is not currently enabled.", name),
            stdout: None, stderr: None,
        })),
        Err(e) => Ok(Json(OpResult {
            status: "failed".to_string(),
            message: format!("Disable failed: {}", e),
            stdout: None, stderr: None,
        })),
    }
}

pub async fn enable(Path(name): Path<String>) -> Result<Json<OpResult>, StatusCode> {
    if !is_safe_mcp_name(&name) {
        return Ok(Json(OpResult {
            status: "rejected".to_string(),
            message: "Invalid MCP name.".to_string(),
            stdout: None, stderr: None,
        }));
    }
    match move_between_buckets(&name, "disabledMcpServers", Some("mcpServers")) {
        Ok(true) => Ok(Json(OpResult {
            status: "enabled".to_string(),
            message: format!("{} enabled.", name),
            stdout: None, stderr: None,
        })),
        Ok(false) => Ok(Json(OpResult {
            status: "not_found".to_string(),
            message: format!("{} is not currently disabled.", name),
            stdout: None, stderr: None,
        })),
        Err(e) => Ok(Json(OpResult {
            status: "failed".to_string(),
            message: format!("Enable failed: {}", e),
            stdout: None, stderr: None,
        })),
    }
}

fn is_safe_mcp_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Move the entry `name` from one bucket to another inside `~/.claude.json`.
/// If `to` is None, just remove from `from`. Returns true if the entry existed
/// in `from` and was acted upon; false if it was missing (no-op).
fn move_between_buckets(name: &str, from: &str, to: Option<&str>) -> Result<bool, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let path = PathBuf::from(home).join(".claude.json");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let mut json: Value = serde_json::from_str(&text).map_err(|e| format!("parse: {}", e))?;

    let cfg = {
        let from_obj = json.get_mut(from).and_then(|v| v.as_object_mut());
        let Some(from_obj) = from_obj else { return Ok(false); };
        let Some(cfg) = from_obj.remove(name) else { return Ok(false); };
        cfg
    };

    if let Some(to_key) = to {
        let to_obj = json.as_object_mut()
            .ok_or_else(|| "claude.json root is not an object".to_string())?;
        let to_entry = to_obj
            .entry(to_key.to_string())
            .or_insert_with(|| Value::Object(Default::default()));
        let to_map = to_entry.as_object_mut()
            .ok_or_else(|| format!("{} is not an object", to_key))?;
        to_map.insert(name.to_string(), cfg);
    }

    // Write back. Use a tempfile + rename for atomicity to avoid corrupting
    // the file if the process is interrupted mid-write.
    let tmp = path.with_extension("claude.json.tmp");
    let pretty = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, pretty).map_err(|e| format!("write tmp: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {}", e))?;

    Ok(true)
}
