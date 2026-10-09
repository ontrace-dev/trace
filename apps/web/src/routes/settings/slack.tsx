import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AtSign,
  Check,
  Copy,
  ExternalLink,
  Hash,
  Lock,
  MessageSquareText,
  Plus,
  Search,
  Send,
  Trash2,
  Unplug,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { SlackIcon } from "@/components/brand-icons";
import { Badge, Button, Dialog, Field, Input, Select, Segmented, Spinner, Switch } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

type NotifyOn = "ticket.created" | "ticket.escalated" | "draft.ready" | "message.customer";

interface ChannelRef {
  id: string;
  name: string;
}

interface SlackConnection {
  id: string;
  name: string;
  enabled: boolean;
  status: "connected" | "error" | "pending";
  statusMessage: string | null;
  mode: "socket" | "http";
  socket: "connected" | "connecting" | "off";
  createdAt: string;
  config: {
    teamId?: string;
    teamName?: string;
    botUserId?: string;
    botToken: string;
    appToken?: string;
    signingSecret?: string;
    notifyChannel?: ChannelRef;
    intakeChannels: ChannelRef[];
    notifyOn: NotifyOn[];
    threadSync: boolean;
    waitForAi?: boolean;
  };
}

interface SlackState {
  integrations: SlackConnection[];
  oauthAvailable: boolean;
  httpSigningConfigured: boolean;
  requestUrls: { events: string; interactions: string; commands: string; oauthCallback: string };
}

interface SlackChannel extends ChannelRef {
  isPrivate: boolean;
  isMember: boolean;
}

const NOTIFY_OPTIONS: { value: NotifyOn; label: string; hint: string }[] = [
  { value: "ticket.created", label: "New tickets", hint: "Every new conversation, from any channel" },
  { value: "ticket.escalated", label: "AI escalations", hint: "When the agent hands a ticket to a human" },
  { value: "draft.ready", label: "Drafts awaiting review", hint: "When the AI has a reply ready to approve" },
  { value: "message.customer", label: "Customer replies", hint: "Post tickets on the customer's next reply" },
];

const slackKey = (wid: string) => ["integrations", wid, "slack"] as const;

/** Slack integration settings (owned by the Slack workstream). */
export function SlackSettings() {
  const { wid, api, isAdmin } = useWorkspace();
  const [adding, setAdding] = React.useState(false);
  const state = useQuery({
    queryKey: slackKey(wid),
    queryFn: () => api<SlackState>("/integrations/slack"),
    refetchInterval: (q) => (q.state.data?.integrations.some((i) => i.status === "pending") ? 2000 : false),
  });

  // Result of the "Add to Slack" OAuth round-trip.
  React.useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("slack") === "connected") toast.success("Slack connected");
    const err = params.get("slack_error");
    if (err) toast.error(`Slack: ${err}`);
    if (params.has("slack") || params.has("slack_error")) {
      history.replaceState(null, "", location.pathname);
    }
  }, []);

  if (state.isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (state.error || !state.data) {
    return (
      <div className="px-8 py-10 text-sm text-danger">
        Could not load Slack settings: {(state.error as Error)?.message}
      </div>
    );
  }
  const data = state.data;
  const showSetup = adding || data.integrations.length === 0;

  return (
    <div className="flex max-w-[924px] flex-col gap-8 px-8 py-7">
      <div className="flex items-start justify-between gap-6">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center border border-line-strong bg-white/[0.03] text-fg">
            <SlackIcon className="size-[18px]" />
          </span>
          <div className="flex flex-col gap-1">
            <h2 className="text-[15px] font-semibold tracking-tight text-fg">Slack</h2>
            <p className="max-w-[560px] text-[12.5px] leading-relaxed text-muted">
              Work the queue without leaving Slack: ticket notifications with the AI's draft, two-way thread sync,
              customer intake from shared channels, and <span className="font-mono text-fg-3">/trace</span>.
            </p>
          </div>
        </div>
        {data.integrations.length > 0 && !adding && isAdmin ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add workspace
          </Button>
        ) : null}
      </div>

      <HowItWorks />

      {data.integrations.map((i) => (
        <ConnectionCard key={i.id} integration={i} />
      ))}

      {showSetup ? (
        isAdmin ? (
          <Setup
            state={data}
            onDone={() => setAdding(false)}
            onCancel={data.integrations.length ? () => setAdding(false) : undefined}
          />
        ) : (
          <div className="border border-line px-4 py-6 text-sm text-muted">Ask a workspace admin to connect Slack.</div>
        )
      ) : null}
    </div>
  );
}

