import type { Article, Counts, Customer, Identity, Message, PortalConfig, Ticket } from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Session = { token: string; customer: Customer | null };

/** Client for /api/portal/<workspace> — the same API you can call to build a portal of your own. */
export class Api {
  token: string | null = null;
  constructor(
    readonly base: string,
    readonly workspace: string,
  ) {}

  get root() {
    return `${this.base}/api/portal/${encodeURIComponent(this.workspace)}`;
  }

  private async req<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    const { json, ...rest } = init;
    const res = await fetch(`${this.root}${path}`, {
      ...rest,
      headers: {
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
    return data;
  }

  config() {
    return this.req<PortalConfig>("/config");
  }

  login(email: string, returnTo?: string) {
    return this.req<{ ok: true }>("/login", { method: "POST", json: { email, returnTo } });
  }

  verify(code: string) {
    return this.req<Session>("/verify", { method: "POST", json: { code } });
  }

  session(identity: Identity) {
    return this.req<Session>("/session", { method: "POST", json: identity });
  }

  demo() {
    return this.req<Session>("/demo", { method: "POST" });
  }

  me() {
    return this.req<{ customer: Customer; scope: "all" | "ticket" }>("/me");
  }

  tickets(state?: string) {
    return this.req<{ tickets: Ticket[]; counts: Counts }>(`/tickets${state ? `?state=${state}` : ""}`);
  }

  ticket(number: number) {
    return this.req<{ ticket: Ticket; messages: Message[] }>(`/tickets/${number}`);
  }

  create(subject: string, body: string) {
    return this.req<{ ticket: Ticket }>("/tickets", { method: "POST", json: { subject, body } });
  }

  reply(number: number, body: string) {
    return this.req<{ message: Message; ticket: Ticket }>(`/tickets/${number}/messages`, {
      method: "POST",
      json: { body },
    });
  }

  solve(number: number) {
    return this.req<{ ticket: Ticket }>(`/tickets/${number}/solve`, { method: "POST" });
  }

  async attachment(number: number, id: string) {
    const res = await fetch(`${this.root}/tickets/${number}/attachments/${encodeURIComponent(id)}`, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, "Attachment not available");
    return res.blob();
  }

  search(q: string) {
    return this.req<{ articles: Article[] }>(`/articles/search?q=${encodeURIComponent(q)}`);
  }
}
