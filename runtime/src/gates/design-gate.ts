/**
 * Quality Gate: Design Approval
 * Verifies UI design has been approved before implementation.
 *
 * When the design phase finishes, it writes approval.json with status="in_review".
 * This gate then POLLS approval.json every 5 seconds, waiting for the human to
 * click "Aprobar diseño" in Don Cheli Studio (which flips status to "approved"
 * via the POST /api/pipeline/{id}/design/approve endpoint).
 *
 * Times out after 30 minutes of waiting.
 */

import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import type { GateResult } from "./spec-gate.js";

const POLL_INTERVAL_SECONDS = 5;
const POLL_TIMEOUT_SECONDS = 30 * 60;  // 30 minutes
const PROGRESS_EVERY_SECONDS = 30;     // log a heartbeat every 30s

export function designGate(projectDir: string): GateResult {
  const approvalPath = join(projectDir, ".dc", "design", "approval.json");

  // No design = warning only (design phase was optional)
  if (!existsSync(approvalPath)) {
    return {
      passed: true,
      message: "No UI design found — implementing without design spec",
      details: ["No .dc/design/approval.json — design phase was skipped"],
    };
  }

  // Read & evaluate current status — and BLOCK if it's pending review.
  const startTime = Date.now();
  let lastHeartbeat = 0;

  while (true) {
    const result = readApproval(approvalPath);
    if (!result) {
      // Couldn't read or parse — treat as soft-pass to not block on a malformed file
      return {
        passed: true,
        message: "Could not read approval.json — skipping design gate",
        details: ["The file exists but is not valid JSON. Implementing anyway."],
      };
    }

    const { status, link, screens, approver, approvedAt } = result;

    switch (status) {
      case "approved":
        return {
          passed: true,
          message: `Design APPROVED (${screens} screens)`,
          details: [
            `Status: ${status}`,
            `Link: ${link}`,
            `Screens: ${screens}`,
            `Approved by: ${approver || "unknown"}`,
            `Approved at: ${approvedAt || "unknown"}`,
          ],
        };

      case "rejected":
        return {
          passed: false,
          message: "Design REJECTED — cannot implement",
          details: [
            `Status: ${status}`,
            "The UI design was rejected by the human reviewer.",
            "Revise the design (regenerate mockups or apply changes) before retrying.",
            `Link: ${link}`,
          ],
        };

      case "in_review":
      case "changes_requested":
      case "pending":
      case "unknown":
      default: {
        // Wait for human approval — poll loop.
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        if (elapsed >= POLL_TIMEOUT_SECONDS) {
          return {
            passed: false,
            message: `Timed out waiting for design approval (${POLL_TIMEOUT_SECONDS / 60} min)`,
            details: [
              `Approval status was still "${status}" after ${POLL_TIMEOUT_SECONDS / 60} minutes.`,
              "Open Don Cheli Studio → tu proyecto → tab Diseño y haz click en \"Aprobar diseño\" para continuar.",
              `Link: ${link}`,
            ],
          };
        }

        // Heartbeat log — first iteration and every PROGRESS_EVERY_SECONDS.
        if (elapsed === 0 || (elapsed - lastHeartbeat) >= PROGRESS_EVERY_SECONDS) {
          const remaining = POLL_TIMEOUT_SECONDS - elapsed;
          // Plain stdout so the Studio's log panel shows it via WebSocket.
          process.stdout.write(
            `[design-gate] Esperando aprobación humana en Don Cheli Studio… ` +
            `(status: ${status}, ${elapsed}s transcurridos, timeout en ${Math.floor(remaining / 60)} min)\n`
          );
          lastHeartbeat = elapsed;
        }

        // Synchronous sleep — claude subprocess is already done at this point,
        // so we're not blocking anything important.
        try {
          execSync(`sleep ${POLL_INTERVAL_SECONDS}`);
        } catch {
          // ignore SIGINT etc; loop will re-check status
        }
        break;  // re-read approval.json
      }
    }
  }
}

interface ApprovalSnapshot {
  status: string;
  link: string;
  screens: number;
  approver: string | null;
  approvedAt: string | null;
}

function readApproval(path: string): ApprovalSnapshot | null {
  try {
    const content = readFileSync(path, "utf-8");
    const approval = JSON.parse(content);
    return {
      status: approval.status || "unknown",
      link: approval.link || "no link",
      screens: approval.screens_count || 0,
      approver: approval.approver ?? null,
      approvedAt: approval.approved_at ?? null,
    };
  } catch {
    return null;
  }
}
