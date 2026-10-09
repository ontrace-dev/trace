# trace

**The open source, AI-native helpdesk.** A modern replacement for Zendesk: every conversation from email, your website, Slack and your own systems lands in one inbox, an AI agent triages and answers it from your knowledge base and past resolutions, and every decision it makes is recorded as a **trace** you can audit span by span.

- **AI agent first.** It triages on arrival (intent, language, priority, tags, sentiment), researches your knowledge, past tickets and the customer profile, **takes actions** (look up an order, refund a charge, file a Jira bug — with human approval where it matters), then drafts or sends a grounded reply with cited sources. Policies decide what may auto-send.
- **Knowledge from everywhere.** Help articles plus synced sources — docs websites, Confluence, Jira, Notion, Zendesk Help Center and uploaded files — searched by meaning _and_ keywords with local multilingual embeddings.
- **Test before you trust it.** Simulate any conversation against the real agent and run graded test suites before switching autopilot on.
- **Every channel, one thread.** Email (SMTP, forwarding, or inbound webhooks), an embeddable chat widget, Slack and Discord (alerts, two-way thread sync, intake channels, `/trace`), and a REST API.
- **Workspaces.** Multi-tenant by design: invite your team, roles, per-workspace channels, AI settings and branding.
- **Local first.** Postgres and Mailpit in docker-compose, no cloud account needed. Without an Anthropic key the agent runs on local heuristics.

## Quickstart

