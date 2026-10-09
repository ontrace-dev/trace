import {
  BookOpen,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  GitCompareArrows,
  ListTree,
  Scale,
  ScanSearch,
  Send,
  ShieldCheck,
  Sparkles,
  UserRound,
  Workflow,
} from "lucide-react";
import * as React from "react";
import { Dialog } from "@/components/ui";
import type { Span } from "@/lib/types";
import { clock, cn, duration } from "@/lib/utils";

const spanIcon = (name: string) => {
  if (name.includes("knowledge")) return BookOpen;
  if (name.includes("past_tickets")) return GitCompareArrows;
  if (name.includes("customer")) return UserRound;
  if (name.includes("triage") || name.includes("intent") || name.includes("update_ticket")) return ScanSearch;
  if (name.includes("policy")) return Scale;
  if (name.includes("send") || name.includes("deliver")) return Send;
  if (name.includes("escalate")) return CircleAlert;
  if (name.includes("compose")) return Sparkles;
  if (name.includes("slack") || name.includes("discord") || name.includes("webhook")) return Workflow;
  return ShieldCheck;
};

/** Human-readable fact lines for the "TRACE ANALYSIS" card. */
function facts(spans: Span[]) {
  const out: { icon: React.ComponentType<{ className?: string }>; text: string; error?: boolean }[] = [];
  for (const s of spans) {
    if (s.name === "model.turn" || s.name === "message.received") continue;
    const label = s.name.replace(/^tool\./, "").replace(/_/g, " ");
    if (!s.summary && s.status === "ok") continue;
    out.push({
      icon: s.status === "error" ? CircleAlert : spanIcon(s.name),
      text: s.summary ? `${label} — ${s.summary}` : label,
      error: s.status === "error",
    });
  }
  return out.slice(0, 6);
}

export function traceDuration(spans: Span[]) {
  if (!spans.length) return 0;
  const start = Math.min(...spans.map((s) => new Date(s.startedAt).getTime()));
  const end = Math.max(...spans.map((s) => new Date(s.startedAt).getTime() + s.durationMs));
  return end - start;
}

/** One line in the conversation by default; expands to the fact lines. Opens on its own when a step failed. */
export function TraceAnalysis({ spans, agentName }: { spans: Span[]; agentName: string }) {
  const [open, setOpen] = React.useState(false);
  const f = facts(spans);
  const errors = f.filter((x) => x.error).length;
  const failed = errors > 0;
  const [expanded, setExpanded] = React.useState(failed);
  if (!f.length) return null;
  const models = spans.filter((s) => s.name === "model.turn").length;
  return (
    <div className="flex flex-col border border-accent/25 bg-accent/[0.06]">
      <div className="flex items-center gap-3 px-3.5 py-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="group flex min-w-0 flex-1 items-center gap-[7px] text-left"
        >
          <ChevronRight
            className={cn("size-3 shrink-0 text-accent-text transition-transform", expanded && "rotate-90")}
          />
          <Sparkles className="size-[13px] shrink-0 text-accent-text" />
          <span className="shrink-0 text-[12px] font-medium text-accent-text">{agentName} analysis</span>
          {expanded ? null : (
            <span className={cn("truncate text-[12px]", failed ? "text-danger" : "text-muted group-hover:text-body")}>
              {failed ? `${errors} ${errors === 1 ? "step" : "steps"} failed` : f[0]!.text}
            </span>
          )}
        </button>
        <button
          onClick={() => setOpen(true)}
          className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-dim hover:text-fg"
        >
          <ListTree className="size-3" />
          {spans.length} spans · {models ? `${models} model calls · ` : ""}
          {duration(traceDuration(spans))}
        </button>
      </div>
      {expanded ? (
        <div className="flex flex-col gap-2.5 px-3.5 pt-1 pb-3.5">
          {f.map((x, i) => (
            <div key={i} className="flex items-start gap-2">
              <x.icon className={cn("mt-[2px] size-[13px] shrink-0", x.error ? "text-danger" : "text-accent/70")} />
              <span className={cn("text-[12px] leading-[1.5]", x.error ? "text-danger" : "text-body")}>{x.text}</span>
            </div>
          ))}
        </div>
      ) : null}
      <TraceWaterfall open={open} onOpenChange={setOpen} spans={spans} />
    </div>
  );
}

/** The full receipt: every span of a trace on a time axis (like the landing page). */
export function TraceWaterfall({
  open,
  onOpenChange,
  spans,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  spans: Span[];
}) {
  const [sel, setSel] = React.useState<Span | null>(null);
  if (!spans.length) return null;
  const t0 = Math.min(...spans.map((s) => new Date(s.startedAt).getTime()));
  const total = Math.max(1, traceDuration(spans));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={<span className="font-mono text-[13px]">trace/{spans[0]!.traceId.slice(4, 12)}</span>}
      description={`${spans.length} spans · ${duration(total)} · started ${clock(spans[0]!.startedAt)}`}
      className="w-[min(920px,calc(100vw-32px))]"
    >
      <div className="-mx-5 -my-4">
        <div className="grid grid-cols-[180px_1fr_260px_64px] border-b border-line px-5 py-2 font-mono text-[11px] text-dim">
          <span>span</span>
          <span className="flex justify-between pr-4">
            <span>0ms</span>
            <span>{duration(total / 2)}</span>
            <span>{duration(total)}</span>
          </span>
          <span>result</span>
          <span className="text-right">time</span>
        </div>
        {spans.map((s, i) => {
          const off = new Date(s.startedAt).getTime() - t0;
          const left = (off / total) * 100;
          const width = Math.max(0.8, (s.durationMs / total) * 100);
          return (
            <button
              key={s.id}
              onClick={() => setSel(sel?.id === s.id ? null : s)}
              className={cn(
                "grid w-full grid-cols-[180px_1fr_260px_64px] items-center border-b border-line-2 px-5 py-2 text-left hover:bg-white/[0.02]",
                sel?.id === s.id && "bg-white/[0.03]",
              )}
            >
              <span className="flex items-center gap-2 truncate font-mono text-[11.5px] text-fg-3">
                {i === 0 ? null : <span className="text-faint">{i === spans.length - 1 ? "└" : "│"}</span>}
                {s.name}
              </span>
              <span className="relative mr-4 h-[6px]">
                <span
                  className={cn(
                    "absolute top-0 h-full",
                    s.status === "error"
                      ? "bg-danger"
                      : s.kind === "ai"
                        ? "bg-accent"
                        : s.kind === "integration"
                          ? "bg-ok/70"
                          : "bg-white/30",
                  )}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              </span>
              <span
                className={cn("truncate font-mono text-[11.5px]", s.status === "error" ? "text-danger" : "text-muted")}
              >
                {s.summary}
              </span>
              <span
                className={cn("text-right font-mono text-[11.5px]", s.kind === "ai" ? "text-accent-text" : "text-dim")}
              >
                {duration(s.durationMs)}
              </span>
            </button>
          );
        })}
        {sel ? (
          <pre className="max-h-64 overflow-auto border-b border-line bg-black/30 px-5 py-3 font-mono text-[11px] leading-relaxed text-muted">
            {JSON.stringify(sel.attributes, null, 2)}
          </pre>
        ) : null}
        <div className="flex items-center gap-4 px-5 py-2.5 font-mono text-[11px] text-dim">
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-3 bg-accent" /> model
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-3 bg-white/30" /> tool / system
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-3 bg-ok/70" /> integration
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <CircleCheck className="size-3" /> click a span for its attributes
          </span>
        </div>
      </div>
    </Dialog>
  );
}
