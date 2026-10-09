import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { channels, member, organization, views, workspaceSettings } from "../db/schema.ts";
import { env } from "../env.ts";
import { id, secretToken } from "../lib/ids.ts";
import type { AiSettings, SlaSettings, WidgetSettings } from "../lib/types.ts";

export const defaultAi = (): AiSettings => ({
  enabled: true,
  agentName: "trace",
  mode: "draft",
  autoSendThreshold: 0.85,
  tone: "friendly",
  guidance: "",
  neverAutoSend: ["refund", "legal", "security", "cancellation"],
  widgetInstantAnswers: true,
  autoTriage: true,
  model: env.AI_MODEL,
  effort: "low",
});

export const defaultWidget = (name = "Support"): WidgetSettings => ({
  title: "Hi there 👋",
  subtitle: `Ask ${name} anything — we usually reply in a few minutes.`,
  greeting: "Hey! How can we help today?",
  agentName: name,
  avatarUrl: "",
  accentColor: "#b9a3ff",
  accentForeground: "",
  theme: "auto",
  position: "right",
  offsetX: 20,
  offsetY: 20,
  radius: 14,
  fontFamily: "",
  launcherIcon: "chat",
  launcherText: "",
  suggestions: ["I was charged twice", "How do I reset my password?", "Talk to a human"],
  requireEmail: false,
  showPoweredBy: true,
  aiInstantAnswers: true,
  allowedOrigins: [],
  identitySecret: secretToken(40),
  customCss: "",
});

export const defaultSla = (): SlaSettings => ({
  firstResponse: { urgent: 30, high: 60, normal: 240, low: 1440 },
});

const defaultViews = [
  { name: "Billing disputes", icon: "receipt", filters: { tags: ["billing"], status: ["open", "pending"] } },
  { name: "Urgent", icon: "alert-triangle", filters: { priority: ["urgent", "high"], status: ["open"] } },
  { name: "Widget chats", icon: "message-circle", filters: { channel: ["widget"], status: ["open"] } },
] as const;

const settingsCache = new Map<string, typeof workspaceSettings.$inferSelect>();

/** Create the trace-specific rows for a workspace if missing (idempotent). */
export async function ensureWorkspace(orgId: string) {
  const cached = settingsCache.get(orgId);
  if (cached) return cached;
  let [row] = await db.select().from(workspaceSettings).where(eq(workspaceSettings.orgId, orgId));
  if (!row) {
    const [org] = await db.select().from(organization).where(eq(organization.id, orgId));
    if (!org) throw new Error(`workspace ${orgId} not found`);
    [row] = await db
      .insert(workspaceSettings)
      .values({
        orgId,
        widgetKey: `wk_${secretToken(24)}`,
        ai: defaultAi(),
        widget: defaultWidget(org.name),
        sla: defaultSla(),
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      [row] = await db.select().from(workspaceSettings).where(eq(workspaceSettings.orgId, orgId));
    } else {
      await db.insert(views).values(
        defaultViews.map((v, i) => ({
          id: id("view"),
          orgId,
          name: v.name,
          icon: v.icon,
          filters: { ...v.filters } as never,
          position: i,
        })),
      );
      await db.insert(channels).values([
        { id: id("ch"), orgId, type: "widget", name: "Website widget", inboundToken: secretToken(20) },
        { id: id("ch"), orgId, type: "api", name: "REST API", inboundToken: secretToken(20) },
      ]);
    }
  }
  settingsCache.set(orgId, row!);
  return row!;
}

export async function getSettings(orgId: string) {
  return ensureWorkspace(orgId);
}

export async function updateSettings(
  orgId: string,
  patch: Partial<Omit<typeof workspaceSettings.$inferInsert, "orgId" | "widgetKey" | "ticketSeq">>,
) {
  await ensureWorkspace(orgId);
  const [row] = await db.update(workspaceSettings).set(patch).where(eq(workspaceSettings.orgId, orgId)).returning();
  settingsCache.set(orgId, row!);
  return row!;
}

export function invalidateSettings(orgId: string) {
  settingsCache.delete(orgId);
}

export async function findWorkspaceByWidgetKey(key: string) {
  const [row] = await db.select().from(workspaceSettings).where(eq(workspaceSettings.widgetKey, key));
  if (row) settingsCache.set(row.orgId, row);
  return row;
}

export async function getMembership(orgId: string, userId: string) {
  const [m] = await db
    .select()
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)));
  return m;
}

export async function getOrg(orgId: string) {
  const [org] = await db.select().from(organization).where(eq(organization.id, orgId));
  return org;
}
