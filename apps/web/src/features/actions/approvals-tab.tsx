import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { Empty, Segmented, Spinner } from "@/components/ui";
import * as React from "react";
import { ago, clock, shortDate } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { ApprovalCard, RunStatus } from "./ticket-runs";
import { automationKeys, type InboxRun } from "./types";

export function ApprovalsTab() {
  const { api, wid, slug } = useWorkspace();
  const [filter, setFilter] = React.useState<"pending_approval" | "all">("pending_approval");
  const status = filter === "all" ? "" : filter;
  const runs = useQuery({
    queryKey: automationKeys.runs(wid, status),
    queryFn: () => api<{ runs: InboxRun[] }>(`/automation/runs${status ? `?status=${status}` : ""}`),
    refetchInterval: 15_000,
  });
  const rows = runs.data?.runs ?? [];
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-line px-8 py-4">
        <p className="text-[12px] text-dim">
          Every action that changes data waits here (and on its ticket) until a teammate approves it.
        </p>
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "pending_approval", label: "Waiting" },
            { value: "all", label: "History" },
          ]}
        />
      </div>
      {runs.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : !rows.length ? (
        <Empty
          icon={<ShieldCheck />}
          title={filter === "all" ? "No action runs yet" : "Nothing waiting for approval"}
        />
      ) : filter === "pending_approval" ? (
        <div className="flex max-w-4xl flex-col gap-4 px-8 py-6">
          {rows.map((r) => (
            <div key={r.id} className="flex flex-col gap-1.5">
              {r.ticketNumber != null ? (
                <Link
                  to="/w/$slug/inbox/$view/$ticket"
                  params={{ slug, view: "ai", ticket: String(r.ticketNumber) }}
                  className="flex items-center gap-1.5 text-xs text-muted hover:text-fg"
                >
                  <span className="font-mono text-dim">{r.ticketRef}</span> {r.ticketSubject}{" "}
                  <ArrowRight className="size-3" />
                </Link>
              ) : null}
              <ApprovalCard run={r} compact />
            </div>
          ))}
        </div>
      ) : (
        rows.map((r) => (
          <div key={r.id} className="flex items-center gap-3 border-b border-line-2 px-8 py-2.5">
            <RunStatus status={r.status} />
            <span className="font-mono text-[12px] text-fg-3">{r.actionName}</span>
            {r.ticketNumber != null ? (
              <Link
                to="/w/$slug/inbox/$view/$ticket"
                params={{ slug, view: "all", ticket: String(r.ticketNumber) }}
                className="truncate text-[12px] text-muted hover:text-fg"
              >
                <span className="font-mono text-dim">{r.ticketRef}</span> {r.ticketSubject}
              </Link>
            ) : null}
            <span className="ml-auto shrink-0 font-mono text-[11px] text-dim">
              {r.httpStatus ? `HTTP ${r.httpStatus} · ` : ""}
              {r.reviewedByName ? `${r.reviewedByName} · ` : r.requestedBy === "ai" ? "AI · " : ""}
              {shortDate(r.createdAt)} {clock(r.createdAt)} ({ago(r.createdAt)})
            </span>
          </div>
        ))
      )}
    </div>
  );
}
