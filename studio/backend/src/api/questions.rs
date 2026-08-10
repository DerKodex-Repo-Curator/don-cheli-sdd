//! Bidirectional questions — Layer 3 of interactivity.
//!
//! During a pipeline run Claude can append questions to `.dc/questions/pending.jsonl`
//! when it needs a decision it can't reasonably guess. The questions-gate in
//! the runtime polls for answers in `.dc/questions/answers.jsonl`. The Studio
//! exposes both files via this module: the UI lists unanswered questions and
//! POSTs answers back.
//!
//! Files live in the worktree during a run and in the project root afterwards,
//! so all reads use `resolve_questions_dir` which prefers the worktree.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path as StdPath, PathBuf};
use std::sync::Arc;

use crate::AppState;
use crate::ws::WsMessage;

// ── Types written/read on disk by both the runtime and this module ──

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Question {
    pub id: String,
    pub phase: Option<String>,           // which phase asked
    pub question: String,
    /// Optional explanation of why the runtime needs this info.
    #[serde(default)]
    pub context: Option<String>,
    /// "text" (free text), "choice" (one of options), "boolean" (yes/no)
    #[serde(default = "default_type")]
    pub kind: String,
    /// Available options when kind == "choice".
    #[serde(default)]
    pub options: Vec<String>,
    /// Default value the runtime suggests; UI prefills with this.
    #[serde(default)]
    pub default: Option<String>,
    /// "blocking" (pipeline can't continue without an answer) or "informative".
    #[serde(default = "default_urgency")]
    pub urgency: String,
    #[serde(default)]
    pub created_at: Option<String>,
}

fn default_type() -> String { "text".to_string() }
fn default_urgency() -> String { "blocking".to_string() }

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Answer {
    pub id: String,
    pub answer: String,
    #[serde(default)]
    pub answered_by: Option<String>,
    #[serde(default)]
    pub answered_at: Option<String>,
    /// True if the user dismissed an informative question without a real answer.
    #[serde(default)]
    pub skipped: bool,
}

// ── Response shapes ──

#[derive(Serialize)]
pub struct PendingResponse {
    pub questions: Vec<QuestionWithAnswer>,
    pub blocking_count: usize,
    pub source: Option<String>,
}

#[derive(Serialize)]
pub struct QuestionWithAnswer {
    #[serde(flatten)]
    pub question: Question,
    pub answer: Option<Answer>,
}

#[derive(Deserialize)]
pub struct AnswerInput {
    pub answer: String,
    #[serde(default)]
    pub answered_by: Option<String>,
    #[serde(default)]
    pub skipped: bool,
}

// ── List pending (unanswered) questions ──

