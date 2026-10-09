import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../env.ts";
import type { AiSettings } from "../../lib/types.ts";

const clients = new Map<string, Anthropic>();

export interface ClaudeHandle {
  client: Anthropic;
  model: string;
  effort: AiSettings["effort"];
}

/**
 * Returns a Claude client for the workspace, or null when no key is configured — in that case
 * trace falls back to its local heuristic agent so the app stays fully usable offline.
 */
export function getClaude(ai: AiSettings): ClaudeHandle | null {
  const key = ai.apiKey?.trim() || env.ANTHROPIC_API_KEY;
  if (!key) return null;
  let client = clients.get(key);
  if (!client) {
    client = new Anthropic({ apiKey: key, maxRetries: 2, timeout: 120_000 });
    clients.set(key, client);
  }
  return { client, model: ai.model || env.AI_MODEL, effort: ai.effort ?? "low" };
}

export type CreateParams = Omit<Anthropic.Beta.MessageCreateParamsNonStreaming, "model" | "betas" | "fallbacks">;

/**
 * One Messages API call with trace's defaults: the workspace model, adaptive thinking (always on for
 * current models), configured effort, prompt caching, and server-side refusal fallbacks.
 */
export async function callClaude(h: ClaudeHandle, params: CreateParams) {
  const response = await h.client.beta.messages.create({
    model: h.model,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    cache_control: { type: "ephemeral" },
    ...params,
    output_config: { effort: h.effort, ...params.output_config },
  });
  return response;
}

export function textOf(message: Anthropic.Beta.BetaMessage) {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export function describeError(err: unknown) {
  if (err instanceof Anthropic.AuthenticationError) return "Invalid Anthropic API key";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API";
  if (err instanceof Anthropic.BadRequestError) return `Bad request: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Anthropic API";
  return err instanceof Error ? err.message : String(err);
}
