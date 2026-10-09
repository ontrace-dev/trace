import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import {
  type Attachment,
  type AuthorType,
  customers,
  drafts,
  type MessageKind,
  type MessageMeta,
  messages,
  type TicketChannel,
  type TicketPriority,
  type TicketStatus,
  tickets,
  user,
  workspaceSettings,
} from "../db/schema.ts";
import { bus } from "../lib/bus.ts";
import { id } from "../lib/ids.ts";
import type { TicketDiscordMeta, TicketEmailMeta, TicketSlackMeta } from "../lib/types.ts";
import { ensureWorkspace } from "./workspace.ts";

export type Ticket = typeof tickets.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Customer = typeof customers.$inferSelect;

export interface CustomerInput {
  email?: string | null;
  name?: string | null;
  company?: string | null;
  externalId?: string | null;
  avatarUrl?: string | null;
  attributes?: Record<string, unknown>;
  slackUserId?: string | null;
}

export async function upsertCustomer(orgId: string, input: CustomerInput): Promise<Customer> {
  const email = input.email?.trim().toLowerCase() || null;
  let existing: Customer | undefined;
  if (email) {
    [existing] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.orgId, orgId), eq(customers.email, email)));
  }
  if (!existing && input.externalId) {
    [existing] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.orgId, orgId), eq(customers.externalId, input.externalId)));
  }
  if (!existing && input.slackUserId) {
    [existing] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.orgId, orgId), eq(customers.slackUserId, input.slackUserId)));
  }
  if (existing) {
    const patch: Partial<Customer> = { lastSeenAt: new Date() };
    if (input.name && !existing.name) patch.name = input.name;
    if (input.company && !existing.company) patch.company = input.company;
    if (input.avatarUrl && !existing.avatarUrl) patch.avatarUrl = input.avatarUrl;
    if (email && !existing.email) patch.email = email;
    if (input.externalId && !existing.externalId) patch.externalId = input.externalId;
    if (input.slackUserId && !existing.slackUserId) patch.slackUserId = input.slackUserId;
    if (input.attributes) patch.attributes = { ...existing.attributes, ...input.attributes };
    const [row] = await db.update(customers).set(patch).where(eq(customers.id, existing.id)).returning();
    return row!;
  }
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      orgId,
      email,
      name: input.name ?? (email ? email.split("@")[0] : "Visitor"),
      company: input.company ?? null,
      externalId: input.externalId ?? null,
      avatarUrl: input.avatarUrl ?? null,
      attributes: input.attributes ?? {},
      slackUserId: input.slackUserId ?? null,
      lastSeenAt: new Date(),
    })
    .returning();
  return row!;
}

async function nextTicketNumber(orgId: string) {
  await ensureWorkspace(orgId);
  const [row] = await db
    .update(workspaceSettings)
    .set({ ticketSeq: sql`${workspaceSettings.ticketSeq} + 1` })
    .where(eq(workspaceSettings.orgId, orgId))
    .returning({ seq: workspaceSettings.ticketSeq, prefix: workspaceSettings.ticketPrefix });
  return row!;
}

export interface CreateTicketInput {
  subject: string;
  body: string;
  html?: string | null;
  channel: TicketChannel;
  channelId?: string | null;
  customer?: CustomerInput;
  customerId?: string;
  priority?: TicketPriority;
  tags?: string[];
  assigneeId?: string | null;
  attachments?: Attachment[];
  externalId?: string | null;
  email?: TicketEmailMeta;
  slack?: TicketSlackMeta;
  discord?: TicketDiscordMeta;
  widgetVisitorId?: string;
  /** When an agent opens a ticket on behalf of a customer. */
  author?: { type: AuthorType; id?: string; name?: string };
  meta?: MessageMeta;
  skipAi?: boolean;
  createdAt?: Date;
  /** Create the ticket without an opening message (the caller adds one, e.g. an outbound agent reply). */
  noInitialMessage?: boolean;
}

