//! Post-codegen verification: build + smoke test.
//!
//! Runs `npm install` (only if package.json changed), then `npm run build`,
//! then a brief smoke test (start the dev server, curl `/`, expect 2xx/3xx).
//! On failure, spawns one auto-fix attempt with a focused sub-Claude.
//!
//! Emits WS events of type `code_verification` with a `status` field
//! progressing through: `starting | installing | building | smoke_testing |
//! passed | fixing | failed`.

use chrono::Utc;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncBufReadExt;
use tokio::time::timeout;

use crate::AppState;
use crate::ws::WsMessage;

const BUILD_TIMEOUT: Duration = Duration::from_secs(240);
const DEV_READY_TIMEOUT: Duration = Duration::from_secs(60);
const SMOKE_HTTP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
struct StackInfo {
    /// Subdirectory relative to project root that contains package.json. Empty
    /// string = project root.
    rel_dir: String,
    /// Absolute path to that dir.
    abs_dir: PathBuf,
    has_build: bool,
    has_dev: bool,
    /// Port we expect the dev server to bind to (heuristic, defaults to 3000).
    dev_port: u16,
    /// Optional `NODE_OPTIONS` value to set when running scripts (rescues the
    /// Node-25 + localStorage issue we saw on MedeLink).
    node_options: Option<String>,
}

pub async fn verify_project(state: Arc<AppState>, project_path: String, project_id: String) {
    let tx = state.tx.clone();
    let root = PathBuf::from(&project_path);

    let emit = |status: &str, extra: serde_json::Value| {
        let _ = tx.send(WsMessage {
            msg_type: "code_verification".to_string(),
            data: serde_json::json!({
                "project_id": project_id,
                "status": status,
                "at": Utc::now().to_rfc3339(),
                "details": extra,
            }),
        });
    };

    emit("starting", serde_json::json!({}));

    // Detect every package.json under the project root (1 level deep). Multi-stack
    // projects (e.g. Trocheros: next/, web/, functions/, landing/) need each stack
    // verified independently.
    let stacks = detect_js_stacks(&root);
    if stacks.is_empty() {
        emit("skipped", serde_json::json!({
            "reason": "No JS/Node stack with build/dev scripts found.",
        }));
        return;
    }

    // Only verify the stack the user is likely targeting: the deepest stack that
    // had its source files touched recently (heuristic: pick the one with the
    // most recent mtime under <stack>/src or <stack>/app). Falls back to first.
    let primary = pick_primary_stack(&stacks);
    emit("stack_selected", serde_json::json!({
        "rel_dir": primary.rel_dir,
        "has_build": primary.has_build,
        "has_dev": primary.has_dev,
    }));

    // Step A — install deps (only if package-lock newer than node_modules, or
    // node_modules missing).
    if needs_install(&primary.abs_dir) {
        emit("installing", serde_json::json!({ "rel_dir": primary.rel_dir }));
        if !run_command(&tx, &project_id, &primary, "install",
                        &["install", "--silent", "--no-audit", "--no-fund"],
                        Duration::from_secs(300)).await {
            emit("failed", serde_json::json!({
                "step": "install",
                "rel_dir": primary.rel_dir,
            }));
            return;
        }
    }

    // Step B — build
    let build_ok = if primary.has_build {
        emit("building", serde_json::json!({ "rel_dir": primary.rel_dir }));
        run_command(&tx, &project_id, &primary, "build", &["run", "build"], BUILD_TIMEOUT).await
    } else {
        true
    };

    if !build_ok {
        // Attempt ONE auto-fix.
        emit("fixing", serde_json::json!({ "step": "build", "rel_dir": primary.rel_dir }));
        let fixed = spawn_autofix(&tx, &project_id, &primary, "build").await;
        if fixed {
            emit("building", serde_json::json!({ "rel_dir": primary.rel_dir, "retry": true }));
            let retry_ok = run_command(&tx, &project_id, &primary, "build", &["run", "build"], BUILD_TIMEOUT).await;
            if !retry_ok {
                emit("failed", serde_json::json!({
                    "step": "build",
                    "after_autofix": true,
                    "rel_dir": primary.rel_dir,
                }));
                return;
            }
        } else {
            emit("failed", serde_json::json!({
                "step": "build",
                "after_autofix": false,
                "rel_dir": primary.rel_dir,
            }));
            return;
        }
    }

    // Step C — smoke test (only if there's a `dev` script and a detectable port)
    if primary.has_dev {
        emit("smoke_testing", serde_json::json!({ "rel_dir": primary.rel_dir, "port": primary.dev_port }));
        match smoke_test(&tx, &project_id, &primary).await {
            SmokeResult::Pass => {}
            SmokeResult::Fail(reason) => {
                emit("fixing", serde_json::json!({ "step": "smoke", "reason": reason }));
                let fixed = spawn_autofix(&tx, &project_id, &primary, "smoke").await;
                if fixed {
                    if let SmokeResult::Pass = smoke_test(&tx, &project_id, &primary).await {
                        // recovered
                    } else {
                        emit("failed", serde_json::json!({
                            "step": "smoke",
                            "after_autofix": true,
                        }));
                        return;
                    }
                } else {
                    emit("failed", serde_json::json!({
                        "step": "smoke",
                        "after_autofix": false,
                    }));
                    return;
                }
            }
        }
    }

    // Step D — security scan (OWASP Top 10 review)
    emit("security_scanning", serde_json::json!({ "rel_dir": primary.rel_dir }));
    match security_scan(&tx, &project_id, &primary).await {
        SecurityResult::Pass { findings_path, critical, high, medium, low } => {
            emit("passed", serde_json::json!({
                "rel_dir": primary.rel_dir,
                "build_ok": build_ok,
                "security": {
                    "findings_path": findings_path,
                    "critical": critical,
                    "high": high,
                    "medium": medium,
                    "low": low,
                },
            }));
        }
        SecurityResult::Block { findings_path, critical, high, reason } => {
            emit("blocked", serde_json::json!({
                "step": "security",
                "rel_dir": primary.rel_dir,
                "build_ok": build_ok,
                "reason": reason,
                "security": {
                    "findings_path": findings_path,
                    "critical": critical,
                    "high": high,
                },
            }));
        }
        SecurityResult::Skipped(reason) => {
            emit("passed", serde_json::json!({
                "rel_dir": primary.rel_dir,
                "build_ok": build_ok,
                "security": { "skipped": reason },
            }));
        }
    }
}

