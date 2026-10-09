import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Bug, Code2, Mail, MessageCircle, Plus, Webhook } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { CopyField, SettingsHeader, SettingsSection } from "../settings";
import { DiscordIcon, SlackIcon } from "@/components/brand-icons";
import { Badge, Button, Dialog, Field, Input, Switch } from "@/components/ui";
import type { Integration } from "@/lib/types";
import { cn } from "@/lib/utils";
import { qk, useWorkspace } from "@/lib/workspace";
import { ChannelNotifications } from "@/features/integrations/channel-notifications";
import { useConfirm } from "@/components/ui/confirm";

export function IntegrationsSettings() {
  const confirm = useConfirm();
  const { api, wid, slug, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const [adding, setAdding] = React.useState(false);
  const q = useQuery({
    queryKey: qk.integrations(wid),
    queryFn: () => api<{ integrations: Integration[]; webhookEvents: string[] }>("/integrations"),
  });
  const slack = (q.data?.integrations ?? []).filter((i) => i.provider === "slack");
  const discord = (q.data?.integrations ?? []).filter((i) => i.provider === "discord");
  const hooks = (q.data?.integrations ?? []).filter((i) => i.provider === "webhook");
  const channelHooks = (q.data?.integrations ?? []).filter((i) => i.provider === "chat_webhook");
  const toggle = useMutation({
    mutationFn: (i: Integration) =>
      api(`/integrations/webhooks/${i.id}`, { method: "PATCH", json: { enabled: !i.enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.integrations(wid) }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/integrations/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.integrations(wid) }),
  });

  const tiles = [
    {
      name: "Slack",
      icon: <SlackIcon className="size-4" />,
      desc: "Ticket alerts with AI drafts, thread sync, reply & assign from Slack, intake channels, /trace.",
      to: "slack",
      status: slack.length ? (slack.some((s) => s.status === "error") ? "error" : "connected") : null,
    },
    {
      name: "Discord",
      icon: <DiscordIcon className="size-4" />,
      desc: "Ticket cards with AI drafts, thread sync, reply & assign from Discord, community intake channels and forums, /trace.",
      to: "discord",
      status: discord.length ? (discord.some((s) => s.status === "error") ? "error" : "connected") : null,
    },
    {
      name: "Linear & Jira",
      icon: <Bug className="size-4" />,
      desc: "File bugs and feature requests from a ticket, drafted by the AI with the trace attached. Status syncs back.",
      to: "fields",
      status: null,
    },
    {
      name: "Email",
      icon: <Mail className="size-4" />,
      desc: "support@ addresses via forwarding, MX or inbound webhooks.",
      to: "channels",
      status: null,
    },
    {
      name: "Chat widget",
      icon: <MessageCircle className="size-4" />,
      desc: "Embeddable, fully themeable chat with AI instant answers.",
      to: "widget",
      status: null,
    },
    {
      name: "REST API",
      icon: <Code2 className="size-4" />,
      desc: "Open and update tickets from any system.",
      to: "api",
      status: null,
    },
  ];
  const soon = ["GitHub Issues", "Stripe", "HubSpot", "WhatsApp", "Microsoft Teams"];

  return (
    <div>
      <SettingsHeader
        title="Integrations"
        description="Connect trace to where your team and your customers already are. Every integration action is recorded on the ticket's trace."
      />
      <div className="grid gap-px border-b border-line bg-line sm:grid-cols-2">
        {tiles.map((t) => (
          <Link
            key={t.name}
            to="/w/$slug/settings/$section"
            params={{ slug, section: t.to }}
            className="group flex flex-col gap-2 bg-bg p-5 hover:bg-white/[0.02]"
          >
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center border border-line-strong text-fg-3">
                {t.icon}
              </span>
              <span className="text-[14px] font-medium text-fg">{t.name}</span>
              {t.status ? (
                <Badge tone={t.status === "connected" ? "ok" : "danger"} upper>
                  {t.status}
                </Badge>
              ) : null}
              <ArrowRight className="ml-auto size-3.5 text-dim group-hover:text-fg" />
            </div>
            <p className="text-[12px] leading-relaxed text-muted">{t.desc}</p>
          </Link>
        ))}
      </div>

      <ChannelNotifications items={channelHooks} />

      <SettingsSection
        title="Outbound webhooks"
        description={
          <>
            POST signed JSON to your endpoint on ticket and message events. Verify{" "}
            <span className="font-mono">X-Trace-Signature</span> ={" "}
            <span className="font-mono">sha256=HMAC(secret, body)</span>.
          </>
        }
      >
        {hooks.map((h) => (
          <div key={h.id} className="flex items-center gap-3 border border-line px-3 py-2.5">
            <Webhook className="size-4 text-dim" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-[13px] text-fg-2">{h.name}</span>
              <span className="truncate font-mono text-[11.5px] text-dim">{String(h.config.url)}</span>
              {h.statusMessage ? <span className="text-[11px] text-danger">{h.statusMessage}</span> : null}
            </div>
            <Badge tone={h.status === "connected" ? "ok" : h.status === "error" ? "danger" : "neutral"} upper>
              {h.status === "pending" ? "no deliveries yet" : h.status}
            </Badge>
            <Switch checked={h.enabled} disabled={!isAdmin} onCheckedChange={() => toggle.mutate(h)} />
            <Button
              variant="ghost"
              size="sm"
              disabled={!isAdmin}
              onClick={async () =>
                (await confirm({
                  title: "Delete webhook?",
                  description: `trace stops sending events to ${String(h.config.url)}.`,
                  confirmLabel: "Delete",
                  destructive: true,
                })) && del.mutate(h.id)
              }
            >
              Delete
            </Button>
          </div>
        ))}
        <div>
          <Button disabled={!isAdmin} onClick={() => setAdding(true)}>
            <Plus /> Add webhook
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection
        title="On the roadmap"
        description="Integrations are plain modules on the event bus — contributions welcome."
      >
        <div className="flex flex-wrap gap-2">
          {soon.map((s) => (
            <span key={s} className="border border-line px-2.5 py-1 font-mono text-[11px] text-dim">
              {s}
            </span>
          ))}
        </div>
      </SettingsSection>
      <AddWebhook open={adding} onOpenChange={setAdding} events={q.data?.webhookEvents ?? []} />
    </div>
  );
}

function AddWebhook({
  open,
  onOpenChange,
  events,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  events: string[];
}) {
  const { api, wid } = useWorkspace();
  const qc = useQueryClient();
  const [form, setForm] = React.useState({ name: "", url: "", events: [] as string[] });
  const [secret, setSecret] = React.useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => api<{ secret: string }>("/integrations/webhooks", { method: "POST", json: form }),
    onSuccess: (r) => {
      setSecret(r.secret);
      qc.invalidateQueries({ queryKey: qk.integrations(wid) });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const close = (v: boolean) => {
    onOpenChange(v);
    if (!v) {
      setSecret(null);
      setForm({ name: "", url: "", events: [] });
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Add webhook"
      footer={
        secret ? (
          <Button variant="primary" onClick={() => close(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={add.isPending}
              disabled={!form.url || !form.name}
              onClick={() => add.mutate()}
            >
              Create
            </Button>
          </>
        )
      }
    >
      {secret ? (
        <CopyField label="Signing secret — store it now, it won't be shown again" value={secret} />
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="Name">
            <Input
              autoFocus
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Data warehouse"
            />
          </Field>
          <Field label="Endpoint URL">
            <Input
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://example.com/hooks/trace"
            />
          </Field>
          <Field label="Events" hint="None selected = all events.">
            <div className="flex flex-wrap gap-1.5">
              {events.map((ev) => {
                const on = form.events.includes(ev);
                return (
                  <button
                    key={ev}
                    type="button"
                    onClick={() =>
                      setForm({ ...form, events: on ? form.events.filter((x) => x !== ev) : [...form.events, ev] })
                    }
                    className={cn(
                      "border px-2 py-1 font-mono text-[11px]",
                      on ? "border-accent/50 bg-accent/10 text-accent-fg" : "border-line-strong text-muted",
                    )}
                  >
                    {ev}
                  </button>
                );
              })}
            </div>
          </Field>
        </div>
      )}
    </Dialog>
  );
}
