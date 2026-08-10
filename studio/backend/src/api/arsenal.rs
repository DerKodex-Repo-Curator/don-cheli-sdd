//! Arsenal inventory — scans the framework directory for skills, agents, commands.

use axum::{Json, extract::State, http::StatusCode};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::AppState;

#[derive(Serialize)]
pub struct ArsenalItem {
    pub id: String,
    pub name: String,
    pub desc: Option<String>,
    pub cat: String,
    pub uses: u32,
}

#[derive(Serialize)]
pub struct ArsenalInventory {
    pub skills: Vec<ArsenalItem>,
    pub agents: Vec<ArsenalItem>,
    pub commands: Vec<ArsenalItem>,
}

pub async fn inventory(
    State(_state): State<Arc<AppState>>,
) -> Result<Json<ArsenalInventory>, StatusCode> {
    let root = resolve_framework_root();

    let skills = scan_skills(&root.join("habilidades"));
    let agents = scan_agents(&root.join("agentes").join("prompts"));
    let commands = scan_commands(&root.join("comandos"));

    Ok(Json(ArsenalInventory { skills, agents, commands }))
}

fn scan_skills(dir: &Path) -> Vec<ArsenalItem> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
        let id = entry.file_name().to_string_lossy().to_string();
        let path = entry.path().join("HABILIDAD.md");
        let meta = parse_frontmatter(&path);
        out.push(ArsenalItem {
            id: id.clone(),
            name: meta.get("nombre").cloned().unwrap_or_else(|| pretty(&id)),
            desc: meta.get("descripcion").cloned(),
            cat: extract_category(&meta).unwrap_or_else(|| "General".to_string()),
            uses: 0,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn scan_agents(dir: &Path) -> Vec<ArsenalItem> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".md") { continue; }
        let id = name.trim_end_matches(".md").to_string();
        let header = read_agent_header(&path);
        out.push(ArsenalItem {
            id: id.clone(),
            name: header.name.unwrap_or_else(|| pretty(&id)),
            desc: header.role,
            cat: header.model.unwrap_or_else(|| "Especialista".to_string()),
            uses: 0,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn scan_commands(dir: &Path) -> Vec<ArsenalItem> {
    let mut out = Vec::new();
    walk_commands(dir, "", &mut out);
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn walk_commands(dir: &Path, prefix: &str, out: &mut Vec<ArsenalItem>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            let new_prefix = if prefix.is_empty() { name.clone() } else { format!("{}:{}", prefix, name) };
            walk_commands(&path, &new_prefix, out);
        } else if name.ends_with(".md") {
            let stem = name.trim_end_matches(".md");
            let id = if prefix.is_empty() {
                format!("/{}", stem)
            } else {
                format!("/{}:{}", prefix, stem)
            };
            let meta = parse_frontmatter(&path);
            out.push(ArsenalItem {
                id,
                name: stem.to_string(),
                desc: meta.get("description").or(meta.get("descripcion")).cloned(),
                cat: extract_command_category(prefix),
                uses: 0,
            });
        }
    }
}

fn extract_command_category(prefix: &str) -> String {
    match prefix {
        "dc" => "Flujo".to_string(),
        "razonar" => "Razonamiento".to_string(),
        "especdev" => "Spec/Dev".to_string(),
        "" => "General".to_string(),
        other => pretty(other),
    }
}

fn extract_category(meta: &std::collections::HashMap<String, String>) -> Option<String> {
    // Try to infer category from tags
    if let Some(tags) = meta.get("tags") {
        let cleaned = tags.trim().trim_start_matches('[').trim_end_matches(']');
        let first = cleaned.split(',').next().map(|s| s.trim().trim_matches('"'));
        if let Some(t) = first.filter(|s| !s.is_empty()) {
            return Some(pretty(t));
        }
    }
    None
}

fn pretty(s: &str) -> String {
    s.replace('-', " ")
        .split(' ')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Parse simple YAML-ish frontmatter: between two `---` lines, `key: value` pairs.
fn parse_frontmatter(path: &Path) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let Ok(content) = std::fs::read_to_string(path) else { return out };
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") { return out };

    let mut lines = trimmed.lines();
    lines.next(); // skip opening ---

    for line in lines {
        if line.trim() == "---" { break; }
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim().to_string();
            let val = value.trim().trim_matches('"').trim_matches('\'').to_string();
            if !key.is_empty() {
                out.insert(key, val);
            }
        }
    }
    out
}

struct AgentHeader {
    name: Option<String>,
    role: Option<String>,
    model: Option<String>,
}

/// Agent prompts use a non-frontmatter format: `# Agente: NAME` then bold lines.
fn read_agent_header(path: &Path) -> AgentHeader {
    let mut h = AgentHeader { name: None, role: None, model: None };
    let Ok(content) = std::fs::read_to_string(path) else { return h };
    for line in content.lines().take(20) {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("# Agente:") {
            h.name = Some(rest.trim().to_string());
        } else if let Some(rest) = trimmed.strip_prefix("**Modelo:**") {
            h.model = Some(rest.trim().to_string());
        } else if let Some(rest) = trimmed.strip_prefix("**Rol:**") {
            h.role = Some(rest.trim().to_string());
        }
    }
    h
}

/// Resolve the framework root directory.
fn resolve_framework_root() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Ok(canonical) = exe.canonicalize() {
            let mut root = canonical;
            for _ in 0..5 {
                if let Some(p) = root.parent() {
                    root = p.to_path_buf();
                }
            }
            if root.join("habilidades").exists() {
                return root;
            }
        }
    }

    if let Ok(home) = std::env::var("FRAMEWORK_HOME") {
        let p = PathBuf::from(home);
        if p.join("habilidades").exists() { return p; }
    }

    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors() {
            if ancestor.join("habilidades").exists() {
                return ancestor.to_path_buf();
            }
        }
    }

    PathBuf::from(".")
}
