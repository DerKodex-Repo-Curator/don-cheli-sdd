/**
 * Don Cheli SDD Runtime — Pipeline Orchestrator
 *
 * Executes the REAL /dc:* commands inside Docker containers.
 * Each phase runs in an isolated container with a fresh git worktree.
 * Only merges to the real project when ALL phases pass.
 *
 * Flow:
 *   1. Create git worktree (isolated copy)
 *   2. Mount worktree in Docker container
 *   3. Execute /dc:* command via Claude Code CLI inside container
 *   4. Verify quality gates
 *   5. If ALL phases pass → merge worktree to project
 *   6. If ANY phase fails → discard worktree (project untouched)
 */

import { existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import type { AgentProvider } from "./providers/base.js";
import { ClaudeProvider } from "./providers/claude.js";
import { CodexProvider } from "./providers/codex.js";
import { OllamaProvider } from "./providers/ollama.js";
import { StateManager, type PhaseName } from "./utils/state.js";
import { estimatePipelineCost, formatCostTable } from "./utils/cost.js";
import { specGate } from "./gates/spec-gate.js";
import { tddGate } from "./gates/tdd-gate.js";
import { customGates } from "./gates/custom-gate.js";
import { designGate } from "./gates/design-gate.js";
import { questionsGate, buildAnsweredContext } from "./gates/questions-gate.js";
import {
  createWorktree, commitWorktree, mergeWorktree,
  cleanupWorktree, isGitRepo
} from "./sandbox/worktree.js";
import {
  ensureDocker, buildImage, startContainer, execInContainerStream,
  stopContainer, dockerAvailable
} from "./sandbox/docker.js";
import { execLocal } from "./sandbox/local.js";
import * as log from "./utils/logger.js";

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

export interface OrchestratorConfig {
  task: string;
  provider: "claude" | "codex" | "ollama";
  model?: string;
  phases?: PhaseName[];
  singlePhase?: PhaseName;
  maxRetries?: number;
  budgetUsd?: number;
  dryRun?: boolean;
  noDocker?: boolean;
  /** Run the pipeline in an isolated git worktree instead of the project dir. */
  useWorktree?: boolean;
}

/**
 * The REAL /dc:* commands. The runtime executes THESE inside the container,
 * not custom prompts. This is the key difference from Sandcastle.
 */
const PHASE_COMMANDS: Record<PhaseName, { dcCommand: string; description: string }> = {
  specify: {
    dcCommand: "/dc:especificar",
    description: "Turns idea into Gherkin specification with test scenarios, priorities and DBML schema",
  },
  clarify: {
    dcCommand: "/dc:clarificar",
    description: "Virtual QA detects ambiguities and contradictions before coding",
  },
  plan: {
    dcCommand: "/dc:planificar-tecnico",
    description: "Technical blueprint with architecture, API contracts and final schema",
  },
  design: {
    dcCommand: "/dc:diseñar-ui",
    description: "Generates UI/UX designs with Figma link or HTML preview and approval flow",
  },
  breakdown: {
    dcCommand: "/dc:desglosar",
    description: "Splits plan into concrete tasks with execution order and parallelism",
  },
  implement: {
    dcCommand: "/dc:implementar",
    description: "Executes with strict TDD: test first, then code, then improve",
  },
  review: {
    dcCommand: "/dc:revisar",
    description: "Automatic peer review across 7 dimensions",
  },
};

const DEFAULT_PHASES: PhaseName[] = ["specify", "clarify", "plan", "design", "breakdown", "implement", "review"];
const MAX_RETRIES = 3;
const DOCKER_IMAGE = "doncheli-runtime";
const COMPLETION_SIGNAL = "DC_PHASE_COMPLETE";

// ═══════════════════════════════════════════════════════════════
// GATE RUNNER
// ═══════════════════════════════════════════════════════════════

function runGatesForPhase(phase: PhaseName, projectDir: string): boolean {
  // Every phase ends with the questions gate so Claude can ask the user mid-
  // pipeline. The gate is a no-op when no questions were raised.
  const gates: Record<PhaseName, (() => { passed: boolean; message: string; details?: string[] })[]> = {
    specify:   [() => specGate(projectDir), () => questionsGate(projectDir)],
    clarify:   [() => specGate(projectDir), () => questionsGate(projectDir)],
    plan:      [() => questionsGate(projectDir)],
    design:    [() => questionsGate(projectDir)],
    breakdown: [
      () => designGate(projectDir),
      () => questionsGate(projectDir),
    ],
    implement: [
      () => tddGate(projectDir),
      () => customGates(projectDir),
      () => questionsGate(projectDir),
    ],
    review: [
      () => customGates(projectDir),
      () => questionsGate(projectDir),
    ],
  };

  const phaseGates = gates[phase] || [];
  if (phaseGates.length === 0) return true;

  log.info(`\n  Quality Gates for ${PHASE_COMMANDS[phase].dcCommand}:`);

  let allPassed = true;
  for (const gate of phaseGates) {
    const result = gate();
    log.gateResult(phase, result.passed, result.message);
    // Print details for visibility
    if (result.details) {
      for (const d of result.details) {
        console.log(`    ${d}`);
      }
    }
    if (!result.passed) allPassed = false;
  }
  console.log("");
  return allPassed;
}

// ═══════════════════════════════════════════════════════════════
// PHASE EXECUTORS
// ═══════════════════════════════════════════════════════════════

function buildPhasePrompt(phase: PhaseName, task: string, projectDir?: string): string {
  const { dcCommand, description } = PHASE_COMMANDS[phase];

  const phaseInstructions: Record<PhaseName, string> = {
    specify: `Create a Gherkin specification file at .dc/specs/spec.feature with:
- Feature name and description
- At least 3 Scenario blocks with Given/When/Then steps
- Mark priority scenarios with @P1 tag
- Include edge cases and error scenarios`,

    clarify: `Review the spec at .dc/specs/spec.feature and:
- Identify ambiguities or contradictions
- Add clarification notes in .dc/specs/clarifications.md
- Update the spec if needed to resolve ambiguities`,

    plan: `Create a technical blueprint at .dc/blueprints/blueprint.md with:
- Architecture overview (components, layers)
- API contracts (endpoints, request/response schemas)
- Data model / database schema
- Technology choices and justification
- File structure plan`,

    design: `Generate UI/UX designs using ATOMIC DESIGN methodology (Brad Frost).
Build components bottom-up: Atoms → Molecules → Organisms → Templates → Pages.

Read .dc/specs/spec.feature and .dc/blueprints/blueprint.md to extract all screens needed.

═══════════════════════════════════════════════════════════════════════════
PRE-DESIGN — DESIGN RESEARCH (MCP tools available in this session)
═══════════════════════════════════════════════════════════════════════════

BEFORE writing any HTML, check whether the following MCP servers are available
in your tool list and use them when they are:

▸ MOBBIN MCP (mcp__mobbin__*):
  600,000+ real screens from shipped products. Search BEFORE designing to find
  proven patterns for the screens you need (onboarding, paywalls, dashboards,
  forms, etc.). For each main screen, run 1-2 Mobbin searches. Save the
  references you used to .dc/design/research/mobbin-refs.json as:
    [{ "screen": "login", "query": "onboarding", "refs": ["<url1>", "<url2>"], "takeaways": "..." }]
  If Mobbin MCP is NOT in your tool list, skip silently — do not fail.

▸ STITCH MCP (mcp__stitch__*):
  Google Stitch can host your HTML mockups and produce a shareable link.
  AFTER generating .dc/design/index.html, .dc/design/pages/*.html and the
  design tokens, use Stitch MCP to upload them and obtain a project URL.
  Save the URL to approval.json as "stitch_url" (see schema below).
  If Stitch MCP is NOT in your tool list, skip silently and leave stitch_url
  as null — the HTML files alone are still usable.

═══════════════════════════════════════════════════════════════════════════
CREATE THE FOLLOWING STRUCTURE
═══════════════════════════════════════════════════════════════════════════

1. .dc/design/tokens/colors.json — Color palette with primary (50-900), neutral (0-1000), semantic (success/warning/error/info)
2. .dc/design/tokens/typography.json — Font families, sizes (xs to 5xl), weights, line heights
3. .dc/design/tokens/spacing.json — Spacing scale (0 to 24), border radius, shadows

4. .dc/design/atoms/ — Individual HTML files for each atom component:
   - button.html (primary, secondary, ghost, danger, disabled, loading variants)
   - input.html (text, email, password, error, disabled variants)
   - badge.html, avatar.html, spinner.html, tag.html
   Each atom file shows ALL variants side by side.

5. .dc/design/molecules/ — Combinations of atoms:
   - search-bar.html, form-field.html, card-header.html, stat.html
   Each molecule shows how atoms combine.

6. .dc/design/organisms/ — Complete sections:
   - header.html (navbar with logo, nav, search, avatar)
   - sidebar.html (menu items, user section, collapse)
   - form.html (complete form with validation)
   - data-table.html (sortable, paginated)

7. .dc/design/pages/ — Complete screens with REALISTIC domain data (NEVER "Lorem ipsum"):
   - One HTML file per screen identified in the spec
   - Use Tailwind CSS via CDN: <script src="https://cdn.tailwindcss.com"></script>
   - Responsive: mobile-first (375px), tablet (768px), desktop (1440px)
   - Include states: normal, empty, loading (skeleton), error
   - Accessible: semantic HTML, ARIA labels, focus visible, contrast 4.5:1, touch targets 44px
   - If Mobbin refs were collected, draw inspiration from them — don't copy verbatim

8. .dc/design/index.html — Component catalog + page navigation hub

9. .dc/design/design-system.md — Documentation of all design decisions, including
   a "Design research" section listing Mobbin references used (if any).

10. .dc/design/approval.json:
    {
      "version": 1,
      "status": "in_review",
      "provider": "html",
      "link": ".dc/design/index.html",
      "stitch_url": "<URL returned by Stitch MCP, or null if not used>",
      "mobbin_research_count": <number of Mobbin references collected, or 0>,
      "screens_count": [N],
      "design_system": { "style": "[NAME]", "primary": "[HEX]",
                         "font_heading": "[FONT]", "font_body": "[FONT]" },
      "approver": null,
      "approved_at": null,
      "history": [{ "action": "created", "at": "[NOW]" }]
    }

CRITICAL — approval flow:
- ALWAYS write approval.json with status="in_review". NEVER write "approved".
- The pipeline will PAUSE after this phase and wait for the human to approve the
  design from Don Cheli Studio (the "Diseño" tab on their project page).
- Your job ends when the mockups are generated and approval.json says "in_review".

RULES:
- Every HTML file must be COMPLETE and functional, not a placeholder
- Use consistent design tokens across ALL components
- Mobile-first: design for 375px first, then scale up
- WCAG AA: contrast 4.5:1, semantic HTML, focus indicators`,

    breakdown: `Create task files in .dc/tareas/ with:
- One markdown file per task (task-01.md, task-02.md, etc.)
- Each task has: description, acceptance criteria, test cases
- Mark dependencies between tasks
- Mark which tasks can run in parallel`,

    implement: `Implement the code following strict TDD.

STEP 1 — Setup (if no package.json exists):
- Create package.json with: { "scripts": { "test": "vitest run" }, "devDependencies": { "vitest": "latest" } }
- Run: npm install

STEP 2 — Write tests FIRST:
- Create test files with names like *.test.ts or *.test.js
- Each test must use describe/it/expect blocks
- Cover at least the main functionality and one edge case

STEP 3 — Write code to pass the tests:
- Implement the minimum code that makes ALL tests pass
- Run the tests to verify: npm test

STEP 4 — Verify:
- Run tests one final time to confirm they pass
- Ensure NO // TODO or // FIXME comments exist in source code
- Aim for >= 85% test coverage

CRITICAL: Tests MUST actually exist as files and contain real assertions (expect/assert). Empty or placeholder test files will be rejected.`,

    review: `Review all code and create .dc/reviews/review.md with:
- Score each dimension (1-5): correctness, security, performance, maintainability, testing, documentation, architecture
- List specific issues found
- Confirm all tests pass
- Confirm no // TODO stubs remain`,
  };

  // Inject any answered questions from previous phases as authoritative context.
  const answeredContext = projectDir ? buildAnsweredContext(projectDir) : "";

  // Interactive Q&A protocol — Claude CAN ask the human user during this phase.
  // This is what gives the runtime bidirectional comms with Don Cheli Studio.
  const questionProtocol = `

INTERACTIVE Q&A PROTOCOL:
If during this phase you encounter a decision that REQUIRES user input — a
business rule you can't infer, a choice between architecturally equivalent
approaches, a credential / endpoint / target you don't have — you can ASK
the user directly via Don Cheli Studio instead of guessing or using
placeholders.

To ask, APPEND a JSON line to .dc/questions/pending.jsonl (one question per
line, no commas between lines). Schema:

  {"id":"q-<short-slug>","phase":"${phase}","question":"<one sentence in user's language>","kind":"text"|"choice"|"boolean","options":["a","b"],"default":"...","context":"why you need this","urgency":"blocking"|"informative"}

Rules:
- Use "blocking" only when you literally cannot make a sensible default. The
  pipeline will pause until the user answers. Default is "informative".
- Use "choice" when there's a small set of valid answers; provide "options".
- Use "boolean" for yes/no.
- Ask the FEWEST possible questions — only what you can't reasonably decide.
- Phrase questions in the user's natural language (Spanish if the task is
  in Spanish). Provide concrete examples.
- Don't ask about anything already covered by the spec/blueprint — assume
  the user wrote those carefully.
- Don't ask about coding style, file names, or things you can decide
  yourself. Take the call and document it.
- After writing pending.jsonl entries, KEEP WORKING on what you can do
  without those answers. The gate at the end of the phase will block if
  needed.
- DO NOT modify or read answers.jsonl yourself — that file is written by
  Don Cheli Studio when the user responds. The next phase will receive
  the answers as context.`;

  return `You are executing phase "${dcCommand}" of the Don Cheli SDD pipeline.

TASK: ${task}${answeredContext}

PHASE: ${dcCommand} — ${description}

INSTRUCTIONS:
${phaseInstructions[phase]}
${questionProtocol}

IMPORTANT:
- Create real files with real content (not placeholders)
- Work in the current directory
- When done, output exactly: ${COMPLETION_SIGNAL}`;
}

interface PhaseExecResult {
  passed: boolean;
  output: string;
  tokensUsed: number;
  costUsd: number;
}

async function executeInDocker(
  phase: PhaseName, task: string, provider: AgentProvider, containerName: string, workDir: string
): Promise<PhaseExecResult> {
  const prompt = buildPhasePrompt(phase, task, workDir);
  const result = await execInContainerStream(
    containerName,
    provider.buildDockerCommand(prompt),
    (data) => process.stdout.write(data),
    { timeout: 15 * 60 * 1000 },
  );
  return extractCost(provider, result.output, result.exitCode === 0);
}

async function executeLocal(
  phase: PhaseName, task: string, provider: AgentProvider, workDir: string
): Promise<PhaseExecResult> {
  const prompt = buildPhasePrompt(phase, task, workDir);
  const { command, args } = provider.buildCommand(prompt);
  const result = await execLocal(command, args, workDir, (data) => {
    process.stdout.write(data);
  }, { timeout: 10 * 60 * 1000, completionSignal: COMPLETION_SIGNAL });
  return extractCost(provider, result.output, result.completed || result.exitCode === 0);
}

/**
 * Run the provider's response parser (if any) to extract real cost from
 * the CLI output. Returns the model's text response (so completion-signal
 * detection still works) plus token/cost data when available.
 */
function extractCost(
  provider: AgentProvider, rawOutput: string, exitOk: boolean
): PhaseExecResult {
  let output = rawOutput;
  let tokensUsed = 0;
  let costUsd = 0;

  if (typeof provider.parseResponse === "function") {
    try {
      const parsed = provider.parseResponse(rawOutput);
      output = parsed.text;
      tokensUsed = parsed.tokensUsed;
      costUsd = parsed.costUsd;
    } catch { /* fall through with raw output */ }
  }

  const passed = output.includes(COMPLETION_SIGNAL) || exitOk;
  return { passed, output, tokensUsed, costUsd };
}

// ═══════════════════════════════════════════════════════════════
// ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════

export async function orchestrate(config: OrchestratorConfig): Promise<boolean> {
  const projectDir = process.cwd();
  const maxRetries = config.maxRetries ?? MAX_RETRIES;

  // ── Prerequisites ──

  if (!isGitRepo(projectDir)) {
    log.fail("Not a git repository. Run 'git init' first.");
    return false;
  }

  // Docker check + auto-install
  let useDocker = !config.noDocker;
  if (useDocker && !dockerAvailable()) {
    log.warn("Docker not available.");
    if (!ensureDocker()) {
      log.info("Falling back to local mode");
      useDocker = false;
    }
  }

  // ── Provider ──

  let provider: AgentProvider;
  switch (config.provider) {
    case "codex":  provider = new CodexProvider(config.model); break;
    case "ollama": provider = new OllamaProvider(config.model); break;
    default:       provider = new ClaudeProvider(config.model); break;
  }

  const phases = config.singlePhase ? [config.singlePhase] : config.phases ?? DEFAULT_PHASES;

  // ── Header ──

  log.header("Don Cheli SDD Runtime");
  console.log(`  Task:     ${config.task}`);
  console.log(`  Provider: ${provider.name}/${provider.model}`);
  console.log(`  Mode:     ${useDocker ? "🐳 Docker (isolated)" : "💻 Local (direct)"}`);
  console.log(`  Phases:   ${phases.map(p => PHASE_COMMANDS[p].dcCommand).join(" → ")}`);
  console.log(`  Retries:  ${maxRetries} per phase`);
  console.log(`  Safety:   Project untouched until ALL phases pass`);

  // ── Pre-flight ──

  const estimate = estimatePipelineCost(phases, provider);
  console.log(`\n${formatCostTable(estimate.phases)}`);

  if (config.budgetUsd && estimate.totalCostUsd > config.budgetUsd) {
    log.fail(`Estimated $${estimate.totalCostUsd} exceeds budget $${config.budgetUsd}`);
    return false;
  }

  if (config.dryRun) {
    log.info("Dry run — no execution");
    return true;
  }

  // ── State + Lock ──

  const stateManager = new StateManager(projectDir);
  const existingState = stateManager.load();

  // Decide whether we're resuming a crashed run or starting fresh.
  // We resume ONLY if the previous state has a phase still in progress
  // ("running"/"pending" between passed phases). If every phase is terminal
  // (all passed, or any failed but none pending), treat it as stale and
  // reset — otherwise a new run inherits the old state and exits immediately.
  const isResumable = !!existingState
    && !config.singlePhase
    && stateManager.getNextPhase() !== null
    && existingState.phases.some((p) => p.status === "running" || p.status === "pending")
    && existingState.task === config.task;

  if (isResumable) {
    const nextPhase = stateManager.getNextPhase()!;
    log.warn(`Crash recovery: resuming from ${PHASE_COMMANDS[nextPhase].dcCommand}`);
    const idx = phases.indexOf(nextPhase);
    if (idx > 0) phases.splice(0, idx);
  } else {
    if (existingState) {
      log.info("Previous state is stale — starting fresh");
    }
    stateManager.init(config.task, config.provider, provider.model, useDocker ? "docker" : "local");
  }

  if (!stateManager.acquireLock()) {
    log.fail("Another dc-run instance is running.");
    return false;
  }

  // ── Create worktree (PROJECT STAYS SAFE) ──

  log.info("Creating isolated worktree...");
  let worktreeInfo;
  try {
    worktreeInfo = createWorktree(projectDir, "pipeline");
    log.success(`Worktree: ${worktreeInfo.branch}`);
    log.success("Your project is SAFE — all work happens in the worktree");
  } catch {
    log.warn("Worktree failed — working on project directly (less safe)");
    worktreeInfo = null;
  }

  const workDir = worktreeInfo?.path ?? projectDir;

  // Ensure .dc/ in worktree
  for (const dir of ["specs", "blueprints", "tareas", "reviews", "auto", "prd"]) {
    mkdirSync(join(workDir, ".dc", dir), { recursive: true });
  }

  // ── Docker setup ──

  let containerName: string | null = null;

  if (useDocker) {
    containerName = `dc-runtime-${Date.now()}`;
    log.info("Building Docker image...");
    try {
      // Look for Dockerfile
      const dockerfilePaths = [
        join(resolve(import.meta.dirname ?? "."), "..", "Dockerfile"),
        join(projectDir, "runtime", "Dockerfile"),
      ];
      const dockerfilePath = dockerfilePaths.find(existsSync);

      if (dockerfilePath) {
        buildImage(dockerfilePath, DOCKER_IMAGE);
      } else {
        log.warn("No Dockerfile found, falling back to local mode");
        useDocker = false;
        containerName = null;
      }

      if (containerName) {
        startContainer({
          name: containerName,
          image: DOCKER_IMAGE,
          env: {},
          volumes: [`${resolve(workDir)}:/workspace`],
          workdir: "/workspace",
        });
        log.success(`Container: ${containerName}`);
      }
    } catch (err) {
      log.warn("Docker setup failed, falling back to local mode");
      containerName = null;
      useDocker = false;
    }
  }

  // ── Execute pipeline ──

  const results: { phase: string; command: string; passed: boolean; commits: number }[] = [];

  try {
    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i];
      const { dcCommand } = PHASE_COMMANDS[phase];

      log.progressBar(i, phases.length, dcCommand);
      log.phaseHeader(`${dcCommand}`, 1, maxRetries);

      let phasePassed = false;
      let phaseCommits = 0;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (attempt > 1) log.phaseHeader(`${dcCommand}`, attempt, maxRetries);

        stateManager.startPhase(phase);

        // Execute the REAL /dc:* command
        const result = containerName
          ? await executeInDocker(phase, config.task, provider, containerName, workDir)
          : await executeLocal(phase, config.task, provider, workDir);

        // Record real token + cost spend (Claude Code's session cost)
        if (result.tokensUsed > 0 || result.costUsd > 0) {
          stateManager.addCost(result.tokensUsed, result.costUsd);
          log.info(`Cost: $${result.costUsd.toFixed(4)} (+${result.tokensUsed} tokens)`);
        }

        // Commit in worktree. Keep the headline short — the long user task
        // is in spec.md / plan.md / etc., not in every commit message.
        if (worktreeInfo) {
          const headline = `dc(${phase}): attempt ${attempt}`;
          const body = config.task.length > 200
            ? config.task.slice(0, 200) + "…"
            : config.task;
          const message = `${headline}\n\nTask:\n${body}`;
          try {
            const sha = commitWorktree(workDir, message);
            if (sha) {
              phaseCommits++;
              log.info(`Committed: ${sha.substring(0, 7)}`);
            } else {
              log.warn(`No changes to commit for ${dcCommand}`);
            }
          } catch (err) {
            log.fail(`Commit failed for ${dcCommand}: ${(err as Error).message}`);
          }
        }

        // Quality gates
        const gatesPassed = runGatesForPhase(phase, workDir);

        if (result.passed && gatesPassed) {
          stateManager.passPhase(phase, []);
          log.success(`${dcCommand} PASSED`);
          phasePassed = true;
          break;
        }

        stateManager.failPhase(phase);
        log.fail(`Attempt ${attempt}/${maxRetries}`);
      }

      results.push({ phase, command: dcCommand, passed: phasePassed, commits: phaseCommits });

      if (!phasePassed && !config.singlePhase) {
        log.fail(`Pipeline stopped at ${dcCommand}`);
        break;
      }
    }

    log.progressBar(phases.length, phases.length, "Complete");
  } finally {
    if (containerName) {
      stopContainer(containerName);
      log.info("Container destroyed");
    }
    stateManager.releaseLock();
  }

  // ── Merge or discard ──

  const allPassed = results.every((r) => r.passed);

  if (worktreeInfo) {
    if (allPassed) {
      log.success("All phases passed — merging to project...");
      const result = mergeWorktree(projectDir, worktreeInfo);
      if (result.merged) {
        log.success(`✅ Worktree merged — ${result.commitsAhead} commit(s) brought into ${worktreeInfo.baseBranch}`);
        cleanupWorktree(projectDir, worktreeInfo);
      } else {
        // Preserve branch + worktree so the user doesn't lose work.
        log.fail(`Merge failed: ${result.reason} — branch ${worktreeInfo.branch} preserved`);
        log.info(`Recover with: git checkout ${worktreeInfo.branch}  (or copy from ${worktreeInfo.path})`);
        cleanupWorktree(projectDir, worktreeInfo, { preserveBranch: true });
      }
    } else {
      log.warn("Pipeline failed — branch preserved for inspection: " + worktreeInfo.branch);
      cleanupWorktree(projectDir, worktreeInfo, { preserveBranch: true });
    }
  }

  // ── Summary ──

  log.header("PIPELINE SUMMARY");
  let totalCommits = 0;
  for (const r of results) {
    const icon = r.passed ? `${log.COLORS.green}✅` : `${log.COLORS.red}❌`;
    console.log(`  ${icon}${log.COLORS.reset} ${r.command.padEnd(25)} — ${r.commits} commits`);
    totalCommits += r.commits;
  }

  console.log(`\n  Commits: ${totalCommits}`);
  console.log(`  Result: ${allPassed
    ? `${log.COLORS.green}ALL PASSED — Project updated with verified code${log.COLORS.reset}`
    : `${log.COLORS.red}FAILED — Project UNTOUCHED${log.COLORS.reset}`
  }\n`);

  return allPassed;
}
