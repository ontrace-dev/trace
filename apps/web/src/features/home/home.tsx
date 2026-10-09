import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { TrendingUp } from "lucide-react";
import * as React from "react";
import { Spinner } from "@/components/ui";
import { ago, cn, since } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { type HomeData, homeKeys, type HotTopic, type NeedItem, type NeedKind } from "./types";

/*
 * Home — designed in pen.dev ("trace — Home (app)"). One dominant region, the triage waterfall: every ticket
 * that needs a human, drawn as a span over the last 24h (grey: customer waiting, orange from the moment the
 * first-reply target passed, purple square: when trace worked it). Color is semantic only — orange is time/SLA,
 * purple is the AI.
 */

const TRACK = 280;
const WINDOW_H = 24;
const xFor = (iso: string | null | undefined) => {
  if (!iso) return null;
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  return Math.round(TRACK * (1 - Math.min(Math.max(h, 0), WINDOW_H) / WINDOW_H));
};

const humanize = (s: string) => s.replace(/_/g, " ");
/** "just now" / "12m ago" */

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
  const d = q.data;
  return <HomeLayout data={d} />;
}

function HomeLayout({ data: d }: { data: HomeData }) {
  const [filter, setFilter] = React.useState<Filter>("all");
  return (
    <div className="h-full overflow-y-auto">
      <div className="flex min-h-full min-w-0 flex-col">
        <Brief data={d} onFilter={setFilter} />
        <Surging topics={d.hot} />
        <Triage data={d} filter={filter} onFilter={setFilter} />
      </div>
    </div>
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
      <span className="ml-auto shrink-0 font-mono text-[11px] text-dim">insights →</span>
    </Link>
  );
}

/* ------------------------------------------------------------------ brief */

