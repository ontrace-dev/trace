import * as React from "react";
import { cn, duration } from "@/lib/utils";
import type { SimulationSpan } from "./types";

/** Span waterfall for an in-memory simulation trace (same visual language as the ticket trace view). */
export function SimulationWaterfall({ spans }: { spans: SimulationSpan[] }) {
  const [sel, setSel] = React.useState<number | null>(null);
  if (!spans.length) return <div className="px-4 py-3 text-xs text-dim">No spans recorded.</div>;
  const t0 = Math.min(...spans.map((s) => new Date(s.startedAt).getTime()));
  const end = Math.max(...spans.map((s) => new Date(s.startedAt).getTime() + s.durationMs));
  const total = Math.max(1, end - t0);
  return (
    <div className="border border-line">
      <div className="grid grid-cols-[150px_minmax(90px,1fr)_minmax(0,200px)_52px] border-b border-line px-3 py-1.5 font-mono text-[11px] text-dim">
        <span>span</span>
        <span className="flex justify-between pr-3">
          <span>0ms</span>
          <span>{duration(total)}</span>
        </span>
        <span>result</span>
        <span className="text-right">time</span>
      </div>
      {spans.map((s, i) => {
        const left = ((new Date(s.startedAt).getTime() - t0) / total) * 100;
        const width = Math.max(0.8, (s.durationMs / total) * 100);
        return (
          <React.Fragment key={i}>
            <button
              onClick={() => setSel(sel === i ? null : i)}
              className={cn(
                "grid w-full grid-cols-[150px_minmax(90px,1fr)_minmax(0,200px)_52px] items-center border-b border-line-2 px-3 py-1.5 text-left last:border-b-0 hover:bg-white/[0.02]",
                sel === i && "bg-white/[0.03]",
              )}
            >
              <span className="truncate font-mono text-[11px] text-fg-3">{s.name}</span>
              <span className="relative mr-3 h-[5px]">
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
                className={cn("truncate font-mono text-[11px]", s.status === "error" ? "text-danger" : "text-muted")}
              >
                {s.summary}
              </span>
              <span
                className={cn("text-right font-mono text-[11px]", s.kind === "ai" ? "text-accent-text" : "text-dim")}
              >
                {duration(s.durationMs)}
              </span>
            </button>
            {sel === i ? (
              <pre className="max-h-56 overflow-auto border-b border-line bg-black/30 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-muted">
                {JSON.stringify(s.attributes, null, 2)}
              </pre>
            ) : null}
          </React.Fragment>
        );
      })}
    </div>
  );
}
