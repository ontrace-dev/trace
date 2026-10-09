import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import * as React from "react";
import { PageHeader } from "./customers";
import { Spinner } from "@/components/ui";
import { LastDay, Queues, Sla, Surfacing, TraceRead } from "@/features/home/pulse";
import { type HomeData, homeKeys } from "@/features/home/types";
import { duration } from "@/lib/utils";
import { qk, useWorkspace } from "@/lib/workspace";

interface Insights {
  perDay: { day: string; n: number }[];
  byChannel: { channel: string; n: number }[];
  byIntent: { intent: string | null; n: number }[];
  totals: { total: number; open: number; resolved: number; autoReplied: number; breached: number };
  replies: { authorType: string; n: number }[];
  medianFirstResponseSeconds: number | null;
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-r border-line px-5 py-4 last:border-r-0">
      <span className="label-mono">{label}</span>
      <span className="text-[26px] font-semibold tracking-tight text-fg tabular-nums">{value}</span>
      {sub ? <span className="font-mono text-[11.5px] text-dim">{sub}</span> : null}
    </div>
  );
}

/** Single-series bars: one hue (accent), hover tooltip per bar, labels in text tokens. */
function Columns({ data }: { data: { label: string; value: number }[] }) {
  const [hover, setHover] = React.useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="flex flex-col gap-2">
      <div className="relative flex h-40 items-end gap-[2px] border-b border-line-strong">
        {[0.5, 1].map((g) => (
          <div
            key={g}
            className="pointer-events-none absolute inset-x-0 border-t border-line-2"
            style={{ bottom: `${g * 100}%` }}
          >
            <span className="absolute -top-2 right-0 bg-bg pl-1 font-mono text-[11px] text-dim">
              {Math.round(max * g)}
            </span>
          </div>
        ))}
        {data.map((d, i) => (
          <div
            key={d.label}
            className="relative flex h-full flex-1 items-end"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <div
              className="w-full rounded-t-[2px] bg-accent transition-opacity"
              style={{
                height: `${(d.value / max) * 100}%`,
                opacity: hover === null || hover === i ? 1 : 0.45,
                minHeight: d.value ? 2 : 0,
              }}
            />
            {hover === i ? (
              <div className="absolute bottom-full left-1/2 z-10 mb-1.5 -translate-x-1/2 border border-line-strong bg-bar px-2 py-1 font-mono text-[11.5px] whitespace-nowrap text-fg">
                {d.label} · {d.value} tickets
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="flex justify-between font-mono text-[11px] text-dim">
        <span>{data[0]?.label}</span>
        <span>{data.at(-1)?.label}</span>
      </div>
    </div>
  );
}

function HBars({ data }: { data: { label: string; value: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (!data.length) return <div className="py-6 text-xs text-dim">No data yet.</div>;
  return (
    <div className="flex flex-col gap-2.5">
      {data.map((d) => (
        <div
          key={d.label}
          className="grid grid-cols-[130px_1fr_36px] items-center gap-3"
          title={`${d.label}: ${d.value}`}
        >
          <span className="truncate font-mono text-[11px] text-fg-3">{d.label}</span>
          <span className="h-2 bg-white/[0.05]">
            <span className="block h-full rounded-r-[2px] bg-accent" style={{ width: `${(d.value / max) * 100}%` }} />
          </span>
          <span className="text-right font-mono text-[11px] text-muted tabular-nums">{d.value}</span>
        </div>
      ))}
    </div>
  );
}

export function InsightsPage() {
  const { api, wid } = useWorkspace();
  const q = useQuery({ queryKey: qk.insights(wid), queryFn: () => api<Insights>("/insights") });
  const today = useQuery({
    queryKey: homeKeys.home(wid),
    queryFn: () => api<HomeData>("/home"),
    refetchInterval: 30_000,
  });
  if (q.isPending || !q.data)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  const d = q.data;
  const days: { label: string; value: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86_400_000);
    const key = dt.toISOString().slice(0, 10);
    days.push({
      label: dt.toLocaleDateString([], { month: "short", day: "numeric" }),
      value: d.perDay.find((p) => p.day === key)?.n ?? 0,
    });
  }
  const ai = d.replies.find((r) => r.authorType === "ai")?.n ?? 0;
  const human = d.replies.find((r) => r.authorType === "agent")?.n ?? 0;
  const aiShare = ai + human ? Math.round((ai / (ai + human)) * 100) : 0;
  const resolution = d.totals.total ? Math.round((d.totals.resolved / d.totals.total) * 100) : 0;
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Insights" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {today.data ? <Today data={today.data} /> : null}
        <div className="border-b border-line px-5 pt-8 pb-3">
          <span className="label-mono">All time</span>
        </div>
        <div className="grid grid-cols-2 border-b border-line lg:grid-cols-5">
          <Stat label="Tickets" value={d.totals.total} sub={`${d.totals.open} open now`} />
          <Stat label="Resolution rate" value={`${resolution}%`} sub={`${d.totals.resolved} resolved`} />
          <Stat label="Replies by AI" value={`${aiShare}%`} sub={`${ai} ai · ${human} human`} />
          <Stat
            label="Median first response"
            value={d.medianFirstResponseSeconds != null ? duration(d.medianFirstResponseSeconds * 1000) : "—"}
            sub="created → first reply"
          />
          <Stat label="SLA breaches" value={d.totals.breached} sub="open, unanswered, overdue" />
        </div>
        <div className="grid gap-px bg-line lg:grid-cols-[2fr_1fr]">
          <section className="flex flex-col gap-4 bg-bg p-5">
            <span className="label-mono">New tickets · last 14 days</span>
            <Columns data={days} />
          </section>
          <section className="flex flex-col gap-4 bg-bg p-5">
            <span className="label-mono">By channel</span>
            <HBars
              data={d.byChannel.map((c) => ({ label: c.channel, value: c.n })).sort((a, b) => b.value - a.value)}
            />
          </section>
        </div>
        <section className="flex flex-col gap-4 border-t border-line p-5">
          <div className="flex items-center gap-2">
            <Sparkles className="size-3 text-accent-text" />
            <span className="label-mono">Top intents (classified by the AI agent)</span>
          </div>
          <div className="max-w-2xl">
            <HBars data={d.byIntent.map((c) => ({ label: c.intent ?? "unknown", value: c.n }))} />
          </div>
        </section>
      </div>
    </div>
  );
}

/** The last 24 hours: every queue, plus volume, SLA, what the agent did and what's above its usual level. */
function Today({ data }: { data: HomeData }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] border-b border-line xl:grid-cols-[minmax(0,1fr)_322px]">
      <div className="min-w-0">
        <Queues data={data} />
      </div>
      <aside className="flex flex-col border-t border-line bg-black/20 xl:border-t-0 xl:border-l">
        <LastDay data={data} />
        <Sla data={data} />
        <TraceRead data={data} />
        <Surfacing topics={data.hot} />
      </aside>
    </div>
  );
}