function Brief({ data, onFilter }: { data: HomeData; onFilter: (f: Filter) => void }) {
  const { slug, boot } = useWorkspace();
  const navigate = useNavigate();
  const { total, counts } = data.needs;
  const figures: { value: number; label: string; filter: Filter; tone?: string }[] = [
    { value: total, label: "need you", filter: "all" },
    { value: counts.sla_breached, label: "past first reply", filter: "sla", tone: "text-warn" },
    { value: counts.approval, label: "awaiting approval", filter: "approvals", tone: "text-accent-text" },
    { value: counts.draft_ready, label: "drafts to review", filter: "drafts" },
  ];
  const top = data.needs.items[0];
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
  const now = new Date();
  const dateline = [
    now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }).replace(",", ""),
    now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    boot.org.slug,
  ].join(" · ");
  return (
    <section className="flex flex-col gap-[22px] border-b border-line px-4 pt-8 pb-[34px] md:px-10 md:pt-10">
      <span className="font-mono text-[11px] tracking-[0.1em] text-dim uppercase">{dateline}</span>
      <div className="flex flex-wrap items-end justify-between gap-x-12 gap-y-6">
        <h1 className="sr-only">Home</h1>
        <div className="flex flex-wrap items-end gap-x-12 gap-y-5">
          {figures.map((f) => (
            <button
              key={f.label}
              onClick={() => {
                onFilter(f.filter);
                document.getElementById("needs-you")?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className="group flex flex-col items-start gap-2 text-left"
            >
              <span
                className={cn(
                  "text-[34px] leading-none font-medium tracking-[-1px] tabular-nums",
                  f.value ? (f.tone ?? "text-fg") : "text-dim",
                )}
              >
                {f.value}
              </span>
              <span className="font-mono text-[11px] text-dim group-hover:text-fg-2">{f.label}</span>
            </button>
          ))}
        </div>
        {top ? (
          <div className="flex flex-col items-end gap-2">
            <button
              onClick={start}
              className="flex items-center gap-2.5 bg-fg px-3 py-2 text-[12.5px] font-medium text-[#080808] hover:bg-white"
            >
              Start triage <span className="font-mono text-[11px] text-[#55555f]">↵</span>
            </button>
            <span className="font-mono text-[11px] text-dim">opens #{top.number}</span>
          </div>
        ) : (
          <span className="font-mono text-[11px] text-dim">nothing waiting on a human</span>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ triage waterfall */

type Tone = "late" | "ai" | "plain" | "danger";
const TONE: Record<Tone, string> = {
  late: "text-warn",
  ai: "text-accent-text",
  plain: "text-fg-2",
  danger: "text-danger",
};

function draftDetail(i: NeedItem) {
  if (!i.draft) return i.kinds.includes("draft_ready") ? "draft ready" : "no draft yet";
  const pct = Math.round(i.draft.confidence * 100);
  return `draft · ${pct}%`;
}

function why(i: NeedItem): { reason: string; tone: Tone; detail: string } {
  const k = i.kinds[0]!;
  switch (k) {
    case "approval": {
      const title = i.approval?.title ?? "an action";
      return {
        reason: `approve ${title.charAt(0).toLowerCase()}${title.slice(1)}`,
        tone: "ai",
        detail: i.approval ? `trace asked ${since(i.approval.requestedAt)}` : "waiting for a decision",
      };
    }
    case "sla_breached":
      return {
        reason:
          ago(i.firstResponseDueAt) === "now"
            ? "first reply just slipped"
            : `first reply ${ago(i.firstResponseDueAt)} late`,
        tone: "late",
        detail: draftDetail(i),
      };
    case "sla_soon": {
      const m = Math.max(1, Math.round((new Date(i.firstResponseDueAt!).getTime() - Date.now()) / 60_000));
      return { reason: `first reply due in ${m}m`, tone: "late", detail: draftDetail(i) };
    }
    case "escalated":
      return {
        reason: "handed off by trace",
        tone: "ai",
        detail: [i.aiSentiment, i.aiIntent && humanize(i.aiIntent)].filter(Boolean).join(" · ") || "needs a human",
      };
    case "ai_error":
      return { reason: "trace failed on this", tone: "danger", detail: "open it to retry" };
    case "mine_waiting":
      return { reason: "waiting on you", tone: "plain", detail: draftDetail(i) };
    case "urgent_unassigned":
      return { reason: `${i.priority}, nobody on it`, tone: "plain", detail: draftDetail(i) };
    default: {
      const pct = i.draft ? Math.round(i.draft.confidence * 100) : null;
      const cites = i.draft?.sources ? ` · cites ${i.draft.sources}` : "";
      return { reason: "draft ready", tone: "plain", detail: pct != null ? `${pct}%${cites}` : "review and send" };
    }
  }
}

type Filter = "all" | "sla" | "approvals" | "handed off" | "drafts" | "mine";
const FILTER_KINDS: Record<Exclude<Filter, "all">, NeedKind[]> = {
  sla: ["sla_breached", "sla_soon"],
  approvals: ["approval"],
  "handed off": ["escalated", "ai_error"],
  drafts: ["draft_ready"],
  mine: ["mine_waiting"],
};

function Triage({
  data,
  filter,
  onFilter: setFilter,
}: {
  data: HomeData;
  filter: Filter;
  onFilter: (f: Filter) => void;
}) {
  const [all, setAll] = React.useState(false);
  const { items, total } = data.needs;
  const match = (f: Filter) =>
    f === "all" ? items : items.filter((i) => i.kinds.some((k) => FILTER_KINDS[f].includes(k)));
  const shown = match(filter);
  const visible = all ? shown : shown.slice(0, 7);
  const filters: Filter[] = ["all", "sla", "approvals", "handed off", "drafts", "mine"];
  return (
    <section id="needs-you" className="flex scroll-mt-4 flex-col">
      <div className="flex h-[50px] items-stretch gap-5 overflow-x-auto border-b border-line px-4 md:gap-8 md:pr-8 md:pl-10">
        <h2 className="flex shrink-0 items-center font-mono text-[11px] font-medium tracking-[0.14em] whitespace-nowrap text-fg-2">
          NEEDS YOU
        </h2>
        <div className="flex items-stretch gap-5" role="tablist">
          {filters.map((f) => {
            const n = f === "all" ? total : match(f).length;
            const on = filter === f;
            return (
              <button
                key={f}
                role="tab"
                aria-selected={on}
                disabled={!n && f !== "all"}
                onClick={() => {
                  setFilter(f);
                  setAll(false);
                }}
                className={cn(
                  "-mb-px flex items-center gap-1.5 border-b font-mono text-[11px] whitespace-nowrap",
                  on ? "border-fg text-fg" : "border-transparent text-dim enabled:hover:text-fg-2 disabled:opacity-60",
                )}
              >
                {f}
                <span className={on ? "text-fg-2" : undefined}>{n}</span>
              </button>
            );
          })}
        </div>
      </div>
      {!shown.length ? (
        <p className="border-b border-line px-4 py-12 text-[13px] leading-relaxed text-body md:px-10">
          Nothing here. Tickets show up the moment they're late, handed off or waiting on a decision.
        </p>
      ) : (
        <>
          <div className="flex h-8 items-center gap-8 border-b border-line-2 pr-8 pl-10 max-md:hidden">
            <span className="flex-1 text-right font-mono text-[11px] text-dim">customer waiting since</span>
            <span className="relative h-full shrink-0" style={{ width: TRACK }} aria-hidden>
              {[24, 18, 12, 6, 0].map((h) => (
                <span
                  key={h}
                  className="absolute top-1/2 font-mono text-[11px] text-dim"
                  style={{
                    left: TRACK * (1 - h / WINDOW_H),
                    transform: `translate(${h === 24 ? "0" : h === 0 ? "-100%" : "-50%"}, -50%)`,
                  }}
                >
                  {h ? `${h}h` : "now"}
                </span>
              ))}
            </span>
            <span className="w-[196px] shrink-0" />
          </div>
          <ol>
            {visible.map((item, i) => (
              <TriageRow key={item.ticketId} item={item} first={i === 0 && filter === "all"} />
            ))}
          </ol>
        </>
      )}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-4 py-4 md:pr-8 md:pl-10">
        {shown.length > 7 ? (
          <button onClick={() => setAll(!all)} className="font-mono text-[11px] text-dim hover:text-fg">
            {all ? "show fewer" : `+${shown.length - 7} more · show all ${shown.length}`}
          </button>
        ) : (
          <span />
        )}
        <span className="flex items-center gap-4 font-mono text-[11px] text-dim">
          <span className="flex items-center gap-1.5">
            <span className="h-1 w-3.5 bg-white/[0.22]" /> waiting
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-1 w-3.5 bg-warn" /> past first-reply target
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 bg-accent" /> trace worked it
          </span>
        </span>
      </div>
    </section>
  );
}

function TriageRow({ item, first }: { item: NeedItem; first: boolean }) {
  const { slug } = useWorkspace();
  const w = why(item);
  const start = xFor(item.waitingSince) ?? 0;
  const dueIso =
    item.firstResponseDueAt && new Date(item.firstResponseDueAt).getTime() < Date.now()
      ? item.firstResponseDueAt
      : null;
  const late = item.kinds.includes("sla_breached") ? xFor(dueIso) : null;
  const ai = xFor(item.aiAt);
  const who = [
    item.customerName ?? item.customerEmail ?? "unknown visitor",
    item.channel,
    item.priority === "high" || item.priority === "urgent" ? item.priority : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li>
      <Link
        to="/w/$slug/inbox/$view/$ticket"
        params={{ slug, view: "inbox", ticket: String(item.number) }}
        className={cn(
          "flex h-[68px] items-center gap-4 border-b border-line-2 px-4 hover:bg-white/[0.03] md:gap-8 md:pr-8 md:pl-10",
          first && "bg-white/[0.025]",
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-[11px] text-dim">#{item.number}</span>
            <span className="truncate text-[13px] text-fg">{item.subject}</span>
          </div>
          <span className="truncate font-mono text-[11px] text-dim">{who}</span>
        </div>
        <span className="relative h-full shrink-0 max-md:hidden" style={{ width: TRACK }} aria-hidden>
          {[18, 12, 6].map((h) => (
            <span
              key={h}
              className="absolute inset-y-0 w-px bg-white/[0.04]"
              style={{ left: TRACK * (1 - h / WINDOW_H) }}
            />
          ))}
          <span className="absolute top-1/2 h-1 -translate-y-1/2 bg-white/[0.22]" style={{ left: start, right: 0 }} />
          {late != null ? (
            <>
              <span className="absolute top-1/2 h-1 -translate-y-1/2 bg-warn" style={{ left: late, right: 0 }} />
              <span className="absolute top-1/2 h-[18px] w-px -translate-y-1/2 bg-warn" style={{ left: late }} />
            </>
          ) : null}
          {ai != null ? (
            <span
              className="absolute top-1/2 size-1.5 -translate-y-1/2 bg-accent"
              style={{ left: Math.min(ai, TRACK - 6) }}
            />
          ) : null}
        </span>
        <div className="flex w-[140px] shrink-0 flex-col items-end gap-1.5 text-right md:w-[196px]">
          <span className={cn("max-w-full truncate font-mono text-[11.5px]", TONE[w.tone])}>{w.reason}</span>
          <span className="max-w-full truncate font-mono text-[11px] text-dim">{w.detail}</span>
        </div>
      </Link>
    </li>
  );
}
