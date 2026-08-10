//! Shared helper for spawning `claude -p` with live progress streaming.
//!
//! Uses `--output-format stream-json --verbose` so we get one JSON event per
//! line and can surface real-time WS updates instead of a single final blob.
//!
//! For each event we parse, we emit ONE WS message with a friendly `summary`
//! line (e.g. "📖 Read src/lib/x.ts", "🔧 Edit src/components/y.tsx", "🌐 Bash:
//! npm install") plus the raw JSON for clients that want full fidelity.

use serde_json::Value;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::AsyncBufReadExt;

use crate::AppState;
use crate::ws::WsMessage;

pub struct StreamOpts<'a> {
    /// Project id, sent in every WS event so the UI can correlate.
    pub project_id: &'a str,
    /// WS msg_type for progress lines (e.g. "code_regeneration_log",
    /// "security_autofix_log", "design_log").
    pub log_type: &'a str,
    /// WS msg_type for status changes (e.g. "code_regeneration").
    pub status_type: &'a str,
    /// Model: "haiku" | "sonnet" | "opus".
    pub model: &'a str,
    /// Working directory for the subprocess.
    pub cwd: &'a str,
    pub prompt: &'a str,
}

#[derive(Debug)]
pub struct StreamResult {
    pub success: bool,
    pub total_cost_usd: Option<f64>,
    pub final_text: Option<String>,
}

/// Spawn `claude -p --output-format stream-json --verbose ...` and stream
/// every event to the broadcast channel. Awaits the subprocess to completion.
pub async fn stream_claude(state: Arc<AppState>, opts: StreamOpts<'_>) -> StreamResult {
    let tx = state.tx.clone();
    let project_id = opts.project_id.to_string();
    let log_type = opts.log_type.to_string();
    let status_type = opts.status_type.to_string();

    let spawn = tokio::process::Command::new("claude")
        .args([
            "-p",
            "--model", opts.model,
            "--dangerously-skip-permissions",
            "--output-format", "stream-json",
            "--verbose",
            opts.prompt,
        ])
        .current_dir(opts.cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match spawn {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(WsMessage {
                msg_type: status_type.clone(),
                data: serde_json::json!({
                    "project_id": project_id,
                    "status": "failed",
                    "error": format!("spawn failed: {}", e),
                }),
            });
            return StreamResult { success: false, total_cost_usd: None, final_text: None };
        }
    };

    // shared state captured from stream events
    let final_meta = Arc::new(tokio::sync::Mutex::new(StreamResult {
        success: false,
        total_cost_usd: None,
        final_text: None,
    }));

    if let Some(stdout) = child.stdout.take() {
        let tx2 = tx.clone();
        let pid = project_id.clone();
        let lt = log_type.clone();
        let st = status_type.clone();
        let meta = final_meta.clone();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() { continue; }
                let Ok(ev) = serde_json::from_str::<Value>(&line) else {
                    // Non-JSON line — still surface as a raw log entry.
                    let _ = tx2.send(WsMessage {
                        msg_type: lt.clone(),
                        data: serde_json::json!({ "project_id": pid, "summary": line }),
                    });
                    continue;
                };

                // Update accumulator on the `result` event.
                if ev.get("type").and_then(|t| t.as_str()) == Some("result") {
                    let mut m = meta.lock().await;
                    m.success = ev.get("is_error").and_then(|b| b.as_bool()).map(|b| !b).unwrap_or(false);
                    m.total_cost_usd = ev.get("total_cost_usd").and_then(|c| c.as_f64());
                    m.final_text = ev.get("result").and_then(|s| s.as_str()).map(String::from);
                }

                let summary = friendly_summary(&ev);
                if let Some(s) = summary {
                    let _ = tx2.send(WsMessage {
                        msg_type: lt.clone(),
                        data: serde_json::json!({
                            "project_id": pid,
                            "summary": s,
                            "kind": ev.get("type"),
                        }),
                    });
                }
            }
            let _ = tx2.send(WsMessage {
                msg_type: st,
                data: serde_json::json!({
                    "project_id": pid,
                    "status": "streaming_ended",
                }),
            });
        });
    }

    // stderr just gets surfaced verbatim — usually empty unless something blew up.
    if let Some(stderr) = child.stderr.take() {
        let tx3 = tx.clone();
        let pid = project_id.clone();
        let lt = log_type.clone();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() { continue; }
                let _ = tx3.send(WsMessage {
                    msg_type: lt.clone(),
                    data: serde_json::json!({
                        "project_id": pid,
                        "summary": format!("⚠️  {}", line),
                        "stream": "stderr",
                    }),
                });
            }
        });
    }

    let _ = child.wait().await;
    let m = final_meta.lock().await;
    StreamResult {
        success: m.success,
        total_cost_usd: m.total_cost_usd,
        final_text: m.final_text.clone(),
    }
}

