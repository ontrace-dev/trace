import { env } from "../../env.ts";
import type { ActionParameter } from "../../lib/types.ts";

/**
 * Ready-made action templates. Each one works as soon as the secrets it references exist
 * (Agent → Actions & procedures → Secrets). Placeholders:
 *   {{param}}            a parameter the AI fills in
 *   {{secrets.NAME}}     an encrypted workspace secret
 *   {{customer.email}}   / {{customer.externalId}} / {{customer.<attribute>}} — the ticket's customer
 *   {{ticket.number}}    / {{ticket.subject}}
 */
export interface ActionPreset {
  id: string;
  group: string;
  name: string;
  title: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body: string | null;
  bodyFormat: "json" | "form" | "none";
  parameters: ActionParameter[];
  requiresApproval: boolean;
  readOnly: boolean;
  /** Secrets that must exist for the action to work. */
  secrets: string[];
  /** One-line setup hint shown in the gallery. */
  setup: string;
}

const p = (
  name: string,
  description: string,
  required = true,
  type: ActionParameter["type"] = "string",
): ActionParameter => ({
  name,
  type,
  description,
  required,
});

export const DEMO_BILLING_KEY = "demo_billing_key_northwind_7f3a";

export function demoBillingUrl() {
  return `${env.PUBLIC_URL}/api/demo/billing`;
}