#[derive(Debug)]
enum SecurityResult {
    /// Scan completed; no critical findings (high count surfaced but non-blocking).
    Pass {
        findings_path: String,
        critical: u32,
        high: u32,
        medium: u32,
        low: u32,
    },
    /// Critical (or many high) findings — verification did not pass.
    Block {
        findings_path: String,
        critical: u32,
        high: u32,
        reason: String,
    },
    Skipped(String),
}

async fn security_scan(
    tx: &tokio::sync::broadcast::Sender<WsMessage>,
    project_id: &str,
    stack: &StackInfo,
) -> SecurityResult {
    let findings_rel = ".dc/audits/security.md";
    let findings_abs = stack.abs_dir.join(findings_rel);
    if let Some(parent) = findings_abs.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let prompt = format!(
        "You are running a SECURITY review for the recently regenerated code in the \
         stack at `{}` (cwd: `{}`). Audit against the OWASP Top 10 and write a single \
         findings report to `{}`.\n\n\
         FOCUS — review files that were modified in the last code regeneration. Start \
         by running `git status --short` to see what changed. Prioritize files under \
         `src/`, `app/`, `pages/`, `api/`, `lib/`, `middleware*`. Skim everything \
         touched.\n\n\
         OWASP TOP 10 CHECKLIST (mention each — at minimum confirm 'not applicable' or 'no findings'):\n\
         A01 Broken Access Control — missing authz checks, IDOR, exposed admin routes\n\
         A02 Cryptographic Failures — weak hashing, secrets in client bundles, plain-text comms\n\
         A03 Injection — SQL/NoSQL/command injection, unsafe template strings\n\
         A04 Insecure Design — missing rate limits, weak password policy, missing CSRF\n\
         A05 Security Misconfiguration — default creds, debug routes enabled, permissive CORS, \
              missing security headers (CSP, HSTS, X-Frame-Options)\n\
         A06 Vulnerable Components — outdated deps with known CVEs (check package.json)\n\
         A07 Identification & Authentication Failures — missing MFA, weak sessions, JWT misuse\n\
         A08 Software & Data Integrity Failures — unsafe deserialization, supply chain risks, \
              missing SRI on CDN scripts\n\
         A09 Logging & Monitoring Failures — sensitive data logged, missing audit trail\n\
         A10 SSRF — fetch with user-controlled URLs, no allow-list\n\n\
         FRAMEWORK-SPECIFIC checks:\n\
         - Next.js / React: 'use server' actions without authz; `dangerouslySetInnerHTML` without \
           sanitization; secrets in `NEXT_PUBLIC_*` env vars; missing middleware on API routes.\n\
         - Supabase: tables without RLS; service-role key on client; missing 'auth.uid()' checks.\n\
         - Firebase: Firestore rules `allow read, write: if true`; insecure storage rules; \
           service-account JSON in repo.\n\
         - Mapbox/Google Maps API keys with no domain restriction.\n\n\
         OUTPUT FORMAT (write to `{}`):\n\
         Start with this exact line so the runtime can parse counts:\n\
         `SUMMARY: critical=<N> high=<N> medium=<N> low=<N>`\n\n\
         Then markdown sections per category. For each finding include: severity, file:line, \
         description, and remediation.\n\n\
         WHEN DONE: output the literal `DC_SECURITY_DONE` followed by the SUMMARY line.\n",
        stack.rel_dir, stack.abs_dir.display(), findings_rel, findings_rel,
    );

    let _ = tx.send(WsMessage {
        msg_type: "code_verification_log".to_string(),
        data: serde_json::json!({
            "project_id": project_id,
            "step": "security",
            "stream": "info",
            "line": "Running OWASP Top 10 security review on regenerated code…",
        }),
    });

    let spawn = tokio::process::Command::new("claude")
        .args([
            "-p",
            "--model", "sonnet",
            "--dangerously-skip-permissions",
            "--output-format", "json",
            &prompt,
        ])
        .current_dir(&stack.abs_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match spawn {
        Ok(c) => c,
        Err(e) => return SecurityResult::Skipped(format!("Could not spawn scanner: {}", e)),
    };

    if let Some(stdout) = child.stdout.take() {
        let tx2 = tx.clone();
        let pid = project_id.to_string();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx2.send(WsMessage {
                    msg_type: "code_verification_log".to_string(),
                    data: serde_json::json!({
                        "project_id": pid, "step": "security", "stream": "stdout", "line": line,
                    }),
                });
            }
        });
    }

    let wait = timeout(Duration::from_secs(360), child.wait()).await;
    if !matches!(wait, Ok(Ok(s)) if s.success()) {
        return SecurityResult::Skipped("Scanner timed out or exited non-zero".to_string());
    }

    // Parse the SUMMARY line.
    let content = std::fs::read_to_string(&findings_abs).unwrap_or_default();
    let summary_line = content.lines().find(|l| l.trim_start().starts_with("SUMMARY:")).unwrap_or("");
    let (critical, high, medium, low) = parse_summary(summary_line);

    if critical > 0 {
        SecurityResult::Block {
            findings_path: findings_rel.to_string(),
            critical, high,
            reason: format!("{} critical OWASP finding(s) detected. Review {} before shipping.", critical, findings_rel),
        }
    } else if high >= 3 {
        SecurityResult::Block {
            findings_path: findings_rel.to_string(),
            critical, high,
            reason: format!("{} high-severity OWASP findings exceed threshold (3). Review {} before shipping.", high, findings_rel),
        }
    } else {
        SecurityResult::Pass {
            findings_path: findings_rel.to_string(),
            critical, high, medium, low,
        }
    }
}

