import * as React from "react";

/**
 * Customer messages arriving live (from the workspace stream). Feeds the toast, and lets list rows flash
 * for a moment when the ticket they show just got news. Unread state itself lives on the server.
 */

export interface Arrival {
  ticketId: string;
  kind: "ticket" | "reply";
  number: number;
  subject: string;
  channel: string;
  customer: string | null;
  preview: string;
  at: number;
}

/** How long a row stays highlighted after news arrives. */
export const FLASH_MS = 4000;

const recent = new Map<string, Arrival>();
const listeners = new Set<(a: Arrival) => void>();
const subscribers = new Set<() => void>();
const notify = () => subscribers.forEach((s) => s());

export function pushArrival(a: Arrival) {
  recent.set(a.ticketId, a);
  listeners.forEach((l) => l(a));
  notify();
  setTimeout(notify, FLASH_MS + 50);
}

export function onArrival(fn: (a: Arrival) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function subscribe(fn: () => void) {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** True for a few seconds after news arrived on this ticket. */
export function useJustArrived(ticketId: string) {
  return React.useSyncExternalStore(subscribe, () => {
    const a = recent.get(ticketId);
    return !!a && Date.now() - a.at < FLASH_MS;
  });
}
