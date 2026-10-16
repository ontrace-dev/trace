import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, CircleCheck, Sparkles, TrendingUp } from "lucide-react";
import * as React from "react";
import { Avatar, Spinner, StatusDot } from "@/components/ui";
import { type Tone, toneDot } from "@/lib/ticket-state";
import { ago, cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { type HomeData, homeKeys, type HotTopic, type NeedItem, type NeedKind } from "./types";

/*
 * Home answers one question: what should I do next? The headline says how much needs a person; below it the
 * work is grouped by what you'd do (decide, answer, take over, send), most urgent first. Every ticket appears
 * once, under its most important reason, with enough context (customer, what they asked, how long they've
 * waited, what the AI already did) to act without opening it first. Volume and trends live in Insights.
 */

const humanize = (s: string) => s.replace(/_/g, " ");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function HomePage() {
  const { api, wid } = useWorkspace();
  const q = useQuery({
    queryKey: homeKeys.home(wid),
    queryFn: () => api<HomeData>("/home"),
    refetchInterval: 30_000,
  });
  if (q.isPending)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  if (q.error || !q.data)
    return <div className="p-10 text-[13px] text-danger">Couldn't load home: {(q.error as Error)?.message}</div>;
  return <HomeLayout data={q.data} />;
}

/* ------------------------------------------------------------------ lanes */

interface Lane {
  id: string;
  kinds: NeedKind[];
  title: (agent: string) => string;
  hint: (agent: string) => string;
  tone: Tone;
  action: (i: NeedItem) => string;
}

/** In order of urgency. A ticket lands in the first lane matching its most important reason. */
const LANES: Lane[] = [
  {
    id: "decide",
    kinds: ["approval"],
    title: () => "Waiting for your decision",
    hint: (a) => `${a} wants to take an action on these and needs a yes or no.`,
    tone: "accent",
    action: () => "Review",
  },
  {
    id: "late",
    kinds: ["sla_breached", "sla_soon"],
    title: () => "Waiting for a first reply",
    hint: () => "Nobody has answered these customers yet, and the first-reply target has passed or is close.",
    tone: "warn",
    action: (i) => (i.draft ? "Review draft" : "Reply"),
  },
  {
    id: "handoff",
    kinds: ["escalated", "ai_error"],
    title: (a) => `Handed off by ${a}`,
    hint: (a) => `${a} wasn't confident enough to answer these on its own, or ran into an error.`,
    tone: "warn",
    action: () => "Take over",
  },
  {
    id: "mine",
    kinds: ["mine_waiting"],
    title: () => "Assigned to you",
    hint: () => "Customers waiting on your reply.",
    tone: "plain",
    action: (i) => (i.draft ? "Review draft" : "Reply"),
  },
  {
    id: "unowned",
    kinds: ["urgent_unassigned"],
    title: () => "High priority, nobody on it",
    hint: () => "Pick one up or assign it to someone.",
    tone: "plain",
    action: () => "Pick up",
  },
  {
    id: "drafts",
    kinds: ["draft_ready"],
    title: () => "Drafts ready to send",
    hint: (a) => `${a} wrote a reply for each of these. Check it, edit if needed, and send.`,
    tone: "accent",
    action: () => "Review draft",
  },
];

function laneOf(i: NeedItem) {
  return LANES.find((l) => l.kinds.includes(i.kinds[0]!)) ?? LANES[LANES.length - 1]!;
}

function HomeLayout({ data }: { data: HomeData }) {
  const lanes = React.useMemo(() => {
    const by = new Map<string, NeedItem[]>();
    for (const i of data.needs.items) {
      const l = laneOf(i);
      by.set(l.id, [...(by.get(l.id) ?? []), i]);
    }
    return LANES.map((l) => ({ lane: l, items: by.get(l.id) ?? [] })).filter((x) => x.items.length);
  }, [data.needs.items]);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-[1320px] min-w-0 flex-col">
        <Headline data={data} lanes={lanes} />
        <Surging topics={data.hot} />
        <div className="grid flex-1 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex min-w-0 flex-col xl:border-r xl:border-line">
            {lanes.length ? (
              lanes.map(({ lane, items }) => <LaneSection key={lane.id} lane={lane} items={items} />)
            ) : (
              <AllClear data={data} />
            )}
            {data.needs.total > data.needs.items.length ? (
              <MoreInInbox n={data.needs.total - data.needs.items.length} />
            ) : null}
          </div>
          <LastDay data={data} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ headline */

function Headline({ data, lanes }: { data: HomeData; lanes: { lane: Lane; items: NeedItem[] }[] }) {
  const { slug, boot } = useWorkspace();
  const navigate = useNavigate();
  const agent = boot.settings.ai.agentName;
  const total = data.needs.total;
  const top = data.needs.items[0];
  const count = (id: string) => lanes.find((l) => l.lane.id === id)?.items.length ?? 0;

  const start = React.useCallback(() => {
    if (top)
      navigate({ to: "/w/$slug/inbox/$view/$ticket", params: { slug, view: "inbox", ticket: String(top.number) } });
  }, [navigate, slug, top]);
  // ↵ anywhere on Home starts triage (unless you're typing or a dialog is open).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const el = document.activeElement;
      if (el && el !== document.body && !(el instanceof HTMLAnchorElement)) return;
      if (document.querySelector("[role=dialog]")) return;
      e.preventDefault();
      start();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [start]);

  // One sentence per lane that has something, most urgent first.
  const parts = [
    count("decide") && `${plural(count("decide"), "action")} waiting for your approval`,
    count("late") && `${plural(count("late"), "customer")} still without a first reply`,
    count("handoff") && `${count("handoff")} handed off by ${agent}`,
    count("mine") && `${count("mine")} assigned to you`,
    count("unowned") && `${count("unowned")} high priority with nobody on it`,
    count("drafts") && `${plural(count("drafts"), "draft")} ready to send`,
  ].filter(Boolean) as string[];

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <section className="flex flex-col gap-5 border-b border-line px-4 pt-8 pb-7 md:flex-row md:items-end md:justify-between md:px-10 md:pt-10">
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-[12.5px] text-muted">
          {greeting} · {new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}
        </span>
        <h1 className="text-[24px] leading-tight font-semibold tracking-[-0.4px] text-fg">
          {total ? `${plural(total, "ticket")} ${total === 1 ? "needs" : "need"} a person` : "You're all caught up"}
        </h1>
        <p className="max-w-[720px] text-[13.5px] leading-relaxed text-body">
          {parts.length
            ? `${parts.slice(0, -1).join(", ")}${parts.length > 1 ? " and " : ""}${parts.at(-1)}.`
            : `Nothing is waiting on your team. ${agent} keeps working new conversations as they come in.`}
        </p>
      </div>
      {top ? (
        <div className="flex shrink-0 flex-col items-start gap-1.5 md:items-end">
          <button
            onClick={start}
            className="flex items-center gap-2.5 bg-fg px-3.5 py-2 text-[13px] font-medium text-[#080808] hover:bg-white"
          >
            Start with the most urgent <span className="font-mono text-[11px] text-[#55555f]">↵</span>
          </button>
          <span className="max-w-[300px] truncate text-[11.5px] text-dim">
            #{top.number} · {top.subject}
          </span>
        </div>
      ) : null}
    </section>
  );
}