fn parse_summary(line: &str) -> (u32, u32, u32, u32) {
    let mut c = (0u32, 0u32, 0u32, 0u32);
    for token in line.split_whitespace() {
        if let Some(rest) = token.strip_prefix("critical=") { c.0 = rest.parse().unwrap_or(0); }
        else if let Some(rest) = token.strip_prefix("high=") { c.1 = rest.parse().unwrap_or(0); }
        else if let Some(rest) = token.strip_prefix("medium=") { c.2 = rest.parse().unwrap_or(0); }
        else if let Some(rest) = token.strip_prefix("low=") { c.3 = rest.parse().unwrap_or(0); }
    }
    c
}

fn detect_js_stacks(root: &Path) -> Vec<StackInfo> {
    let mut out = Vec::new();
    // Root itself
    if let Some(info) = read_stack(root, "") {
        out.push(info);
    }
    // One level deep
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else { continue };
            if !path.is_dir() { continue; }
            if matches!(name, "node_modules" | ".git" | ".next" | ".dc" | "target" | "build" | "dist" | ".idea" | ".gradle" | "android") {
                continue;
            }
            if let Some(info) = read_stack(&path, name) {
                out.push(info);
            }
        }
    }
    out
}

fn read_stack(dir: &Path, rel: &str) -> Option<StackInfo> {
    let pkg = dir.join("package.json");
    let content = std::fs::read_to_string(&pkg).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let scripts = json.get("scripts")?.as_object()?;
    let has_build = scripts.contains_key("build");
    let has_dev = scripts.contains_key("dev") || scripts.contains_key("start");

    if !has_build && !has_dev { return None; }

    // Sniff NODE_OPTIONS from existing scripts so we inherit any workaround
    // (e.g. --localstorage-file) the project already configured.
    let node_options = scripts.get("dev")
        .and_then(|v| v.as_str())
        .and_then(extract_node_options);

    // Heuristic port detection from `dev_cmd` flags.
    let dev_port = scripts.get("dev")
        .and_then(|v| v.as_str())
        .and_then(extract_port)
        .unwrap_or(3000);

    Some(StackInfo {
        rel_dir: rel.to_string(),
        abs_dir: dir.to_path_buf(),
        has_build,
        has_dev,
        dev_port,
        node_options,
    })
}

