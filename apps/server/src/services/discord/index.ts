import { bus, type BusEvent } from "../../lib/bus.ts";
import { registerDiscordDelivery, startNotifications } from "./notify.ts";
import { syncClients } from "./runtime.ts";

/** Boots a gateway connection per Discord integration and subscribes notifications to the event bus. */
export async function startDiscord() {
  registerDiscordDelivery();
  startNotifications();
  bus.on("event", (e: BusEvent) => {
    if (e.type === "integration.updated") {
      // Idempotent: clients only restart when the token or pinned server changes.
      syncClients(e.orgId).catch((err) => console.error("[discord] sync failed", err));
    }
  });
  await syncClients();
}
