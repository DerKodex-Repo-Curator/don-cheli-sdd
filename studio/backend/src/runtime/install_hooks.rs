//! Install hooks for Claude Code, Codex CLI, and OpenCode CLI.
//!
//! Writes (or merges) hook entries that pipe stdin to `scripts/dc-hook.sh`,
//! which forwards events to the running Studio backend.

use anyhow::{Context, Result};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

const CLAUDE_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Notification",
    "Stop",
    "SubagentStop",
    "SessionEnd",
];

const OPENCODE_EVENTS: &[&str] = &[
    "session.start",
    "session.end",
    "tool.before",
    "tool.after",
    "message.user",
];

const CODEX_EVENTS: &[&str] = &[
    "before_tool",
    "after_tool",
    "user_prompt",
    "session_start",
    "session_end",
];

/// Resolve the absolute path to `scripts/dc-hook.sh`.
/// Looks relative to the binary, then CWD, then FRAMEWORK_HOME.
pub fn resolve_hook_script() -> Result<PathBuf> {
    // 1. Relative to binary
    if let Ok(exe) = std::env::current_exe() {
        if let Ok(canonical) = exe.canonicalize() {
            let mut root = canonical;
            for _ in 0..5 {
                if let Some(p) = root.parent() {
                    root = p.to_path_buf();
                }
            }
            let candidate = root.join("scripts").join("dc-hook.sh");
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    // 2. Relative to CWD
    if let Ok(cwd) = std::env::current_dir() {
        let candidates = [
            cwd.join("../../scripts/dc-hook.sh"),
            cwd.join("../scripts/dc-hook.sh"),
            cwd.join("scripts/dc-hook.sh"),
        ];
        for c in &candidates {
            if c.exists() {
                if let Ok(abs) = c.canonicalize() {
                    return Ok(abs);
                }
            }
        }
    }

    // 3. FRAMEWORK_HOME
    if let Ok(home) = std::env::var("FRAMEWORK_HOME") {
        let candidate = PathBuf::from(home).join("scripts").join("dc-hook.sh");
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    anyhow::bail!("Could not locate scripts/dc-hook.sh — set FRAMEWORK_HOME or run from the framework root")
}

fn home_dir() -> Result<PathBuf> {
    std::env::var("HOME")
        .map(PathBuf::from)
        .context("HOME environment variable not set")
}

fn read_json_or_empty(path: &Path) -> Value {
    if !path.exists() {
        return json!({});
    }
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!({}))
}

fn ensure_object(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = json!({});
    }
    value.as_object_mut().unwrap()
}

/// Install hooks for Claude Code by merging into ~/.claude/settings.json.
///
/// Result schema (per the official docs):
/// {
///   "hooks": {
///     "PreToolUse": [
///       {
///         "matcher": "*",
///         "hooks": [{ "type": "command", "command": "/abs/path/dc-hook.sh PreToolUse claude" }]
///       }
///     ],
///     ...
///   }
/// }
pub fn install_claude_hooks(script: &Path) -> Result<PathBuf> {
    let home = home_dir()?;
    let claude_dir = home.join(".claude");
    std::fs::create_dir_all(&claude_dir)?;
    let path = claude_dir.join("settings.json");

    let mut settings = read_json_or_empty(&path);
    let root = ensure_object(&mut settings);

    // Get or create top-level "hooks"
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    let hooks_obj = ensure_object(hooks);

    for event in CLAUDE_EVENTS {
        let command_str = format!(
            "{} {} claude",
            shell_quote(&script.to_string_lossy()),
            event
        );

        let new_entry = json!({
            "matcher": "*",
            "hooks": [{
                "type": "command",
                "command": command_str
            }]
        });

        // Replace any prior Don Cheli entry, keep others
        let entries = hooks_obj
            .entry(event.to_string())
            .or_insert_with(|| json!([]));
        let arr = if entries.is_array() {
            entries.as_array_mut().unwrap()
        } else {
            *entries = json!([]);
            entries.as_array_mut().unwrap()
        };

        arr.retain(|e| !is_doncheli_entry(e));
        arr.push(new_entry);
    }

    let pretty = serde_json::to_string_pretty(&settings)?;
    std::fs::write(&path, pretty)?;
    Ok(path)
}

/// Install hooks for OpenCode CLI by merging into ~/.config/opencode/config.json
/// (OpenCode reads this file at startup).
pub fn install_opencode_hooks(script: &Path) -> Result<PathBuf> {
    let home = home_dir()?;
    let dir = home.join(".config").join("opencode");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("config.json");

    let mut settings = read_json_or_empty(&path);
    let root = ensure_object(&mut settings);

    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    let hooks_obj = ensure_object(hooks);

    for event in OPENCODE_EVENTS {
        let command_str = format!(
            "{} {} opencode",
            shell_quote(&script.to_string_lossy()),
            event
        );

        let new_entry = json!({
            "command": command_str,
            "managed_by": "don-cheli"
        });

        let entries = hooks_obj
            .entry(event.to_string())
            .or_insert_with(|| json!([]));
        let arr = if entries.is_array() {
            entries.as_array_mut().unwrap()
        } else {
            *entries = json!([]);
            entries.as_array_mut().unwrap()
        };

        arr.retain(|e| !is_doncheli_entry(e));
        arr.push(new_entry);
    }

    let pretty = serde_json::to_string_pretty(&settings)?;
    std::fs::write(&path, pretty)?;
    Ok(path)
}

/// Install hooks for Codex CLI by merging into ~/.codex/config.json.
///
/// Codex doesn't expose a first-class hook system at the time of writing, so
/// we drop a `hooks` block following the same shape as Claude Code. The
/// `dc-hook.sh` script will be invoked manually from a wrapper if needed.
pub fn install_codex_hooks(script: &Path) -> Result<PathBuf> {
    let home = home_dir()?;
    let dir = home.join(".codex");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("hooks.json");

    let mut settings = read_json_or_empty(&path);
    let root = ensure_object(&mut settings);

    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    let hooks_obj = ensure_object(hooks);

    for event in CODEX_EVENTS {
        let command_str = format!(
            "{} {} codex",
            shell_quote(&script.to_string_lossy()),
            event
        );

        let new_entry = json!({
            "command": command_str,
            "managed_by": "don-cheli"
        });

        let entries = hooks_obj
            .entry(event.to_string())
            .or_insert_with(|| json!([]));
        let arr = if entries.is_array() {
            entries.as_array_mut().unwrap()
        } else {
            *entries = json!([]);
            entries.as_array_mut().unwrap()
        };

        arr.retain(|e| !is_doncheli_entry(e));
        arr.push(new_entry);
    }

    let pretty = serde_json::to_string_pretty(&settings)?;
    std::fs::write(&path, pretty)?;
    Ok(path)
}

fn is_doncheli_entry(entry: &Value) -> bool {
    if let Some(obj) = entry.as_object() {
        if obj.get("managed_by").and_then(|v| v.as_str()) == Some("don-cheli") {
            return true;
        }
        // Claude shape: { matcher, hooks: [{ command }] }
        if let Some(arr) = obj.get("hooks").and_then(|v| v.as_array()) {
            for h in arr {
                if let Some(cmd) = h.get("command").and_then(|v| v.as_str()) {
                    if cmd.contains("dc-hook.sh") {
                        return true;
                    }
                }
            }
        }
        if let Some(cmd) = obj.get("command").and_then(|v| v.as_str()) {
            if cmd.contains("dc-hook.sh") {
                return true;
            }
        }
    }
    false
}

/// Quote a path for shell consumption (handles spaces).
fn shell_quote(s: &str) -> String {
    if s.chars().all(|c| c.is_ascii_alphanumeric() || "/_.-".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// Install all hooks (Claude, Codex, OpenCode). Returns paths written.
pub fn install_all() -> Result<Vec<(&'static str, PathBuf)>> {
    let script = resolve_hook_script()?;
    let mut results = Vec::new();

    match install_claude_hooks(&script) {
        Ok(p) => results.push(("claude", p)),
        Err(e) => tracing::warn!("Claude hook install failed: {}", e),
    }
    match install_codex_hooks(&script) {
        Ok(p) => results.push(("codex", p)),
        Err(e) => tracing::warn!("Codex hook install failed: {}", e),
    }
    match install_opencode_hooks(&script) {
        Ok(p) => results.push(("opencode", p)),
        Err(e) => tracing::warn!("OpenCode hook install failed: {}", e),
    }

    Ok(results)
}

/// Uninstall: remove all Don Cheli entries from the three config files.
pub fn uninstall_all() -> Result<Vec<PathBuf>> {
    let home = home_dir()?;
    let candidates = [
        home.join(".claude").join("settings.json"),
        home.join(".codex").join("hooks.json"),
        home.join(".config").join("opencode").join("config.json"),
    ];

    let mut touched = Vec::new();
    for path in candidates {
        if !path.exists() {
            continue;
        }
        let mut v = read_json_or_empty(&path);
        if let Some(hooks) = v.get_mut("hooks").and_then(|h| h.as_object_mut()) {
            for (_event, entries) in hooks.iter_mut() {
                if let Some(arr) = entries.as_array_mut() {
                    arr.retain(|e| !is_doncheli_entry(e));
                }
            }
        }
        let pretty = serde_json::to_string_pretty(&v)?;
        std::fs::write(&path, pretty)?;
        touched.push(path);
    }
    Ok(touched)
}
