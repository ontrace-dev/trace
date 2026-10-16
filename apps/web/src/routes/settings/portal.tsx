import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, RefreshCw } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { CopyField, SettingsHeader } from "../settings";
import { ColorInput, Group, Range, Toggle } from "./widget";
import { Button, Field, Input, Segmented, Select, Spinner, Switch, Textarea } from "@/components/ui";
import type { PortalSettings, WorkspaceSettings } from "@/lib/types";
import { qk, useWorkspace } from "@/lib/workspace";

type Draft = PortalSettings;
type PreviewView = "list" | "ticket" | "new" | "signin";

const fonts = [
  { value: "", label: "System default" },
  { value: "Inter", label: "Inter" },
  { value: "Geist", label: "Geist" },
  { value: "Georgia", label: "Georgia (serif)" },
  { value: "ui-rounded", label: "Rounded" },
];

/** The customer portal: settings for the hosted page and the embeddable <trace-portal>, with a live preview. */
export function PortalSettingsPage() {
  const { wid, slug, api, boot, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: qk.settings(wid),
    queryFn: () => api<{ settings: WorkspaceSettings }>("/settings"),
  });
  const saved = settings.data?.settings.portal;
  const [draft, setDraft] = React.useState<Draft | null>(null);
  React.useEffect(() => {
    if (saved && !draft) setDraft(saved);
  }, [saved, draft]);

  const save = useMutation({
    mutationFn: (portal: Draft) =>
      api<{ settings: WorkspaceSettings }>("/settings", { method: "PATCH", json: { portal } }),
    onSuccess: (res) => {
      qc.setQueryData(qk.settings(wid), res);
      setDraft(res.settings.portal ?? null);
      toast.success("Portal saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!draft || !saved) {
    return (
      <div className="flex h-60 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const publicUrl = boot.env.publicUrl.replace(/\/$/, "");
  const portalUrl = `${publicUrl}/portal/${slug}`;

  return (
    <div className="flex min-h-full flex-col">
      <SettingsHeader
        title="Customer portal"
        description="One place where customers see every request they ever opened, by email, chat, Slack or here, and reply to your team. Use the hosted page, or embed it in your own platform."
      >
        <Button variant="ghost" size="sm" disabled={!saved.enabled} onClick={() => window.open(portalUrl, "_blank")}>
          <ExternalLink /> Open portal
        </Button>
      </SettingsHeader>

      <div className="grid flex-1 gap-0 xl:grid-cols-[minmax(0,1fr)_520px]">
        <fieldset disabled={!isAdmin} className="min-w-0 border-line xl:border-r">
          {!isAdmin ? (
            <div className="border-b border-line px-8 py-3 text-xs text-warn">Only admins can change the portal.</div>
          ) : null}

          <Group label="Portal">
            <Toggle
              label="Customer portal"
              description="When on, email replies link to the request online, and customers can sign in to see all of their requests."
              checked={draft.enabled}
              onChange={(v) => set("enabled", v)}
            />
            <CopyField label="Hosted portal" value={portalUrl} />
          </Group>

          <Group label="Appearance" description="Applies to the hosted page and every embed. Embeds can override it.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Accent color">
                <ColorInput value={draft.accentColor} onChange={(v) => set("accentColor", v)} />
              </Field>
              <Field label="Text on accent" hint="Auto picks black or white for contrast.">
                <div className="flex items-center gap-2">
                  <Segmented
                    value={draft.accentForeground ? "custom" : "auto"}
                    onChange={(v) => set("accentForeground", v === "auto" ? "" : "#ffffff")}
                    options={[
                      { value: "auto", label: "Auto" },
                      { value: "custom", label: "Custom" },
                    ]}
                  />
                  {draft.accentForeground ? (
                    <ColorInput value={draft.accentForeground} onChange={(v) => set("accentForeground", v)} />
                  ) : null}
                </div>
              </Field>
              <Field label="Theme">
                <Segmented
                  value={draft.theme}
                  onChange={(v) => set("theme", v)}
                  options={[
                    { value: "auto", label: "Auto" },
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark" },
                  ]}
                />
              </Field>
              <Field label={`Corner radius · ${draft.radius}px`}>
                <Range value={draft.radius} min={0} max={24} onChange={(v) => set("radius", v)} />
              </Field>
              <Field label="Font" hint="Embeds use your site's font if it is already loaded.">
                <Select
                  value={fonts.some((f) => f.value === draft.fontFamily) ? draft.fontFamily : "__custom"}
                  onChange={(e) =>
                    set(
                      "fontFamily",
                      e.target.value === "__custom" ? draft.fontFamily || "Helvetica Neue" : e.target.value,
                    )
                  }
                >
                  {fonts.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                  <option value="__custom">Custom…</option>
                </Select>
                {!fonts.some((f) => f.value === draft.fontFamily) ? (
                  <Input
                    className="mt-2"
                    value={draft.fontFamily}
                    onChange={(e) => set("fontFamily", e.target.value)}
                    placeholder="e.g. 'Söhne', Helvetica"
                  />
                ) : null}
              </Field>
              <Field label="Logo URL" hint="Defaults to the workspace logo.">
                <Input
                  value={draft.logoUrl}
                  onChange={(e) => set("logoUrl", e.target.value)}
                  placeholder="https://…/logo.svg"
                />
              </Field>
            </div>
          </Group>

          <Group label="Content">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Title">
                <Input value={draft.title} onChange={(e) => set("title", e.target.value)} />
              </Field>
              <Field label="Back to website link" hint="Shown in the hosted portal's header.">
                <Input
                  value={draft.homeUrl}
                  onChange={(e) => set("homeUrl", e.target.value)}
                  placeholder="https://acme.com"
                />
              </Field>
            </div>
            <Field label="Intro">
              <Textarea rows={2} value={draft.intro} onChange={(e) => set("intro", e.target.value)} />
            </Field>
          </Group>

          <Group label="Sign-in & features">
            <Toggle
              label="Sign in with an email link"
              description="Customers enter their email and get a one-time link. Turn off when your own platform signs customers in (see Embed)."
              checked={draft.emailSignIn}
              onChange={(v) => set("emailSignIn", v)}
            />
            <Toggle
              label="New requests"
              description="Customers can open a request from the portal. Your team's replies are emailed to them with a link back."
              checked={draft.allowNewRequests}
              onChange={(v) => set("allowNewRequests", v)}
            />
            <Toggle
              label="Search help articles"
              description="A search over knowledge marked public, also suggested while customers write a new request."
              checked={draft.showKnowledge}
              onChange={(v) => set("showKnowledge", v)}
            />
            <Toggle
              label="Show “Powered by trace”"
              checked={draft.showPoweredBy}
              onChange={(v) => set("showPoweredBy", v)}
            />
          </Group>

          <EmbedGroup draft={draft} set={set} publicUrl={publicUrl} slug={slug} />

          <Group label="Advanced">
            <Field
              label="Custom CSS"
              hint="Injected into the portal's shadow root. Target classes like .top, .row, .pill, .msg.you, .btn.primary."
            >
              <Textarea
                rows={6}
                spellCheck={false}
                className="font-mono text-[12px]"
                value={draft.customCss}
                onChange={(e) => set("customCss", e.target.value)}
                placeholder={"h1 { letter-spacing: -0.03em; }\n.row { padding-block: 18px; }"}
              />
            </Field>
          </Group>
          <div className="h-20" />
        </fieldset>

        <aside className="min-w-0 border-t border-line xl:border-t-0">
          <div className="sticky top-0 flex flex-col gap-3 p-6">
            <Preview draft={draft} slug={slug} />
          </div>
        </aside>
      </div>

      {dirty ? (
        <div className="sticky bottom-0 z-10 flex items-center justify-between gap-4 border-t border-line-strong bg-bar/95 px-8 py-3 backdrop-blur">
          <span className="flex items-center gap-2 text-xs text-fg-3">
            <span className="h-1.5 w-1.5 bg-warn" /> Unsaved changes — the preview already shows them.
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDraft(saved)}>
              Discard
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={save.isPending}
              onClick={() => save.mutate({ ...draft, allowedOrigins: draft.allowedOrigins.filter(Boolean) })}
            >
              Save changes
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Snippet({ label, code }: { label: string; code: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-fg-2">{label}</span>
      <div className="relative border border-line-strong bg-input">
        <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-fg-3">{code}</pre>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(code);
            toast.success("Copied");
          }}
          className="absolute top-2 right-2 border border-line-strong bg-bar px-2 py-0.5 font-mono text-[11.5px] text-muted hover:text-fg"
        >
          copy
        </button>
      </div>
    </div>
  );
}

function Reference({ title, children }: { title: string; children: string }) {
  return (
    <details className="text-xs text-muted">
      <summary className="cursor-pointer text-fg-3 select-none">{title}</summary>
      <pre className="mt-2 overflow-x-auto border border-line bg-cell px-3 py-2.5 font-mono text-[11px] leading-relaxed text-body">
        {children}
      </pre>
    </details>
  );
}

function EmbedGroup({
  draft,
  set,
  publicUrl,
  slug,
}: {
  draft: Draft;
  set: <K extends keyof Draft>(k: K, v: Draft[K]) => void;
  publicUrl: string;
  slug: string;
}) {
  const embed = `<trace-portal workspace="${slug}"></trace-portal>\n<script src="${publicUrl}/portal.js" async></script>`;
  const signedIn = `<!-- your page, rendered on your server for the logged-in user -->
<trace-portal workspace="${slug}"
  user-email="{{ user.email }}"
  user-name="{{ user.name }}"
  user-hash="{{ userHash }}"></trace-portal>

// your server (Node)
import { createHmac } from "node:crypto";
const userHash = createHmac("sha256", process.env.TRACE_IDENTITY_SECRET)
  .update(user.email)   // sign the email: the portal shows every request it ever opened
  .digest("hex");`;
  return (
    <Group
      label="Embed in your platform"
      description="The portal is a web component. Drop it into any page of your app, sign your users in, and theme it with your own CSS."
    >
      <Snippet label="Embed" code={embed} />
      <Snippet label="Sign your logged-in users in (no email link needed)" code={signedIn} />
      <p className="text-xs leading-relaxed text-dim">
        The identity secret is shared with the chat widget, so one signature works for both. Copy or rotate it on the{" "}
        <Link
          to="/w/$slug/settings/$section"
          params={{ slug, section: "widget" }}
          className="text-fg-3 underline underline-offset-2"
        >
          Chat widget
        </Link>{" "}
        page.
      </p>
      <Reference title="Attributes & JavaScript API">{`<trace-portal
  workspace="${slug}"
  layout="embed"            // or "page": full-page layout with its own background
  routing="memory"          // "hash" (#/tickets/42) or "path" (with base-path="/support") for deep links
  theme="auto" accent="#0f766e" radius="8" font="Inter"
  hide-header               // when your app already has a header
  return-to="https://app.acme.com/support"   // where email sign-in links come back to
></trace-portal>

const portal = document.querySelector("trace-portal");
portal.identify({ email, name, userHash });   // or userId + userHash
portal.navigate("/new");                      // "/", "/new", "/tickets/42"
portal.update({ accentColor: "#0f766e" });    // any setting, at runtime
portal.signOut();                             // e.g. on logout

// Or without markup:
TracePortal.mount("#support", { workspace: "${slug}", identity: { email, userHash } });`}</Reference>
      <Reference title="Theming with CSS">{`/* CSS variables pierce the shadow root */
trace-portal {
  --trace-accent: #0f766e;
  --trace-accent-foreground: #fff;
  --trace-font: "Inter", sans-serif;
  --trace-radius: 6px;
  --trace-background: transparent;  /* page background (embed: transparent) */
  --trace-surface: #fff;            /* cards */
  --trace-foreground: #111;
  --trace-muted: #666;
  --trace-border: #e5e5e5;
  --trace-max-width: 960px;
}

/* Parts: header, brand, main, title, tabs, tab, ticket-list, ticket-row, status,
   thread, message, message-you, message-team, message-ai, message-body, attachment,
   composer, input, button, button-primary, search, answers, card, signin, footer */
trace-portal::part(ticket-row) { padding-block: 18px; }
trace-portal::part(button-primary) { border-radius: 999px; }`}</Reference>
      <Reference title="Events">{`portal.addEventListener("trace:unauthenticated", (e) => {
  e.preventDefault();          // hide the built-in sign-in form…
  showYourOwnLogin();          // …and use your own
});
// also: trace:ready, trace:signin, trace:signout, trace:navigate { path }, trace:ticket-created { ticket }`}</Reference>
      <Reference title="Headless API (build your own UI)">{`Base: ${publicUrl}/api/portal/${slug}
Auth: Authorization: Bearer <token>

POST /session   { email | userId, name?, userHash }  → { token, customer }   signed in by your platform
POST /login     { email, returnTo? }                  → sends a one-time sign-in link
POST /verify    { code }                              → { token, customer }   code from the link (?trace_code=)
GET  /me
GET  /tickets?state=active|open|awaiting_you|solved   → { tickets, counts }
POST /tickets   { subject, body }
GET  /tickets/:number                                 → { ticket, messages }
POST /tickets/:number/messages   { body }             (reopens a solved request)
POST /tickets/:number/solve
GET  /tickets/:number/attachments/:id
GET  /articles/search?q=`}</Reference>
      <Field
        label="Allowed sites"
        hint="Sites that may embed the portal, one per line (acme.com, *.acme.com or https://app.acme.com). Email sign-in links only return to these sites; otherwise they open the hosted portal. Leave empty to allow embedding anywhere."
      >
        <Textarea
          rows={3}
          className="font-mono text-[12px]"
          value={draft.allowedOrigins.join("\n")}
          onChange={(e) =>
            set(
              "allowedOrigins",
              e.target.value.split("\n").map((s) => s.trim()),
            )
          }
          onBlur={() => set("allowedOrigins", draft.allowedOrigins.filter(Boolean))}
          placeholder={"app.acme.com\n*.acme.com"}
        />
      </Field>
    </Group>
  );
}

/**
 * Renders the real portal bundle with sample requests (the `preview` attribute) inside an iframe.
 * Unsaved settings are pushed with postMessage → portal.update(…), so every change shows instantly.
 */
function Preview({ draft, slug }: { draft: Draft; slug: string }) {
  const ref = React.useRef<HTMLIFrameElement>(null);
  const [view, setView] = React.useState<PreviewView>("list");
  const [embedded, setEmbedded] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);
  const srcDoc = React.useMemo(
    () => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
html,body{margin:0;min-height:100%;font-family:ui-sans-serif,system-ui,sans-serif}
body.embed{background:#fafaf9;padding:0}
body.embed[data-theme=dark]{background:#0f0f12}
@media (prefers-color-scheme: dark){body.embed[data-theme=auto]{background:#0f0f12}}
.app{display:grid;grid-template-columns:160px 1fr;min-height:100vh}
.side{background:#18181b;padding:18px 14px;display:flex;flex-direction:column;gap:10px}
.side i{display:block;height:8px;border-radius:4px;background:#3f3f46}
.side i:first-child{width:60%;height:14px;background:#52525b;margin-bottom:12px}
.content{padding:24px}
</style></head><body class="${embedded ? "embed" : ""}">
${
  embedded
    ? `<div class="app"><div class="side"><i></i><i></i><i style="width:70%"></i><i style="width:80%"></i></div><div class="content"><trace-portal workspace="${slug}" preview hide-header></trace-portal></div></div>`
    : `<trace-portal workspace="${slug}" preview layout="page"></trace-portal>`
}
<script>
window.addEventListener("message",function(e){
  var d=e.data,p=document.querySelector("trace-portal");
  if(!p||!d||d.type!=="trace-portal-preview")return;
  document.body.dataset.theme=d.settings.theme||"auto";
  customElements.whenDefined("trace-portal").then(function(){p.update(d.settings);if(d.path!==p.__path){p.__path=d.path;p.navigate(d.path)}});
});
</script>
<script src="/portal.js" async></script>
</body></html>`,
    [slug, embedded],
  );

  const path = view === "ticket" ? "/tickets/1042" : view === "new" ? "/new" : view === "signin" ? "/signin" : "/";
  const push = React.useCallback(() => {
    ref.current?.contentWindow?.postMessage({ type: "trace-portal-preview", settings: draft, path }, "*");
  }, [draft, path]);
  // The delayed pushes after a reload must send the latest settings and view, not the ones at load time.
  const latest = React.useRef(push);
  latest.current = push;

  React.useEffect(() => {
    const t = setTimeout(push, 60);
    return () => clearTimeout(t);
  }, [push]);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="label-mono">Live preview</span>
        <div className="flex items-center gap-1">
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: "list", label: "Requests" },
              { value: "ticket", label: "Request" },
              { value: "new", label: "New" },
              { value: "signin", label: "Sign-in" },
            ]}
          />
          <button
            type="button"
            onClick={() => setNonce((n) => n + 1)}
            className="p-1.5 text-dim hover:text-fg"
            aria-label="Reload preview"
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs text-fg-3">
        <Switch checked={embedded} onCheckedChange={setEmbedded} /> Show embedded in an app
      </label>
      <div className="overflow-hidden border border-line-strong bg-cell">
        <iframe
          key={`${embedded}-${nonce}`}
          ref={ref}
          title="Portal preview"
          srcDoc={srcDoc}
          onLoad={() => {
            latest.current();
            // The bundle loads async; push again once it has booted.
            setTimeout(() => latest.current(), 400);
            setTimeout(() => latest.current(), 1200);
          }}
          className="block h-[720px] w-full"
        />
      </div>
      <p className="text-[11px] leading-relaxed text-dim">
        This is the real portal with sample requests. Nothing you do here reaches your inbox.
      </p>
    </>
  );
}