/// Convert a raw stream-json event into a one-line, human-friendly progress
/// summary. Returns None for events we don't care about (init blobs, hooks,
/// raw token deltas, etc.) so the UI isn't flooded.
fn friendly_summary(ev: &Value) -> Option<String> {
    let ty = ev.get("type")?.as_str()?;
    match ty {
        "assistant" => {
            // Look at the message content blocks — text vs tool_use.
            let blocks = ev.pointer("/message/content")?.as_array()?;
            for b in blocks {
                let kind = b.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match kind {
                    "tool_use" => {
                        let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("?");
                        let input = b.get("input").cloned().unwrap_or(Value::Null);
                        return Some(format_tool_call(name, &input));
                    }
                    "text" => {
                        let txt = b.get("text").and_then(|t| t.as_str()).unwrap_or("").trim();
                        if txt.is_empty() { continue; }
                        // First sentence only, capped.
                        let snippet = txt.split('\n').next().unwrap_or(txt);
                        let snippet = if snippet.len() > 140 {
                            format!("{}…", &snippet[..140])
                        } else {
                            snippet.to_string()
                        };
                        return Some(format!("💬 {}", snippet));
                    }
                    "thinking" => {
                        let txt = b.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                        let snippet = txt.split('\n').next().unwrap_or("").trim();
                        if snippet.is_empty() { continue; }
                        let snippet = if snippet.len() > 120 {
                            format!("{}…", &snippet[..120])
                        } else {
                            snippet.to_string()
                        };
                        return Some(format!("💭 {}", snippet));
                    }
                    _ => {}
                }
            }
            None
        }
        "user" => {
            // Surface only failed tool results (success is noise).
            let blocks = ev.pointer("/message/content")?.as_array()?;
            for b in blocks {
                if b.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                    let is_error = b.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                    if !is_error { continue; }
                    let content = b.get("content").cloned().unwrap_or(Value::Null);
                    let txt = match &content {
                        Value::String(s) => s.clone(),
                        Value::Array(arr) => arr.iter()
                            .filter_map(|x| x.get("text").and_then(|t| t.as_str()))
                            .collect::<Vec<_>>()
                            .join(" "),
                        _ => "error".to_string(),
                    };
                    let snippet = txt.lines().next().unwrap_or("").trim();
                    let snippet = if snippet.len() > 140 {
                        format!("{}…", &snippet[..140])
                    } else {
                        snippet.to_string()
                    };
                    return Some(format!("❌ tool failed: {}", snippet));
                }
            }
            None
        }
        "result" => {
            let cost = ev.get("total_cost_usd").and_then(|c| c.as_f64()).unwrap_or(0.0);
            let ok = !ev.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
            let symbol = if ok { "✅" } else { "❌" };
            Some(format!("{} done · ${:.4}", symbol, cost))
        }
        _ => None, // system/init, hooks, rate_limit, etc. — silent.
    }
}

fn format_tool_call(name: &str, input: &Value) -> String {
    // Strip MCP prefixes for readability.
    let pretty_name = name.strip_prefix("mcp__").unwrap_or(name);

    match name {
        "Read" => {
            let path = input.get("file_path").and_then(|p| p.as_str()).unwrap_or("?");
            format!("📖 Read {}", short_path(path))
        }
        "Edit" => {
            let path = input.get("file_path").and_then(|p| p.as_str()).unwrap_or("?");
            format!("✏️  Edit {}", short_path(path))
        }
        "Write" => {
            let path = input.get("file_path").and_then(|p| p.as_str()).unwrap_or("?");
            format!("📝 Write {}", short_path(path))
        }
        "NotebookEdit" => {
            let path = input.get("notebook_path").and_then(|p| p.as_str()).unwrap_or("?");
            format!("📓 Notebook {}", short_path(path))
        }
        "Bash" => {
            let cmd = input.get("command").and_then(|c| c.as_str()).unwrap_or("");
            let first = cmd.lines().next().unwrap_or(cmd);
            let first = if first.len() > 100 { format!("{}…", &first[..100]) } else { first.to_string() };
            format!("🌐 Bash: {}", first)
        }
        "Grep" => {
            let pattern = input.get("pattern").and_then(|p| p.as_str()).unwrap_or("?");
            format!("🔎 Grep: {}", short(pattern, 80))
        }
        "Glob" => {
            let pattern = input.get("pattern").and_then(|p| p.as_str()).unwrap_or("?");
            format!("🔎 Glob: {}", short(pattern, 80))
        }
        "WebFetch" => {
            let url = input.get("url").and_then(|u| u.as_str()).unwrap_or("?");
            format!("🌍 Fetch {}", short(url, 80))
        }
        "WebSearch" => {
            let q = input.get("query").and_then(|q| q.as_str()).unwrap_or("?");
            format!("🔍 Search: {}", short(q, 80))
        }
        "TodoWrite" => "📋 TodoWrite".to_string(),
        n if n.starts_with("mcp__stitch__") => {
            let action = n.trim_start_matches("mcp__stitch__");
            // For generate/edit screens, include the prompt snippet.
            let detail = input.get("prompt").or_else(|| input.get("name")).or_else(|| input.get("screenId"))
                .and_then(|v| v.as_str())
                .map(|s| format!(" — {}", short(s, 60)))
                .unwrap_or_default();
            format!("🎨 stitch.{}{}", action, detail)
        }
        n if n.starts_with("mcp__mobbin__") => {
            let action = n.trim_start_matches("mcp__mobbin__");
            let detail = input.get("query").and_then(|q| q.as_str())
                .map(|s| format!(" — {}", short(s, 60)))
                .unwrap_or_default();
            format!("📱 mobbin.{}{}", action, detail)
        }
        n if n.starts_with("mcp__firebase__") => {
            let action = n.trim_start_matches("mcp__firebase__");
            format!("🔥 firebase.{}", action)
        }
        _ => format!("⚙️  {}", pretty_name),
    }
}

fn short(s: &str, max: usize) -> String {
    if s.len() > max { format!("{}…", &s[..max]) } else { s.to_string() }
}

fn short_path(p: &str) -> String {
    // Trim noise like `/Users/x/Documents/Project/` prefixes.
    if let Some(idx) = p.rfind('/') {
        let parent = &p[..idx];
        let file = &p[idx + 1..];
        let parent_short = parent
            .rsplit('/')
            .take(2)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("/");
        return format!("{}/{}", parent_short, file);
    }
    p.to_string()
}
