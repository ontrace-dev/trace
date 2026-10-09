import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AtSign,
  Check,
  ExternalLink,
  Hash,
  Link2,
  MessageSquareText,
  MessagesSquare,
  Plus,
  RefreshCw,
  Search,
  Send,
  Trash2,
  Unplug,
  UserPlus,
  X,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { DiscordIcon } from "@/components/brand-icons";
import { Badge, Button, Dialog, Field, Input, Select, Spinner, Switch } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

type NotifyOn = "ticket.created" | "ticket.escalated" | "draft.ready" | "message.customer";

interface ChannelRef {
  id: string;
  name: string;
  type?: "text" | "forum";
}

interface UserLink {
  discordUserId: string;
  discordName: string;
  userId: string;
}

interface DiscordConnection {
  id: string;
  name: string;
  enabled: boolean;
  status: "connected" | "error" | "pending";
  statusMessage: string | null;
  gateway: "connected" | "connecting" | "off";
  inviteUrl: string;
  createdAt: string;
  config: {
    applicationId: string;
    botUserId?: string;
    botName?: string;
    guildId?: string;
    guildName?: string;
    notifyChannel?: ChannelRef;
    intakeChannels: ChannelRef[];
    notifyOn: NotifyOn[];
    threadSync: boolean;
    waitForAi?: boolean;
    userLinks: UserLink[];
  };
}

interface DiscordChannel extends ChannelRef {
  type: "text" | "forum";
  category: string | null;
}

const NOTIFY_OPTIONS: { value: NotifyOn; label: string; hint: string }[] = [
  { value: "ticket.created", label: "New tickets", hint: "Every new conversation, from any channel" },
  { value: "ticket.escalated", label: "AI escalations", hint: "When the agent hands a ticket to a human" },
  { value: "draft.ready", label: "Drafts awaiting review", hint: "When the AI has a reply ready to approve" },
  { value: "message.customer", label: "Customer replies", hint: "Post tickets on the customer's next reply" },
];

const discordKey = (wid: string) => ["integrations", wid, "discord"] as const;

export function DiscordSettings() {
  const { wid, api, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const [adding, setAdding] = React.useState(false);
  const state = useQuery({
    queryKey: discordKey(wid),
    queryFn: () => api<{ integrations: DiscordConnection[] }>("/integrations/discord"),
    refetchInterval: (q) =>
      q.state.data?.integrations.some((i) => i.status === "pending" || i.gateway === "connecting") ? 2000 : false,
  });

  // Self-service linking: `/trace link` in Discord sends teammates here with a signed token.
  const linked = React.useRef(false);
  React.useEffect(() => {
    const token = new URLSearchParams(location.search).get("link");
    if (!token || linked.current) return;
    linked.current = true;
    history.replaceState(null, "", location.pathname);
    api<{ discordName: string }>("/integrations/discord/link", { method: "POST", json: { token } })
      .then((r) => {
        toast.success(`Linked Discord account ${r.discordName} to you`);
        qc.invalidateQueries({ queryKey: ["integrations", wid] });
      })
      .catch((e: Error) => toast.error(e.message));
  }, [api, qc, wid]);

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
        Could not load Discord settings: {(state.error as Error)?.message}
      </div>
    );
  }
  const list = state.data.integrations;
  const showSetup = adding || list.length === 0;

  return (
    <div className="flex max-w-[924px] flex-col gap-8 px-8 py-7">
      <div className="flex items-start justify-between gap-6">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center border border-line-strong bg-white/[0.03] text-fg">
            <DiscordIcon className="size-[18px]" />
          </span>
          <div className="flex flex-col gap-1">
            <h2 className="text-[15px] font-semibold tracking-tight text-fg">Discord</h2>
            <p className="max-w-[560px] text-[12.5px] leading-relaxed text-muted">
              Run support where your community already is: ticket cards with the AI's draft, two-way thread sync,
              support channels and forums that open tickets, and <span className="font-mono text-fg-3">/trace</span>.
              Connects over the gateway — no public URL needed.
            </p>
          </div>
        </div>
        {list.length > 0 && !adding && isAdmin ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add bot
          </Button>
        ) : null}
      </div>

      <HowItWorks />

      {list.map((i) => (
        <ConnectionCard key={i.id} integration={i} />
      ))}

      {showSetup ? (
        isAdmin ? (
          <Setup onDone={() => setAdding(false)} onCancel={list.length ? () => setAdding(false) : undefined} />
        ) : (
          <div className="border border-line px-4 py-6 text-sm text-muted">
            Ask a workspace admin to connect Discord.
          </div>
        )
      ) : null}
    </div>
  );
}

