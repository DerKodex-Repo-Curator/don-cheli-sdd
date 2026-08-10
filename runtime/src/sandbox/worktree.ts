/**
 * Don Cheli Runtime — Git Worktree Manager
 * Forked and adapted from Sandcastle (mattpocock/sandcastle, Apache 2.0)
 */

import { execSync } from "child_process";
import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseBranch: string;
}

function git(args: string, cwd?: string): string {
  return execSync(`git ${args}`, {
    encoding: "utf-8",
    cwd,
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** Same as git() but also captures stderr in the error message for diagnostics. */
function gitVerbose(args: string, cwd?: string): string {
  try {
    return git(args, cwd);
  } catch (err) {
    const e = err as { message?: string; stderr?: Buffer };
    const stderr = e.stderr ? e.stderr.toString() : "";
    throw new Error(`git ${args} failed: ${e.message ?? ""} ${stderr}`);
  }
}

export function getCurrentBranch(cwd?: string): string {
  return git("branch --show-current", cwd);
}

export function isGitRepo(cwd?: string): boolean {
  try {
    git("rev-parse --is-inside-work-tree", cwd);
    return true;
  } catch {
    return false;
  }
}

export function hasUncommittedChanges(cwd?: string): boolean {
  const status = git("status --porcelain", cwd);
  return status.length > 0;
}

export function createWorktree(
  repoDir: string,
  phaseName: string,
  baseBranch?: string
): WorktreeInfo {
  const branch = `dc-${phaseName}-${Date.now()}`;
  const worktreeDir = join(repoDir, ".dc", "worktrees");
  const worktreePath = join(worktreeDir, branch);

  mkdirSync(worktreeDir, { recursive: true });

  const base = baseBranch ?? getCurrentBranch(repoDir);
  gitVerbose(`worktree add -b ${branch} ${worktreePath}`, repoDir);

  return { path: worktreePath, branch, baseBranch: base };
}

/**
 * Commit all changes in the worktree. Returns the new SHA on success, null
 * when there's nothing to commit, throws on real failures so callers can
 * surface them. The commit message is passed via a temp file so any
 * combination of quotes/$/newlines is safe.
 */
export function commitWorktree(worktreePath: string, message: string): string | null {
  // Stage everything (including deletions). Surface real failures.
  gitVerbose("add -A", worktreePath);

  const status = git("status --porcelain", worktreePath);
  if (!status) return null;

  // Write message to a temp file so we can use `git commit -F <file>`
  // and avoid every shell escaping pitfall imaginable.
  const msgPath = join(tmpdir(), `dc-commit-${Date.now()}-${process.pid}.txt`);
  try {
    writeFileSync(msgPath, message, "utf-8");
    gitVerbose(`commit --no-verify -F "${msgPath}"`, worktreePath);
    const sha = git("rev-parse HEAD", worktreePath);
    return sha;
  } finally {
    try { unlinkSync(msgPath); } catch { /* ignore */ }
  }
}

/**
 * Merge the worktree branch into its base branch. Verifies the branch
 * actually contains commits ahead of the base — otherwise returns false
 * so the caller can preserve the branch instead of force-deleting it.
 */
export function mergeWorktree(
  repoDir: string,
  info: WorktreeInfo,
): { merged: boolean; reason?: string; commitsAhead: number } {
  // How many commits does this branch have on top of base?
  let commitsAhead = 0;
  try {
    const out = git(`rev-list --count ${info.baseBranch}..${info.branch}`, repoDir);
    commitsAhead = parseInt(out, 10) || 0;
  } catch {
    return { merged: false, reason: "rev-list failed", commitsAhead: 0 };
  }

  if (commitsAhead === 0) {
    return { merged: false, reason: "branch has no commits ahead of base", commitsAhead: 0 };
  }

  try {
    gitVerbose(`checkout ${info.baseBranch}`, repoDir);
    gitVerbose(`merge ${info.branch} --no-edit`, repoDir);
    return { merged: true, commitsAhead };
  } catch (err) {
    const e = err as { message?: string };
    return { merged: false, reason: e.message ?? "merge failed", commitsAhead };
  }
}

/**
 * Remove the worktree directory and optionally delete the branch. When
 * `preserveBranch` is true we keep the branch so the user can recover work
 * if the merge failed.
 */
export function cleanupWorktree(
  repoDir: string,
  info: WorktreeInfo,
  opts: { preserveBranch?: boolean } = {},
): void {
  try {
    git(`worktree remove ${info.path} --force`, repoDir);
  } catch { /* ignore */ }

  if (!opts.preserveBranch) {
    try {
      git(`branch -D ${info.branch}`, repoDir);
    } catch { /* ignore */ }
  }
}

export function listWorktrees(repoDir: string): string[] {
  const output = git("worktree list --porcelain", repoDir);
  return output
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.replace("worktree ", ""));
}