pub async fn pending(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Result<Json<PendingResponse>, StatusCode> {
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let dir = resolve_questions_dir(&project.path);
    let questions = read_jsonl::<Question>(&dir.join("pending.jsonl"));
    let answers_index = answers_by_id(&dir);

    let answered_ids: HashSet<String> = answers_index.keys().cloned().collect();
    let pending: Vec<QuestionWithAnswer> = questions
        .into_iter()
        .filter(|q| !answered_ids.contains(&q.id))
        .map(|q| QuestionWithAnswer { answer: None, question: q })
        .collect();

    let blocking_count = pending.iter()
        .filter(|q| q.question.urgency == "blocking")
        .count();

    Ok(Json(PendingResponse {
        questions: pending,
        blocking_count,
        source: Some(dir.to_string_lossy().to_string()),
    }))
}

// ── List ALL questions (with answers) — useful for history/debug ──

pub async fn list_all(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Result<Json<PendingResponse>, StatusCode> {
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let dir = resolve_questions_dir(&project.path);
    let questions = read_jsonl::<Question>(&dir.join("pending.jsonl"));
    let answers_index = answers_by_id(&dir);

    let combined: Vec<QuestionWithAnswer> = questions
        .into_iter()
        .map(|q| {
            let answer = answers_index.get(&q.id).cloned();
            QuestionWithAnswer { question: q, answer }
        })
        .collect();

    let blocking_count = combined
        .iter()
        .filter(|q| q.answer.is_none() && q.question.urgency == "blocking")
        .count();

    Ok(Json(PendingResponse {
        questions: combined,
        blocking_count,
        source: Some(dir.to_string_lossy().to_string()),
    }))
}

// ── Submit an answer ──

pub async fn submit_answer(
    State(state): State<Arc<AppState>>,
    Path((project_id, question_id)): Path<(String, String)>,
    Json(payload): Json<AnswerInput>,
) -> Result<Json<Answer>, StatusCode> {
    let project = state
        .db
        .get_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let dir = resolve_questions_dir(&project.path);
    std::fs::create_dir_all(&dir).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Make sure the question exists
    let questions = read_jsonl::<Question>(&dir.join("pending.jsonl"));
    let question = questions.iter().find(|q| q.id == question_id);
    if question.is_none() {
        return Err(StatusCode::NOT_FOUND);
    }

    // Refuse double-answering — runtime can re-open by writing a new question id
    let existing_answers = answers_by_id(&dir);
    if existing_answers.contains_key(&question_id) {
        return Err(StatusCode::CONFLICT);
    }

    let answer = Answer {
        id: question_id.clone(),
        answer: payload.answer,
        answered_by: payload.answered_by.or_else(|| Some("Studio user".to_string())),
        answered_at: Some(Utc::now().to_rfc3339()),
        skipped: payload.skipped,
    };

    // Append to answers.jsonl
    let answers_path = dir.join("answers.jsonl");
    let line = serde_json::to_string(&answer).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut existing = std::fs::read_to_string(&answers_path).unwrap_or_default();
    if !existing.is_empty() && !existing.ends_with('\n') {
        existing.push('\n');
    }
    existing.push_str(&line);
    existing.push('\n');
    std::fs::write(&answers_path, existing).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Broadcast so the UI's other tabs / Ahora dashboard refreshes immediately
    let _ = state.tx.send(WsMessage {
        msg_type: "question_answered".to_string(),
        data: serde_json::json!({
            "project_id": project_id,
            "question_id": question_id,
            "skipped": answer.skipped,
        }),
    });

    Ok(Json(answer))
}

// ── Helpers ──

/// Prefer the active worktree's questions dir during a run; fall back to the
/// project root for completed runs.
/// Resolve where to read/write questions. Priority order:
///   1. Any worktree's `.dc/questions/` that already has files (active run)
///   2. Project root's `.dc/questions/` if it has files (completed run or manual setup)
///   3. The first worktree's `.dc/questions/` path (about to be created — runtime starting)
///   4. Project root's `.dc/questions/` (fallback for write)
fn resolve_questions_dir(project_path: &str) -> PathBuf {
    let project_root = PathBuf::from(project_path);
    let worktrees = project_root.join(".dc").join("worktrees");

    let worktree_dirs: Vec<PathBuf> = std::fs::read_dir(&worktrees)
        .ok()
        .map(|it| it.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();

    // 1. Worktree with existing pending/answers files (active run pipeline)
    for wt in &worktree_dirs {
        let candidate = wt.join(".dc").join("questions");
        if candidate.join("pending.jsonl").exists() || candidate.join("answers.jsonl").exists() {
            return candidate;
        }
    }

    // 2. Project root with existing files (completed run, manual seed)
    let root_q = project_root.join(".dc").join("questions");
    if root_q.join("pending.jsonl").exists() || root_q.join("answers.jsonl").exists() {
        return root_q;
    }

    // 3. First worktree (if any) — runtime is about to write here
    if let Some(wt) = worktree_dirs.first() {
        let candidate = wt.join(".dc").join("questions");
        if wt.join(".dc").exists() { return candidate; }
    }

    // 4. Project root fallback
    root_q
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: &StdPath) -> Vec<T> {
    let Ok(content) = std::fs::read_to_string(path) else { return Vec::new() };
    let mut out = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") { continue }
        match serde_json::from_str::<T>(trimmed) {
            Ok(v) => out.push(v),
            Err(e) => tracing::debug!("Skipping malformed jsonl line: {} ({})", trimmed, e),
        }
    }
    out
}

fn answers_by_id(dir: &StdPath) -> HashMap<String, Answer> {
    let answers = read_jsonl::<Answer>(&dir.join("answers.jsonl"));
    let mut out = HashMap::new();
    for a in answers {
        // Latest write wins if there are duplicates (which shouldn't happen,
        // but a runtime bug could cause it).
        out.insert(a.id.clone(), a);
    }
    out
}
