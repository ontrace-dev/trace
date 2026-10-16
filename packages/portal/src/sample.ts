import type { Counts, Customer, Message, Ticket } from "./types";

/** Made-up requests for the settings preview (`preview` attribute): theming without signing anyone in. */
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export const sampleCustomer: Customer = { name: "Alex Morgan", email: "alex@example.com" };

export function sampleTickets(prefix: string): Ticket[] {
  const t = (
    number: number,
    subject: string,
    state: Ticket["state"],
    channel: string,
    updated: number,
    preview: string,
    lastAuthor: Ticket["lastAuthor"],
  ): Ticket => ({
    number,
    ref: `${prefix}-${number}`,
    subject,
    status: state === "awaiting_you" ? "pending" : state === "solved" ? "resolved" : "open",
    state,
    channel,
    createdAt: ago(updated + 600),
    updatedAt: ago(updated),
    solvedAt: state === "solved" ? ago(updated) : null,
    preview,
    lastAuthor,
  });
  return [
    t(
      1042,
      "Invoice shows the wrong VAT number",
      "awaiting_you",
      "email",
      25,
      "Could you send us the corrected VAT id so we can reissue it?",
      "team",
    ),
    t(
      1039,
      "SSO login loops back to the sign-in page",
      "open",
      "portal",
      190,
      "Thanks — we can reproduce it and are working on a fix.",
      "team",
    ),
    t(
      1031,
      "Export to CSV is missing the custom fields",
      "solved",
      "widget",
      3 * 1440,
      "Great, that works now. Thank you!",
      "you",
    ),
    t(
      1017,
      "How do I add a second admin?",
      "solved",
      "email",
      12 * 1440,
      "Go to Settings → Members and choose Invite.",
      "ai",
    ),
  ];
}

export function sampleCounts(tickets: Ticket[]): Counts {
  const n = (s: Ticket["state"]) => tickets.filter((t) => t.state === s).length;
  return { open: n("open"), awaiting_you: n("awaiting_you"), solved: n("solved"), all: tickets.length };
}

export function sampleMessages(ticket: Ticket, team: string): Message[] {
  return [
    {
      id: "s1",
      author: "you",
      authorName: null,
      body: `Hi! ${ticket.subject}. Can you take a look?`,
      attachments: [{ id: "att_sample", name: "screenshot.png", size: 182_000, contentType: "image/png" }],
      createdAt: ticket.createdAt,
    },
    {
      id: "s2",
      author: "ai",
      authorName: `${team} assistant`,
      body: "Thanks for reaching out! I've passed this to the team with the details you sent.",
      attachments: [],
      createdAt: new Date(new Date(ticket.createdAt).getTime() + 60_000).toISOString(),
    },
    {
      id: "s3",
      author: "team",
      authorName: "Sam from support",
      body: ticket.preview || "We're on it and will get back to you shortly.",
      attachments: [],
      createdAt: ticket.updatedAt,
    },
  ];
}