function HowItWorks() {
  const rows: { icon: React.ReactNode; title: string; body: React.ReactNode }[] = [
    {
      icon: <MessageSquareText />,
      title: "Ticket threads",
      body: "Each ticket card gets a thread; replies there become internal notes. Use Reply… to answer the customer.",
    },
    {
      icon: <MessagesSquare />,
      title: "Support channels & forums",
      body: "New messages (or forum posts) open tickets; the thread syncs both ways with the customer.",
    },
    {
      icon: <span className="font-mono text-[11px] leading-none">/</span>,
      title: "/trace",
      body: (
        <>
          <span className="font-mono text-fg-3">ask</span>, <span className="font-mono text-fg-3">search</span>,{" "}
          <span className="font-mono text-fg-3">new</span>, <span className="font-mono text-fg-3">stats</span>,{" "}
          <span className="font-mono text-fg-3">link</span> — plus @mention the bot to ask the AI.
        </>
      ),
    },
    {
      icon: <AtSign />,
      title: "Linked teammates",
      body: "Discord has no emails, so teammates link their account (/trace link) to act as themselves.",
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

function Setup({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const { wid, api } = useWorkspace();
  const qc = useQueryClient();
  const [token, setToken] = React.useState("");
  const connect = useMutation({
    mutationFn: () =>
      api<{ integration: DiscordConnection }>("/integrations/discord/connect", {
        method: "POST",
        json: { botToken: token.trim() },
      }),
    onSuccess: (r) => {
      toast.success(`Connected ${r.integration.config.botName ?? "Discord bot"}`);
      setToken("");
      qc.invalidateQueries({ queryKey: ["integrations", wid] });
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="label-mono">Connect a Discord bot</span>
        {onCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
      <div className="border border-line bg-cell">
        <Step n={1} title="Create a bot in the Discord Developer Portal">
          <ol className="flex list-decimal flex-col gap-1 pl-4 text-xs leading-relaxed text-dim">
            <li>
              <span className="text-fg-3">New Application</span> → name it (e.g. “Support”).
            </li>
            <li>
              <span className="text-fg-3">Bot → Reset Token</span> and copy the token.
            </li>
            <li>
              Under <span className="text-fg-3">Privileged Gateway Intents</span>, turn on{" "}
              <span className="text-fg-3">Message Content Intent</span> — trace needs it to read customer messages in
              support channels and replies in ticket threads. Optionally enable{" "}
              <span className="text-fg-3">Server Members Intent</span> to search members when linking teammates.
            </li>
          </ol>
          <a
            href="https://discord.com/developers/applications"
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 w-fit items-center gap-1.5 text-xs text-accent-text hover:underline"
          >
            Open the Discord Developer Portal <ExternalLink className="size-3" />
          </a>
        </Step>
        <Step n={2} title="Paste the bot token">
          <form
            className="flex flex-col gap-3 md:flex-row md:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (token.trim()) connect.mutate();
            }}
          >
            <Field label="Bot token" className="flex-1">
              <Input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="MTI3…"
                autoComplete="off"
                spellCheck={false}
                type="password"
                className="font-mono text-[12px]"
              />
            </Field>
            <Button variant="primary" disabled={!token.trim()} loading={connect.isPending}>
              <DiscordIcon className="size-[13px]" /> Connect Discord
            </Button>
          </form>
          <p className="text-[11.5px] text-dim">Stored encrypted. trace connects to the Discord gateway right away.</p>
        </Step>
        <Step n={3} title="Invite the bot and pick channels">
          <p className="text-xs leading-relaxed text-dim">
            After connecting you'll get an invite link with the right permissions, then choose the server, where ticket
            cards go, and which channels or forums open tickets.
          </p>
        </Step>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ connection */

function StatusChip({ i }: { i: DiscordConnection }) {
  if (!i.enabled) return <Badge upper>paused</Badge>;
  if (i.status === "error")
    return (
      <Badge tone="danger" upper>
        error
      </Badge>
    );
  if (i.status === "pending" || i.gateway === "connecting")
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

function ConnectionCard({ integration: i }: { integration: DiscordConnection }) {
  const { wid, api, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const [notifyChannel, setNotifyChannel] = React.useState<ChannelRef | undefined>(i.config.notifyChannel);
  const [intake, setIntake] = React.useState<ChannelRef[]>(i.config.intakeChannels ?? []);
  const [notifyOn, setNotifyOn] = React.useState<NotifyOn[]>(i.config.notifyOn ?? []);
  const [threadSync, setThreadSync] = React.useState(i.config.threadSync);
  const [waitForAi, setWaitForAi] = React.useState(i.config.waitForAi ?? true);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

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

  const guilds = useQuery({
    queryKey: [...discordKey(wid), i.id, "guilds"],
    queryFn: () => api<{ guilds: { id: string; name: string }[] }>(`/integrations/discord/${i.id}/guilds`),
    enabled: i.enabled,
    retry: false,
  });
  const channels = useQuery({
    queryKey: [...discordKey(wid), i.id, "channels", i.config.guildId],
    queryFn: () => api<{ channels: DiscordChannel[] }>(`/integrations/discord/${i.id}/channels`),
    enabled: i.enabled && !!i.config.guildId,
    staleTime: 60_000,
    retry: false,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["integrations", wid] });
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api(`/integrations/discord/${i.id}`, { method: "PATCH", json: patch }),
    onSuccess: () => {
      toast.success("Discord settings saved");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const test = useMutation({
    mutationFn: () => api(`/integrations/discord/${i.id}/test`, { method: "POST" }),
    onSuccess: () => toast.success(`Test message sent to #${i.config.notifyChannel?.name}`),
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api(`/integrations/discord/${i.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Discord disconnected");
      setConfirmDelete(false);
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const chans = channels.data?.channels ?? [];
  const textChannels = chans.filter((c) => c.type === "text");
  const guildList = guilds.data?.guilds ?? [];

  return (
    <section className="border border-line bg-cell">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <DiscordIcon className="size-4 shrink-0 text-fg-3" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] font-medium text-fg">{i.config.botName ?? i.name}</span>
            <span className="font-mono text-[11.5px] text-dim">
              {i.config.guildName ? `server ${i.config.guildName}` : "no server selected"} · app{" "}
              {i.config.applicationId}
            </span>
          </div>
          <StatusChip i={i} />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted">
          Enabled
          <Switch
            checked={i.enabled}
            disabled={!isAdmin || save.isPending}
            onCheckedChange={(v) => save.mutate({ enabled: v })}
          />
        </label>
      </header>

      {i.statusMessage ? (
        <div
          className={cn("border-b border-line px-5 py-2.5 text-xs", i.status === "error" ? "text-danger" : "text-dim")}
        >
          {i.statusMessage}
        </div>
      ) : null}

      {/* Server */}
      <div className="flex flex-col gap-3 border-b border-line p-5">
        <span className="label-mono">Server</span>
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <Field
            label="Discord server"
            className="flex-1"
            hint={guilds.error ? (guilds.error as Error).message : undefined}
          >
            <Select
              value={i.config.guildId ?? ""}
              disabled={!isAdmin || guilds.isPending}
              onChange={(e) => {
                const g = guildList.find((x) => x.id === e.target.value);
                save.mutate({ guildId: g?.id ?? null, guildName: g?.name ?? null });
              }}
            >
              <option value="">{guildList.length ? "— choose a server —" : "Invite the bot to a server first"}</option>
              {i.config.guildId && !guildList.some((g) => g.id === i.config.guildId) ? (
                <option value={i.config.guildId}>{i.config.guildName ?? i.config.guildId}</option>
              ) : null}
              {guildList.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex gap-2">
            <a
              href={i.inviteUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 border border-line-strong bg-white/[0.04] px-3 text-[12.5px] font-medium text-fg hover:bg-white/[0.08]"
            >
              <UserPlus className="size-[13px]" /> Invite bot
            </a>
            <Button size="md" variant="ghost" onClick={() => guilds.refetch()} loading={guilds.isFetching}>
              <RefreshCw /> Refresh
            </Button>
          </div>
        </div>
        <p className="text-[11.5px] leading-relaxed text-dim">
          The invite asks for: view channels, send messages (also in threads), create threads, embed links, read
          history, add reactions and slash commands.
        </p>
      </div>

      {i.config.guildId ? (
        <div className="grid grid-cols-1 md:grid-cols-2">
          <div className="flex flex-col gap-5 border-b border-line p-5 md:border-r">
            <span className="label-mono">Notifications</span>
            <Field label="Post ticket cards to">
              <Select
                value={notifyChannel?.id ?? ""}
                disabled={!isAdmin || channels.isPending}
                onChange={(e) => {
                  const ch = textChannels.find((c) => c.id === e.target.value);
                  setNotifyChannel(ch ? { id: ch.id, name: ch.name, type: "text" } : undefined);
                }}
              >
                <option value="">— don't post notifications —</option>
                {notifyChannel && !textChannels.some((c) => c.id === notifyChannel.id) ? (
                  <option value={notifyChannel.id}>#{notifyChannel.name}</option>
                ) : null}
                {textChannels.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                    {c.category ? ` · ${c.category}` : ""}
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
                  Open a thread on each card, mirror replies and notes into it, and keep the card up to date.
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

          <div className="flex min-w-0 flex-col gap-3 border-b border-line p-5">
            <span className="label-mono">Support channels & forums</span>
            <p className="text-[11.5px] leading-relaxed text-dim">
              New messages here — or new posts in a forum — become tickets. The conversation continues in a thread.
            </p>
            <ChannelMultiSelect
              channels={chans}
              loading={channels.isPending && channels.fetchStatus !== "idle"}
              error={
                channels.error
                  ? (channels.error as Error).message
                  : i.enabled
                    ? undefined
                    : "enable the connection to load channels."
              }
              value={intake}
              onChange={setIntake}
              disabled={!isAdmin}
              exclude={notifyChannel?.id}
            />
          </div>
        </div>
      ) : null}

      <TeamLinks integration={i} />

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
        title="Disconnect Discord?"
        description={`trace will stop posting to and listening in ${i.config.guildName ?? "Discord"}. Existing tickets keep their history.`}
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

/* ------------------------------------------------------------------ teammate links */

function TeamLinks({ integration: i }: { integration: DiscordConnection }) {
  const { wid, api, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const [q, setQ] = React.useState("");
  const [deb, setDeb] = React.useState("");
  const [pick, setPick] = React.useState<{ id: string; name: string } | null>(null);
  const [userId, setUserId] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDeb(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const team = useQuery({
    queryKey: [...discordKey(wid), i.id, "team"],
    queryFn: () => api<{ team: { id: string; name: string; email: string }[] }>(`/integrations/discord/${i.id}/team`),
  });
  const isId = /^\d{5,25}$/.test(deb);
  const search = useQuery({
    queryKey: [...discordKey(wid), i.id, "members", deb],
    queryFn: () =>
      api<{ members: { id: string; name: string; username: string }[]; error?: string }>(
        `/integrations/discord/${i.id}/members?q=${encodeURIComponent(deb)}`,
      ),
    enabled: isAdmin && !!deb && !isId && !!i.config.guildId,
    retry: false,
  });
  const save = useMutation({
    mutationFn: (userLinks: UserLink[]) =>
      api(`/integrations/discord/${i.id}`, { method: "PATCH", json: { userLinks } }),
    onSuccess: () => {
      setPick(null);
      setQ("");
      setUserId("");
      qc.invalidateQueries({ queryKey: ["integrations", wid] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const links = i.config.userLinks ?? [];
  const nameOf = (uid: string) => team.data?.team.find((t) => t.id === uid)?.name ?? "unknown user";
  const candidate = pick ?? (isId ? { id: deb, name: deb } : null);

  return (
    <div className="flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="label-mono">Linked teammates</span>
        <span className="flex items-center gap-1.5 text-[11.5px] text-dim">
          <Link2 className="size-3" /> or run <span className="font-mono text-fg-3">/trace link</span> in Discord
        </span>
      </div>
      <p className="text-[11.5px] leading-relaxed text-dim">
        Linked teammates can send drafts, reply, assign and resolve from Discord, and their thread replies count as
        agent replies. Everyone else is treated as a customer.
      </p>
      {links.length ? (
        <div className="flex flex-col border border-line">
          {links.map((l) => (
            <div
              key={l.discordUserId}
              className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
            >
              <AtSign className="size-3.5 text-dim" />
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-3">
                {l.discordName} <span className="text-dim">→</span> {nameOf(l.userId)}
              </span>
              {isAdmin ? (
                <button
                  type="button"
                  className="text-dim hover:text-fg"
                  aria-label={`Unlink ${l.discordName}`}
                  onClick={() => save.mutate(links.filter((x) => x.discordUserId !== l.discordUserId))}
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <span className="text-[11.5px] text-dim">Nobody linked yet.</span>
      )}

      {isAdmin && i.config.guildId ? (
        <div className="flex flex-col gap-2 border border-line bg-bg p-3">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_auto]">
            <div className="relative">
              <div className="flex h-8 items-center gap-2 border border-line-strong bg-input px-2.5">
                <Search className="size-3 text-dim" />
                <input
                  value={pick ? pick.name : q}
                  onChange={(e) => {
                    setPick(null);
                    setQ(e.target.value);
                  }}
                  placeholder="Discord member name or user id"
                  className="flex-1 bg-transparent text-[12.5px] text-fg placeholder:text-dim focus:outline-none"
                />
              </div>
              {!pick && deb && !isId && search.data?.members.length ? (
                <div className="absolute top-9 right-0 left-0 z-10 border border-line-strong bg-bar py-1 shadow-xl shadow-black/50">
                  {search.data.members.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setPick({ id: m.id, name: m.name })}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-fg-3 hover:bg-white/[0.06]"
                    >
                      {m.name} <span className="font-mono text-[11px] text-dim">@{m.username}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">— trace user —</option>
              {(team.data?.team ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <Button
              size="md"
              disabled={!candidate || !userId}
              loading={save.isPending}
              onClick={() =>
                candidate &&
                save.mutate([
                  ...links.filter((l) => l.discordUserId !== candidate.id),
                  { discordUserId: candidate.id, discordName: candidate.name, userId },
                ])
              }
            >
              <Link2 /> Link
            </Button>
          </div>
          {search.data?.error ? <span className="text-[11.5px] text-warn">{search.data.error}</span> : null}
        </div>
      ) : null}
    </div>
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
  channels: DiscordChannel[];
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
    onChange(
      selected.has(c.id) ? value.filter((v) => v.id !== c.id) : [...value, { id: c.id, name: c.name, type: c.type }],
    );

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
              {v.type === "forum" ? "▤ " : "#"}
              {v.name} <span className="text-dim">×</span>
            </button>
          ))}
        </div>
      ) : (
        <span className="text-[11.5px] text-dim">No support channels — Discord is notifications-only.</span>
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
                {c.type === "forum" ? (
                  <MessagesSquare className="size-3 text-dim" />
                ) : (
                  <Hash className="size-3 text-dim" />
                )}
                <span className="flex-1 truncate text-fg-3">{c.name}</span>
                {c.category ? <span className="font-mono text-[11px] text-dim">{c.category}</span> : null}
              </label>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