export function presets(): ActionPreset[] {
  const stripeAuth = { Authorization: "Bearer {{secrets.STRIPE_SECRET_KEY}}" };
  return [
    // ---------------------------------------------------------------- demo
    {
      id: "demo.lookup_charges",
      group: "Demo billing",
      name: "lookup_charges",
      title: "Look up charges",
      description:
        "List the customer's recent card charges (id, amount, currency, invoice, created time, refunded flag). Use it to verify billing questions like duplicate charges before answering.",
      method: "GET",
      url: `${demoBillingUrl()}/charges?email={{customer.email}}`,
      headers: { Authorization: "Bearer {{secrets.DEMO_BILLING_KEY}}" },
      body: null,
      bodyFormat: "none",
      parameters: [],
      requiresApproval: false,
      readOnly: true,
      secrets: ["DEMO_BILLING_KEY"],
      setup: "Built-in fake billing API for trying actions locally.",
    },
    {
      id: "demo.refund_charge",
      group: "Demo billing",
      name: "refund_charge",
      title: "Refund a charge",
      description:
        "Refund one charge in full. Only for a confirmed duplicate or an explicitly approved refund — use the exact charge id from lookup_charges.",
      method: "POST",
      url: `${demoBillingUrl()}/refunds`,
      headers: { Authorization: "Bearer {{secrets.DEMO_BILLING_KEY}}" },
      body: JSON.stringify({ charge_id: "{{charge_id}}", reason: "{{refund_reason}}" }, null, 2),
      bodyFormat: "json",
      parameters: [
        p("charge_id", "The charge id to refund, e.g. ch_3PqL5k"),
        {
          name: "refund_reason",
          type: "string",
          description: "Why the charge is refunded",
          required: true,
          enum: ["duplicate", "requested_by_customer", "fraudulent"],
        },
      ],
      requiresApproval: true,
      readOnly: false,
      secrets: ["DEMO_BILLING_KEY"],
      setup: "Built-in fake billing API for trying actions locally.",
    },
    // ---------------------------------------------------------------- Stripe
    {
      id: "stripe.find_customer",
      group: "Stripe",
      name: "stripe_find_customer",
      title: "Find Stripe customer",
      description:
        "Find the Stripe customer for the ticket's email address. Returns the customer id (cus_…) needed by other Stripe actions.",
      method: "GET",
      url: "https://api.stripe.com/v1/customers/search?query=email:'{{customer.email}}'",
      headers: stripeAuth,
      body: null,
      bodyFormat: "none",
      parameters: [],
      requiresApproval: false,
      readOnly: true,
      secrets: ["STRIPE_SECRET_KEY"],
      setup: "Add a restricted Stripe key (customers + charges read, refunds write) as STRIPE_SECRET_KEY.",
    },
    {
      id: "stripe.list_charges",
      group: "Stripe",
      name: "stripe_list_charges",
      title: "List Stripe charges",
      description:
        "List the most recent charges of a Stripe customer (amount, currency, status, refunded, created). Needs the cus_… id from stripe_find_customer.",
      method: "GET",
      url: "https://api.stripe.com/v1/charges?customer={{customer_id}}&limit=10",
      headers: stripeAuth,
      body: null,
      bodyFormat: "none",
      parameters: [p("customer_id", "Stripe customer id, e.g. cus_Nf…")],
      requiresApproval: false,
      readOnly: true,
      secrets: ["STRIPE_SECRET_KEY"],
      setup: "Requires STRIPE_SECRET_KEY.",
    },
    {
      id: "stripe.refund",
      group: "Stripe",
      name: "stripe_refund_charge",
      title: "Refund Stripe charge",
      description:
        "Refund a Stripe charge in full (or partially with amount in cents). Only after confirming the charge with stripe_list_charges.",
      method: "POST",
      url: "https://api.stripe.com/v1/refunds",
      headers: stripeAuth,
      body: JSON.stringify({ charge: "{{charge_id}}", amount: "{{amount_cents}}", reason: "{{reason_code}}" }, null, 2),
      bodyFormat: "form",
      parameters: [
        p("charge_id", "Stripe charge id, e.g. ch_3Pq…"),
        p("amount_cents", "Amount to refund in cents; omit for a full refund", false, "integer"),
        {
          name: "reason_code",
          type: "string",
          description: "Stripe refund reason",
          required: true,
          enum: ["duplicate", "requested_by_customer", "fraudulent"],
        },
      ],
      requiresApproval: true,
      readOnly: false,
      secrets: ["STRIPE_SECRET_KEY"],
      setup: "Requires STRIPE_SECRET_KEY with refunds write permission.",
    },
    // ---------------------------------------------------------------- Shopify
    {
      id: "shopify.order",
      group: "Shopify",
      name: "shopify_lookup_order",
      title: "Look up Shopify order",
      description: "Find an order by its number (e.g. 1042) and return status, fulfillment, tracking and line items.",
      method: "GET",
      url: "https://{{secrets.SHOPIFY_SHOP}}.myshopify.com/admin/api/2025-07/orders.json?name=%23{{order_number}}&status=any",
      headers: { "X-Shopify-Access-Token": "{{secrets.SHOPIFY_ACCESS_TOKEN}}" },
      body: null,
      bodyFormat: "none",
      parameters: [p("order_number", "The order number without #, e.g. 1042")],
      requiresApproval: false,
      readOnly: true,
      secrets: ["SHOPIFY_SHOP", "SHOPIFY_ACCESS_TOKEN"],
      setup: "SHOPIFY_SHOP = your shop subdomain, SHOPIFY_ACCESS_TOKEN = Admin API token with read_orders.",
    },
    // ---------------------------------------------------------------- Jira
    {
      id: "jira.create_issue",
      group: "Jira",
      name: "jira_create_issue",
      title: "Create Jira issue",
      description:
        "File a bug or task in Jira for engineering when a customer reports a reproducible problem. Include steps, expected vs actual and the ticket reference.",
      method: "POST",
      url: "https://{{secrets.JIRA_SITE}}.atlassian.net/rest/api/3/issue",
      headers: { Authorization: "Basic {{secrets.JIRA_BASIC_AUTH}}" },
      body: JSON.stringify(
        {
          fields: {
            project: { key: "{{secrets.JIRA_PROJECT_KEY}}" },
            issuetype: { name: "{{issue_type}}" },
            summary: "{{summary}}",
            labels: ["from-support"],
            description: {
              type: "doc",
              version: 1,
              content: [
                { type: "paragraph", content: [{ type: "text", text: "{{details}}" }] },
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "Reported via trace ticket {{ticket.number}} by {{customer.email}}" },
                  ],
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      bodyFormat: "json",
      parameters: [
        p("summary", "One-line issue title"),
        p("details", "Steps to reproduce, expected vs actual behavior, customer impact"),
        { name: "issue_type", type: "string", description: "Jira issue type", required: true, enum: ["Bug", "Task"] },
      ],
      requiresApproval: true,
      readOnly: false,
      secrets: ["JIRA_SITE", "JIRA_BASIC_AUTH", "JIRA_PROJECT_KEY"],
      setup:
        "JIRA_SITE = your site (acme for acme.atlassian.net), JIRA_BASIC_AUTH = base64 of email:api_token, JIRA_PROJECT_KEY e.g. SUP.",
    },
    {
      id: "jira.get_issue",
      group: "Jira",
      name: "jira_get_issue",
      title: "Get Jira issue status",
      description:
        "Read the status, assignee, fix version and last comments of a Jira issue by key (e.g. ENG-123), to tell a customer where a bug stands.",
      method: "GET",
      url: "https://{{secrets.JIRA_SITE}}.atlassian.net/rest/api/3/issue/{{issue_key}}?fields=summary,status,assignee,fixVersions,resolution,comment",
      headers: { Authorization: "Basic {{secrets.JIRA_BASIC_AUTH}}" },
      body: null,
      bodyFormat: "none",
      parameters: [p("issue_key", "Jira issue key, e.g. ENG-123")],
      requiresApproval: false,
      readOnly: true,
      secrets: ["JIRA_SITE", "JIRA_BASIC_AUTH"],
      setup: "JIRA_SITE + JIRA_BASIC_AUTH (base64 of email:api_token).",
    },
    // ---------------------------------------------------------------- Linear
    {
      id: "linear.create_issue",
      group: "Linear",
      name: "linear_create_issue",
      title: "Create Linear issue",
      description:
        "Create an issue in Linear for engineering (bugs, feature requests) with a clear title and description.",
      method: "POST",
      url: "https://api.linear.app/graphql",
      headers: { Authorization: "{{secrets.LINEAR_API_KEY}}" },
      body: JSON.stringify(
        {
          query:
            "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }",
          variables: {
            input: {
              teamId: "{{secrets.LINEAR_TEAM_ID}}",
              title: "{{title}}",
              description: "{{description}}\n\nFrom trace ticket {{ticket.number}} ({{customer.email}})",
            },
          },
        },
        null,
        2,
      ),
      bodyFormat: "json",
      parameters: [p("title", "Issue title"), p("description", "Markdown description with reproduction details")],
      requiresApproval: true,
      readOnly: false,
      secrets: ["LINEAR_API_KEY", "LINEAR_TEAM_ID"],
      setup: "LINEAR_API_KEY = personal API key, LINEAR_TEAM_ID = target team id.",
    },
    // ---------------------------------------------------------------- generic
    {
      id: "generic.webhook",
      group: "Generic",
      name: "call_webhook",
      title: "Call webhook",
      description:
        "Notify an internal system about this ticket (e.g. start an account review). Describe precisely when the AI should use it.",
      method: "POST",
      url: "https://example.com/hooks/support",
      headers: { Authorization: "Bearer {{secrets.WEBHOOK_TOKEN}}" },
      body: JSON.stringify(
        { ticket: "{{ticket.number}}", customer_email: "{{customer.email}}", note: "{{note}}" },
        null,
        2,
      ),
      bodyFormat: "json",
      parameters: [p("note", "What the receiving system should know")],
      requiresApproval: true,
      readOnly: false,
      secrets: ["WEBHOOK_TOKEN"],
      setup: "Point the URL at your endpoint and add WEBHOOK_TOKEN.",
    },
  ];
}

export function getPreset(id: string) {
  return presets().find((p) => p.id === id);
}