/** Home only mentions volume when something is above its usual level; the full picture lives in Insights. */
function Surging({ topics }: { topics: HotTopic[] }) {
  const { slug } = useWorkspace();
  const top = topics[0];
  if (!top) return null;
  const name = top.kind === "tag" ? `#${top.key}` : humanize(top.key);
  return (
    <Link
      to="/w/$slug/insights"
      params={{ slug }}
      className="flex items-center gap-2.5 border-b border-line bg-warn/[0.05] px-4 py-2.5 text-[12.5px] text-body hover:text-fg md:px-10"
    >
      <TrendingUp className="size-3.5 shrink-0 text-warn" />
      <span className="truncate">
        <span className="text-fg-2">{name}</span> is surging: {top.recent} in the last 24h, usually{" "}
        {top.baseline < 1 ? "under 1" : Math.round(top.baseline)} a day
        {topics.length > 1 ? ` · ${topics.length - 1} more topic${topics.length > 2 ? "s" : ""} above usual` : ""}
      </span>
      <span className="ml-auto shrink-0 text-[11.5px] text-dim">Insights →</span>
    </Link>
  );
}

/* ------------------------------------------------------------------ a lane */

const LANE_LIMIT = 5;

function LaneSection({ lane, items }: { lane: Lane; items: NeedItem[] }) {
  const { boot } = useWorkspace();
  const [all, setAll] = React.useState(false);
  const agent = boot.settings.ai.agentName;
  const shown = all ? items : items.slice(0, LANE_LIMIT);
  return (
    <section className="flex flex-col border-b border-line">
      <header className="flex items-start gap-3 px-4 pt-6 pb-3 md:px-10">
        <span className={cn("mt-[7px] size-2 shrink-0", toneDot[lane.tone])} aria-hidden />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-[14px] font-semibold text-fg">
            {lane.title(agent)} <span className="ml-1 font-normal text-dim tabular-nums">{items.length}</span>
          </h2>
          <p className="text-[12.5px] text-muted">{lane.hint(agent)}</p>
        </div>
      </header>
      <ol className="flex flex-col pb-3">
        {shown.map((i) => (
          <NeedRow key={i.ticketId} item={i} lane={lane} />
        ))}
      </ol>
      {items.length > LANE_LIMIT ? (
        <button
          onClick={() => setAll(!all)}
          className="mb-4 self-start px-4 text-[12px] text-muted hover:text-fg md:px-10"
        >
          {all ? "Show fewer" : `Show ${items.length - LANE_LIMIT} more`}
        </button>
      ) : null}
    </section>
  );
}

