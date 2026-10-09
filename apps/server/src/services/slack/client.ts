import { LogLevel, WebClient } from "@slack/web-api";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { integrations } from "../../db/schema.ts";
import type { SlackConfig } from "../../lib/types.ts";

export type Integration = typeof integrations.$inferSelect;
export type SlackIntegration = Integration & { config: SlackConfig };

/** Loose Block Kit typing — Slack validates the shape server-side. */
export type Block = Record<string, unknown>;

const clients = new Map<string, WebClient>();

export function webClient(token: string) {
  let c = clients.get(token);
  if (!c) {
    c = new WebClient(token, { logLevel: LogLevel.ERROR, retryConfig: { retries: 2 } });
    clients.set(token, c);
  }
  return c;
}

export const slackOf = (i: SlackIntegration) => webClient(i.config.botToken);

export function isSlack(i: Integration): i is SlackIntegration {
  return i.provider === "slack" && (i.config as SlackConfig).kind === "slack";
}

export async function getSlackIntegration(id: string, orgId?: string) {
  const [row] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.id, id), orgId ? eq(integrations.orgId, orgId) : undefined));
  return row && isSlack(row) ? row : undefined;
}

export async function listSlackIntegrations(orgId?: string) {
  const rows = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.provider, "slack"), orgId ? eq(integrations.orgId, orgId) : undefined));
  return rows.filter(isSlack);
}

export async function integrationsForTeam(teamId: string) {
  const rows = await db
    .select()
    .from(integrations)
    .where(
      and(eq(integrations.provider, "slack"), eq(integrations.externalId, teamId), eq(integrations.enabled, true)),
    );
  return rows.filter(isSlack);
}

export async function setStatus(id: string, status: Integration["status"], message: string | null = null) {
  await db.update(integrations).set({ status, statusMessage: message }).where(eq(integrations.id, id));
}

/** Thin wrappers so call sites don't fight Slack's very wide argument unions. */
export async function postMessage(i: SlackIntegration, args: Record<string, unknown>) {
  return slackOf(i).chat.postMessage(args as never);
}
export async function updateMessage(i: SlackIntegration, args: Record<string, unknown>) {
  return slackOf(i).chat.update(args as never);
}
export async function postEphemeral(i: SlackIntegration, args: Record<string, unknown>) {
  return slackOf(i).chat.postEphemeral(args as never);
}

export function slackError(err: unknown) {
  const data = (err as { data?: { error?: string; needed?: string } })?.data;
  if (data?.error) return data.needed ? `${data.error} (needs ${data.needed})` : data.error;
  return err instanceof Error ? err.message : String(err);
}