export async function createTicket(orgId: string, input: CreateTicketInput) {
  const settings = await ensureWorkspace(orgId);
  const customer = input.customerId
    ? (await db.select().from(customers).where(eq(customers.id, input.customerId)))[0]
    : input.customer
      ? await upsertCustomer(orgId, input.customer)
      : undefined;
  const { seq } = await nextTicketNumber(orgId);
  const priority = input.priority ?? "normal";
  const now = input.createdAt ?? new Date();
  const dueMinutes = settings.sla.firstResponse[priority];
  const [ticket] = await db
    .insert(tickets)
    .values({
      id: id("tkt"),
      orgId,
      number: seq,
      subject: input.subject.trim() || "(no subject)",
      status: "open",
      priority,
      channel: input.channel,
      channelId: input.channelId ?? null,
      customerId: customer?.id ?? null,
      assigneeId: input.assigneeId ?? null,
      tags: input.tags ?? [],
      firstResponseDueAt: new Date(now.getTime() + dueMinutes * 60_000),
      lastMessageAt: now,
      lastCustomerMessageAt: input.author && input.author.type !== "customer" ? null : now,
      email: input.email ?? null,
      slack: input.slack ?? null,
      discord: input.discord ?? null,
      widgetVisitorId: input.widgetVisitorId ?? null,
      createdAt: now,
    })
    .returning();

  const authorType = input.author?.type ?? "customer";
  if (input.noInitialMessage) {
    bus.publish({ type: "ticket.created", orgId, ticketId: ticket!.id });
    return { ticket: ticket!, message: undefined, customer };
  }
  const [message] = await db
    .insert(messages)
    .values({
      id: id("msg"),
      orgId,
      ticketId: ticket!.id,
      kind: "message",
      authorType,
      authorId: input.author?.id ?? customer?.id ?? null,
      authorName: input.author?.name ?? customer?.name ?? null,
      body: input.body,
      html: input.html ?? null,
      attachments: input.attachments ?? [],
      externalId: input.externalId ?? null,
      meta: { via: input.channel === "web" ? "web" : (input.channel as MessageMeta["via"]), ...input.meta },
      createdAt: now,
    })
    .returning();

  bus.publish({ type: "ticket.created", orgId, ticketId: ticket!.id });
  bus.publish({
    type: "message.created",
    orgId,
    ticketId: ticket!.id,
    messageId: message!.id,
    authorType,
    kind: "message",
    skipAi: input.skipAi,
  });
  return { ticket: ticket!, message: message!, customer };
}

export interface AddMessageInput {
  kind?: MessageKind;
  authorType: AuthorType;
  authorId?: string | null;
  authorName?: string | null;
  body: string;
  html?: string | null;
  attachments?: Attachment[];
  externalId?: string | null;
  meta?: MessageMeta;
  /** Override the automatic status transition. */
  status?: TicketStatus;
  skipAi?: boolean;
  createdAt?: Date;
  /** Set false to record a reply without sending it to the customer (imports, seeds). */
  deliver?: boolean;
}

export type Deliverer = (ticket: Ticket, message: Message) => Promise<Partial<MessageMeta> | void>;
const deliverers = new Map<TicketChannel, Deliverer>();

/** Channels register how a public reply reaches the customer (email → SMTP, slack → thread, …). */
export function registerDeliverer(channel: TicketChannel, fn: Deliverer) {
  deliverers.set(channel, fn);
}

export async function addMessage(orgId: string, ticketId: string, input: AddMessageInput) {
  const [ticket] = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)));
  if (!ticket) throw new Error("ticket not found");
  const kind = input.kind ?? "message";
  const now = input.createdAt ?? new Date();

  const [message] = await db
    .insert(messages)
    .values({
      id: id("msg"),
      orgId,
      ticketId,
      kind,
      authorType: input.authorType,
      authorId: input.authorId ?? null,
      authorName: input.authorName ?? null,
      body: input.body,
      html: input.html ?? null,
      attachments: input.attachments ?? [],
      externalId: input.externalId ?? null,
      meta: input.meta ?? {},
      createdAt: now,
    })
    .returning();

  const patch: Partial<Ticket> = {};
  const isPublicReply = kind === "message" && (input.authorType === "agent" || input.authorType === "ai");
  if (kind === "message") patch.lastMessageAt = now;
  if (kind === "message" && input.authorType === "customer") {
    patch.lastCustomerMessageAt = now;
    if (ticket.status !== "open") patch.status = "open";
  }
  if (isPublicReply) {
    if (!ticket.firstRespondedAt) patch.firstRespondedAt = now;
    if (ticket.status === "open") patch.status = "pending";
  }
  if (input.status) patch.status = input.status;
  if (patch.status === "resolved" || patch.status === "closed") patch.resolvedAt = now;
  if (Object.keys(patch).length) {
    await db.update(tickets).set(patch).where(eq(tickets.id, ticketId));
  }

  // Deliver public replies to the customer over the ticket's channel.
  let delivered = message!;
  if (isPublicReply && input.deliver !== false && input.meta?.via !== ticket.channel) {
    const deliver = deliverers.get(ticket.channel);
    if (deliver) {
      try {
        const extra = await deliver({ ...ticket, ...patch }, message!);
        if (extra) {
          [delivered] = await db
            .update(messages)
            .set({ meta: { ...message!.meta, ...extra, delivery: { status: "sent" } } })
            .where(eq(messages.id, message!.id))
            .returning();
        }
      } catch (err) {
        console.error(`[deliver:${ticket.channel}]`, err);
        [delivered] = await db
          .update(messages)
          .set({
            meta: {
              ...message!.meta,
              delivery: { status: "failed", error: err instanceof Error ? err.message : String(err) },
            },
          })
          .where(eq(messages.id, message!.id))
          .returning();
      }
    }
  }

  if (isPublicReply) {
    // Any pending AI draft is superseded once a human or the agent has replied.
    await db
      .update(drafts)
      .set({ status: "superseded" })
      .where(and(eq(drafts.ticketId, ticketId), eq(drafts.status, "pending")));
    if (ticket.aiState === "draft_ready") {
      await db.update(tickets).set({ aiState: "none" }).where(eq(tickets.id, ticketId));
    }
  }

  bus.publish({
    type: "message.created",
    orgId,
    ticketId,
    messageId: delivered!.id,
    authorType: input.authorType,
    kind,
    skipAi: input.skipAi,
  });
  if (Object.keys(patch).some((k) => k === "status")) {
    bus.publish({ type: "ticket.updated", orgId, ticketId, changes: ["status"] });
  }
  return delivered!;
}