function HowItWorks() {
  const rows: { icon: React.ReactNode; title: string; body: React.ReactNode }[] = [
    {
      icon: <MessageSquareText />,
      title: "Thread replies",
      body: "Replies in a ticket's notification thread become internal notes. Use Reply… to answer the customer.",
    },
    {
      icon: <Hash />,
      title: "Intake channels",
      body: "Top-level messages open tickets; the thread syncs both ways — teammates reply, customers see it in Slack.",
    },
    {
      icon: <span className="font-mono text-[11px] leading-none">/</span>,
      title: "/trace",
      body: (
        <>
          <span className="font-mono text-fg-3">ask</span>, <span className="font-mono text-fg-3">search</span>,{" "}
          <span className="font-mono text-fg-3">new</span>, <span className="font-mono text-fg-3">stats</span> — from
          any channel.
        </>
      ),
    },
    {
      icon: <AtSign />,
      title: "@mention",
      body: "Mention the bot to ask the AI about a ticket, customer or the knowledge base.",
    },
  ];
  return (
    <div className="grid grid-cols-1 border border-line sm:grid-cols-2">
      {rows.map((r, n) => (
        <div
          key={r.title}
          className={cn("flex gap-3 p-4", n % 2 === 0 && "sm:border-r sm:border-line", n < 2 && "border-b border-line")}
        >
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-accent-text [&_svg]:size-[13px]">
            {r.icon}
          </span>
          <div className="flex flex-col gap-1">
            <span className="text-[12.5px] font-medium text-fg-2">{r.title}</span>
            <span className="text-xs leading-relaxed text-dim">{r.body}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ setup */

function Step({ n, title, children, done }: { n: number; title: string; children: React.ReactNode; done?: boolean }) {
  return (
    <div className="flex gap-4 border-b border-line px-5 py-5 last:border-b-0">
      <span
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center border font-mono text-[11px]",
          done ? "border-accent/50 text-accent-text" : "border-line-strong text-muted",
        )}
      >
        {done ? <Check className="size-3" /> : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <span className="text-[13px] font-medium text-fg">{title}</span>
        {children}
      </div>
    </div>
  );
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Button
      size="sm"
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check /> : <Copy />} {copied ? "Copied" : label}
    </Button>
  );
}

function Setup({ state, onDone, onCancel }: { state: SlackState; onDone: () => void; onCancel?: () => void }) {
  const { wid, api } = useWorkspace();
  const qc = useQueryClient();
  const [mode, setMode] = React.useState<"socket" | "http">("socket");
  const [showManifest, setShowManifest] = React.useState(false);
  const [botToken, setBotToken] = React.useState("");
  const [appToken, setAppToken] = React.useState("");
  const [signingSecret, setSigningSecret] = React.useState("");

  const manifest = useQuery({
    queryKey: [...slackKey(wid), "manifest", mode],
    queryFn: () => api<Record<string, unknown>>(`/integrations/slack/manifest?mode=${mode}`),
  });
  const manifestText = manifest.data ? JSON.stringify(manifest.data, null, 2) : "";

  const connect = useMutation({
    mutationFn: () =>
      api<{ integration: SlackConnection }>("/integrations/slack/connect", {
        method: "POST",
        json: {
          botToken: botToken.trim(),
          appToken: mode === "socket" ? appToken.trim() : "",
          signingSecret: signingSecret.trim() || undefined,
        },
      }),
    onSuccess: (r) => {
      toast.success(`Connected to ${r.integration.config.teamName ?? "Slack"}`);
      setBotToken("");
      setAppToken("");
      setSigningSecret("");
      qc.invalidateQueries({ queryKey: ["integrations", wid] });
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const canConnect = botToken.startsWith("xoxb-") && (mode === "http" || appToken.startsWith("xapp-"));

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="label-mono">Connect a Slack workspace</span>
        {onCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>

      {state.oauthAvailable ? (
        <div className="flex items-center justify-between gap-4 border border-line bg-cell px-5 py-4">
          <div className="flex flex-col gap-1">
            <span className="text-[13px] font-medium text-fg">One-click install</span>
            <span className="text-xs text-dim">
              Uses this server's Slack app (SLACK_CLIENT_ID) and the HTTP Events API.
            </span>
          </div>
          <Button
            variant="primary"
            onClick={() => (window.location.href = `/api/integrations/slack/install?workspaceId=${wid}`)}
          >
            <SlackIcon className="size-[13px]" /> Add to Slack
          </Button>
        </div>
      ) : null}

      <div className="border border-line bg-cell">
        <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-3">
          <span className="text-xs text-muted">
            {state.oauthAvailable
              ? "Or bring your own Slack app"
              : "Bring your own Slack app — takes about two minutes"}
          </span>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: "socket", label: "Socket Mode · local-first" },
              { value: "http", label: "HTTP events" },
            ]}
          />
        </div>

        <Step n={1} title="Create the app from our manifest">
          <p className="text-xs leading-relaxed text-dim">
            On api.slack.com choose <span className="text-fg-3">Create New App → From a manifest</span>, pick your Slack
            workspace and paste the manifest. Then <span className="text-fg-3">Install to Workspace</span>.
            {mode === "socket" ? (
              <> Socket Mode needs no public URL — perfect for running trace locally.</>
            ) : (
              <> Slack will call this server at its PUBLIC_URL, so it must be reachable from the internet.</>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton text={manifestText} label="Copy manifest" />
            <Button size="sm" variant="ghost" type="button" onClick={() => setShowManifest((v) => !v)}>
              {showManifest ? "Hide" : "Show"} JSON
            </Button>
            <a
              href="https://api.slack.com/apps?new_app=1"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-7 items-center gap-1.5 px-2.5 text-xs text-accent-text hover:underline"
            >
              Open api.slack.com/apps <ExternalLink className="size-3" />
            </a>
          </div>
          {showManifest ? (
            <pre className="max-h-72 overflow-auto border border-line bg-bg p-3 font-mono text-[11px] leading-relaxed text-fg-3">
              {manifest.isPending ? "Loading…" : manifestText}
            </pre>
          ) : null}
          {mode === "http" ? (
            <div className="flex flex-col gap-1.5 border border-line bg-bg p-3 font-mono text-[11px] text-muted">
              <UrlRow label="events" value={state.requestUrls.events} />
              <UrlRow label="interactivity" value={state.requestUrls.interactions} />
              <UrlRow label="/trace" value={state.requestUrls.commands} />
            </div>
          ) : null}
        </Step>

        <Step
          n={2}
          title={
            mode === "socket" ? "Paste the bot token and an app-level token" : "Paste the bot token and signing secret"
          }
        >
          <p className="text-xs leading-relaxed text-dim">
            Bot token: <span className="text-fg-3">OAuth &amp; Permissions → Bot User OAuth Token</span>.{" "}
            {mode === "socket" ? (
              <>
                App-level token: <span className="text-fg-3">Basic Information → App-Level Tokens → Generate</span> with
                the <span className="font-mono text-fg-3">connections:write</span> scope.
              </>
            ) : (
              <>
                Signing secret: <span className="text-fg-3">Basic Information → App Credentials</span>
                {state.httpSigningConfigured ? " (optional — SLACK_SIGNING_SECRET is set on the server)." : "."}
              </>
            )}
          </p>
          <form
            className="grid grid-cols-1 gap-3 md:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (canConnect) connect.mutate();
            }}
          >
            <Field label="Bot token">
              <Input
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="xoxb-…"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-[12px]"
              />
            </Field>
            {mode === "socket" ? (
              <Field label="App-level token">
                <Input
                  value={appToken}
                  onChange={(e) => setAppToken(e.target.value)}
                  placeholder="xapp-…"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-[12px]"
                />
              </Field>
            ) : (
              <Field label="Signing secret">
                <Input
                  value={signingSecret}
                  onChange={(e) => setSigningSecret(e.target.value)}
                  placeholder="8f3a…"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-[12px]"
                />
              </Field>
            )}
            <div className="md:col-span-2">
              <Button variant="primary" disabled={!canConnect} loading={connect.isPending}>
                <SlackIcon className="size-[13px]" /> Connect Slack
              </Button>
            </div>
          </form>
        </Step>

        <Step n={3} title="Pick channels">
          <p className="text-xs leading-relaxed text-dim">
            Once connected, choose where ticket notifications go and which channels (e.g. Slack Connect channels with
            customers) open tickets.
          </p>
        </Step>
      </div>
    </section>
  );
}

function UrlRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-dim">{label}</span>
      <span className="min-w-0 flex-1 truncate text-fg-3">{value}</span>
      <button
        type="button"
        className="text-dim hover:text-fg"
        onClick={() => navigator.clipboard.writeText(value).then(() => toast.success("Copied"))}
      >
        <Copy className="size-3" />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ connection */

function StatusChip({ i }: { i: SlackConnection }) {
  if (!i.enabled) return <Badge upper>paused</Badge>;
  if (i.status === "error")
    return (
      <Badge tone="danger" upper>
        error
      </Badge>
    );
  if (i.status === "pending" || (i.mode === "socket" && i.socket === "connecting"))
    return (
      <Badge tone="warn" upper>
        connecting
      </Badge>
    );
  return (
    <Badge tone="ok" upper>
      <span className="h-1.5 w-1.5 bg-ok" /> connected
    </Badge>
  );
}

function ConnectionCard({ integration: i }: { integration: SlackConnection }) {
  const { wid, api, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const [notifyChannel, setNotifyChannel] = React.useState<ChannelRef | undefined>(i.config.notifyChannel);
  const [intake, setIntake] = React.useState<ChannelRef[]>(i.config.intakeChannels ?? []);
  const [notifyOn, setNotifyOn] = React.useState<NotifyOn[]>(i.config.notifyOn ?? []);
  const [threadSync, setThreadSync] = React.useState(i.config.threadSync);
  const [waitForAi, setWaitForAi] = React.useState(i.config.waitForAi ?? true);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  // Re-sync local form state when the server copy changes (another admin, OAuth reconnect…).
  const serverKey = JSON.stringify([
    i.config.notifyChannel,
    i.config.intakeChannels,
    i.config.notifyOn,
    i.config.threadSync,
    i.config.waitForAi,
  ]);
  React.useEffect(() => {
    setNotifyChannel(i.config.notifyChannel);
    setIntake(i.config.intakeChannels ?? []);
    setNotifyOn(i.config.notifyOn ?? []);
    setThreadSync(i.config.threadSync);
    setWaitForAi(i.config.waitForAi ?? true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  const dirty =
    JSON.stringify([notifyChannel ?? null, intake, [...notifyOn].sort(), threadSync, waitForAi]) !==
    JSON.stringify([
      i.config.notifyChannel ?? null,
      i.config.intakeChannels ?? [],
      [...(i.config.notifyOn ?? [])].sort(),
      i.config.threadSync,
      i.config.waitForAi ?? true,
    ]);

  const channels = useQuery({
    queryKey: [...slackKey(wid), i.id, "channels"],
    queryFn: () => api<{ channels: SlackChannel[] }>(`/integrations/slack/${i.id}/channels`),
    enabled: i.enabled && i.status !== "pending",
    staleTime: 60_000,
    retry: false,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["integrations", wid] });

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api<{ warnings: string[] }>(`/integrations/slack/${i.id}`, { method: "PATCH", json: patch }),
    onSuccess: (r) => {
      r.warnings?.forEach((w) => toast.warning(w));
      toast.success("Slack settings saved");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const test = useMutation({
    mutationFn: () => api(`/integrations/slack/${i.id}/test`, { method: "POST" }),
    onSuccess: () => toast.success(`Test message sent to #${i.config.notifyChannel?.name}`),
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api(`/integrations/slack/${i.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Slack disconnected");
      setConfirmDelete(false);
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const list = channels.data?.channels ?? [];

  return (
    <section className="border border-line bg-cell">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <SlackIcon className="size-4 shrink-0 text-fg-3" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] font-medium text-fg">{i.config.teamName ?? i.name}</span>
            <span className="font-mono text-[11.5px] text-dim">
              {i.config.teamId} · {i.mode === "socket" ? "socket mode" : "http events"} · bot {i.config.botToken}
            </span>
          </div>
          <StatusChip i={i} />
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted">
            Enabled
            <Switch
              checked={i.enabled}
              disabled={!isAdmin || save.isPending}
              onCheckedChange={(v) => save.mutate({ enabled: v })}
            />
          </label>
        </div>
      </header>

      {i.statusMessage ? (
        <div
          className={cn("border-b border-line px-5 py-2.5 text-xs", i.status === "error" ? "text-danger" : "text-dim")}
        >
          {i.statusMessage}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-0 md:grid-cols-2">
        <div className="flex flex-col gap-5 border-b border-line p-5 md:border-r md:border-b-0">
          <span className="label-mono">Notifications</span>
          <Field
            label="Post tickets to"
            hint="Public channels work without inviting the bot; for private ones, /invite it first."
          >
            <Select
              value={notifyChannel?.id ?? ""}
              disabled={!isAdmin || channels.isPending}
              onChange={(e) => {
                const ch = list.find((c) => c.id === e.target.value);
                setNotifyChannel(ch ? { id: ch.id, name: ch.name } : undefined);
              }}
            >
              <option value="">— don't post notifications —</option>
              {notifyChannel && !list.some((c) => c.id === notifyChannel.id) ? (
                <option value={notifyChannel.id}>#{notifyChannel.name}</option>
              ) : null}
              {list.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.isPrivate ? "🔒 " : "#"}
                  {c.name}
                  {c.isPrivate && !c.isMember ? " (invite bot)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-fg-2">Notify on</span>
            {NOTIFY_OPTIONS.map((o) => {
              const on = notifyOn.includes(o.value);
              return (
                <label key={o.value} className="flex cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-[var(--color-accent)]"
                    checked={on}
                    disabled={!isAdmin}
                    onChange={() => setNotifyOn((cur) => (on ? cur.filter((x) => x !== o.value) : [...cur, o.value]))}
                  />
                  <span className="flex flex-col">
                    <span className="text-[12.5px] text-fg-3">{o.label}</span>
                    <span className="text-[11px] text-dim">{o.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
          <label className="flex items-start justify-between gap-4">
            <span className="flex flex-col gap-0.5">
              <span className="text-[12.5px] text-fg-3">Thread sync</span>
              <span className="text-[11px] leading-relaxed text-dim">
                Mirror replies and notes into the ticket's thread and keep the card up to date.
              </span>
            </span>
            <Switch checked={threadSync} disabled={!isAdmin} onCheckedChange={setThreadSync} />
          </label>
          <label className="flex items-start justify-between gap-4">
            <span className="flex flex-col gap-0.5">
              <span className="text-[12.5px] text-fg-3">Wait for AI context</span>
              <span className="text-[11px] leading-relaxed text-dim">
                Post new-ticket cards once the AI has summarized and drafted a reply (at most 60s), so they arrive
                complete.
              </span>
            </span>
            <Switch checked={waitForAi} disabled={!isAdmin} onCheckedChange={setWaitForAi} />
          </label>
        </div>

        <div className="flex min-w-0 flex-col gap-3 p-5">
          <span className="label-mono">Intake channels</span>
          <p className="text-[11.5px] leading-relaxed text-dim">
            New messages here become tickets — ideal for Slack Connect channels shared with customers. The bot joins
            public channels automatically.
          </p>
          <ChannelMultiSelect
            channels={list}
            loading={channels.isPending && channels.fetchStatus !== "idle"}
            error={channels.error ? (channels.error as Error).message : undefined}
            value={intake}
            onChange={setIntake}
            disabled={!isAdmin}
            exclude={notifyChannel?.id}
          />
        </div>
      </div>

      {isAdmin ? (
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3">
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={!dirty}
              loading={save.isPending}
              onClick={() =>
                save.mutate({
                  notifyChannel: notifyChannel ?? null,
                  intakeChannels: intake,
                  notifyOn,
                  threadSync,
                  waitForAi,
                })
              }
            >
              Save changes
            </Button>
            <Button
              size="sm"
              disabled={!i.config.notifyChannel || dirty}
              loading={test.isPending}
              onClick={() => test.mutate()}
            >
              <Send /> Send test message
            </Button>
          </div>
          <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
            <Unplug /> Disconnect
          </Button>
        </footer>
      ) : null}

      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Disconnect Slack?"
        description={`trace will stop posting to and listening in ${i.config.teamName ?? "this Slack workspace"}. Existing tickets keep their history.`}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              <Trash2 /> Disconnect
            </Button>
          </>
        }
      />
    </section>
  );
}

function ChannelMultiSelect({
  channels,
  value,
  onChange,
  loading,
  error,
  disabled,
  exclude,
}: {
  channels: SlackChannel[];
  value: ChannelRef[];
  onChange: (v: ChannelRef[]) => void;
  loading?: boolean;
  error?: string;
  disabled?: boolean;
  exclude?: string;
}) {
  const [q, setQ] = React.useState("");
  const selected = new Set(value.map((v) => v.id));
  const filtered = channels.filter(
    (c) => c.id !== exclude && c.name.includes(q.trim().toLowerCase().replace(/^#/, "")),
  );
  const toggle = (c: ChannelRef) =>
    onChange(selected.has(c.id) ? value.filter((v) => v.id !== c.id) : [...value, { id: c.id, name: c.name }]);

  return (
    <div className="flex flex-col gap-2">
      {value.length ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v) => (
            <button
              key={v.id}
              type="button"
              disabled={disabled}
              onClick={() => toggle(v)}
              className="inline-flex items-center gap-1 border border-accent/35 px-1.5 py-0.5 font-mono text-[11.5px] text-accent-fg hover:border-accent/70"
            >
              #{v.name} <span className="text-dim">×</span>
            </button>
          ))}
        </div>
      ) : (
        <span className="text-[11.5px] text-dim">No intake channels — Slack is notifications-only.</span>
      )}
      <div className="border border-line-strong bg-input">
        <div className="flex items-center gap-2 border-b border-line px-2.5">
          <Search className="size-3 text-dim" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter channels"
            className="h-8 flex-1 bg-transparent text-[12.5px] text-fg placeholder:text-dim focus:outline-none"
          />
        </div>
        <div className="max-h-48 overflow-y-auto py-1">
          {loading ? (
            <div className="flex justify-center py-4">
              <Spinner />
            </div>
          ) : error ? (
            <div className="px-3 py-3 text-xs text-danger">Couldn't list channels: {error}</div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-3 text-xs text-dim">No channels found.</div>
          ) : (
            filtered.map((c) => (
              <label
                key={c.id}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-[12.5px] hover:bg-white/[0.04]",
                  disabled && "pointer-events-none opacity-60",
                )}
              >
                <input
                  type="checkbox"
                  className="accent-[var(--color-accent)]"
                  checked={selected.has(c.id)}
                  onChange={() => toggle(c)}
                />
                {c.isPrivate ? <Lock className="size-3 text-dim" /> : <Hash className="size-3 text-dim" />}
                <span className="flex-1 truncate text-fg-3">{c.name}</span>
                {c.isPrivate && !c.isMember ? (
                  <span className="font-mono text-[11px] text-warn">invite bot</span>
                ) : null}
              </label>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