/** What the AI already did on this ticket, in a few words. */
function aiLine(i: NeedItem, agent: string): { text: string; tone: Tone } | null {
  if (i.approval) return { text: `${agent} wants to: ${i.approval.title}`, tone: "accent" };
  if (i.kinds.includes("ai_error")) return { text: `${agent} failed, open to retry`, tone: "danger" };
  if (i.kinds.includes("escalated")) {
    const why = [i.aiSentiment, i.aiIntent && humanize(i.aiIntent)].filter(Boolean).join(", ");
    return { text: why ? `Handed off · ${why}` : "Handed off", tone: "warn" };
  }
  if (i.draft) return { text: `Draft ready · ${Math.round(i.draft.confidence * 100)}% confident`, tone: "accent" };
  return null;
}

function waitLine(i: NeedItem): { text: string; tone: Tone } {
  const waited = ago(i.waitingSince);
  const due = i.firstResponseDueAt ? new Date(i.firstResponseDueAt).getTime() : null;
  if (i.kinds.includes("sla_breached") && due) return { text: `Waiting ${waited} · overdue`, tone: "warn" };
  if (i.kinds.includes("sla_soon") && due) {
    const m = Math.max(1, Math.round((due - Date.now()) / 60_000));
    return { text: `Reply due in ${m < 60 ? `${m}m` : `${Math.round(m / 60)}h`}`, tone: "warn" };
  }
  return { text: waited === "now" ? "Just arrived" : `Waiting ${waited}`, tone: "plain" };
}

function NeedRow({ item: i, lane }: { item: NeedItem; lane: Lane }) {
  const { slug, boot } = useWorkspace();
  const agent = boot.settings.ai.agentName;
  const name = i.customerName ?? i.customerEmail ?? "Unknown visitor";
  const wait = waitLine(i);
  const ai = aiLine(i, agent);
  const about = i.preview || i.aiSummary;
  const high = i.priority === "high" || i.priority === "urgent";
  return (
    <li>
      <Link
        to="/w/$slug/inbox/$view/$ticket"
        params={{ slug, view: "inbox", ticket: String(i.number) }}
        className="group mx-2 flex items-start gap-3.5 px-2 py-3 hover:bg-white/[0.03] md:mx-8"
      >
        <Avatar name={name} size={32} tone="neutral" className="mt-0.5" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13.5px] font-medium text-fg">{i.subject}</span>
            {high ? (
              <span
                className={cn(
                  "shrink-0 text-[11px] font-semibold tracking-wide uppercase",
                  i.priority === "urgent" ? "text-danger" : "text-warn",
                )}
              >
                {i.priority}
              </span>
            ) : null}
          </div>
          <span className="truncate text-[12px] text-muted">
            {name}
            {i.customerCompany ? ` · ${i.customerCompany}` : ""} · #{i.number} via {i.channel}
            {i.assigneeName ? ` · ${i.assigneeName}` : ""}
          </span>
          {about ? <p className="line-clamp-1 text-[12.5px] leading-relaxed text-faint">“{about}”</p> : null}
          <div className="flex flex-wrap gap-x-3 gap-y-1 pt-0.5 sm:hidden">
            <StatusDot tone={wait.tone}>{wait.text}</StatusDot>
            {ai ? <StatusDot tone={ai.tone}>{ai.text}</StatusDot> : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5 pt-0.5 max-sm:hidden">
          <StatusDot tone={wait.tone}>{wait.text}</StatusDot>
          {ai ? (
            <StatusDot tone={ai.tone} className="max-w-[260px] truncate">
              {ai.text}
            </StatusDot>
          ) : null}
        </div>
        <span className="flex w-[118px] shrink-0 items-center justify-end gap-1.5 self-center text-[12px] font-medium text-muted group-hover:text-fg max-md:hidden">
          {lane.action(i)} <ArrowRight className="size-3.5" />
        </span>
      </Link>
    </li>
  );
}

