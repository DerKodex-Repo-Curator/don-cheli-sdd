use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::Serialize;
use std::sync::Arc;

use crate::AppState;

#[derive(Serialize)]
pub struct CostEstimate {
    pub provider: String,
    pub model: String,
    pub phases: u32,
    pub estimated_minutes: f64,
    pub runtime_cost: f64,
    pub token_cost: f64,
    pub total: f64,
}

#[derive(Serialize)]
pub struct CostHistory {
    pub runs: Vec<RunCost>,
}

#[derive(Serialize)]
pub struct RunCost {
    pub run_id: String,
    pub task: String,
    pub total_cost: f64,
    pub provider: String,
    pub started_at: String,
}

pub async fn estimate(
    State(_state): State<Arc<AppState>>,
    Path(_project_id): Path<String>,
) -> Json<CostEstimate> {
    // Default estimate for 6 phases with Claude
    let phases = 6u32;
    let minutes_per_phase = 5.0;
    let estimated_minutes = phases as f64 * minutes_per_phase;

    // Claude Code CLI = free, Managed Agents = $0.08/hr, Ollama = free
    let runtime_cost = 0.0; // Default to Claude Code CLI (free)
    let token_cost = phases as f64 * 0.15; // ~50K tokens per phase at sonnet rates

    Json(CostEstimate {
        provider: "claude".to_string(),
        model: "sonnet".to_string(),
        phases,
        estimated_minutes,
        runtime_cost,
        token_cost,
        total: runtime_cost + token_cost,
    })
}

pub async fn history(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Result<Json<CostHistory>, StatusCode> {
    let runs = state
        .db
        .get_runs_for_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(CostHistory {
        runs: runs
            .into_iter()
            .map(|r| RunCost {
                run_id: r.id,
                task: r.task,
                total_cost: r.total_cost,
                provider: r.provider,
                started_at: r.started_at,
            })
            .collect(),
    }))
}

// ── Aggregated dashboard data (Gastos page) ──

#[derive(Serialize)]
pub struct AggregatedCosts {
    pub this_month: f64,
    pub budget: f64,
    pub estimated_end: f64,
    pub last_month: f64,
    pub jobs_this_month: u64,
    pub daily: Vec<DayCost>,
    pub by_project: Vec<GroupedCost>,
    pub by_model: Vec<GroupedCost>,
    pub by_step: Vec<GroupedCost>,
}

#[derive(Serialize)]
pub struct DayCost {
    pub d: u32,    // day of month
    pub v: f64,    // dollars
}

#[derive(Serialize)]
pub struct GroupedCost {
    pub id: String,
    pub cost: f64,
    pub pct: u32,
}

