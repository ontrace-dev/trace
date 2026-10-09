import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DEMO_BILLING_KEY } from "../services/actions/presets.ts";

/**
 * A tiny fake billing API so the demo workspace has real actions to call. Mounted at /api/demo/billing.
 * State lives in memory and resets when the server restarts.
 */
export const demoBillingRoutes = new Hono();

interface Charge {
  id: string;
  customer_email: string;
  amount: number;
  currency: string;
  description: string;
  invoice: string;
  created: string;
  status: "succeeded";
  refunded: boolean;
  refund_id: string | null;
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function initialCharges(): Charge[] {
  const c = (
    id: string,
    email: string,
    amount: number,
    invoice: string,
    created: string,
    description: string,
  ): Charge => ({
    id,
    customer_email: email,
    amount,
    currency: "eur",
    description,
    invoice,
    created,
    status: "succeeded",
    refunded: false,
    refund_id: null,
  });
  return [
    // The duplicate from the demo ticket: same invoice and amount, four minutes apart.
    c("ch_3PqL2x", "anna@northwind.io", 248000, "4821", minutesAgo(9 * 60 + 8), "Scale plan · October"),
    c("ch_3PqL5k", "anna@northwind.io", 248000, "4821", minutesAgo(9 * 60 + 4), "Scale plan · October"),
    c("ch_3Nn81a", "anna@northwind.io", 248000, "4790", minutesAgo(31 * 1440), "Scale plan · September"),
    c("ch_3PmQ0r", "mira@orbital.space", 195000, "4766", minutesAgo(8 * 1440), "Scale plan · October"),
    c("ch_3PkZ7t", "dan@paleblue.app", 64000, "4801", minutesAgo(3 * 1440), "Team plan · October"),
  ];
}

let charges = initialCharges();
const refunds = new Map<
  string,
  {
    id: string;
    charge_id: string;
    amount: number;
    currency: string;
    reason: string;
    status: "succeeded";
    created: string;
  }
>();

demoBillingRoutes.use("*", async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  if (auth !== `Bearer ${DEMO_BILLING_KEY}`) return c.json({ error: { message: "Invalid API key" } }, 401);
  await next();
});

demoBillingRoutes.get("/charges", (c) => {
  const email = c.req.query("email")?.trim().toLowerCase();
  const data = charges
    .filter((ch) => !email || ch.customer_email === email)
    .sort((a, b) => b.created.localeCompare(a.created));
  return c.json({ object: "list", data });
});

demoBillingRoutes.get("/charges/:id", (c) => {
  const ch = charges.find((x) => x.id === c.req.param("id"));
  if (!ch) return c.json({ error: { message: `No such charge: ${c.req.param("id")}` } }, 404);
  return c.json(ch);
});

demoBillingRoutes.post("/refunds", async (c) => {
  const parsed = z
    .object({ charge_id: z.string().min(1), reason: z.string().optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: { message: "charge_id is required" } }, 400);
  const ch = charges.find((x) => x.id === parsed.data.charge_id);
  if (!ch) return c.json({ error: { message: `No such charge: ${parsed.data.charge_id}` } }, 404);
  if (ch.refunded)
    return c.json({ error: { message: `Charge ${ch.id} has already been refunded (${ch.refund_id})` } }, 409);
  const refund = {
    id: `re_${randomBytes(6).toString("hex")}`,
    charge_id: ch.id,
    amount: ch.amount,
    currency: ch.currency,
    reason: parsed.data.reason ?? "requested_by_customer",
    status: "succeeded" as const,
    created: new Date().toISOString(),
  };
  ch.refunded = true;
  ch.refund_id = refund.id;
  refunds.set(refund.id, refund);
  return c.json(refund, 201);
});

/** Restore the initial demo data (handy when re-running the demo). */
demoBillingRoutes.post("/reset", (c) => {
  charges = initialCharges();
  refunds.clear();
  return c.json({ ok: true });
});
