import { CircleAlert, CircleCheck, Clock, Hand, Lock, Sparkles } from "lucide-react";
import * as React from "react";
import { Badge } from "@/components/ui";
import { SourceChips } from "@/features/source-chips";
import { cn, duration, md } from "@/lib/utils";
import type { SimulatedActionCall, SimulationResult } from "./types";
import { SimulationWaterfall } from "./waterfall";

export function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = pct >= 80 ? "bg-accent" : pct >= 50 ? "bg-warn" : "bg-danger/70";
  return (
    <span className="flex items-center gap-2">
      <span className="font-mono text-[11px] tracking-[0.08em] text-dim">CONFIDENCE {pct}%</span>
      <span className="h-1 w-14 bg-white/[0.08]">
        <span className={cn("block h-full", color)} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

const actionMode: Record<SimulatedActionCall["mode"], { label: string; tone: "ok" | "neutral" | "warn" }> = {
  executed: { label: "executed · read-only", tone: "ok" },
  simulated: { label: "simulated · not run", tone: "neutral" },
  approval: { label: "would need approval", tone: "warn" },
};

function Block({ label, right, children }: { label: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="label-mono">{label}</span>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Everything the agent decided in a simulation: outcome, reply, evidence, actions, policy and spans. */
export function SimulationView({ result, agentName }: { result: SimulationResult; agentName: string }) {
  const t = result.triage;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={result.outcome === "reply" ? "solid-accent" : "warn"} upper>
          {result.outcome === "reply" ? "reply" : "escalate to human"}
        </Badge>
        {result.outcome === "reply" ? <ConfidenceBar value={result.confidence} /> : null}
        <span className="ml-auto flex items-center gap-2">
          <Badge tone={result.provider === "claude" ? "accent" : "neutral"}>
            {result.provider === "claude" ? "claude" : "local heuristics"}
          </Badge>
          <span className="flex items-center gap-1 font-mono text-[11px] text-dim">
            <Clock className="size-3" /> {duration(result.durationMs)}
          </span>
        </span>
      </div>
      {result.provider === "local" ? (
        <div className="border border-line bg-white/[0.02] px-3 py-2 text-[11.5px] leading-relaxed text-muted">
          No Anthropic key is configured, so this ran on the offline heuristic agent (keyword triage, template replies,
          no actions, never escalates). Add a key in Agent → Setup to test the real {agentName}.
        </div>
      ) : null}

      <div
        className={cn(
          "flex items-start gap-2 border px-3 py-2 text-[12px]",
          result.policy.autoSend ? "border-ok/25 bg-ok/[0.04] text-ok" : "border-line-strong text-fg-3",
        )}
      >
        {result.policy.autoSend ? (
          <CircleCheck className="mt-[2px] size-[13px] shrink-0" />
        ) : (
          <Hand className="mt-[2px] size-[13px] shrink-0 text-warn" />
        )}
        <span>
          {result.policy.autoSend ? "Would auto-send" : "Would wait for review"}
          <span className="text-muted"> — {result.policy.why}</span>
        </span>
      </div>

      {t ? (
        <Block label="Triage">
          <div className="flex flex-wrap gap-1.5">
            {t.intent ? <Badge tone="solid-accent">{t.intent}</Badge> : null}
            {t.priority ? <Badge upper>{t.priority}</Badge> : null}
            {t.language ? <Badge upper>{t.language}</Badge> : null}
            {t.sentiment ? <Badge>{t.sentiment}</Badge> : null}
            {(t.tags ?? []).map((tag) => (
              <Badge key={tag} tone="accent">
                {tag}
              </Badge>
            ))}
          </div>
        </Block>
      ) : null}

      {result.outcome === "escalate" ? (
        <Block label="Escalation">
          <div className="flex flex-col gap-2 border border-warn/25 bg-warn/[0.04] p-3">
            <span className="flex items-center gap-1.5 text-[12.5px] text-warn">
              <CircleAlert className="size-[13px]" /> {result.reason || "Handed to a human"}
            </span>
            {result.internalNote ? (
              <div className="flex gap-1.5 text-[12px] text-fg-3">
                <Lock className="mt-[3px] size-3 shrink-0 text-dim" />
                <div className="prose-trace" dangerouslySetInnerHTML={{ __html: md(result.internalNote) }} />
              </div>
            ) : null}
          </div>
        </Block>
      ) : null}

      {result.body ? (
        <Block label={result.outcome === "reply" ? "Reply" : "Suggested reply for the human"}>
          <div className="border border-line-strong bg-raised p-3.5">
            <div
              className="prose-trace text-[13px] leading-[1.65]"
              dangerouslySetInnerHTML={{ __html: md(result.body) }}
            />
            {result.sources.length ? <SourceChips sources={result.sources} /> : null}
          </div>
        </Block>
      ) : null}

      {result.actions.length ? (
        <Block label={`Actions · ${result.actions.length}`}>
          <div className="flex flex-col border border-line">
            {result.actions.map((a, i) => (
              <div key={i} className="flex flex-col gap-1.5 border-b border-line-2 px-3 py-2 last:border-b-0">
                <div className="flex items-center gap-2">
                  <Sparkles className="size-3 text-accent-text" />
                  <span className="font-mono text-[11.5px] text-fg-2">{a.name}</span>
                  <Badge tone={actionMode[a.mode].tone}>{actionMode[a.mode].label}</Badge>
                </div>
                <code className="truncate font-mono text-[11.5px] text-muted">{JSON.stringify(a.input)}</code>
                {a.output ? (
                  <pre className="max-h-32 overflow-auto bg-black/30 px-2 py-1.5 font-mono text-[11.5px] text-dim">
                    {a.output}
                  </pre>
                ) : null}
              </div>
            ))}
          </div>
        </Block>
      ) : null}

      <Block label={`Trace · ${result.spans.length} spans`}>
        <SimulationWaterfall spans={result.spans} />
      </Block>
    </div>
  );
}