fn extract_node_options(script: &str) -> Option<String> {
    // Match `NODE_OPTIONS="..."` or `NODE_OPTIONS=...`
    let key = "NODE_OPTIONS=";
    let idx = script.find(key)?;
    let rest = &script[idx + key.len()..];
    let value = if rest.starts_with('"') {
        let end = rest[1..].find('"')?;
        &rest[1..1 + end]
    } else {
        rest.split_whitespace().next()?
    };
    Some(value.to_string())
}

fn extract_port(script: &str) -> Option<u16> {
    for token in script.split_whitespace() {
        if let Some(rest) = token.strip_prefix("--port=") {
            return rest.parse().ok();
        }
    }
    let parts: Vec<&str> = script.split_whitespace().collect();
    for i in 0..parts.len() {
        if (parts[i] == "-p" || parts[i] == "--port") && i + 1 < parts.len() {
            return parts[i + 1].parse().ok();
        }
    }
    None
}

fn pick_primary_stack(stacks: &[StackInfo]) -> StackInfo {
    // Prefer the stack whose `src/` or `app/` has the most recent mtime.
    let mut best: Option<(StackInfo, std::time::SystemTime)> = None;
    for s in stacks {
        let mt = ["src", "app", "pages"]
            .iter()
            .filter_map(|sub| std::fs::metadata(s.abs_dir.join(sub)).ok())
            .filter_map(|m| m.modified().ok())
            .max()
            .unwrap_or(std::time::UNIX_EPOCH);
        match &best {
            None => best = Some((s.clone(), mt)),
            Some((_, prev)) if mt > *prev => best = Some((s.clone(), mt)),
            _ => {}
        }
    }
    best.map(|(s, _)| s).unwrap_or_else(|| stacks[0].clone())
}

