import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BellRing, Plus, Send, Sparkles } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { SettingsSection } from "@/routes/settings";
import { DiscordIcon, SlackIcon } from "@/components/brand-icons";
import { Badge, Button, Dialog, Field, Input, Segmented, Switch } from "@/components/ui";
import type { Integration } from "@/lib/types";
import { cn } from "@/lib/utils";
import { qk, useWorkspace } from "@/lib/workspace";
import { useConfirm } from "@/components/ui/confirm";

type Platform = "slack" | "discord";
type Event = "ticket.created" | "ticket.escalated";

interface ChatWebhookConfig {
  kind: "chat_webhook";
  platform: Platform;
  url: string;
  events: Event[];
  waitForAi: boolean;
}

const HELP: Record<Platform, { steps: string; placeholder: string; docs: string }> = {
  slack: {
    steps:
      "In Slack: Apps → search “Incoming Webhooks” (or create an app → Incoming Webhooks) → Add to channel → copy the URL.",
    placeholder: "https://hooks.slack.com/services/T000/B000/xxxx",
    docs: "https://api.slack.com/messaging/webhooks",
  },
  discord: {
    steps: "In Discord: channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL.",
    placeholder: "https://discord.com/api/webhooks/123…/abc…",
    docs: "https://support.discord.com/hc/en-us/articles/228383668",
  },
};

