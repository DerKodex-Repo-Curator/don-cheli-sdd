/**
 * Quality Gate: Questions
 *
 * If the current phase appended any blocking questions to
 * `.dc/questions/pending.jsonl`, this gate polls `.dc/questions/answers.jsonl`
 * until every blocking question has an answer (or until it times out).
 *
 * This is what makes the runtime bidirectional: Claude can write
 *   {"id":"q-...","question":"...","urgency":"blocking"}
 * to pending.jsonl and Don Cheli Studio will surface a modal to the user.
 */

import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import type { GateResult } from "./spec-gate.js";

const POLL_INTERVAL_SECONDS = 5;
const POLL_TIMEOUT_SECONDS = 30 * 60;
const HEARTBEAT_EVERY_SECONDS = 30;

interface QuestionRecord {
  id: string;
  phase?: string;
  question: string;
  urgency?: string;
}

interface AnswerRecord {
  id: string;
  answer: string;
  skipped?: boolean;
}

export function questionsGate(projectDir: string): GateResult {
  const questionsDir = join(projectDir, ".dc", "questions");
  const pendingPath = join(questionsDir, "pending.jsonl");

  // No file = no questions = pass.
  if (!existsSync(pendingPath)) {
    return { passed: true, message: "No questions raised by this phase" };
  }

  const start = Date.now();
  let lastHeartbeat = 0;

  while (true) {
    const pending = readJsonl<QuestionRecord>(pendingPath);
    const answers = readJsonl<AnswerRecord>(join(questionsDir, "answers.jsonl"));
    const answered = new Set(answers.map((a) => a.id));

    // Only BLOCKING unanswered questions hold the pipeline.
    const blockingMissing = pending.filter((q) =>
      (q.urgency ?? "blocking") === "blocking" && !answered.has(q.id)
    );

    if (blockingMissing.length === 0) {
      const totalAnswered = pending.filter((q) => answered.has(q.id)).length;
      return {
        passed: true,
        message: `All blocking questions answered (${totalAnswered}/${pending.length})`,
        details: pending.map((q) => {
          const a = answers.find((x) => x.id === q.id);
          if (!a) return `${q.id}: (informative, not answered)`;
          return `${q.id}: ${a.skipped ? "(skipped)" : a.answer.slice(0, 80)}`;
        }),
      };
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    if (elapsed >= POLL_TIMEOUT_SECONDS) {
      return {
        passed: false,
        message: `Timed out waiting for question answers (${POLL_TIMEOUT_SECONDS / 60} min)`,
        details: blockingMissing.map((q) => `• ${q.id}: ${q.question}`),
      };
    }

    if (elapsed === 0 || (elapsed - lastHeartbeat) >= HEARTBEAT_EVERY_SECONDS) {
      const remaining = POLL_TIMEOUT_SECONDS - elapsed;
      process.stdout.write(
        `[questions-gate] ${blockingMissing.length} pregunta(s) esperando respuesta humana en Don Cheli Studio… ` +
        `(${elapsed}s transcurridos, timeout en ${Math.floor(remaining / 60)} min)\n`
      );
      // List them on the first iteration so the log makes the wait actionable
      if (elapsed === 0) {
        for (const q of blockingMissing) {
          process.stdout.write(`  ↳ ${q.id}: ${q.question}\n`);
        }
      }
      lastHeartbeat = elapsed;
    }

    try {
      execSync(`sleep ${POLL_INTERVAL_SECONDS}`);
    } catch { /* ignore SIGINT during sleep */ }
  }
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  try {
    const content = readFileSync(path, "utf-8");
    const out: T[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) continue;
      try { out.push(JSON.parse(trimmed) as T); } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Build a context block summarizing answered questions, to be injected into
 * the prompt of the next phase. Returns empty string if nothing to share.
 */
export function buildAnsweredContext(projectDir: string): string {
  const questionsDir = join(projectDir, ".dc", "questions");
  const pending = readJsonl<QuestionRecord>(join(questionsDir, "pending.jsonl"));
  const answers = readJsonl<AnswerRecord>(join(questionsDir, "answers.jsonl"));
  if (answers.length === 0) return "";

  const byId = new Map(pending.map((q) => [q.id, q] as const));
  const lines = answers.map((a) => {
    const q = byId.get(a.id);
    if (!q) return null;
    if (a.skipped) return `Q (${q.id}): ${q.question}\nA: [skipped by user]`;
    return `Q (${q.id}): ${q.question}\nA: ${a.answer}`;
  }).filter((x): x is string => x !== null);

  if (lines.length === 0) return "";

  return `\n\nUSER DECISIONS FROM PREVIOUS PHASES (these were answered live in Don Cheli Studio — respect them):\n\n${lines.join("\n\n")}\n`;
}
