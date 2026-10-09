import { Link } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { DayBars, QueueTable } from "./queue-table";
import type { HomeData, HotTopic } from "./types";

/* The last 24 hours at a glance — queues, volume, SLA, what the agent did, what's surging. Shown on Insights. */

const humanize = (s: string) => s.replace(/_/g, " ");

/* ------------------------------------------------------------------ queues */

export function Queues({ data }: { data: HomeData }) {
  const { slug } = useWorkspace();
  return (
    <section className="flex flex-col pt-10 pb-12">
      <div className="flex items-center justify-between px-4 pb-4 md:pr-8 md:pl-10">
        <span className="flex items-center gap-3">
          <h2 className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-2">QUEUES</h2>
          <span className="font-mono text-[11px] text-dim">every view, live</span>
        </span>
        <Link to="/w/$slug/views" params={{ slug }} className="font-mono text-[11px] text-body hover:text-fg">
          all views →
        </Link>
      </div>
      <QueueTable variant="home" groups={[{ label: "all", queues: data.queues }]} />
    </section>
  );
}

/* ------------------------------------------------------------------ side panel */

function SideHead({ label, right }: { label: string; right?: React.ReactNode }) {
  return (
    <div className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-5">
      <span className="font-mono text-[11px] font-medium tracking-[0.14em] text-dim">{label}</span>
      {right ? <span className="font-mono text-[11px] text-dim">{right}</span> : null}
    </div>
  );
}

function compactDuration(seconds: number) {
  const m = Math.round(seconds / 60);
  if (m < 1) return `${Math.round(seconds)}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? (m % 60 ? `${h}h ${m % 60}m` : `${h}h`) : `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function LastDay({ data }: { data: HomeData }) {
  const t = data.pulse.tickets;
  const rows: [string, React.ReactNode][] = [
    ["new tickets", t.new24h],
    ["waiting on us", t.waiting],
    ["waiting on customer", t.pending],
    [
      "first reply, median",
      data.pulse.medianFirstResponseSeconds != null ? compactDuration(data.pulse.medianFirstResponseSeconds) : "–",
    ],
    ["resolved", t.resolved24h],
  ];
  return (
    <section className="pb-2">
      <SideHead label="LAST 24 HOURS" />
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between px-5 py-3">
          <span className="font-mono text-[11.5px] text-dim">{k}</span>
          <span className="text-[13px] font-medium text-fg-2 tabular-nums">{v}</span>
        </div>
      ))}
    </section>
  );
}

export function Sla({ data }: { data: HomeData }) {
  const late = data.pulse.tickets.slaBreached;
  const open = Math.max(data.pulse.tickets.waiting, late);
  const soon = data.queues.find((q) => q.id === "inbox")?.stats.slaSoon ?? 0;
  const segments = Math.min(open, 20);
  const lateSegments = open ? Math.round((late / open) * segments) : 0;
  return (
    <section className="flex flex-col gap-3 border-y border-line p-5">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] font-medium tracking-[0.12em] text-dim">FIRST-REPLY SLA</span>
        <span className={cn("font-mono text-[11.5px]", late ? "text-warn" : "text-fg-2")}>
          {late ? `${late} of ${open} late` : "on track"}
        </span>
      </div>
      {segments ? (
        <div className="flex h-1 gap-0.5">
          {Array.from({ length: segments }, (_, i) => (
            <span key={i} className={cn("flex-1", i < lateSegments ? "bg-warn" : "bg-white/[0.14]")} />
          ))}
        </div>
      ) : null}
      <span className="font-mono text-[11px] text-dim">
        {soon ? `${soon} due within the hour` : "none due within the hour"}
      </span>
    </section>
  );
}

export function TraceRead({ data }: { data: HomeData }) {
  const { slug, boot } = useWorkspace();
  const ai = data.pulse.ai;
  const drafts = data.needs.counts.draft_ready;
  const pct = ai.avgConfidence != null ? Math.round(ai.avgConfidence * 100) : null;
  const weak = pct != null && pct < 70;
  const s = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const text = !ai.worked
    ? "Nothing to work on in the last 24 hours."
    : [
        `Worked ${s(ai.worked, "ticket", "tickets")}${ai.autoReplies ? `, answered ${ai.autoReplies} alone` : ""}.`,
        drafts
          ? `${s(drafts, "draft awaits", "drafts await")} review${pct != null ? ` at ${pct}% average confidence` : ""}.`
          : null,
        ai.approvals ? `${s(ai.approvals, "action awaits", "actions await")} approval.` : null,
        weak ? "Low confidence usually means missing sources." : null,
      ]
        .filter(Boolean)
        .join(" ");
  return (
    <section className="flex flex-col gap-3.5 border-b border-line bg-accent/[0.06] p-5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-[7px]">
          <Sparkles className="size-3 text-accent" />
          <span className="font-mono text-[11px] font-medium tracking-[0.14em] text-accent-text">
            {boot.settings.ai.agentName.toUpperCase()} · 24H
          </span>
        </span>
        <span className="font-mono text-[11px] text-dim">{boot.ai.online ? "Claude" : "local heuristics"}</span>
      </div>
      <p className="text-[12.5px] leading-[1.55] text-body">{text}</p>
      <div className="flex flex-wrap gap-x-3.5 gap-y-1 font-mono text-[11px] text-accent-text">
        <span>{ai.worked} worked</span>
        <span>{ai.autoReplies} sent alone</span>
        <span>{ai.escalated} handed off</span>
      </div>
      {weak ? (
        <Link
          to="/w/$slug/knowledge"
          params={{ slug }}
          className="font-mono text-[11px] text-accent-text hover:text-fg"
        >
          fill knowledge gaps →
        </Link>
      ) : (
        <Link
          to="/w/$slug/agent/$section"
          params={{ slug, section: "ai" }}
          className="font-mono text-[11px] text-accent-text hover:text-fg"
        >
          tune the agent →
        </Link>
      )}
    </section>
  );
}

export function Surfacing({ topics }: { topics: HotTopic[] }) {
  const { slug } = useWorkspace();
  return (
    <section className="flex flex-col">
      <SideHead label="SURFACING" right="vs usual" />
      {!topics.length ? (
        <p className="px-5 py-4 text-[12px] leading-relaxed text-dim">Nothing above its usual volume.</p>
      ) : (
        topics.map((t) => (
          <div key={`${t.kind}:${t.key}`} className="flex items-center gap-4 border-b border-line-2 px-5 py-4">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="truncate text-[12.5px] text-fg-2">
                {t.kind === "tag" ? `#${t.key}` : humanize(t.key).replace(/^\w/, (c) => c.toUpperCase())}
              </span>
              <span className="truncate font-mono text-[11px] text-dim">
                {t.recent} new · usually {t.baseline} ·
                {t.samples.slice(0, 2).map((s) => (
                  <Link
                    key={s.number}
                    to="/w/$slug/inbox/$view/$ticket"
                    params={{ slug, view: "all", ticket: String(s.number) }}
                    title={s.subject}
                    className="ml-1.5 hover:text-fg"
                  >
                    #{s.number}
                  </Link>
                ))}
              </span>
            </div>
            <DayBars values={t.daily} height={16} />
          </div>
        ))
      )}
    </section>
  );
}
