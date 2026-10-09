import { EventEmitter } from "node:events";

/**
 * In-process event bus. Every state change in a workspace is published here and fanned out to
 * SSE clients (agents' browsers, widget visitors) and integrations (Slack, webhooks).
 */
export type BusEvent =
  | { type: "ticket.created"; orgId: string; ticketId: string }
  | { type: "ticket.updated"; orgId: string; ticketId: string; changes: string[]; actorId?: string }
  | {
      type: "message.created";
      orgId: string;
      ticketId: string;
      messageId: string;
      authorType: string;
      kind: string;
      skipAi?: boolean;
    }
  | { type: "draft.ready"; orgId: string; ticketId: string; draftId: string }
  | { type: "ai.state"; orgId: string; ticketId: string; state: string }
  | { type: "ticket.escalated"; orgId: string; ticketId: string; reason: string }
  | { type: "integration.updated"; orgId: string; integrationId: string };

class Bus extends EventEmitter {
  publish(event: BusEvent) {
    this.emit("event", event);
    this.emit(`org:${event.orgId}`, event);
  }
}

export const bus = new Bus();
bus.setMaxListeners(0);
