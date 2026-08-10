use anyhow::Result;
use notify::{Event, EventKind, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::AppState;
use crate::db::Database;
use crate::ws::WsMessage;

/// Watch `.dc/auto/state.json` for changes and:
///   1. Broadcast the raw state as a `state_update` WebSocket message
///   2. Sync the state into the DB so the rest of the API exposes fresh data
///
/// Stops when the run is observed in a terminal state (`passed` / `failed`).
pub async fn watch_state(
    project_path: &str,
    run_id: String,
    app: Arc<AppState>,
) -> Result<()> {
    let tx = app.tx.clone();
    let state_dir = format!("{}/.dc/auto", project_path);
    let state_file = format!("{}/state.json", state_dir);

    std::fs::create_dir_all(&state_dir)?;

    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::channel::<()>(16);

    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            if matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                let _ = notify_tx.blocking_send(());
            }
        }
    })?;

    watcher.watch(Path::new(&state_dir), RecursiveMode::NonRecursive)?;

    tracing::info!("Watching state at: {} (run={})", state_file, run_id);

    // Run an initial sync in case state.json already exists when we start.
    sync_once(&state_file, &run_id, &app.db, &tx).await;

    while notify_rx.recv().await.is_some() {
        let terminal = sync_once(&state_file, &run_id, &app.db, &tx).await;
        if terminal {
            tracing::info!("State watcher exiting — run {} reached terminal state", run_id);
            break;
        }
    }

    Ok(())
}

/// Read state.json, broadcast it and sync it to the DB.
/// Returns `true` if the run is in a terminal state.
async fn sync_once(
    state_file: &str,
    run_id: &str,
    db: &Database,
    tx: &broadcast::Sender<WsMessage>,
) -> bool {
    let Ok(content) = tokio::fs::read_to_string(state_file).await else { return false };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else { return false };

    // Broadcast the raw state
    let _ = tx.send(WsMessage {
        msg_type: "state_update".to_string(),
        data: value.clone(),
    });

    // Persist into the DB so the REST API serves fresh values
    if let Err(e) = db.sync_run_state(run_id, &value) {
        tracing::warn!("DB sync failed for run {}: {}", run_id, e);
    }

    // Determine terminal state
    if let Some(phases) = value.get("phases").and_then(|v| v.as_array()) {
        let all_passed = !phases.is_empty()
            && phases.iter().all(|p| {
                p.get("status").and_then(|v| v.as_str()) == Some("passed")
            });
        let any_failed = phases.iter().any(|p| {
            p.get("status").and_then(|v| v.as_str()) == Some("failed")
        });
        let any_running = phases.iter().any(|p| {
            p.get("status").and_then(|v| v.as_str()) == Some("running")
        });
        return all_passed || (any_failed && !any_running);
    }
    false
}