fn needs_install(dir: &Path) -> bool {
    let node_modules = dir.join("node_modules");
    if !node_modules.exists() { return true; }
    let pkg_lock_meta = std::fs::metadata(dir.join("package-lock.json")).ok();
    let nm_meta = std::fs::metadata(&node_modules).ok();
    match (pkg_lock_meta.and_then(|m| m.modified().ok()),
           nm_meta.and_then(|m| m.modified().ok())) {
        (Some(lock), Some(nm)) => lock > nm,
        _ => false,
    }
}

/// Returns true if the command exited 0 within `time_limit`. Streams stdout +
/// stderr lines as WS log events. Captures the LAST 200 lines to a file so a
/// follow-up auto-fix has the error context.
async fn run_command(
    tx: &tokio::sync::broadcast::Sender<WsMessage>,
    project_id: &str,
    stack: &StackInfo,
    label: &str,
    args: &[&str],
    time_limit: Duration,
) -> bool {
    let mut cmd = tokio::process::Command::new("npm");
    cmd.args(args)
        .current_dir(&stack.abs_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(opts) = &stack.node_options {
        cmd.env("NODE_OPTIONS", opts);
    }
    #[cfg(unix)]
    cmd.process_group(0);

    let Ok(mut child) = cmd.spawn() else {
        let _ = tx.send(WsMessage {
            msg_type: "code_verification_log".to_string(),
            data: serde_json::json!({
                "project_id": project_id,
                "step": label,
                "line": format!("[verification] failed to spawn npm {:?}", args),
            }),
        });
        return false;
    };
    let child_pid = child.id().map(|p| p as i32);

    if let Some(stdout) = child.stdout.take() {
        let tx2 = tx.clone();
        let pid = project_id.to_string();
        let lbl = label.to_string();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            let buf_path = log_buffer_path(&pid);
            while let Ok(Some(line)) = lines.next_line().await {
                append_log_line(&buf_path, &line);
                let _ = tx2.send(WsMessage {
                    msg_type: "code_verification_log".to_string(),
                    data: serde_json::json!({ "project_id": pid, "step": lbl, "stream": "stdout", "line": line }),
                });
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let tx2 = tx.clone();
        let pid = project_id.to_string();
        let lbl = label.to_string();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            let buf_path = log_buffer_path(&pid);
            while let Ok(Some(line)) = lines.next_line().await {
                append_log_line(&buf_path, &line);
                let _ = tx2.send(WsMessage {
                    msg_type: "code_verification_log".to_string(),
                    data: serde_json::json!({ "project_id": pid, "step": lbl, "stream": "stderr", "line": line }),
                });
            }
        });
    }

    match timeout(time_limit, child.wait()).await {
        Ok(Ok(status)) => status.success(),
        Ok(Err(_)) => false,
        Err(_) => {
            kill_process_group(child_pid);
        let _ = child.kill().await;
            false
        }
    }
}

enum SmokeResult {
    Pass,
    Fail(String),
}

