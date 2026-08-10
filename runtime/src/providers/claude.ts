/**
 * Don Cheli Runtime — Claude Code Provider
 * Uses Claude Code CLI (subscription-based, no API key needed).
 *
 * Output format is `json`: one envelope at the end of each invocation that
 * includes `total_cost_usd` and `usage`. We parse it in `parseResponse` so
 * the orchestrator can write real session cost into state.json.
 */

import type { AgentProvider, ParsedResponse } from "./base.js";

const COST_PER_1M_INPUT: Record<string, number> = {
  "claude-opus-4-6": 15.0,
  "claude-sonnet-4-6": 3.0,
  "claude-haiku-4-5": 0.25,
};

const COST_PER_1M_OUTPUT: Record<string, number> = {
  "claude-opus-4-6": 75.0,
  "claude-sonnet-4-6": 15.0,
  "claude-haiku-4-5": 1.25,
};

export class ClaudeProvider implements AgentProvider {
  readonly name = "claude";
  readonly model: string;

  constructor(model?: string) {
    this.model = model ?? "claude-sonnet-4-6";
  }

  buildCommand(prompt: string): { command: string; args: string[] } {
    return {
      command: "claude",
      args: [
        "-p",                              // Print mode (non-interactive)
        "--model", this.model,
        "--dangerously-skip-permissions",   // Allow file creation without prompts
        "--output-format", "json",          // Final envelope with cost + usage
        prompt,
      ],
    };
  }

  buildDockerCommand(prompt: string): string[] {
    return [
      "claude", "-p",
      "--model", this.model,
      "--dangerously-skip-permissions",
      "--output-format", "json",
      prompt,
    ];
  }

  isComplete(output: string, signal: string): boolean {
    return output.includes(signal);
  }

  /**
   * Parse the JSON envelope emitted by `claude -p --output-format json`.
   * Returns the model's text response plus real token usage and cost.
   * Falls back to the raw output (with zero cost) on parse failure.
   */
  parseResponse(rawOutput: string): ParsedResponse {
    const fallback: ParsedResponse = { text: rawOutput, tokensUsed: 0, costUsd: 0 };
    const trimmed = rawOutput.trim();
    if (!trimmed) return fallback;

    // Most often the entire stdout is a single JSON object.
    const candidates: string[] = [];
    try { JSON.parse(trimmed); candidates.push(trimmed); } catch { /* try harder */ }

    // Fallback: find the last balanced `{ ... }` block in the output.
    if (candidates.length === 0) {
      const lastBrace = trimmed.lastIndexOf("{");
      if (lastBrace >= 0) candidates.push(trimmed.slice(lastBrace));
    }

    for (const candidate of candidates) {
      try {
        const obj = JSON.parse(candidate);
        if (obj && typeof obj === "object" && obj.type === "result") {
          const text = typeof obj.result === "string" ? obj.result : rawOutput;
          const costUsd = typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0;
          const usage = obj.usage ?? {};
          const tokensUsed =
            (typeof usage.input_tokens === "number" ? usage.input_tokens : 0) +
            (typeof usage.output_tokens === "number" ? usage.output_tokens : 0) +
            (typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0) +
            (typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0);
          return { text, tokensUsed, costUsd };
        }
      } catch { /* keep trying */ }
    }

    return fallback;
  }

  estimateCost(promptLength: number): { tokens: number; costUsd: number } {
    // Rough: 1 char ≈ 0.25 tokens, output ≈ 3x input
    const inputTokens = Math.ceil(promptLength * 0.25);
    const outputTokens = inputTokens * 3;
    const inputCost = (inputTokens / 1_000_000) * (COST_PER_1M_INPUT[this.model] ?? 3.0);
    const outputCost = (outputTokens / 1_000_000) * (COST_PER_1M_OUTPUT[this.model] ?? 15.0);
    return {
      tokens: inputTokens + outputTokens,
      costUsd: Math.round((inputCost + outputCost) * 1000) / 1000,
    };
  }
}
