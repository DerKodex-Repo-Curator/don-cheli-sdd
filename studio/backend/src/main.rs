mod api;
mod db;
mod runtime;
mod state;
mod ws;

use axum::{Router, routing::get, routing::post};
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use tracing_subscriber::EnvFilter;

pub struct AppState {
    pub db: db::Database,
    pub tx: broadcast::Sender<ws::WsMessage>,
    pub previews: Arc<api::preview::PreviewRegistry>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    // CLI subcommands handled before server startup
    let args: Vec<String> = std::env::args().collect();
    if let Some(cmd) = args.get(1).map(|s| s.as_str()) {
        match cmd {
            "--install-hooks" | "install-hooks" => {
                match runtime::install_hooks::install_all() {
                    Ok(results) => {
                        println!("Don Cheli — hooks installed:");
                        for (provider, path) in results {
                            println!("  ✓ {:<10} → {}", provider, path.display());
                        }
                        println!("\nRestart your AI CLI to pick up the new hooks.");
                        return Ok(());
                    }
                    Err(e) => {
                        eprintln!("Hook install failed: {}", e);
                        std::process::exit(1);
                    }
                }
            }
            "--uninstall-hooks" | "uninstall-hooks" => {
                match runtime::install_hooks::uninstall_all() {
                    Ok(paths) => {
                        println!("Don Cheli — hooks removed from:");
                        for p in paths {
                            println!("  ✓ {}", p.display());
                        }
                        return Ok(());
                    }
                    Err(e) => {
                        eprintln!("Hook uninstall failed: {}", e);
                        std::process::exit(1);
                    }
                }
            }
            _ => {}
        }
    }

    let db = db::Database::new("studio.db")?;
    db.migrate()?;

    let (tx, _rx) = broadcast::channel::<ws::WsMessage>(256);

    let shared_state = Arc::new(AppState {
        db,
        tx,
        previews: Arc::new(api::preview::PreviewRegistry::new()),
    });

    // Recover runs that were running when the previous backend died.
    // Their underlying `npx tsx` process keeps writing to .dc/auto/state.json,
    // so we just need to attach a fresh watcher for each.
    if let Ok(active) = shared_state.db.list_active_runs() {
        for run in active {
            if let Ok(Some(project)) = shared_state.db.get_project(&run.project_id) {
                let state_for_watcher = shared_state.clone();
                let run_id = run.id.clone();
                let project_path = project.path.clone();
                tokio::spawn(async move {
                    tracing::info!("Resuming watcher for orphaned run {}", run_id);
                    if let Err(e) = state::watcher::watch_state(&project_path, run_id, state_for_watcher).await {
                        tracing::warn!("Orphan watcher exited with error: {}", e);
                    }
                });
            }
        }
    }

