import { bus, type BusEvent } from "../../lib/bus.ts";
import { registerSlackDelivery, startNotifications } from "./notify.ts";
import { syncSockets } from "./runtime.ts";

/** Boots Socket Mode connections and subscribes Slack notifications to the event bus. */
export async function startSlack() {
  registerSlackDelivery();
  startNotifications();
  bus.on("event", (e: BusEvent) => {
    if (e.type === "integration.updated") {
      // Idempotent: clients are only restarted when tokens change.
      syncSockets(e.orgId).catch((err) => console.error("[slack] sync failed", err));
    }
  });
  await syncSockets();
}
