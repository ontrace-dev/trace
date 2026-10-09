import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Inbox, Layers, type LucideIcon, Sparkles, User, UserX } from "lucide-react";
import * as React from "react";
import { useSession } from "@/lib/auth";
import type { ViewFilters } from "@/lib/types";
import { ago, cn } from "@/lib/utils";
import { viewIcons } from "@/lib/view-icons";
import { useWorkspace } from "@/lib/workspace";
import type { QueueRow, QueueStats } from "./types";

const systemIcons: Record<string, LucideIcon> = { inbox: Inbox, sparkles: Sparkles, "user-x": UserX, user: User };
export const queueIcon = (icon: string) => systemIcons[icon] ?? viewIcons[icon] ?? Layers;

/** Empty value: a short drawn hairline, so zeros recede and real numbers stand out. */
export function Nil() {
  return <span aria-label="none" className="inline-block h-px w-2.5 bg-white/[0.15] align-middle" />;
}

/** Daily counts as tiny columns, oldest first; the latest day is drawn in white. */
export function DayBars({ values, height = 14 }: { values: number[]; height?: number }) {
  const max = Math.max(1, ...values);
  return (
    <span className="inline-flex items-end gap-[2px]" style={{ height }} aria-hidden>
      {values.map((v, i) => (
        <span
          key={i}
          className={cn("w-1", i === values.length - 1 && v ? "bg-fg" : v ? "bg-white/30" : "bg-white/[0.12]")}
          style={{ height: v ? Math.max(3, Math.round((v / max) * height)) : 1 }}
        />
      ))}
    </span>
  );
}

export type SortKey = "name" | "total" | "waiting" | "unassigned" | "urgent" | "sla" | "drafts" | "oldest";
export type Sort = { key: SortKey; dir: 1 | -1 } | null;

const COLUMNS: { key: SortKey; label: string; title: string; home: number; views: number }[] = [
  { key: "total", label: "Open", title: "Tickets in the view", home: 64, views: 64 },
  {
    key: "waiting",
    label: "Waiting",
    title: "Waiting on us: the customer is waiting for a reply",
    home: 80,
    views: 80,
  },
  { key: "unassigned", label: "Unassigned", title: "Open or pending without an assignee", home: 104, views: 100 },
  { key: "urgent", label: "High+", title: "High or urgent priority", home: 68, views: 64 },
  { key: "sla", label: "SLA", title: "First reply overdue, or due within the hour", home: 84, views: 80 },
  { key: "drafts", label: "Drafts", title: "AI drafts waiting for review", home: 76, views: 72 },
  { key: "oldest", label: "Max wait", title: "How long the longest-waiting customer has waited", home: 88, views: 84 },
];

function sortValue(s: QueueStats, key: SortKey) {
  if (key === "sla") return s.slaBreached * 1000 + s.slaSoon;
  if (key === "oldest") return s.oldestWaitingAt ? Date.now() - new Date(s.oldestWaitingAt).getTime() : -1;
  if (key === "name") return 0;
  return s[key];
}

export function sortQueues(qs: QueueRow[], sort: Sort) {
  if (!sort) return qs;
  return [...qs].sort((a, b) =>
    sort.key === "name"
      ? a.name.localeCompare(b.name) * sort.dir
      : (sortValue(a.stats, sort.key) - sortValue(b.stats, sort.key)) * sort.dir,
  );
}

const num = "pl-4 text-right font-mono text-[12px] tabular-nums";
const headText = "font-mono text-[11px] font-normal tracking-[0.1em] uppercase";

function Count({ n, tone }: { n: number; tone?: "accent" }) {
  if (!n) return <Nil />;
  return <span className={tone === "accent" ? "text-accent-text" : "text-fg-2"}>{n}</span>;
}

export interface QueueGroup {
  label: string;
  note?: string;
  queues: QueueRow[];
  /** Per-row actions (edit, delete) — saved views only. */
  actions?: (q: QueueRow) => React.ReactNode;
}

/**
 * Every queue with its live numbers. `home` is the compact table on the landing page; `views` adds the
 * filter column, group rows (built-in / saved), sorting and row actions.
 */
