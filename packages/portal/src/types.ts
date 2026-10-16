export interface PortalSettings {
  enabled: boolean;
  title: string;
  intro: string;
  logoUrl: string;
  homeUrl: string;
  accentColor: string;
  accentForeground: string;
  theme: "light" | "dark" | "auto";
  radius: number;
  fontFamily: string;
  emailSignIn: boolean;
  allowNewRequests: boolean;
  showKnowledge: boolean;
  showPoweredBy: boolean;
  customCss: string;
}

export interface PortalConfig {
  portal: PortalSettings;
  org: { name: string; logo: string | null; slug: string };
  ticketPrefix: string;
  demo: { customer: string } | null;
}

export type TicketState = "open" | "awaiting_you" | "solved";

export interface Ticket {
  number: number;
  ref: string;
  subject: string;
  status: "open" | "pending" | "resolved" | "closed";
  state: TicketState;
  channel: string;
  createdAt: string;
  updatedAt: string;
  solvedAt: string | null;
  preview?: string;
  lastAuthor?: Author | null;
  working?: boolean;
}

export type Author = "you" | "team" | "ai" | "system";

export interface Message {
  id: string;
  author: Author;
  authorName: string | null;
  body: string;
  attachments: { id: string; name: string; size: number; contentType: string }[];
  createdAt: string;
  pending?: boolean;
}

export interface Customer {
  name: string | null;
  email: string | null;
}

export interface Article {
  id: string;
  title: string;
  url: string | null;
  excerpt: string;
  body: string | null;
}

export type Counts = Record<TicketState | "all", number>;

/** Signs the customer in from your platform: HMAC-SHA256(email or userId, identity secret) as hex. */
export interface Identity {
  email?: string;
  userId?: string;
  name?: string;
  userHash: string;
  attributes?: Record<string, unknown>;
}
