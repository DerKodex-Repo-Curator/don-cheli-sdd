use axum::{Json, extract::State, http::StatusCode};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;
use crate::ws::WsMessage;

/// Universal hook event payload — accepts events from Claude Code, Codex, OpenCode, etc.
#[derive(Debug, Deserialize)]
pub struct HookEvent {
    /// Provider name: "claude" | "codex" | "opencode" | etc.
    #[serde(default = "default_provider")]
    pub provider: String,
    /// Event name (PreToolUse, PostToolUse, UserPromptSubmit, etc.)
    pub event: String,
    /// Optional project id to scope events to a specific run
    #[serde(default)]
    pub project_id: Option<String>,
    /// Optional human-readable session identifier
    #[serde(default)]
    pub session_id: Option<String>,
    /// Original hook payload from the provider (passthrough)
    #[serde(default)]
    pub payload: serde_json::Value,
}

fn default_provider() -> String {
    "claude".to_string()
}

#[derive(Serialize)]
pub struct HookResponse {
    pub ok: bool,
}

/// Receive a hook event and broadcast it to all connected WebSocket clients.
///
/// Claude Code, Codex, and OpenCode hooks call this endpoint via the `dc-hook.sh`
/// script. The script reads stdin (JSON), wraps it, and POSTs here.
pub async fn receive_event(
    State(state): State<Arc<AppState>>,
    Json(event): Json<HookEvent>,
) -> Result<Json<HookResponse>, StatusCode> {
    let summary = summarize(&event);

    tracing::info!(
        provider = %event.provider,
        event = %event.event,
        project = ?event.project_id,
        "hook event received"
    );

    let _ = state.tx.send(WsMessage {
        msg_type: "hook_event".to_string(),
        data: serde_json::json!({
            "provider": event.provider,
            "event": event.event,
            "project_id": event.project_id,
            "session_id": event.session_id,
            "summary": summary,
            "payload": event.payload,
            "timestamp": Utc::now().to_rfc3339(),
        }),
    });

    Ok(Json(HookResponse { ok: true }))
}

/// Build a one-line human-readable summary of the event for the UI.
fn summarize(event: &HookEvent) -> String {
    let p = &event.payload;
    match event.event.as_str() {
        "PreToolUse" | "PostToolUse" => {
            let tool = p.get("tool_name").and_then(|v| v.as_str()).unwrap_or("unknown");
            let input = p.get("tool_input").and_then(|v| v.as_object());
            let detail = input
                .and_then(|m| {
                    m.get("file_path")
                        .or_else(|| m.get("path"))
                        .or_else(|| m.get("command"))
                        .or_else(|| m.get("pattern"))
                        .and_then(|v| v.as_str())
                })
                .unwrap_or("");
            if detail.is_empty() {
                format!("{} {}", event.event, tool)
            } else {
                format!("{} {} → {}", event.event, tool, truncate(detail, 80))
            }
        }
        "UserPromptSubmit" => {
            let prompt = p.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
            format!("Prompt: {}", truncate(prompt, 100))
        }
        "SessionStart" => "Session started".to_string(),
        "SessionEnd" => "Session ended".to_string(),
        "Stop" => "Agent stopped".to_string(),
        "SubagentStop" => "Subagent stopped".to_string(),
        "Notification" => {
            let msg = p.get("message").and_then(|v| v.as_str()).unwrap_or("");
            format!("Notification: {}", truncate(msg, 100))
        }
        other => other.to_string(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max).collect();
        format!("{}…", truncated)
    }
}
