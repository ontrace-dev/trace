import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Hand, PenLine, TrendingUp, UserRoundCheck } from "lucide-react";
import * as React from "react";
import { Spinner } from "@/components/ui";
import { useJustArrived } from "@/lib/arrivals";
import type { TicketListItem } from "@/lib/types";
import { ago, cn } from "@/lib/utils";
import { qk, useWorkspace } from "@/lib/workspace";
import { LastDay } from "./pulse";
import { type HomeData, homeKeys, type HotTopic, type NeedItem, type NeedKind } from "./types";

/*
 * Home: what's new, then what needs a person, as dense rows you can act on. Each ticket appears once,
 * under its most important reason. The last-24h numbers sit on the side; trends live in Insights.
 */

const humanize = (s: string) => s.replace(/_/g, " ");

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

/** In order of urgency; a ticket is listed under the first section matching its top reason. */
const SECTIONS: { id: string; label: string; kinds: NeedKind[] }[] = [
  { id: "decide", label: "Approve or reject", kinds: ["approval"] },
  { id: "late", label: "First reply overdue", kinds: ["sla_breached", "sla_soon"] },
  { id: "handoff", label: "Handed off", kinds: ["escalated", "ai_error"] },
  { id: "mine", label: "Assigned to you", kinds: ["mine_waiting"] },
  { id: "unowned", label: "High priority, unassigned", kinds: ["urgent_unassigned"] },
  { id: "drafts", label: "Drafts to send", kinds: ["draft_ready"] },
];