Requirements: Node ≥ 22.18, Docker, and [Vite+](https://viteplus.dev) (`vp`, or use `pnpm exec vp`).

```bash
vp install
cp .env.example .env            # optionally set ANTHROPIC_API_KEY
vp run setup                    # postgres + mailpit, migrations, demo workspace
vp run dev                      # API :3000, web :5173, widget watcher
```

Open http://localhost:5173 and sign in as **demo@trace.dev / password** (workspace `northwind`).

| URL                                         | What                                                              |
| ------------------------------------------- | ----------------------------------------------------------------- |
| http://localhost:5173                       | the app                                                           |
| http://localhost:3000/api/widget/demo?key=… | a demo site with the chat widget (link in Settings → Chat widget) |
| http://localhost:8025                       | Mailpit — every email trace sends (replies, invites)              |
| http://localhost:5174                       | the marketing site (`apps/site`, deployed to ontrace.dev)         |
| `localhost:2525`                            | built-in inbound SMTP server for support@ mail                    |

### Everything in Docker

```bash
docker compose --profile app up --build     # http://localhost:3000, demo data seeded
```

## Deploy (any server with Docker)

The simplest production setup is a small VPS (e.g. Hetzner CX22) running `docker compose` with automatic HTTPS:

```bash
# on the server, after pointing your domain's A record at it
git clone https://github.com/ontrace-dev/trace.git && cd trace
cp .env.prod.example .env          # set DOMAIN, POSTGRES_PASSWORD, BETTER_AUTH_SECRET (+ optional keys)
docker compose -f docker-compose.prod.yml up -d --build
```

That starts Postgres (pgvector), trace and Caddy (Let's Encrypt certificates). Update with `git pull && docker compose -f docker-compose.prod.yml up -d --build`.

### Coolify (with a shared demo)

[`docker-compose.coolify.yml`](docker-compose.coolify.yml) is ready for Coolify's Docker Compose build pack. Coolify generates the domain, HTTPS, the database password and the auth secret, so there's nothing to fill in.

1. In Coolify, add a resource: **Public/Private repository** → this repo → build pack **Docker Compose** → compose file `/docker-compose.coolify.yml`.
2. Optional, under Environment Variables: set `ANTHROPIC_API_KEY` for the real AI agent (without it, trace uses its offline heuristics). On a public demo, use a key with a spend limit.
3. Deploy. The first build takes a few minutes and needs about 4 GB RAM on the server. On first boot trace seeds the demo and downloads the local embedding model (~120 MB). The app is reachable right away, and the demo workspace appears a minute later.

With `DEMO_MODE=true` (the default in this file):

- The login page has an **Enter the demo** button for the shared "northwind" workspace (`demo@trace.dev` / `password`): sample tickets, AI drafts, routing with assigned tickets, a pending approval, a hand-off, ticket fields and a week of history.
- The demo accounts can't change their password or email, and can't delete or leave the workspace.
- The demo workspace is rebuilt every `DEMO_RESET_HOURS` (default 24).
- Anyone can still sign up and create their own workspace.
- Every email trace sends lands in the demo mailbox (Mailpit), on its own generated domain.
- Because that mailbox is public, sign-in links and password-reset emails are turned off on a demo instance (anyone could read them).

For a real installation, set `DEMO_MODE=false` and `SMTP_URL` to a real mail provider, and remove the `mailpit` service.

### Free test deploy (Render + Supabase)

Good for clicking through a deployed trace at no cost. It isn't meant for production: the free instance sleeps after 15 minutes idle (the first request then takes about a minute), uploads are lost on every deploy, and the built-in inbound mail server is off (only HTTP reaches the container).

1. Create a free [Supabase](https://supabase.com) project. Under **Connect**, copy the **Session pooler** connection string (port 5432), put in your database password and append `?sslmode=require`.
2. In [Render](https://render.com): **New → Blueprint** → this repo. [`render.yaml`](render.yaml) sets up a free web service; paste the connection string as `DATABASE_URL`.
3. Deploy. trace runs the migrations on first boot and is reachable on its `onrender.com` URL.

The local embedding model is off to fit in 512 MB, so knowledge search uses keywords only. Optional: `ANTHROPIC_API_KEY` for the real AI agent, and `SMTP_URL` (e.g. Resend's SMTP) for invites and sign-in links.

## Try the channels locally

**Email** — send mail to the demo support address; it becomes a ticket, the AI drafts a reply, replies go to Mailpit and customer answers thread back in:

```bash
swaks --server localhost:2525 --to support@northwind.io --from you@example.com \
  --header "Subject: I was charged twice" --body "Invoice 1042 shows two charges"
```

Production options (Settings → Channels → Email): forward support@ to the channel's forwarding address, point an MX record at the built-in SMTP server, or POST from Postmark / SendGrid Inbound Parse / Mailgun / Cloudflare Email Workers to the channel's inbound webhook URL. Outbound uses `SMTP_URL` or a per-address SMTP override.

**Chat widget** — Settings → Chat widget has the snippet, a live preview and every visual option (colors, theme, position, radius, font, launcher, greeting, suggestions, custom CSS, allowed origins, identity verification):

```html
<script>
  window.Trace =
    window.Trace ||
    function () {
      (Trace.q = Trace.q || []).push(arguments);
    };
</script>
<script src="https://support.example.com/widget.js" data-key="wk_…" async></script>
<script>
  Trace("identify", { email: "ana@acme.io", name: "Ana", userId: "u_123", userHash: "<hmac>" });
</script>
```

**REST API** — create a key in Settings → API & keys:

```bash
curl -X POST http://localhost:3000/api/v1/tickets -H "Authorization: Bearer trk_…" \
  -H "content-type: application/json" \
  -d '{"subject":"Checkout fails","body":"Card declined","customer":{"email":"ana@acme.io"}}'
```

**Just want new tickets in a channel?** Settings → Integrations → **Notify a channel**: paste a Slack incoming-webhook or Discord channel-webhook URL. Every new ticket (and escalation) is posted once the AI has triaged it — summary, suggested reply, customer plan/MRR, open tickets and recent history, plus a link to the ticket. No bot needed.

**Slack** — Settings → Integrations → Slack. Create a Slack app from the generated manifest (Socket Mode — no public URL needed), paste the bot token and app-level token, pick a notification channel and optional intake channels. You get:

- a ticket card per new ticket with the AI summary and draft — **Send AI draft**, **Reply…**, **Assign to me**, **Resolve** right from Slack;
- two-way thread sync (thread replies become internal notes);
- intake channels (e.g. Slack Connect channels with customers) where messages open tickets and agent replies are posted back;
- `/trace ask|search|new|stats` and `@trace` mentions answered by the AI.

Set `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`/`SLACK_SIGNING_SECRET` to offer a one-click "Add to Slack" OAuth flow with HTTP events instead.

**Discord** — Settings → Integrations → Discord. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications), add a bot, copy its token and turn on **Message Content Intent** (Bot → Privileged Gateway Intents) so trace can read support messages. Paste the token, invite the bot with the generated link, then pick the server, a notification channel and optional support channels or forums. trace connects over the gateway — no public URL needed. You get:

- ticket cards with the AI draft and **Send AI draft**, **Reply…**, **Assign to me**, **Resolve** buttons, plus a synced thread per card (replies there become internal notes);
- support channels and forums where new messages/posts open tickets and the thread syncs both ways with the customer;
- `/trace ask|search|new|stats|link` and @mentions answered by the AI.

Discord has no emails, so teammates link their accounts with `/trace link` (or an admin links them in settings) to act as themselves; everyone else is treated as a customer.

**Outbound webhooks** — signed (`X-Trace-Signature: sha256=…`) JSON for `ticket.*`, `message.created`, `draft.ready`.

## The AI agent

On every inbound customer message the agent (Claude, `claude-opus-5-5` by default) runs a tool loop — `update_ticket` (triage), `search_knowledge_base`, `search_past_tickets`, `get_customer_profile` — and finishes with `submit_reply` (with confidence and cited sources) or `escalate_to_human`. Then a policy check decides:

- **Draft mode** (default): the reply waits as a suggested draft — send with one click or press ⇥ in the composer.
- **Autopilot**: sent automatically when confidence ≥ threshold and no "never auto-send" keyword (refund, legal, …) matches.
- **Widget instant answers**: visitors get confident answers immediately; otherwise a holding message and a human follows up.

Every step — model turns with token counts, tool calls, triage, policy decision, delivery — is a span. Open **⋯ → View full trace** on a ticket for the waterfall. Also: ⌘K "Ask trace anything" over your tickets and articles, AI rewrite/translate in the composer, conversation summaries, and "Turn into help article" for resolved tickets.

## Routing (auto-assignment)

Settings → **Routing** decides who gets a ticket once it needs a human. trace answers first, so routing does not assign every ticket the moment it arrives. It runs only when:

- trace hands the ticket off,
- an action is waiting for approval,
- trace's draft is below a confidence threshold, or
- the first reply is due soon.

You can still switch on classic "assign every new ticket" mode. Routing is off until you turn it on.

- **Groups and rules.** Rules are checked from top to bottom, and the first match decides the group. Rules match on what triage found (intent, tags, language), on the ticket (channel, priority) and on customer attributes (`plan`, `mrr`). Tickets no rule catches go to a fallback group.
- **Picking a person.** If the customer wrote recently, the ticket goes to whoever handled them last. Otherwise it goes to the person with the fewest open tickets, or round robin. People who are away or have reached their limit of open tickets are skipped. People set themselves available or away from the avatar menu, or with `/trace away` / `/trace back` in Slack.
- **Safety net.** If the assignee hasn't replied shortly before the first-reply target, the ticket goes back to the group and the next person is picked the same way (at most twice by default).
- **Visible decisions.** Every assignment is a `route.assign` span on the ticket's trace. The ticket's side panel shows the rule, the reason and the hand-back countdown. Settings has a log of recent decisions and a "try ticket #" preview that shows where a ticket would go without assigning it.

## Ticket fields & issue trackers

Settings → **Ticket fields** defines what every ticket carries:

- **Classification** (`type`: bug, feature request, question, incident, billing, how-to; options are editable). trace sets it on every ticket. When someone changes it, that counts as a correction: recent corrections are given to the agent as examples, and settings shows how often people changed trace's guess.
- **Custom fields** (text, number, single/multiple choice, yes/no, date, link). Each field's value comes from one of three places:
  - **trace fills it** from the conversation, following an instruction you write ("the app version, e.g. 3.18.2"). It stays empty when the conversation doesn't say.
  - **The customer record:** for example `org_id` from the attributes your app sends. trace can look for it in the conversation if the record has none.
  - **Set by hand.**

  A person's value is never overwritten by trace. Fields can show next to the subject (with one-click copy) or in the side panel, and can be required before a ticket is resolved. Values are in the ticket API under `fields`.

**Linear & Jira.** Connect them under the same settings page: Linear with a personal API key, Jira Cloud with site, email and API token. From any ticket, **Create issue** opens a draft written by trace from the conversation, what support found and the ticket's fields. The type (bug → Bug label or issue type, feature request → Feature / Story) comes from the classification. Before you file, trace looks for similar existing issues and offers "Link instead". The issue gets a link back to the ticket, and the ticket gets a note and a span on its trace. You can also link an existing issue by key or URL. Status is checked every 5 minutes, and changes are posted as notes on every linked ticket, including "you can let the customer know" when an issue is done.

## Sign-in & SSO

Built on [Better Auth](https://better-auth.com). Out of the box:

- **Email & password**, **sign-in links** by email, and **passkeys** (Face ID, Touch ID, Windows Hello, security keys). The login page marks the method you used last.
- **Two-factor** with an authenticator app, plus one-time backup codes. Passkeys and SSO skip it.
- **Social logins** for GitHub, Google, Microsoft and GitLab, each shown when its `*_CLIENT_ID`/`*_CLIENT_SECRET` is set. Google and Microsoft link to an existing account with the same email.
- **Settings → Account & security** (per person): passkeys, two-factor, password, connected logins and active sessions (device and IP, sign out one or all).

**Workspace SSO** (Settings → Single sign-on, admins). Add an OIDC provider (Okta, Microsoft Entra ID, Google Workspace, Auth0, Keycloak …) with issuer, client id and secret, or a SAML 2.0 provider with its sign-in URL and metadata or certificate. The page shows what to paste into the IdP (redirect URI, or ACS URL and SP metadata for SAML). A provider only works after you prove you own its email domain with a DNS TXT record (`_trace-verify-<provider>.<domain>`). After that:

- people with that email domain see "signs in with …" on the login page and go straight to the IdP, or use the link `/login?sso=<domain>`;
- they join the workspace on first sign-in, as member or admin (your choice);
- **Require SSO** for a verified domain turns off every other way in (password, links, passkeys, social) for those addresses.

trace fetches the issuer's discovery document itself and only reaches public https hosts. For an IdP on a private network, add its origin to `SSO_TRUSTED_ORIGINS`.

## Actions & procedures

Settings → **Actions & procedures** turns the agent from "answers" into "resolves".

- **Actions** are HTTP calls the agent can make: method, URL and JSON/form body templates with `{{param}}`, `{{customer.email}}`, `{{customer.externalId}}`, `{{ticket.number}}` and `{{secrets.NAME}}` (secrets are stored encrypted, write-only). Start from templates — Stripe (find customer, list charges, refund), Shopify order lookup, Jira create issue / get status, Linear create issue, generic webhook — or build your own and test it live from the editor.
- **Read-only** actions run immediately. **Consequential** actions (refunds, creates) wait for a human: the ticket shows an approval card with the agent's reason and editable inputs; _Approve & run_ executes the call, records the result on the ticket and re-runs the agent so it can tell the customer what happened. Inputs are validated before anything reaches an approver.
- **Procedures** are plain-language playbooks ("Duplicate charge: look up charges, confirm same invoice within minutes, request a refund of the later one, …") the agent follows when they match.

The demo workspace ships with a fake billing API (`/api/demo/billing`), `lookup_charges` + `refund_charge` actions and a _Duplicate charge_ procedure, so you can try the full loop without third-party accounts.

### MCP servers

Settings → Actions & procedures → **MCP servers** connects [Model Context Protocol](https://modelcontextprotocol.io) servers, so the agent can investigate and act in your team's systems live while it works a ticket. For example, it can check whether a bug is already known in Linear, find the Sentry error a customer is hitting, read a subscription in Stripe or search Confluence.

- **Add a server.** Templates: Linear, Sentry, Jira & Confluence, Notion (OAuth sign-in), plus Stripe, GitHub and PostHog (access token). Any other server works by URL (Streamable HTTP, with automatic fallback to SSE). In development you can also run a local command (stdio). Sign-in uses OAuth 2.1 with PKCE and dynamic client registration, and tokens are stored encrypted and refreshed automatically. If a server answers 401, trace switches it to sign-in on its own.
- **Choose the tools.** New tools start **off**. Turn on only the ones the agent may use. Each tool is either _read-only_ (runs freely), _writes · needs approval_ (the default for anything not marked read-only by the server) or _writes · runs freely_. Approval-gated calls go through the same approval card and re-run loop as actions. You can test any tool from settings.
- **Everywhere actions work.** MCP tools are part of the agent, simulations and test suites, and appear in the ticket trace as `mcp.<server>.<tool>` spans. Simulations really run read-only tools and only record write tools. The server's own usage instructions go into the agent's prompt, and tool output is treated as data, never as instructions.
- Local (stdio) servers run on the trace host without trace's environment variables, only with the ones you give them. They are off in production unless you set `MCP_ALLOW_STDIO=true`.

## Knowledge sources

Knowledge → **Sources** connects external content; everything is chunked and embedded **locally** (`Xenova/paraphrase-multilingual-MiniLM-L12-v2`, ~120 MB, downloaded on first use — no API key, nothing leaves your machine) and stored in Postgres with pgvector. Retrieval fuses semantic and keyword search, so a German question finds an English article.

| Source              | Auth                                           | Notes                                                                                      |
| ------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Website / docs      | —                                              | sitemap.xml or crawl under a path, main-content extraction                                 |
| Confluence          | email + API token (Cloud) or PAT (Data Center) | spaces + optional CQL                                                                      |
| Jira                | email + API token (Cloud)                      | JQL; issues are **internal** by default — context for the agent, never quoted to customers |
| Notion              | integration token                              | pages shared with the integration                                                          |
| Zendesk Help Center | none (public) or agent token                   | handy when migrating off Zendesk                                                           |
| Files               | —                                              | .md, .txt, .html, .pdf                                                                     |

Sources re-sync on a schedule; the **Search playground** shows exactly what the agent would retrieve.

## Test & simulate

Settings → **Test & simulate** runs the real agent — same prompt, knowledge, actions, procedures and policy — on a hypothetical conversation without creating tickets, sending messages or running write actions (only read-only actions execute). You see the reply, sources, triage, which actions it would take, the policy decision and the full span waterfall. Try "what-ifs" (autopilot on, different threshold, tone or guidance) before saving them.

**Test suites** hold cases with an expected outcome (reply / escalate) and plain-language expectations; import them from resolved tickets in one click. Runs grade every case with an LLM judge (offline: keyword coverage) and track the pass rate — run the suite after changing guidance, procedures or knowledge.

## Architecture

```
apps/server     Hono API on Node — better-auth (organizations = workspaces), Drizzle + Postgres/pgvector,
                AI agent (Anthropic SDK) with actions & approvals, local embeddings (transformers.js),
                knowledge connectors, simulator + judge, inbound SMTP, email/Slack/Discord/webhook integrations, SSE
apps/web        React 19 SPA — TanStack Router + Query, Tailwind v4, Radix, cmdk (built with Vite+)
packages/widget Embeddable chat widget — vanilla TS, Shadow DOM, ~11 KB gzipped IIFE
```

Everything that happens is published on an in-process event bus; the browser (SSE), Slack, Discord, webhooks and the AI queue subscribe to it. Channels register a _deliverer_ that carries public replies back to the customer (SMTP, Slack/Discord thread, widget stream).

Useful scripts: `vp run dev`, `vp run build`, `vp check`, `vp run db:generate` (after schema changes), `vp run db:migrate`, `vp run db:seed`.

## Configuration

See [.env.example](.env.example). The important ones: `DATABASE_URL`, `APP_URL`, `PUBLIC_URL`, `BETTER_AUTH_SECRET`, `ANTHROPIC_API_KEY` (or per-workspace in Settings → AI agent), `SMTP_URL`, `INBOUND_SMTP_PORT`, `INBOUND_DOMAIN`, `MCP_ALLOW_STDIO`, optional Slack credentials, GitHub/Google/Microsoft/GitLab OAuth credentials and `SSO_TRUSTED_ORIGINS`.

## License

MIT
