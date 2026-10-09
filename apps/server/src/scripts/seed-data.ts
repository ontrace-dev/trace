/** Demo content for the "northwind" workspace — mirrors the first design iteration. */

export const demoArticles = [
  {
    title: "Duplicate charges and refunds",
    tags: ["billing", "refunds"],
    body: `If you see the same invoice charged twice, it is almost always a payment retry that fired after the first charge had already succeeded.

## What we do

We refund the duplicate charge in full as soon as we confirm it in our payment provider. Refunds appear on your statement within **3–5 business days**, depending on your bank.

## What you need to do

Nothing. You'll receive a corrected invoice by email. If the refund isn't visible after 5 business days, reply to your ticket and we'll send the refund reference (ARN) so your bank can trace it.`,
  },
  {
    title: "Refund not showing on your statement",
    tags: ["billing", "refunds"],
    body: `Refunds are issued immediately on our side but banks take **3–5 business days** (sometimes up to 10 for credit cards) to show them.

If it has been longer than that, ask us for the **ARN (Acquirer Reference Number)** — your bank can use it to locate the refund.`,
  },
  {
    title: "Resetting your password",
    tags: ["auth", "account"],
    body: `Go to the sign-in page and click **Forgot password**. We'll email you a reset link that is valid for 1 hour.

If your workspace uses SSO, password resets are handled by your identity provider (Okta, Google Workspace, Azure AD) — contact your IT admin.`,
  },
  {
    title: "SSO redirect loops",
    tags: ["auth", "sso"],
    body: `A redirect loop after SSO sign-in usually means the **ACS URL** or **Entity ID** configured in your identity provider doesn't match the one shown in Settings → Security.

1. Copy the ACS URL from Settings → Security → SSO.
2. Paste it exactly (no trailing slash) into your IdP's app configuration.
3. Clear cookies for our domain and try again.

Staging environments need their own SAML app — the production ACS URL won't work there.`,
  },
  {
    title: "Exporting your data",
    tags: ["data", "export"],
    body: `Admins can export everything from **Settings → Data → Export**. Exports include tickets, messages, customers and attachments as JSON or CSV and cover your full history, including previous years.

Large exports are prepared in the background; you'll get an email with a download link that stays valid for 7 days.`,
  },
  {
    title: "API rate limits (HTTP 429)",
    tags: ["api"],
    body: `The API allows **600 requests per minute** per API key on v3 (v2 allowed 1,200 burst). When you exceed it you'll receive \`429 Too Many Requests\` with a \`Retry-After\` header.

- Respect \`Retry-After\` and back off exponentially.
- Batch writes using the bulk endpoints.
- Webhook retries count against the limit — make sure your webhook endpoint answers within 10 seconds so we don't retry.`,
  },
  {
    title: "Adding seats to your plan",
    tags: ["billing", "sales"],
    body: `Owners and billing admins can add seats under **Settings → Billing → Seats**. New seats are prorated for the current billing period. Annual plans can add seats at any time; removing seats takes effect at renewal.`,
  },
  {
    title: "Security & compliance (SOC 2, GDPR)",
    tags: ["trust", "security"],
    body: `We are **SOC 2 Type II** certified and audited annually. Customers on Scale and Enterprise plans can request the latest report under NDA from Settings → Security → Compliance, or by replying to their account manager.

We are GDPR compliant and offer a DPA; data is hosted in the EU (Frankfurt) by default.`,
  },
  {
    title: "Customer portal shows a blank page",
    tags: ["portal", "bug"],
    body: `A blank customer portal is usually caused by a browser extension blocking our script or a stale cache after a deploy.

1. Hard refresh (Cmd/Ctrl + Shift + R).
2. Try a private window.
3. If it persists, send us the browser console output (View → Developer → Console).`,
  },
];

export const demoCustomers = [
  {
    email: "anna@northwind.io",
    name: "Anna Møller",
    company: "Northwind",
    attributes: { org_id: "org_4f2a91c3", plan: "scale", mrr: "€2,480", nps: 94, region: "EU · CET" },
  },
  {
    email: "tomas@lumen.dev",
    name: "Tomas Ruiz",
    company: "Lumen",
    attributes: { org_id: "org_9b1e77d0", plan: "enterprise", mrr: "€9,800", nps: 71 },
  },
  {
    email: "jade@fathom.co",
    name: "Jade Lin",
    company: "Fathom",
    attributes: { org_id: "org_2c8d4a11", plan: "starter", mrr: "€290" },
  },
  {
    email: "kwame@kestrel.io",
    name: "Kwame Osei",
    company: "Kestrel",
    attributes: { org_id: "org_7e3f05b2", plan: "scale", mrr: "€3,100", nps: 60 },
  },
  {
    email: "mira@orbital.space",
    name: "Mira Bhatt",
    company: "Orbital",
    attributes: { org_id: "org_51aa9e6c", plan: "scale", mrr: "€1,950" },
  },
  {
    email: "dan@paleblue.app",
    name: "Dan Vo",
    company: "Pale Blue",
    attributes: { org_id: "org_0d93c4f8", plan: "team", mrr: "€640" },
  },
  {
    email: "rosa@lumen.dev",
    name: "Rosa Silva",
    company: "Lumen",
    attributes: { org_id: "org_9b1e77d0", plan: "enterprise", mrr: "€9,800" },
  },
  {
    email: "erik@fathom.co",
    name: "Erik Nyström",
    company: "Fathom",
    attributes: { org_id: "org_2c8d4a11", plan: "starter", mrr: "€290" },
  },
  {
    email: "amara@kestrel.io",
    name: "Amara Yeboah",
    company: "Kestrel",
    attributes: { org_id: "org_7e3f05b2", plan: "scale", mrr: "€3,100" },
  },
];