function HomeLayout({ data }: { data: HomeData }) {
  const { slug } = useWorkspace();
  // Unread tickets are listed under New (with their signals), so every ticket appears exactly once.
  const needs = React.useMemo(() => new Map(data.needs.items.map((i) => [i.ticketId, i])), [data.needs.items]);
  const sections = React.useMemo(() => {
    const fresh = new Set(data.fresh.map((t) => t.id));
    const by = new Map<string, NeedItem[]>();
    for (const i of data.needs.items) {
      if (fresh.has(i.ticketId)) continue;
      const s = SECTIONS.find((x) => x.kinds.includes(i.kinds[0]!)) ?? SECTIONS.at(-1)!;
      by.set(s.id, [...(by.get(s.id) ?? []), i]);
    }
    return SECTIONS.map((s) => ({ ...s, items: by.get(s.id) ?? [] })).filter((s) => s.items.length);
  }, [data.needs.items, data.fresh]);
  return (
    <div className="h-full overflow-y-auto">
      <div className="flex min-h-full min-w-0 flex-col">
        <Header data={data} sections={sections} />
        <Surging topics={data.hot} />
        <div className="grid flex-1 xl:grid-cols-[minmax(0,1fr)_288px]">
          <div className="flex min-w-0 flex-col xl:border-r xl:border-line">
            <Fresh items={data.fresh} needs={needs} />
            {sections.map((s) => (
              <Section key={s.id} label={s.label} items={s.items} />
            ))}
            {!sections.length && !data.fresh.length ? (
              <p className="px-4 py-12 font-mono text-[12px] text-dim md:px-10">
                Nothing needs a person right now. New tickets show up here the moment they do.
              </p>
            ) : null}
            {data.needs.total > data.needs.items.length ? (
              <Link
                to="/w/$slug/inbox/$view"
                params={{ slug, view: "inbox" }}
                className="px-4 py-4 font-mono text-[11.5px] text-dim hover:text-fg md:px-10"
              >
                +{data.needs.total - data.needs.items.length} more in the inbox →
              </Link>
            ) : null}
          </div>
          <aside className="border-t border-line xl:border-t-0">
            <LastDay data={data} />
          </aside>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ header */

function Header({ data, sections }: { data: HomeData; sections: { id: string; label: string; items: NeedItem[] }[] }) {
  const { slug } = useWorkspace();
  const navigate = useNavigate();
  const top = data.fresh[0]?.number ?? data.needs.items[0]?.number;
  const start = React.useCallback(() => {
    if (top) navigate({ to: "/w/$slug/inbox/$view/$ticket", params: { slug, view: "inbox", ticket: String(top) } });
  }, [navigate, slug, top]);
  // ↵ anywhere on Home opens the first ticket (unless you're typing or a dialog is open).
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
  const fresh = data.fresh.length;
  const total = data.needs.total;
  return (
    <section className="flex flex-wrap items-end justify-between gap-4 border-b border-line px-4 pt-7 pb-5 md:px-10">
      <div className="flex min-w-0 flex-col gap-2">
        <h1 className="text-[17px] font-semibold tracking-[-0.2px] text-fg">
          {fresh ? (
            <>
              <span className="text-accent-text">{fresh} unread</span>
              <span className="text-dim"> · </span>
            </>
          ) : null}
          {total ? `${total} need${total === 1 ? "s" : ""} you` : fresh ? "nothing else waiting" : "All clear"}
        </h1>
        {sections.length ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11.5px] text-dim">
            {sections.map((s) => (
              <a key={s.id} href={`#${s.id}`} className="hover:text-fg">
                {s.label.toLowerCase()} <span className="text-fg-2">{s.items.length}</span>
              </a>
            ))}
          </div>
        ) : null}
      </div>
      {top ? (
        <button
          onClick={start}
          className="flex items-center gap-2.5 bg-fg px-3 py-1.5 text-[12.5px] font-medium text-[#080808] hover:bg-white"
        >
          Start triage <span className="font-mono text-[11px] text-[#55555f]">↵</span>
        </button>
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
      className="flex items-center gap-2.5 border-b border-line bg-warn/[0.05] px-4 py-2 text-[12.5px] text-body hover:text-fg md:px-10"
    >
      <TrendingUp className="size-3.5 shrink-0 text-warn" />
      <span className="truncate">
        <span className="text-fg-2">{name}</span> is surging: {top.recent} in the last 24h, usually{" "}
        {top.baseline < 1 ? "under 1" : Math.round(top.baseline)} a day
      </span>
      <span className="ml-auto shrink-0 font-mono text-[11px] text-dim">insights →</span>
    </Link>
  );
}

/* ------------------------------------------------------------------ rows */

function SectionHead({ id, label, n, right }: { id?: string; label: string; n: number; right?: React.ReactNode }) {
  return (
    <div id={id} className="flex h-10 scroll-mt-2 items-center justify-between gap-4 px-4 md:px-10">
      <h2 className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-2 uppercase">
        {label} <span className="ml-1 text-dim">{n}</span>
      </h2>
      {right}
    </div>
  );
}

/** One line per ticket: marker · customer · subject — latest message · signal · time. */
function Row({
  to,
  ticketId,
  unread,
  customer,
  subject,
  preview,
  signal,
  time,
  timeTone,
}: {
  to: number;
  ticketId: string;
  unread: boolean;
  customer: string;
  subject: string;
  preview: string | null;
  signal?: React.ReactNode;
  time: string;
  timeTone?: "warn" | "accent";
}) {
  const { slug } = useWorkspace();
  const fresh = useJustArrived(ticketId);
  return (
    <li>
      <Link
        to="/w/$slug/inbox/$view/$ticket"
        params={{ slug, view: "inbox", ticket: String(to) }}
        className={cn(
          "flex h-10 items-center gap-3 border-t border-line-2 pr-4 pl-2 hover:bg-white/[0.03] md:pr-10 md:pl-8",
          fresh && "arrive",
        )}
      >
        <span className="flex w-2.5 shrink-0 justify-center">
          {unread ? <span className="size-1.5 bg-accent" aria-label="Unread" /> : null}
        </span>
        <span
          className={cn(
            "w-[150px] shrink-0 truncate text-[13px] max-sm:w-[104px]",
            unread ? "font-semibold text-fg" : "text-body",
          )}
        >
          {customer}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px]">
          <span className={unread ? "font-medium text-fg-2" : "text-fg-3"}>{subject}</span>
          {preview && !preview.startsWith(subject.replace(/…$/, "")) ? (
            <span className="text-faint max-md:hidden"> — {preview}</span>
          ) : null}
        </span>
        {signal ? <span className="flex shrink-0 items-center gap-1.5 max-sm:hidden">{signal}</span> : null}
        <span
          className={cn(
            "w-[64px] shrink-0 text-right font-mono text-[11px] tabular-nums",
            timeTone === "warn" ? "text-warn" : timeTone === "accent" ? "text-accent-text" : "text-dim",
          )}
        >
          {fresh ? "new" : time}
        </span>
      </Link>
    </li>
  );
}

/** Customer messages you haven't seen yet, newest first: the first thing you see when you come back. */
function Fresh({ items, needs }: { items: TicketListItem[]; needs: Map<string, NeedItem> }) {
  const { boot } = useWorkspace();
  const { api, wid } = useWorkspace();
  const qc = useQueryClient();
  const readAll = useMutation({
    mutationFn: () => api("/unread/read-all", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["home", wid] });
      qc.invalidateQueries({ queryKey: qk.unread(wid) });
      qc.invalidateQueries({ queryKey: qk.counts(wid) });
      qc.invalidateQueries({ queryKey: ["tickets", wid] });
    },
  });
  if (!items.length) return null;
  return (
    <section className="border-b border-line bg-accent/[0.03] pb-1">
      <SectionHead
        label="Unread"
        n={items.length}
        right={
          <button
            onClick={() => readAll.mutate()}
            disabled={readAll.isPending}
            className="font-mono text-[11px] text-dim hover:text-fg"
          >
            mark all read
          </button>
        }
      />
      <ol>
        {items.map((t) => {
          const need = needs.get(t.id);
          const due = need ? dueOf(need) : null;
          return (
            <Row
              key={t.id}
              to={t.number}
              ticketId={t.id}
              unread
              customer={t.customer?.name ?? t.customer?.email ?? "Unknown visitor"}
              subject={t.subject}
              preview={t.preview}
              signal={need ? <Signal item={need} agent={boot.settings.ai.agentName} /> : undefined}
              time={due?.time ?? ago(t.lastCustomerMessageAt ?? t.lastMessageAt)}
              timeTone={due ? "warn" : "accent"}
            />
          );
        })}
      </ol>
    </section>
  );
}