export function QueueTable({
  groups,
  variant,
  sort = null,
  onSort,
}: {
  groups: QueueGroup[];
  variant: "home" | "views";
  sort?: Sort;
  onSort?: (s: Sort) => void;
}) {
  const { slug } = useWorkspace();
  const views = variant === "views";
  const head = (key: SortKey, label: string, title?: string, right = true) => {
    const active = sort?.key === key;
    const Arrow = sort?.dir === 1 ? ArrowUp : ArrowDown;
    const text = (
      <span className={cn("inline-flex items-center gap-1", headText, active ? "text-fg" : "text-dim")}>
        {label}
        {active ? <Arrow className="size-3" /> : null}
      </span>
    );
    return (
      <th key={key} title={title} className={cn("h-9 font-normal", right ? "pl-4 text-right" : "pl-10 text-left")}>
        {onSort ? (
          <button
            className="hover:[&>span]:text-fg"
            onClick={() =>
              onSort(active ? (sort!.dir === -1 ? { key, dir: 1 } : null) : { key, dir: key === "name" ? 1 : -1 })
            }
          >
            {text}
          </button>
        ) : (
          text
        )}
      </th>
    );
  };
  const colCount = COLUMNS.length + (views ? 4 : 2);

  return (
    <div className="overflow-x-auto">
      <table className={cn("w-full table-fixed border-collapse", views ? "min-w-[1100px]" : "min-w-[880px]")}>
        <colgroup>
          <col className={views ? "w-[236px]" : undefined} />
          {views ? <col /> : null}
          {COLUMNS.map((c) => (
            <col key={c.key} style={{ width: views ? c.views : c.home }} />
          ))}
          <col style={{ width: views ? 76 : 100 }} />
          {views ? <col className="w-[92px]" /> : null}
        </colgroup>
        <thead>
          <tr className="border-y border-line">
            {head("name", "View", undefined, false)}
            {views ? <th className={cn("h-9 pl-4 text-left text-dim", headText)}>Shows</th> : null}
            {COLUMNS.map((c) => head(c.key, c.label, c.title))}
            <th className={cn("h-9 pl-4 text-right text-dim", headText, !views && "pr-8")}>7d</th>
            {views ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <React.Fragment key={g.label}>
              {views ? (
                <tr className="border-b border-line-2 bg-white/[0.02]">
                  <td colSpan={colCount} className="h-[42px] pl-10">
                    <span className="font-mono text-[11px] font-medium tracking-[0.12em] text-fg-2 uppercase">
                      {g.label}
                    </span>
                    {g.note ? <span className="ml-4 font-mono text-[11px] text-dim">{g.note}</span> : null}
                  </td>
                </tr>
              ) : null}
              {sortQueues(g.queues, sort).map((q) => {
                const Icon = queueIcon(q.icon);
                const s = q.stats;
                return (
                  <tr
                    key={q.id}
                    className={cn(
                      "group border-b border-line-2 hover:bg-white/[0.02]",
                      views ? "h-[54px]" : "h-[46px]",
                    )}
                  >
                    <td className="pl-10">
                      <Link
                        to="/w/$slug/inbox/$view"
                        params={{ slug, view: q.id }}
                        className="flex min-w-0 items-center gap-2.5 text-[13px] text-fg-2 hover:text-fg"
                      >
                        <Icon className="size-3.5 shrink-0 text-dim" />
                        <span className="truncate">{q.name}</span>
                      </Link>
                    </td>
                    {views ? (
                      <td className="min-w-0 pl-4">
                        <FilterText filters={q.filters} />
                      </td>
                    ) : null}
                    <td className={num}>
                      <Count n={s.total} />
                    </td>
                    <td className={num}>
                      <Count n={s.waiting} />
                    </td>
                    <td className={num}>
                      <Count n={s.unassigned} />
                    </td>
                    <td className={num}>
                      <Count n={s.urgent} />
                    </td>
                    <td className={cn(num, "whitespace-nowrap")}>
                      {s.slaBreached ? (
                        <span className="text-warn">{s.slaBreached} late</span>
                      ) : s.slaSoon ? (
                        <span className="text-warn">{s.slaSoon} soon</span>
                      ) : (
                        <Nil />
                      )}
                    </td>
                    <td className={num}>
                      <Count n={s.drafts} tone="accent" />
                    </td>
                    <td className={num}>
                      {s.oldestWaitingAt ? <span className="text-fg-2">{ago(s.oldestWaitingAt)}</span> : <Nil />}
                    </td>
                    <td className={cn("pl-4 text-right", !views && "pr-8")}>
                      <DayBars values={s.trend} />
                    </td>
                    {views ? <td className="pr-6 text-right">{g.actions?.(q)}</td> : null}
                  </tr>
                );
              })}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A view's filters as one plain line: "open, pending · #billing #refund". */
export function FilterText({ filters }: { filters: ViewFilters }) {
  const { boot } = useWorkspace();
  const { data: session } = useSession();
  const parts: string[] = [];
  if (filters.status?.length) parts.push(filters.status.join(", "));
  if (filters.priority?.length) parts.push(`priority ${filters.priority.join(", ")}`);
  if (filters.assignee)
    parts.push(
      filters.assignee === "none"
        ? "nobody assigned"
        : filters.assignee === "me" || filters.assignee === session?.user.id
          ? "assigned to me"
          : `assigned to ${boot.members.find((m) => m.id === filters.assignee)?.name ?? "someone"}`,
    );
  if (filters.channel?.length) parts.push(filters.channel.join(", "));
  if (filters.aiState?.length)
    parts.push(filters.aiState.length > 2 ? "AI working or waiting" : filters.aiState.join(", ").replace(/_/g, " "));
  if (filters.tags?.length) parts.push(filters.tags.map((t) => `#${t}`).join(" "));
  if (filters.q) parts.push(`“${filters.q}”`);
  const text = parts.length ? parts.join(" · ") : "all tickets";
  return (
    <span className="block truncate font-mono text-[11px] text-dim" title={text}>
      {text}
    </span>
  );
}