type Seed = {
  email: string;
  subject: string;
  body: string;
  channel: "email" | "widget" | "api" | "slack" | "discord";
  minutesAgo: number;
  tags?: string[];
  priority?: "low" | "normal" | "high" | "urgent";
  status?: "open" | "pending" | "resolved" | "closed";
  replies?: { from: "agent" | "customer" | "ai"; body: string; minutesAgo: number }[];
  runAgent?: boolean;
};

/** Historical, resolved tickets give the agent past resolutions to learn from. */
export const historicalTickets: Seed[] = [
  {
    email: "anna@northwind.io",
    subject: "Duplicate charge on #4120",
    body: "We were charged twice for invoice #4120. Can you reverse one?",
    channel: "email",
    minutesAgo: 31 * 1440,
    tags: ["billing"],
    status: "resolved",
    replies: [
      {
        from: "agent",
        body: "Hi Anna — confirmed, a retried webhook charged the card twice. I've refunded the duplicate in full; it'll show in 3–5 business days. Sorry about that!",
        minutesAgo: 31 * 1440 - 40,
      },
    ],
  },
  {
    email: "anna@northwind.io",
    subject: "Seat count not syncing",
    body: "We added 5 seats yesterday but the billing page still shows the old count.",
    channel: "email",
    minutesAgo: 58 * 1440,
    tags: ["billing"],
    status: "resolved",
    replies: [
      {
        from: "agent",
        body: "Seat counts sync nightly — I've triggered a manual sync, you should see 25 seats now.",
        minutesAgo: 58 * 1440 - 90,
      },
    ],
  },
  {
    email: "anna@northwind.io",
    subject: "Retry webhook double-fired",
    body: "Our webhook receiver got the same payment event twice and created two orders.",
    channel: "api",
    minutesAgo: 74 * 1440,
    tags: ["api", "billing"],
    status: "closed",
    replies: [
      {
        from: "agent",
        body: "Escalated to engineering: our retry fired before your endpoint's 200 was received. Use the event id as an idempotency key in the meantime.",
        minutesAgo: 74 * 1440 - 200,
      },
    ],
  },
  {
    email: "tomas@lumen.dev",
    subject: "SSO login fails after IdP change",
    body: "After moving to a new Okta app, users get bounced back to the login page.",
    channel: "email",
    minutesAgo: 20 * 1440,
    tags: ["auth"],
    status: "resolved",
    replies: [
      {
        from: "agent",
        body: "The ACS URL in the new Okta app had a trailing slash. After removing it SSO works again — the SSO redirect loops guide covers this.",
        minutesAgo: 20 * 1440 - 60,
      },
    ],
  },
  {
    email: "kwame@kestrel.io",
    subject: "Hitting 429s during nightly sync",
    body: "Our nightly import job keeps hitting rate limits.",
    channel: "api",
    minutesAgo: 12 * 1440,
    tags: ["api"],
    status: "resolved",
    replies: [
      {
        from: "agent",
        body: "v3 allows 600 req/min per key. Switching your import to the bulk endpoint keeps you well under that — let us know if you need a temporary raise.",
        minutesAgo: 12 * 1440 - 30,
      },
    ],
  },
];

