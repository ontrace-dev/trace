import type { testCases } from "../../db/schema.ts";
import type { SimulationResult } from "../../lib/types.ts";
import { getSettings } from "../workspace.ts";
import { callClaude, describeError, getClaude, textOf } from "./client.ts";
import { keywords, stem } from "./knowledge.ts";

export type TestCase = typeof testCases.$inferSelect;

export interface Judgement {
  passed: boolean;
  score: number;
  verdict: string;
  outcomeMatched: boolean;
}

const PASS_SCORE = 0.5;

/** Words that describe the rubric rather than the content of a good answer. */
const RUBRIC_WORDS = new Set(
  "should must convey confirm confirms confirmed explain explains mention mentions point points say says tell tells answer answers answered reply replies respond responds give gives get gets include includes provide provides offer offers ask asks does not doesn't don't never always any every good customer agent support well keep let know need needs see now also only just make sure clearly politely correct correctly language".split(
    " ",
  ),
);

/**
 * Grade a simulated agent run against a test case's expectation.
 * The expected outcome (reply / escalate) is a hard requirement; the content is graded by an LLM
 * judge when Claude is available, otherwise by keyword coverage of the expectation.
 */
export async function judgeResult(orgId: string, tc: TestCase, sim: SimulationResult): Promise<Judgement> {
  const outcomeMatched = tc.expectedOutcome === "any" || tc.expectedOutcome === sim.outcome;
  const outcomeNote = outcomeMatched
    ? ""
    : `Expected the agent to ${tc.expectedOutcome}, but it chose to ${sim.outcome}. `;
  if (!tc.expectation.trim()) {
    return {
      passed: outcomeMatched,
      score: outcomeMatched ? 1 : 0,
      verdict: outcomeMatched ? `Outcome ${sim.outcome} as expected (no content expectation set).` : outcomeNote.trim(),
      outcomeMatched,
    };
  }

  const settings = await getSettings(orgId);
  const claude = getClaude(settings.ai);
  if (claude) {
    try {
      const res = await callClaude(claude, {
        max_tokens: 2000,
        system:
          "You grade an AI customer-support agent's answer against a test expectation written by the support team. Be strict and specific. Score 0-1: how well the answer satisfies every criterion in the expectation. Penalize facts, numbers, policies or promised actions that are not supported by the cited sources or the conversation (hallucinations) — an unsupported claim caps the score at 0.4. passed = score >= 0.7 and no hallucination. verdict: 1-2 sentences naming what was satisfied and what was missing or wrong.",
        messages: [
          {
            role: "user",
            content: `<customer_message>\n${tc.message}\n</customer_message>\n<expectation>\n${tc.expectation}\n</expectation>\n<agent_outcome>${sim.outcome}${sim.reason ? ` — reason: ${sim.reason}` : ""}</agent_outcome>\n<agent_reply>\n${sim.body || "(no reply drafted)"}\n</agent_reply>\n${sim.internalNote ? `<internal_note>\n${sim.internalNote}\n</internal_note>\n` : ""}<cited_sources>\n${sim.sources.map((s) => `- ${s.title} (${s.type}${s.origin ? `/${s.origin}` : ""})`).join("\n") || "none"}\n</cited_sources>\n<actions>\n${sim.actions.map((a) => `- ${a.name} (${a.mode}) ${JSON.stringify(a.input)}`).join("\n") || "none"}\n</actions>`,
          },
        ],
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                score: { type: "number" },
                passed: { type: "boolean" },
                verdict: { type: "string" },
              },
              required: ["score", "passed", "verdict"],
            },
          },
        },
      });
      if (res.stop_reason !== "refusal") {
        const j = JSON.parse(textOf(res)) as { score: number; passed: boolean; verdict: string };
        const score = Math.max(0, Math.min(1, Number(j.score) || 0));
        return {
          passed: Boolean(j.passed) && outcomeMatched,
          score: outcomeMatched ? score : Math.min(score, 0.3),
          verdict: `${outcomeNote}${j.verdict}`.trim(),
          outcomeMatched,
        };
      }
    } catch (err) {
      console.warn("[judge] LLM judge failed, using keyword coverage:", describeError(err));
    }
  }
  return keywordJudge(tc, sim, outcomeMatched, outcomeNote);
}

/** Offline judge: share of the expectation's content words that appear in the answer. */
export function keywordJudge(
  tc: TestCase,
  sim: SimulationResult,
  outcomeMatched: boolean,
  outcomeNote = "",
): Judgement {
  const norm = (s: string) => s.toLowerCase().replace(/[\u2010-\u2015]/g, "-");
  const expectation = norm(tc.expectation.replace(/^should convey:\s*/i, ""));
  const terms = [
    ...new Set(
      keywords(expectation, 30)
        .filter((w) => !RUBRIC_WORDS.has(w))
        .map(stem)
        .filter((t) => t.length > 2 && !RUBRIC_WORDS.has(t)),
    ),
  ].slice(0, 20);
  const haystack = norm(`${sim.body}\n${sim.internalNote ?? ""}\n${sim.reason ?? ""}`);
  const found = terms.filter((t) => haystack.includes(t));
  const missing = terms.filter((t) => !haystack.includes(t));
  const coverage = terms.length ? found.length / terms.length : outcomeMatched ? 1 : 0;
  const score = Math.round((outcomeMatched ? coverage : Math.min(coverage, 0.3)) * 100) / 100;
  const passed = outcomeMatched && coverage >= PASS_SCORE;
  const verdict = `${outcomeNote}Keyword coverage ${Math.round(coverage * 100)}% (offline judge)${
    missing.length ? ` — missing: ${missing.slice(0, 8).join(", ")}` : " — all key terms present"
  }.`;
  return { passed, score, verdict, outcomeMatched };
}