function MoreInInbox({ n }: { n: number }) {
  const { slug } = useWorkspace();
  return (
    <Link
      to="/w/$slug/inbox/$view"
      params={{ slug, view: "inbox" }}
      className="px-4 py-4 text-[12.5px] text-muted hover:text-fg md:px-10"
    >
      {plural(n, "more ticket")} {n === 1 ? "needs" : "need"} you · open the inbox →
    </Link>
  );
}

function AllClear({ data }: { data: HomeData }) {
  const { boot } = useWorkspace();
  const t = data.pulse.tickets;
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-12 md:px-10">
      <CircleCheck className="size-5 text-ok" />
      <p className="max-w-[520px] text-[13.5px] leading-relaxed text-body">
        No approvals, late replies or hand-offs.{" "}
        {t.resolvedByAi24h
          ? `${boot.settings.ai.agentName} resolved ${plural(t.resolvedByAi24h, "ticket")} on its own in the last 24 hours.`
          : "New conversations show up here the moment they need a person."}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ last 24 hours */

function compactDuration(seconds: number) {
  const m = Math.round(seconds / 60);
  if (m < 1) return `${Math.round(seconds)}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? (m % 60 ? `${h}h ${m % 60}m` : `${h}h`) : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function LastDay({ data }: { data: HomeData }) {
  const { slug, boot } = useWorkspace();
  const t = data.pulse.tickets;
  const ai = data.pulse.ai;
  const agent = boot.settings.ai.agentName;
  const delta = t.new24h - t.newPrev24h;
  const rows: { label: string; value: React.ReactNode; note?: string }[] = [
    {
      label: "New tickets",
      value: t.new24h,
      note: delta ? `${delta > 0 ? "+" : ""}${delta} vs the day before` : "same as the day before",
    },
    {
      label: "Resolved",
      value: t.resolved24h,
      note: t.resolvedByAi24h ? `${t.resolvedByAi24h} by ${agent}` : undefined,
    },
    {
      label: "First reply, median",
      value:
        data.pulse.medianFirstResponseSeconds != null ? compactDuration(data.pulse.medianFirstResponseSeconds) : "–",
    },
    { label: `Replies sent by ${agent}`, value: ai.autoReplies },
    { label: "Waiting on customers", value: t.pending },
  ];
  return (
    <aside className="flex flex-col border-t border-line xl:border-t-0">
      <div className="flex items-center justify-between px-4 pt-6 pb-2 md:px-10 xl:px-6">
        <h2 className="text-[13px] font-semibold text-fg-2">Last 24 hours</h2>
        <Link to="/w/$slug/insights" params={{ slug }} className="text-[12px] text-muted hover:text-fg">
          Insights →
        </Link>
      </div>
      <dl className="grid grid-cols-2 px-4 pb-6 sm:grid-cols-3 md:px-10 xl:grid-cols-1 xl:px-6">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-col gap-0.5 border-b border-line-2 py-3 last:border-b-0">
            <dt className="text-[12px] text-muted">{r.label}</dt>
            <dd className="flex items-baseline gap-2">
              <span className="text-[18px] font-medium text-fg tabular-nums">{r.value}</span>
              {r.note ? <span className="text-[11.5px] text-dim">{r.note}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      {ai.worked ? (
        <p className="mx-4 mb-6 flex gap-2 border border-accent/20 bg-accent/[0.05] p-3 text-[12px] leading-relaxed text-body md:mx-10 xl:mx-6">
          <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent-text" />
          <span>
            {agent} worked {plural(ai.worked, "ticket")}
            {ai.drafted ? `, drafted ${plural(ai.drafted, "reply", "replies")}` : ""}
            {ai.avgConfidence != null ? ` at ${Math.round(ai.avgConfidence * 100)}% confidence on average` : ""}.
          </span>
        </p>
      ) : null}
    </aside>
  );
}