/** "Just notify me" — new tickets with full context in a Slack or Discord channel, via a webhook URL. */
export function ChannelNotifications({ items }: { items: Integration[] }) {
  const confirm = useConfirm();
  const { api, wid, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const [adding, setAdding] = React.useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: qk.integrations(wid) });
  const patch = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      api(`/integrations/chat-webhooks/${id}`, { method: "PATCH", json: body }),
    onSuccess: refresh,
    onError: (e) => toast.error((e as Error).message),
  });
  const test = useMutation({
    mutationFn: (id: string) => api(`/integrations/chat-webhooks/${id}/test`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Test message sent — check the channel");
      refresh();
    },
    onError: (e) => {
      toast.error((e as Error).message);
      refresh();
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/integrations/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  return (
    <SettingsSection
      title="Notify a channel"
      description="The simplest setup: paste a Slack or Discord webhook URL and every new ticket lands in that channel with the AI summary, suggested reply and customer context. No bot or app needed."
    >
      {items.map((h) => {
        const cfg = h.config as unknown as ChatWebhookConfig;
        const Icon = cfg.platform === "slack" ? SlackIcon : DiscordIcon;
        return (
          <div key={h.id} className="flex flex-col gap-2.5 border border-line px-3 py-3">
            <div className="flex items-center gap-3">
              <Icon className="size-4 shrink-0 text-fg-3" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13px] text-fg-2">{h.name}</span>
                <span className="truncate font-mono text-[11.5px] text-dim">{cfg.url}</span>
              </div>
              <Badge tone={h.status === "connected" ? "ok" : h.status === "error" ? "danger" : "neutral"} upper>
                {h.status === "pending" ? "nothing sent yet" : h.status}
              </Badge>
              <Switch
                checked={h.enabled}
                disabled={!isAdmin}
                onCheckedChange={(enabled) => patch.mutate({ id: h.id, enabled })}
              />
            </div>
            {h.statusMessage && h.status === "error" ? (
              <span className="text-[12px] text-danger">{h.statusMessage}</span>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-muted">
              <EventToggles
                value={cfg.events}
                disabled={!isAdmin}
                onChange={(events) => patch.mutate({ id: h.id, events })}
              />
              <label className="flex items-center gap-2">
                <Switch
                  checked={cfg.waitForAi}
                  disabled={!isAdmin}
                  onCheckedChange={(waitForAi) => patch.mutate({ id: h.id, waitForAi })}
                />
                Wait for AI context
              </label>
              <span className="ml-auto flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!isAdmin}
                  loading={test.isPending}
                  onClick={() => test.mutate(h.id)}
                >
                  <Send /> Send test
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!isAdmin}
                  onClick={async () =>
                    (await confirm({
                      title: "Stop notifying this channel?",
                      description: `“${h.name}” will no longer receive new tickets. You can add it again any time.`,
                      confirmLabel: "Remove",
                      destructive: true,
                    })) && del.mutate(h.id)
                  }
                >
                  Remove
                </Button>
              </span>
            </div>
          </div>
        );
      })}
      <div>
        <Button disabled={!isAdmin} onClick={() => setAdding(true)}>
          <Plus /> Add channel
        </Button>
      </div>
      <AddChannelDialog open={adding} onOpenChange={setAdding} />
    </SettingsSection>
  );
}

function EventToggles({
  value,
  onChange,
  disabled,
}: {
  value: Event[];
  onChange: (v: Event[]) => void;
  disabled?: boolean;
}) {
  const opts: { v: Event; label: string }[] = [
    { v: "ticket.created", label: "New tickets" },
    { v: "ticket.escalated", label: "Escalations" },
  ];
  return (
    <span className="flex gap-1.5">
      {opts.map((o) => {
        const on = value.includes(o.v);
        return (
          <button
            key={o.v}
            type="button"
            disabled={disabled || (on && value.length === 1)}
            title={on && value.length === 1 ? "At least one event is required" : undefined}
            onClick={() => onChange(on ? value.filter((x) => x !== o.v) : [...value, o.v])}
            className={cn(
              "border px-2 py-1 font-mono text-[11px] disabled:cursor-not-allowed",
              on ? "border-accent/50 bg-accent/10 text-accent-fg" : "border-line-strong text-muted hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </span>
  );
}

function AddChannelDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { api, wid } = useWorkspace();
  const qc = useQueryClient();
  const [platform, setPlatform] = React.useState<Platform>("slack");
  const [name, setName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [events, setEvents] = React.useState<Event[]>(["ticket.created", "ticket.escalated"]);
  const [waitForAi, setWaitForAi] = React.useState(true);
  const reset = () => {
    setName("");
    setUrl("");
    setEvents(["ticket.created", "ticket.escalated"]);
    setWaitForAi(true);
  };
  const add = useMutation({
    mutationFn: () =>
      api<{ integration: Integration }>("/integrations/chat-webhooks", {
        method: "POST",
        json: {
          name: name || (platform === "slack" ? "Slack channel" : "Discord channel"),
          platform,
          url: url.trim(),
          events,
          waitForAi,
        },
      }),
    onSuccess: async ({ integration }) => {
      qc.invalidateQueries({ queryKey: qk.integrations(wid) });
      onOpenChange(false);
      reset();
      // Show the user what the channel will receive right away.
      try {
        await api(`/integrations/chat-webhooks/${integration.id}/test`, { method: "POST" });
        toast.success("Connected — a sample of your latest ticket was posted to the channel");
      } catch (e) {
        toast.error((e as Error).message);
      }
      qc.invalidateQueries({ queryKey: qk.integrations(wid) });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const help = HELP[platform];
  const urlLooksRight =
    !url ||
    (platform === "slack"
      ? url.startsWith("https://hooks.slack.com/")
      : /^https:\/\/(\w+\.)?discord(app)?\.com\/api\/webhooks\//.test(url));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Notify a channel"
      description="New tickets are posted with the AI summary, triage, suggested reply and customer context, plus a link to open the ticket in trace."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={add.isPending}
            disabled={!url.trim() || !events.length}
            onClick={() => add.mutate()}
          >
            <BellRing /> Connect
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Segmented
          value={platform}
          onChange={setPlatform}
          options={[
            { value: "slack", label: "Slack" },
            { value: "discord", label: "Discord" },
          ]}
        />
        <p className="text-[12px] leading-relaxed text-muted">
          {help.steps}{" "}
          <a
            href={help.docs}
            target="_blank"
            rel="noreferrer"
            className="text-accent-text underline underline-offset-2"
          >
            Guide
          </a>
        </p>
        <Field
          label="Webhook URL"
          hint={
            urlLooksRight
              ? "Stored encrypted. Anyone with this URL can post to the channel — treat it like a password."
              : `This doesn't look like a ${platform === "slack" ? "Slack" : "Discord"} webhook URL — double-check it.`
          }
        >
          <Input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={help.placeholder}
            className="font-mono text-[12px]"
          />
        </Field>
        <Field label="Name (optional)">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={platform === "slack" ? "#support-alerts" : "#tickets"}
          />
        </Field>
        <Field label="Post when">
          <EventToggles value={events} onChange={setEvents} />
        </Field>
        <label className="flex items-start justify-between gap-4 border border-line px-3 py-2.5">
          <span className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-[13px] text-fg-2">
              <Sparkles className="size-3.5 text-accent-text" /> Wait for AI context
            </span>
            <span className="text-[12px] leading-relaxed text-muted">
              Post once the AI has summarized and drafted a reply (usually seconds; at most 60s), so the message arrives
              complete.
            </span>
          </span>
          <Switch checked={waitForAi} onCheckedChange={setWaitForAi} />
        </label>
      </div>
    </Dialog>
  );
}