    let api_routes = Router::new()
        .route("/projects", get(api::projects::list).post(api::projects::create))
        .route("/projects/scan", get(api::projects::scan))
        .route("/projects/import", post(api::projects::import_project))
        .route("/projects/summary", get(api::projects::summary))
        .route("/projects/{id}", get(api::projects::get_one).delete(api::projects::delete))
        .route("/projects/{id}/onboard-sdd/status", get(api::onboard::status))
        .route("/projects/{id}/onboard-sdd", post(api::onboard::start))
        .route("/projects/{id}/env-inventory", get(api::env_inventory::list))
        .route("/pipeline/{project_id}/start", post(api::pipeline::start))
        .route("/pipeline/{project_id}/stop", post(api::pipeline::stop))
        .route("/pipeline/{project_id}/status", get(api::pipeline::status))
        .route("/pipeline/{project_id}/phases", get(api::phases::list))
        .route("/pipeline/{project_id}/artifacts", get(api::artifacts::list))
        .route("/pipeline/{project_id}/artifacts/{artifact_type}/{name}", get(api::artifacts::get_content))
        .route("/pipeline/{project_id}/costs", get(api::costs::estimate))
        .route("/pipeline/{project_id}/costs/history", get(api::costs::history))
        .route("/pipeline/{project_id}/diagnosis", get(api::pipeline::diagnosis))
        .route("/pipeline/{project_id}/retry", post(api::pipeline::retry_failed))
        .route("/runs/active", get(api::runs::list_active))
        .route("/runs/today", get(api::runs::list_today))
        .route("/runs/{run_id}", get(api::runs::get_run))
        .route("/runs/{run_id}/phases", get(api::runs::get_run_phases))
        .route("/runs/{run_id}/phases/{phase_id}/retry", post(api::runs::retry_phase))
        .route("/runs/project/{project_id}", get(api::runs::list_project_runs))
        .route("/filesystem/browse", get(api::filesystem::browse))
        .route("/filesystem/browse-files", get(api::filesystem::browse_files))
        .route("/filesystem/read-file", get(api::filesystem::read_file))
        .route("/filesystem/mkdir", post(api::filesystem::create_dir))
        .route("/hooks/event", post(api::hooks::receive_event))
        .route("/arsenal/inventory", get(api::arsenal::inventory))
        .route("/costs/aggregated", get(api::costs::aggregated))
        .route("/system/info", get(api::system::info))
        .route("/mcps/list", get(api::mcps::list))
        .route("/mcps/install", post(api::mcps::install))
        .route("/mcps/{name}/uninstall", post(api::mcps::uninstall))
        .route("/mcps/{name}/enable", post(api::mcps::enable))
        .route("/mcps/{name}/disable", post(api::mcps::disable))
        .route("/pipeline/{project_id}/design/list", get(api::design::list))
        .route("/pipeline/{project_id}/design/file/{*filename}", get(api::design::get_file))
        .route("/pipeline/{project_id}/design/approve", post(api::design::approve))
        .route("/pipeline/{project_id}/design/reject", post(api::design::reject))
        .route("/pipeline/{project_id}/design/generate", post(api::design::generate))
        .route("/pipeline/{project_id}/design/apply-to-code", post(api::design::apply_to_code))
        .route("/pipeline/{project_id}/design/verify-only", post(api::design::verify_only))
        .route("/pipeline/{project_id}/design/security-autofix", post(api::design::security_autofix))
        .route("/pipeline/{project_id}/design/add-screens", post(api::design::add_screens))
        .route("/pipeline/{project_id}/design/screen-previews", get(api::design::screen_previews))
        .route("/pipeline/{project_id}/design/screen-preview-image/{screen_id}", get(api::design::screen_preview_image))
        .route("/pipeline/{project_id}/design/assets", get(api::design::list_assets))
        .route("/pipeline/{project_id}/design/upload-asset", post(api::design::upload_asset))
        .route("/pipeline/{project_id}/design/asset/{filename}", get(api::design::get_asset).delete(api::design::delete_asset))
        .route("/projects/{project_id}/github/status", get(api::github::status))
        .route("/projects/{project_id}/github/init", post(api::github::init))
        .route("/services/detect", post(api::services::detect))
        .route("/pipeline/{project_id}/services/from-context", get(api::services::from_context))
        .route("/pipeline/{project_id}/questions/pending", get(api::questions::pending))
        .route("/pipeline/{project_id}/questions/all", get(api::questions::list_all))
        .route("/pipeline/{project_id}/questions/{question_id}/answer", post(api::questions::submit_answer))
        .route("/pipeline/{project_id}/preview/info", get(api::preview::info))
        .route("/pipeline/{project_id}/preview/status", get(api::preview::status))
        .route("/pipeline/{project_id}/preview/start", post(api::preview::start))
        .route("/pipeline/{project_id}/preview/stop", post(api::preview::stop))
        .route("/pipeline/{project_id}/preview/env", post(api::preview::write_env));

    let app = Router::new()
        .nest("/api", api_routes)
        .route("/ws/{project_id}", get(ws::stream::ws_handler))
        .fallback_service(ServeDir::new("../frontend/dist"))
        .layer(CorsLayer::permissive())
        .with_state(shared_state);

    let port = std::env::var("DC_STUDIO_PORT")
        .unwrap_or_else(|_| "3847".to_string())
        .parse::<u16>()
        .unwrap_or(3847);

    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{}", port)).await?;
    tracing::info!("Don Cheli Studio running at http://localhost:{}", port);

    // Auto-open browser
    if std::env::var("DC_NO_OPEN").is_err() {
        let _ = open::that(format!("http://localhost:{}", port));
    }

    axum::serve(listener, app).await?;
    Ok(())
}
