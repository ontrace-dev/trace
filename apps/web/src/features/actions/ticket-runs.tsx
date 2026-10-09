import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Hourglass,
  Loader2,
  Play,
  ShieldAlert,
  X,
  Zap,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Badge, Button, Input, Popover, PopoverContent, PopoverTrigger, Textarea } from "@/components/ui";
import type { ActionRun, ActionRunStatus, Message } from "@/lib/types";
import { clock, cn, md, shortDate } from "@/lib/utils";
import { qk, useWorkspace } from "@/lib/workspace";
import { type ActionResult, prettyJson } from "./types";

const statusMeta: Record<
  ActionRunStatus,
  {
    label: string;
    tone: "warn" | "ok" | "danger" | "neutral" | "info";
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  pending_approval: { label: "approval needed", tone: "warn", icon: Hourglass },
  running: { label: "running", tone: "info", icon: Loader2 },
  succeeded: { label: "succeeded", tone: "ok", icon: CircleCheck },
  failed: { label: "failed", tone: "danger", icon: CircleAlert },
  rejected: { label: "rejected", tone: "neutral", icon: CircleX },
};

export function RunStatus({ status }: { status: ActionRunStatus }) {
  const s = statusMeta[status];
  return (
    <Badge tone={s.tone} upper>
      {s.label}
    </Badge>
  );
}

const fmtValue = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