/** The live queue from the design. */
export const openTickets: Seed[] = [
  {
    email: "anna@northwind.io",
    subject: "Invoice #4821 charged twice",
    body: "Hi — we were billed twice for invoice #4821 this morning. Same amount, two charges, four minutes apart. We need the duplicate reversed before our month-end close on Friday.",
    channel: "email",
    minutesAgo: 35,
    tags: ["billing"],
    priority: "high",
    runAgent: true,
  },
  {
    email: "tomas@lumen.dev",
    subject: "SSO redirect loops on staging",
    body: "Our staging environment redirects forever after the Okta login. Production works fine. Same Okta app for both.",
    channel: "email",
    minutesAgo: 95,
    tags: ["auth"],
    runAgent: true,
  },
  {
    email: "jade@fathom.co",
    subject: "Can I export last year's tickets?",
    body: "Is there a way to export all of last year's tickets for our audit? CSV would be ideal.",
    channel: "widget",
    minutesAgo: 170,
    tags: ["data"],
    runAgent: true,
  },
  {
    email: "kwame@kestrel.io",
    subject: "API returns 429 since v3 upgrade",
    body: "Since upgrading to v3 we get 429 Too Many Requests on our sync, which worked fine on v2. Did the limits change?",
    channel: "api",
    minutesAgo: 290,
    tags: ["api"],
    runAgent: true,
  },
  {
    email: "mira@orbital.space",
    subject: "Refund not reflected on statement",
    body: "You told me last week the refund was issued but I still don't see it on my card statement.",
    channel: "email",
    minutesAgo: 420,
    tags: ["billing"],
    runAgent: true,
  },
  {
    email: "dan@paleblue.app",
    subject: "Add seats to the team plan",
    body: "We're onboarding 4 more people next week — how do I add seats, and is it prorated?",
    channel: "widget",
    minutesAgo: 610,
    tags: ["sales"],
    runAgent: true,
  },
  {
    email: "rosa@lumen.dev",
    subject: "Webhook retries are hitting our rate limit",
    body: "Your webhook retries are hammering our endpoint and we're rate limiting you. Can you slow them down?",
    channel: "email",
    minutesAgo: 720,
    tags: ["api"],
    replies: [
      {
        from: "agent",
        body: "Looking into this with engineering now — can you share the endpoint's typical response time?",
        minutesAgo: 690,
      },
    ],
    status: "pending",
  },
  {
    email: "erik@fathom.co",
    subject: "Customer portal login shows a blank page",
    body: "After logging into the customer portal I just get a white page. Chrome, latest version — we're on app 3.18.2.",
    channel: "email",
    minutesAgo: 840,
    tags: ["portal"],
    runAgent: true,
  },
  {
    email: "amara@kestrel.io",
    subject: "Can we get your latest SOC 2 report?",
    body: "Our security team needs your latest SOC 2 Type II report for our vendor review. Can you send it over?",
    channel: "email",
    minutesAgo: 1010,
    tags: ["trust"],
    runAgent: true,
  },
];

/** Resolved tickets from the past week: the baseline "Surfacing" on Home compares today against. */
export const weekTickets: Seed[] = [
  ...[1.2, 2.5, 4.1, 6.3].map((d, i) => ({
    email: demoCustomers[i % demoCustomers.length]!.email,
    subject: [
      "Question about our last invoice",
      "VAT ID missing on invoice",
      "Can I switch to yearly billing?",
      "Card was declined on renewal",
    ][i]!,
    body: "Could you take a look at our billing? Thanks!",
    channel: "email" as const,
    minutesAgo: Math.round(d * 1440),
    tags: ["billing"],
    status: "resolved" as const,
    replies: [
      {
        from: "ai" as const,
        body: "Done — I've updated that for you. Anything else?",
        minutesAgo: Math.round(d * 1440) - 20,
      },
    ],
  })),
  ...[1.8, 3.4, 5.6].map((d, i) => ({
    email: demoCustomers[(i + 3) % demoCustomers.length]!.email,
    subject: ["Webhook signature doesn't verify", "Pagination cursor expires too fast", "How do I rotate an API key?"][
      i
    ]!,
    body: "Having trouble with the API — any pointers?",
    channel: "api" as const,
    minutesAgo: Math.round(d * 1440),
    tags: ["api"],
    status: "resolved" as const,
    replies: [
      {
        from: "agent" as const,
        body: "Here's how that works — let us know if it helps.",
        minutesAgo: Math.round(d * 1440) - 45,
      },
    ],
  })),
];

/** Ticket fields the demo shows next to the subject and in the side panel. */
export const demoFields = [
  {
    key: "org_id",
    label: "Org ID",
    type: "text" as const,
    source: "customer" as const,
    customerAttribute: "org_id",
    aiInstruction: "The customer's organization id, like org_ followed by letters and digits",
    shown: "header" as const,
  },
  {
    key: "app_version",
    label: "App version",
    type: "text" as const,
    source: "ai" as const,
    aiInstruction: "The app version the customer runs, e.g. 3.18.2",
    shown: "panel" as const,
  },
  {
    key: "severity",
    label: "Severity",
    type: "select" as const,
    options: [{ value: "S1" }, { value: "S2" }, { value: "S3" }, { value: "S4" }],
    source: "manual" as const,
    shown: "panel" as const,
  },
];

/** Playbook the agent follows for duplicate charges (uses the demo billing actions). */
export const demoProcedure = {
  name: "Duplicate charge",
  trigger: "The customer says they were charged twice, billed twice for the same invoice, or sees a duplicate payment.",
  instructions: `1. Call **lookup_charges** to list the customer's recent charges.
2. Confirm the duplicate: two charges with the same amount and the same invoice, created within a few minutes of each other. If you can't find one, don't refund — explain what you see and escalate.
3. Request **refund_charge** for the *later* of the two charges with refund_reason "duplicate". In the reason, name both charge ids, the amount and the invoice so the approver can verify at a glance.
4. After the refund has been executed (an internal note will show the result), reply to the customer: confirm the duplicate was refunded in full, give the refund id, and say it shows on their statement within 3–5 business days (see the "Duplicate charges and refunds" article).
5. Never refund more than one charge per invoice, and never refund the original charge.`,
};