pub async fn aggregated(
    State(state): State<Arc<AppState>>,
) -> Result<Json<AggregatedCosts>, StatusCode> {
    use chrono::{Datelike, Local, TimeZone, Utc};

    let projects = state.db.list_projects().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let project_name: std::collections::HashMap<_, _> =
        projects.iter().map(|p| (p.id.clone(), p.name.clone())).collect();

    // Pull all runs (across all projects)
    let mut all_runs = Vec::new();
    for p in &projects {
        if let Ok(runs) = state.db.get_runs_for_project(&p.id) {
            all_runs.extend(runs);
        }
    }

    let now = Utc::now();
    let month_start = Utc.with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0).unwrap();
    let prev_month = if now.month() == 1 {
        Utc.with_ymd_and_hms(now.year() - 1, 12, 1, 0, 0, 0).unwrap()
    } else {
        Utc.with_ymd_and_hms(now.year(), now.month() - 1, 1, 0, 0, 0).unwrap()
    };

    let parsed: Vec<(chrono::DateTime<Utc>, &crate::db::PipelineRun)> = all_runs
        .iter()
        .filter_map(|r| {
            chrono::DateTime::parse_from_rfc3339(&r.started_at)
                .ok()
                .map(|d| (d.with_timezone(&Utc), r))
        })
        .collect();

    let this_month_runs: Vec<_> = parsed.iter().filter(|(d, _)| *d >= month_start).collect();
    let prev_month_runs: Vec<_> = parsed.iter()
        .filter(|(d, _)| *d >= prev_month && *d < month_start).collect();

    let this_month: f64 = this_month_runs.iter().map(|(_, r)| r.total_cost).sum();
    let last_month: f64 = prev_month_runs.iter().map(|(_, r)| r.total_cost).sum();
    let jobs_this_month = this_month_runs.len() as u64;

    // Daily breakdown for the current month
    let days_in_month = days_in_month(now.year(), now.month());
    let mut daily = Vec::with_capacity(days_in_month as usize);
    for d in 1..=days_in_month {
        let total: f64 = this_month_runs.iter()
            .filter(|(dt, _)| dt.day() == d)
            .map(|(_, r)| r.total_cost)
            .sum();
        daily.push(DayCost { d, v: round2(total) });
    }

    // Estimate end-of-month based on current daily rate
    let today = Local::now().day().max(1);
    let daily_rate = this_month / today as f64;
    let estimated_end = round2(daily_rate * days_in_month as f64);

    // By project
    let mut project_costs: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for (_, r) in &this_month_runs {
        *project_costs.entry(r.project_id.clone()).or_insert(0.0) += r.total_cost;
    }
    let by_project = top_grouped(&project_costs, this_month, |id| {
        project_name.get(id).cloned().unwrap_or_else(|| id[..6.min(id.len())].to_string())
    });

    // By model
    let mut model_costs: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for (_, r) in &this_month_runs {
        *model_costs.entry(format!("{} {}", r.provider, r.model)).or_insert(0.0) += r.total_cost;
    }
    let by_model = top_grouped(&model_costs, this_month, |id| id.to_string());

    // By step: aggregate from cost_entries via runs phases
    let by_step = aggregate_by_phase(&state.db, &this_month_runs, this_month);

    Ok(Json(AggregatedCosts {
        this_month: round2(this_month),
        budget: 100.0,
        estimated_end,
        last_month: round2(last_month),
        jobs_this_month,
        daily,
        by_project,
        by_model,
        by_step,
    }))
}

fn aggregate_by_phase(
    db: &crate::db::Database,
    runs: &[&(chrono::DateTime<chrono::Utc>, &crate::db::PipelineRun)],
    total: f64,
) -> Vec<GroupedCost> {
    let mut by_phase: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for (_, r) in runs {
        if let Ok(phases) = db.get_phases_for_run(&r.id) {
            for ph in phases {
                *by_phase.entry(spanish_phase(&ph.name)).or_insert(0.0) += ph.cost_usd;
            }
        }
    }
    top_grouped(&by_phase, total, |id| id.to_string())
}

fn spanish_phase(name: &str) -> String {
    match name {
        "specify" => "Especificar",
        "clarify" => "Aclarar",
        "plan" => "Planificar",
        "design" => "Diseñar",
        "breakdown" => "Desglosar",
        "implement" => "Construir",
        "review" => "Revisar",
        other => return other.to_string(),
    }.to_string()
}

fn top_grouped<F: Fn(&str) -> String>(
    map: &std::collections::HashMap<String, f64>, total: f64, label: F,
) -> Vec<GroupedCost> {
    let mut v: Vec<_> = map.iter().map(|(k, v)| (k.clone(), *v)).collect();
    v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    v.truncate(7);
    let denom = if total > 0.0 { total } else { 1.0 };
    v.into_iter().map(|(k, c)| GroupedCost {
        id: label(&k),
        cost: round2(c),
        pct: ((c / denom) * 100.0).round() as u32,
    }).collect()
}

fn round2(v: f64) -> f64 { (v * 100.0).round() / 100.0 }

fn days_in_month(year: i32, month: u32) -> u32 {
    use chrono::{NaiveDate};
    let next = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)
    };
    let first = NaiveDate::from_ymd_opt(year, month, 1).unwrap();
    next.unwrap().signed_duration_since(first).num_days() as u32
}