function useRunMutations() {
  const { api, wid } = useWorkspace();
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["ticket", wid] });
    qc.invalidateQueries({ queryKey: ["tickets", wid] });
    qc.invalidateQueries({ queryKey: qk.counts(wid) });
    qc.invalidateQueries({ queryKey: ["automation", wid] });
  };
  const approve = useMutation({
    mutationFn: ({ id, input }: { id: string; input?: Record<string, unknown> }) =>
      api<{ result: ActionResult }>(`/automation/runs/${id}/approve`, { method: "POST", json: { input } }),
    onSuccess: ({ result }) => {
      if (result.ok)
        toast.success("Approved and executed", {
          description: `HTTP ${result.status} · the agent is writing the reply`,
        });
      else toast.error("Approved, but the action failed", { description: result.error });
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const reject = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) =>
      api(`/automation/runs/${id}/reject`, { method: "POST", json: { note } }),
    onSuccess: () => {
      toast("Rejected — the agent will take it from here");
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return { approve, reject };
}

/** Pending approvals for a ticket, plus a compact log of every action run. */
export function TicketActionRuns({ runs }: { runs: ActionRun[] }) {
  const pending = runs.filter((r) => r.status === "pending_approval");
  const done = runs.filter((r) => r.status !== "pending_approval");
  if (!runs.length) return null;
  return (
    <div className="flex flex-col gap-3">
      {pending.map((r) => (
        <ApprovalCard key={r.id} run={r} />
      ))}
      {done.length ? <RunLog runs={done} /> : null}
    </div>
  );
}

export function ApprovalCard({ run, compact }: { run: ActionRun; compact?: boolean }) {
  const { approve, reject } = useRunMutations();
  const [input, setInput] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(run.input)
        .filter(([k]) => k !== "reason")
        .map(([k, v]) => [k, fmtValue(v)]),
    ),
  );
  const [note, setNote] = React.useState("");
  const [rejectOpen, setRejectOpen] = React.useState(false);
  const changed = Object.entries(input).some(([k, v]) => v !== fmtValue(run.input[k]));
  const parsedInput = () =>
    Object.fromEntries(
      Object.entries(input).map(([k, v]) => {
        const orig = run.input[k];
        if (typeof orig === "number") return [k, Number(v)];
        if (typeof orig === "boolean") return [k, v === "true"];
        return [k, v];
      }),
    );
  return (
    <div className="flex flex-col gap-3 border border-warn/35 bg-warn/[0.05] p-3.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-[7px]">
          <ShieldAlert className="size-[13px] text-warn" />
          <span className="font-mono text-[11px] font-medium tracking-[0.12em] text-warn">APPROVAL NEEDED</span>
          <span className="text-[12.5px] font-semibold text-[#e8e8ef]">{run.actionTitle}</span>
          <span className="font-mono text-[11.5px] text-dim">{run.actionName}</span>
          {run.mcpToolId ? <Badge>MCP</Badge> : null}
        </div>
        <span className="font-mono text-[11px] text-dim">
          requested {shortDate(run.createdAt)} {clock(run.createdAt)}
        </span>
      </div>
      {run.reason ? (
        <div
          className="prose-trace text-[12.5px] leading-[1.6] text-fg-3"
          dangerouslySetInnerHTML={{ __html: md(run.reason) }}
        />
      ) : null}
      {Object.keys(input).length ? (
        <div className={cn("grid gap-x-3 gap-y-1.5", compact ? "grid-cols-[110px_1fr]" : "grid-cols-[140px_1fr]")}>
          {Object.entries(input).map(([k, v]) => (
            <React.Fragment key={k}>
              <span className="self-center font-mono text-[11px] text-muted">{k}</span>
              <Input
                value={v}
                onChange={(e) => setInput({ ...input, [k]: e.target.value })}
                className="h-7 font-mono text-[12px]"
              />
            </React.Fragment>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          className="h-[30px] px-3.5"
          loading={approve.isPending}
          onClick={() => approve.mutate({ id: run.id, input: changed ? parsedInput() : undefined })}
        >
          <Play /> {changed ? "Approve edited & run" : "Approve & run"}
        </Button>
        <Popover open={rejectOpen} onOpenChange={setRejectOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" className="h-[30px] px-3.5">
              <X /> Reject
            </Button>
          </PopoverTrigger>
          <PopoverContent className="flex w-72 flex-col gap-2">
            <span className="text-xs text-fg-2">Why? (the agent sees this)</span>
            <Textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Not a duplicate — the second charge is the seat upgrade."
            />
            <Button
              size="sm"
              variant="danger"
              loading={reject.isPending}
              onClick={() =>
                reject.mutate({ id: run.id, note: note.trim() || undefined }, { onSuccess: () => setRejectOpen(false) })
              }
            >
              Reject action
            </Button>
          </PopoverContent>
        </Popover>
        <span className="ml-auto font-mono text-[11px] text-dim">runs for real · the agent continues afterwards</span>
      </div>
    </div>
  );
}

function RunLog({ runs }: { runs: ActionRun[] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="border border-line bg-cell">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <Zap className="size-3 text-dim" />
        <span className="font-mono text-[11px] font-medium tracking-[0.12em] text-dim">ACTIONS · {runs.length}</span>
        <span className="flex flex-1 flex-wrap gap-1.5 truncate">
          {runs.slice(0, 4).map((r) => (
            <span key={r.id} className="font-mono text-[11.5px] text-muted">
              {r.actionName}
              <span
                className={r.status === "succeeded" ? "text-ok" : r.status === "rejected" ? "text-dim" : "text-danger"}
              >
                {" "}
                {r.status === "succeeded" ? "✓" : r.status === "rejected" ? "–" : "✗"}
              </span>
            </span>
          ))}
        </span>
        <ChevronRight className={cn("size-3.5 text-dim transition-transform", open && "rotate-90")} />
      </button>
      {open ? (
        <div className="border-t border-line">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RunRow({ run }: { run: ActionRun }) {
  const [open, setOpen] = React.useState(false);
  const input = Object.entries(run.input).filter(([k]) => k !== "reason");
  return (
    <div className="border-b border-line-2 last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-white/[0.02]"
      >
        <RunStatus status={run.status} />
        <span className="font-mono text-[11.5px] text-fg-3">{run.actionName}</span>
        <span className="truncate font-mono text-[11.5px] text-dim">
          {input.map(([k, v]) => `${k}=${fmtValue(v)}`).join(" ")}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[11px] text-dim">
          {run.httpStatus ? `HTTP ${run.httpStatus} · ` : ""}
          {run.reviewedByName ? `by ${run.reviewedByName} · ` : run.requestedBy === "ai" ? "by AI · " : ""}
          {clock(run.finishedAt ?? run.createdAt)}
        </span>
      </button>
      {open ? (
        <pre className="max-h-64 overflow-auto bg-black/30 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-muted">
          {run.error ? `${run.error}\n\n` : ""}
          {prettyJson(run.output) || "(no output)"}
        </pre>
      ) : null}
    </div>
  );
}

/** Notes that record an action request/decision render as compact action events. */
export function ActionNote({ m }: { m: Message }) {
  const a = m.meta.action!;
  const s = statusMeta[a.status];
  const Icon = a.status === "pending_approval" ? ShieldAlert : a.status === "succeeded" ? Check : s.icon;
  const [open, setOpen] = React.useState(a.status !== "pending_approval");
  const [headline, ...rest] = m.body.split("\n");
  return (
    <div className="flex gap-2.5">
      <span
        className={cn(
          "flex h-[26px] w-[26px] shrink-0 items-center justify-center border",
          s.tone === "ok"
            ? "border-ok/30 text-ok"
            : s.tone === "warn"
              ? "border-warn/35 text-warn"
              : s.tone === "danger"
                ? "border-danger/35 text-danger"
                : "border-line-strong text-dim",
        )}
      >
        <Icon className="size-[13px]" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-semibold text-fg-2">
            {m.authorType === "ai" ? "AI agent" : (m.authorName ?? "Agent")}
          </span>
          <RunStatus status={a.status} />
          <span className="font-mono text-[11.5px] text-muted">{a.name}</span>
          <span className="font-mono text-[11px] text-dim">
            {shortDate(m.createdAt)} {clock(m.createdAt)}
          </span>
          {rest.join("").trim() ? (
            <button onClick={() => setOpen(!open)} className="font-mono text-[11px] text-dim hover:text-fg">
              {open ? "hide details" : "details"}
            </button>
          ) : null}
        </div>
        <div
          className="prose-trace text-[12.5px] text-fg-3"
          dangerouslySetInnerHTML={{ __html: md(open ? m.body : (headline ?? "")) }}
        />
      </div>
    </div>
  );
}