async fn smoke_test(
    tx: &tokio::sync::broadcast::Sender<WsMessage>,
    project_id: &str,
    stack: &StackInfo,
) -> SmokeResult {
    let mut cmd = tokio::process::Command::new("npm");
    cmd.args(["run", "dev"])
        .current_dir(&stack.abs_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(opts) = &stack.node_options {
        cmd.env("NODE_OPTIONS", opts);
    }
    // CRITICAL: put the dev server in its own process group so we can kill
    // the whole tree (npm → next → next-server) atomically. Without this,
    // `child.kill()` only stops `npm` and leaves `next-server` running as a
    // zombie, blocking verification forever.
    #[cfg(unix)]
    cmd.process_group(0);

    let Ok(mut child) = cmd.spawn() else {
        return SmokeResult::Fail("Failed to spawn dev server".to_string());
    };
    let child_pid = child.id().map(|p| p as i32);

    // Tap stdout/stderr to detect "ready" + capture errors for autofix.
    let ready_marker = std::sync::Arc::new(tokio::sync::Notify::new());
    let last_lines: std::sync::Arc<tokio::sync::Mutex<Vec<String>>> =
        std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));

    fn is_ready(line: &str) -> bool {
        let l = line.to_lowercase();
        l.contains("ready in") || l.contains("local:") || l.contains("listening on") || l.contains("started server on")
    }

    if let Some(stdout) = child.stdout.take() {
        let tx2 = tx.clone();
        let pid = project_id.to_string();
        let notify = ready_marker.clone();
        let buf = last_lines.clone();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                {
                    let mut b = buf.lock().await;
                    b.push(line.clone());
                    if b.len() > 200 { let _ = b.remove(0); }
                }
                if is_ready(&line) { notify.notify_one(); }
                let _ = tx2.send(WsMessage {
                    msg_type: "code_verification_log".to_string(),
                    data: serde_json::json!({ "project_id": pid, "step": "smoke", "stream": "stdout", "line": line }),
                });
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let tx2 = tx.clone();
        let pid = project_id.to_string();
        let notify = ready_marker.clone();
        let buf = last_lines.clone();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                {
                    let mut b = buf.lock().await;
                    b.push(line.clone());
                    if b.len() > 200 { let _ = b.remove(0); }
                }
                if is_ready(&line) { notify.notify_one(); }
                let _ = tx2.send(WsMessage {
                    msg_type: "code_verification_log".to_string(),
                    data: serde_json::json!({ "project_id": pid, "step": "smoke", "stream": "stderr", "line": line }),
                });
            }
        });
    }

    let ready = timeout(DEV_READY_TIMEOUT, ready_marker.notified()).await;
    if ready.is_err() {
        kill_process_group(child_pid);
        let _ = child.kill().await;
        let lines = last_lines.lock().await.join("\n");
        write_smoke_log(project_id, &lines);
        return SmokeResult::Fail("Dev server didn't become ready in 60s".to_string());
    }

    // Give it a moment to fully bind.
    tokio::time::sleep(Duration::from_millis(500)).await;

    let url = format!("http://localhost:{}/", stack.dev_port);
    let probe = timeout(SMOKE_HTTP_TIMEOUT, async {
        // Plain TCP+HTTP/1.0 GET — no extra crate needed.
        use tokio::io::AsyncReadExt;
        use tokio::io::AsyncWriteExt;
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", stack.dev_port)).await.ok()?;
        let req = format!("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n");
        stream.write_all(req.as_bytes()).await.ok()?;
        let mut buf = Vec::with_capacity(2048);
        let mut chunk = [0u8; 2048];
        for _ in 0..32 {
            let n = stream.read(&mut chunk).await.ok()?;
            if n == 0 { break; }
            buf.extend_from_slice(&chunk[..n]);
            if buf.len() > 32_000 { break; }
        }
        Some(String::from_utf8_lossy(&buf).into_owned())
    }).await;

    kill_process_group(child_pid);
    let _ = child.kill().await;
    let _ = child.wait().await;

    match probe {
        Ok(Some(response)) => {
            // First line: "HTTP/1.0 200 OK"
            let first = response.lines().next().unwrap_or("").to_string();
            let parts: Vec<&str> = first.split_whitespace().collect();
            let status_code = parts.get(1).and_then(|s| s.parse::<u16>().ok()).unwrap_or(0);
            if (200..=399).contains(&status_code) {
                let _ = url;
                SmokeResult::Pass
            } else {
                let lines = last_lines.lock().await.join("\n");
                write_smoke_log(project_id, &lines);
                SmokeResult::Fail(format!("HTTP {} on GET / ({})", status_code, first))
            }
        }
        Ok(None) | Err(_) => {
            let lines = last_lines.lock().await.join("\n");
            write_smoke_log(project_id, &lines);
            SmokeResult::Fail(format!("Could not reach {}", url))
        }
    }
}

