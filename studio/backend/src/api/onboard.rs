//! SDD onboarding for existing (pre-Don-Cheli) projects.
//!
//! Reads the codebase, generates a real blueprint, spec, plan, tasks and
//! optional improvements audit. Preserves any existing `.dc/design/`.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;
use crate::ws::WsMessage;

#[derive(Deserialize, Default)]
pub struct OnboardInput {
    /// Whether to also generate `.dc/audits/improvements.md`. Default: true.
    #[serde(default = "default_true")]
    pub include_improvements: bool,
    /// Optional user-supplied goal/focus to bias the analysis.
    #[serde(default)]
    pub user_goal: Option<String>,
}

fn default_true() -> bool { true }

#[derive(Serialize)]
pub struct OnboardStatus {
    pub has_imported_blueprint: bool,
    pub has_full_blueprint: bool,
    pub has_spec: bool,
    pub has_plan: bool,
    pub has_tasks: bool,
    pub has_audit: bool,
    pub has_design: bool,
    pub eligible: bool,
}

/// Lightweight read — used by frontend to decide whether to surface the
/// "Onboard to SDD" panel.
pub async fn status(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Result<Json<OnboardStatus>, StatusCode> {
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let root = std::path::PathBuf::from(&project.path);
    let dc = root.join(".dc");

    let has_imported_blueprint = dc.join("blueprints").join("imported.md").exists();
    let has_full_blueprint = dc.join("blueprints").join("blueprint.md").exists();
    let has_spec = dc.join("specs").join("spec.feature").exists()
        || dc.join("specs").join("spec.md").exists();
    let has_plan = dc.join("plans").join("plan.md").exists();
    let has_tasks = dc.join("tareas").join("INDEX.md").exists();
    let has_audit = dc.join("audits").join("improvements.md").exists();
    let has_design = dc.join("design").exists()
        && std::fs::read_dir(dc.join("design")).map(|d| d.count() > 0).unwrap_or(false);

    // Eligible = imported but not fully SDD-onboarded.
    let eligible = !has_full_blueprint || !has_spec || !has_plan || !has_tasks;

    Ok(Json(OnboardStatus {
        has_imported_blueprint,
        has_full_blueprint,
        has_spec,
        has_plan,
        has_tasks,
        has_audit,
        has_design,
        eligible,
    }))
}

#[derive(Serialize)]
pub struct OnboardStart {
    pub status: String,
}

pub async fn start(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Json(payload): Json<OnboardInput>,
) -> Result<Json<OnboardStart>, StatusCode> {
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let project_path = project.path.clone();
    let project_name = project.name.clone();
    let tx = state.tx.clone();
    let pid = project_id.clone();

    let prompt = build_prompt(&project_name, &project_path, &payload);

    tokio::spawn(async move {
        let _ = tx.send(WsMessage {
            msg_type: "sdd_onboarding".to_string(),
            data: serde_json::json!({
                "project_id": pid,
                "status": "starting",
                "at": Utc::now().to_rfc3339(),
            }),
        });

        let result = crate::api::stream::stream_claude(
            state.clone(),
            crate::api::stream::StreamOpts {
                project_id: &pid,
                log_type: "sdd_onboarding_log",
                status_type: "sdd_onboarding",
                model: "sonnet",
                cwd: &project_path,
                prompt: &prompt,
            },
        ).await;

        let success = result.success;
        let _ = tx.send(WsMessage {
            msg_type: "sdd_onboarding".to_string(),
            data: serde_json::json!({
                "project_id": pid,
                "status": if success { "completed" } else { "failed" },
                "at": Utc::now().to_rfc3339(),
            }),
        });
    });

    Ok(Json(OnboardStart { status: "started".to_string() }))
}

fn build_prompt(name: &str, _project_path: &str, payload: &OnboardInput) -> String {
    let user_goal_block = match payload.user_goal.as_deref() {
        Some(g) if !g.trim().is_empty() => format!(
            "\nUSER GOAL (CRITICAL — bias all analysis toward this):\n{}\n",
            g.trim(),
        ),
        _ => String::new(),
    };

    let improvements_block = if payload.include_improvements {
        "\nSTEP 6 — IMPROVEMENTS AUDIT (REQUIRED for this run)\n\
         Write `.dc/audits/improvements.md` with concrete improvement opportunities, \
         grouped by category. Reference specific files/lines. Categories:\n\
         - UX gaps (compare against patterns from Mobbin research if applicable)\n\
         - Performance (bundle sizes, queries, image handling)\n\
         - Test coverage (current state vs target; what's missing)\n\
         - Code smells (duplication, deprecated APIs, oversized files)\n\
         - Security (env-var exposure, auth holes, dependency CVEs)\n\
         - Accessibility (a11y attrs, contrast, keyboard nav)\n\
         For each item: WHAT, WHY it matters, WHERE (file:line), ROUGH EFFORT (S/M/L).\n"
    } else { "" };

    format!(
        "You are running the SDD ONBOARDING for an EXISTING project `{name}`. The user \
         already has working code but no SDD artifacts (or only a thin imported.md). \
         Your job is to retroactively produce a complete SDD bundle so the project can \
         be iterated on with Don Cheli going forward.\n\
         {user_goal_block}\n\
         GROUND RULES\n\
         - The codebase EXISTS. Read it carefully before writing anything.\n\
         - DO NOT modify any source files in this run. Only WRITE inside `.dc/`.\n\
         - DO NOT overwrite `.dc/design/*.html` if they already exist — they were \
           hand-crafted earlier and are still useful references.\n\
         - DO NOT delete `.dc/blueprints/imported.md` — leave it as historical record. \
           Write the NEW, richer blueprint to `.dc/blueprints/blueprint.md`.\n\
         - Multi-stack projects are common here (e.g. android/, web/, functions/, \
           landing/). Inspect each top-level dir to discover sub-stacks.\n\n\
         STEP 1 — DISCOVER (read-only)\n\
         A) List the project root. Identify every top-level dir that contains an app, \
            service, or platform target.\n\
         B) For each stack, read its manifest: `package.json`, `pubspec.yaml`, \
            `build.gradle*`, `AndroidManifest.xml`, `Cargo.toml`, `requirements.txt`, etc.\n\
         C) Inspect 5–10 representative source files per stack to understand patterns, \
            UI framework, state mgmt, data layer.\n\
         D) Read `.firebaserc`, `firebase.json`, `.env.example`, `next.config.*`, etc. \
            to detect external services.\n\
         E) Look in the project root for stray `.md` files (specs, bug lists, design \
            notes). These contain product intent — read and classify them.\n\
         F) If `.dc/design/` already has HTMLs and `design-tokens.json`, read them all \
            to learn the visual direction.\n\
         G) Look for `TODO`, `FIXME`, `// HACK`, `// XXX` in the code — flag the \
            top 10 by relevance.\n\n\
         STEP 2 — BLUEPRINT (REQUIRED)\n\
         Write `.dc/blueprints/blueprint.md` (replace existing if present) with:\n\
         - **Vision**: one paragraph describing the product, inferred from code + docs\n\
         - **Target audience**: who uses this\n\
         - **Stack**: per-platform breakdown (language, framework, key deps)\n\
         - **Current features**: bulleted list of capabilities that are working, with \
           a one-line reference to the entry file for each\n\
         - **Incomplete features**: features started but not finished — show evidence \
           (TODOs, dead routes, half-implemented screens)\n\
         - **External services**: Firebase products, maps, auth, storage, etc.\n\
         - **Data model**: rough inferred schema (collections / tables / state shape)\n\
         - **Known issues**: from the stray BUGS_*.md / FIXME comments\n\
         - **Open questions**: ambiguities the SDD spec needs to resolve\n\n\
         STEP 3 — SPEC (REQUIRED)\n\
         Write `.dc/specs/spec.feature` (Gherkin syntax) with:\n\
         - One `Feature:` block per capability (current + planned).\n\
         - Each feature: 2–5 `Scenario:` entries with Given/When/Then.\n\
         - Cover the HAPPY PATHS of features that exist, AND the EXPECTED behavior \
           of features that are incomplete (this is what's missing).\n\
         - Use realistic content from the actual domain (no Lorem Ipsum).\n\n\
         STEP 4 — PLAN (REQUIRED)\n\
         Write `.dc/plans/plan.md` with:\n\
         - 3–5 phases ordered by risk + dependency. Suggested ordering:\n\
           Phase 1 — fix critical bugs (from BUGS_* docs / FIXMEs)\n\
           Phase 2 — complete the half-built features identified in step 2\n\
           Phase 3 — UX polish & gap-closing from the audit\n\
           Phase 4 — performance & tests\n\
           Phase 5 — launch readiness\n\
         - Each phase: scope, deliverables, dependencies, success criteria.\n\n\
         STEP 5 — TAREAS (REQUIRED)\n\
         Write `.dc/tareas/task-01.md` through `task-NN.md` (12–20 atomic, PR-sized).\n\
         Also write `.dc/tareas/INDEX.md` listing all tasks with one-line summaries.\n\
         Each task file must include:\n\
         - Title (verb + noun)\n\
         - Phase (from step 4)\n\
         - Scope (1–2 sentences)\n\
         - Expected files to touch (paths, even if approximate)\n\
         - Acceptance criteria (3–5 bullets — concrete, testable)\n\
         - Effort estimate (S/M/L)\n\
         {improvements_block}\n\
         STEP 7 — DESIGN AUDIT (if `.dc/design/` already has files)\n\
         Write `.dc/design/audit.md` analyzing the existing HTMLs:\n\
         - What's good about the current direction\n\
         - Specific improvements per screen (be concrete — colors, spacing, hierarchy)\n\
         - Whether the visual direction is consistent with the inferred product vision\n\
         - Suggested next steps (regenerate via Stitch, iterate, or keep as-is)\n\
         DO NOT touch the HTML files themselves in this run.\n\n\
         OUTPUT\n\
         When finished, output the literal string `DC_SDD_ONBOARDING_COMPLETE` followed \
         by a one-line summary count: blueprint=Y spec=Y plan=Y tasks=N audit=Y/N design=Y/N.\n"
    )
}