export interface TicketPatch {
  subject?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  assigneeId?: string | null;
  tags?: string[];
}

export async function updateTicket(
  orgId: string,
  ticketId: string,
  patch: TicketPatch,
  actor: { type: AuthorType; id?: string | null; name?: string | null },
) {
  const [ticket] = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)));
  if (!ticket) throw new Error("ticket not found");
  const set: Partial<Ticket> = {};
  const events: { type: string; from: unknown; to: unknown; text: string }[] = [];
  const who = actor.name ?? (actor.type === "ai" ? "trace" : "Someone");

  if (patch.subject !== undefined && patch.subject !== ticket.subject) set.subject = patch.subject;
  if (patch.status && patch.status !== ticket.status) {
    set.status = patch.status;
    if (patch.status === "resolved" || patch.status === "closed") set.resolvedAt = new Date();
    events.push({
      type: "status",
      from: ticket.status,
      to: patch.status,
      text: `${who} set status to ${patch.status}`,
    });
  }
  if (patch.priority && patch.priority !== ticket.priority) {
    set.priority = patch.priority;
    events.push({
      type: "priority",
      from: ticket.priority,
      to: patch.priority,
      text: `${who} changed priority to ${patch.priority}`,
    });
  }
  if (patch.assigneeId !== undefined && patch.assigneeId !== ticket.assigneeId) {
    set.assigneeId = patch.assigneeId;
    set.assignedAt = patch.assigneeId ? new Date() : null;
    // A person assigning by hand overrides routing; trace's own assignments record their reason separately.
    if (actor.type !== "ai") set.routing = null;
    let assigneeName = "nobody";
    if (patch.assigneeId) {
      const [u] = await db.select({ name: user.name }).from(user).where(eq(user.id, patch.assigneeId));
      assigneeName = u?.name ?? "someone";
    }
    events.push({
      type: "assignee",
      from: ticket.assigneeId,
      to: patch.assigneeId,
      text: patch.assigneeId ? `${who} assigned to ${assigneeName}` : `${who} unassigned the ticket`,
    });
  }
  if (patch.tags) {
    const tags = [...new Set(patch.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
    if (tags.join() !== ticket.tags.join()) set.tags = tags;
  }
  if (!Object.keys(set).length) return ticket;
  const [updated] = await db.update(tickets).set(set).where(eq(tickets.id, ticketId)).returning();
  for (const e of events) {
    const [m] = await db
      .insert(messages)
      .values({
        id: id("msg"),
        orgId,
        ticketId,
        kind: "event",
        authorType: actor.type,
        authorId: actor.id ?? null,
        authorName: actor.name ?? null,
        body: e.text,
        meta: { event: { type: e.type, from: e.from, to: e.to } },
      })
      .returning();
    bus.publish({
      type: "message.created",
      orgId,
      ticketId,
      messageId: m!.id,
      authorType: actor.type,
      kind: "event",
    });
  }
  bus.publish({ type: "ticket.updated", orgId, ticketId, changes: Object.keys(set), actorId: actor.id ?? undefined });
  return updated!;
}

export async function getTicket(orgId: string, ticketId: string) {
  const [t] = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.orgId, orgId), eq(tickets.id, ticketId)));
  return t;
}

export async function getTicketByNumber(orgId: string, number: number) {
  const [t] = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.orgId, orgId), eq(tickets.number, number)));
  return t;
}

export async function getMessages(ticketId: string) {
  return db.select().from(messages).where(eq(messages.ticketId, ticketId)).orderBy(messages.createdAt);
}

export async function getCustomer(customerId: string | null) {
  if (!customerId) return undefined;
  const [c] = await db.select().from(customers).where(eq(customers.id, customerId));
  return c;
}

export async function getPendingDraft(ticketId: string) {
  const [d] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.ticketId, ticketId), eq(drafts.status, "pending")))
    .orderBy(desc(drafts.createdAt))
    .limit(1);
  return d;
}

/** Send the pending AI draft (optionally edited) as a public reply. */
export async function sendDraft(
  orgId: string,
  ticketId: string,
  actor: { id?: string | null; name?: string | null },
  overrideBody?: string,
) {
  const draft = await getPendingDraft(ticketId);
  if (!draft) throw new Error("no pending draft");
  const edited = overrideBody !== undefined && overrideBody.trim() !== draft.body.trim();
  const msg = await addMessage(orgId, ticketId, {
    authorType: edited || actor.id ? "agent" : "ai",
    authorId: actor.id ?? null,
    authorName: actor.name ?? null,
    body: overrideBody ?? draft.body,
    meta: { sources: draft.sources, draftId: draft.id },
  });
  await db.update(drafts).set({ status: "sent" }).where(eq(drafts.id, draft.id));
  return msg;
}

export function ticketRef(prefix: string, number: number) {
  return `${prefix}-${number}`;
}