fn log_buffer_path(project_id: &str) -> PathBuf {
    PathBuf::from(format!("/tmp/dc-verify-{}.log", project_id))
}

fn append_log_line(path: &Path, line: &str) {
    use std::io::Write;
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut f| writeln!(f, "{}", line));
}

fn write_smoke_log(project_id: &str, content: &str) {
    let _ = std::fs::write(log_buffer_path(project_id), content);
}

/// Spawn a focused sub-Claude to fix the build/smoke failure using the recent
/// log content. Returns true if it claimed to fix something.
async fn spawn_autofix(
    tx: &tokio::sync::broadcast::Sender<WsMessage>,
    project_id: &str,
    stack: &StackInfo,
    step: &str,
) -> bool {
    let log_path = log_buffer_path(project_id);
    let log_excerpt = std::fs::read_to_string(&log_path)
        .ok()
        .map(|s| s.lines().rev().take(80).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"))
        .unwrap_or_else(|| "(no log captured)".to_string());

    let prompt = format!(
        "You are auto-fixing a {step} failure that just happened on stack `{rel_dir}` \
         (cwd: `{abs_dir}`). Read the failure log below, infer the root cause, and \
         apply the smallest possible fix to the source code. Do NOT modify tests. Do \
         NOT introduce new dependencies unless absolutely required. DO NOT downgrade \
         existing dependencies.\n\n\
         FAILURE LOG (last lines):\n```\n{log_excerpt}\n```\n\n\
         RULES:\n\
         - Read 2–3 files mentioned in the log before editing.\n\
         - Make one focused fix. If the log shows multiple errors, fix the first one.\n\
         - For Node-25 `localStorage.getItem is not a function` errors during SSR: \
           the root cause is usually a server-side `localStorage` access. Patch the \
           offending file to guard with `typeof window !== 'undefined'`.\n\
         - For 'Module not found' errors: create the missing file or correct the import path.\n\
         - For type errors: fix the type, do not weaken with `any` unless truly necessary.\n\n\
         OUTPUT: when done, output exactly `DC_AUTOFIX_APPLIED` if you fixed something, \
         or `DC_AUTOFIX_SKIPPED` if no fix was warranted.\n",
        step = step,
        rel_dir = if stack.rel_dir.is_empty() { ".".to_string() } else { stack.rel_dir.clone() },
        abs_dir = stack.abs_dir.display(),
        log_excerpt = log_excerpt,
    );

    let _ = tx.send(WsMessage {
        msg_type: "code_verification_log".to_string(),
        data: serde_json::json!({
            "project_id": project_id,
            "step": "autofix",
            "stream": "info",
            "line": format!("Spawning autofix agent for {} failure…", step),
        }),
    });

    let spawn = tokio::process::Command::new("claude")
        .args([
            "-p",
            "--model", "sonnet",
            "--dangerously-skip-permissions",
            "--output-format", "json",
            &prompt,
        ])
        .current_dir(&stack.abs_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match spawn {
        Ok(c) => c,
        Err(_) => return false,
    };

    // Truncate the log buffer so the next attempt captures fresh output.
    let _ = std::fs::write(&log_path, "");

    let result = timeout(Duration::from_secs(180), child.wait()).await;
    matches!(result, Ok(Ok(s)) if s.success())
}

/// Kill the entire process group rooted at `pid` (SIGKILL). Required because
/// `tokio::process::Child::kill` only signals the immediate process — npm,
/// next, and next-server form a tree where the children survive otherwise.
#[cfg(unix)]
fn kill_process_group(pid: Option<i32>) {
    let Some(pid) = pid else { return };
    // SAFETY: killpg with a negative pgid sends the signal to the whole group.
    // `pid` here is the leader's pid (== pgid because we set process_group(0)).
    // SIGKILL (9) is unconditional. Errors are ignored — the process may have
    // already exited.
    unsafe {
        libc::killpg(pid, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_process_group(_pid: Option<i32>) {}