const LIMIT = 6;

/** The first-reply deadline, when it's passed or close: "8d late", "due 25m". */
function dueOf(i: NeedItem) {
  if (i.kinds.includes("sla_breached")) return { time: `${ago(i.firstResponseDueAt)} late` };
  if (i.kinds.includes("sla_soon") && i.firstResponseDueAt) return { time: `due ${until(i.firstResponseDueAt)}` };
  return null;
}

/** "25m" until a moment in the future. */
function until(iso: string) {
  const m = Math.max(1, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

function Section({ label, items }: { label: string; items: NeedItem[] }) {
  const { boot } = useWorkspace();
  const [all, setAll] = React.useState(false);
  const agent = boot.settings.ai.agentName;
  const id = SECTIONS.find((s) => s.label === label)?.id;
  const shown = all ? items : items.slice(0, LIMIT);
  return (
    <section className="border-b border-line pb-1">
      <SectionHead id={id} label={label} n={items.length} />
      <ol>
        {shown.map((i) => {
          const due = dueOf(i);
          return (
            <Row
              key={i.ticketId}
              to={i.number}
              ticketId={i.ticketId}
              unread={i.unread}
              customer={i.customerName ?? i.customerEmail ?? "Unknown visitor"}
              subject={i.subject}
              preview={i.preview}
              signal={<Signal item={i} agent={agent} />}
              time={due?.time ?? ago(i.waitingSince)}
              timeTone={due ? "warn" : undefined}
            />
          );
        })}
      </ol>
      {items.length > LIMIT ? (
        <button
          onClick={() => setAll(!all)}
          className="px-4 py-2 font-mono text-[11px] text-dim hover:text-fg md:pl-[54px]"
        >
          {all ? "show fewer" : `+${items.length - LIMIT} more`}
        </button>
      ) : null}
    </section>
  );
}

/** What the AI did, as one icon and a few mono characters. */
function Signal({ item: i, agent }: { item: NeedItem; agent: string }) {
  const high = i.priority === "high" || i.priority === "urgent";
  const prio = high ? (
    <span
      className={cn(
        "font-mono text-[10.5px] font-semibold tracking-[0.08em] uppercase",
        i.priority === "urgent" ? "text-danger" : "text-warn",
      )}
    >
      {i.priority}
    </span>
  ) : null;
  let ai: React.ReactNode = null;
  if (i.approval)
    ai = (
      <span className="flex items-center gap-1 font-mono text-[11px] text-warn" title={i.approval.title}>
        <Hand className="size-3" /> approve
      </span>
    );
  else if (i.kinds.includes("ai_error"))
    ai = (
      <span className="flex items-center gap-1 font-mono text-[11px] text-danger">
        <AlertTriangle className="size-3" /> failed
      </span>
    );
  else if (i.kinds.includes("escalated"))
    ai = (
      <span className="flex items-center gap-1 font-mono text-[11px] text-warn" title={`Handed off by ${agent}`}>
        <UserRoundCheck className="size-3" /> handed off
      </span>
    );
  else if (i.draft)
    ai = (
      <span
        className="flex items-center gap-1 font-mono text-[11px] text-accent-text"
        title={`${agent} drafted a reply`}
      >
        <PenLine className="size-3" /> {Math.round(i.draft.confidence * 100)}%
      </span>
    );
  return (
    <>
      {prio}
      {ai}
    </>
  );
}
