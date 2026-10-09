import type { Conversation, Identity, WidgetConfig, WMessage } from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Api {
  token: string | null = null;
  constructor(
    readonly base: string,
    readonly key: string,
  ) {}

  get root() {
    return `${this.base}/api/widget/${encodeURIComponent(this.key)}`;
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
    return this.req<WidgetConfig>("/config");
  }

  session(body: { visitorId?: string; token?: string } & Identity) {
    return this.req<{ visitorId: string; token: string; verified: boolean }>("/session", {
      method: "POST",
      json: body,
    });
  }

  conversations() {
    return this.req<{ conversations: Conversation[] }>("/conversations");
  }

  start(body: { body: string; email?: string; name?: string }) {
    return this.req<{ conversation: Conversation; message: WMessage | null; token: string }>("/conversations", {
      method: "POST",
      json: body,
    });
  }

  messages(id: string) {
    return this.req<{ conversation: Conversation; messages: WMessage[] }>(`/conversations/${id}/messages`);
  }

  send(id: string, body: string) {
    return this.req<{ message: WMessage }>(`/conversations/${id}/messages`, { method: "POST", json: { body } });
  }

  streamUrl() {
    return `${this.root}/stream?token=${encodeURIComponent(this.token ?? "")}`;
  }
}
