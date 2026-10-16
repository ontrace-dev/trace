import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import * as React from "react";
import { Avatar, Spinner } from "@/components/ui";
import { AiPill, StatusPill, UnreadBadge } from "@/features/ticket/badges";
import { useJustArrived } from "@/lib/arrivals";
import { turnOf } from "@/lib/ticket-state";
import type { TicketListItem } from "@/lib/types";
import { ago, cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { homeKeys, type Overview } from "./types";

/*
 * Home, kept simple on purpose: four counts, the open tickets in the order to look at them (unread first,
 * then whoever has waited longest), and a feed of what just happened. Everything in words, nothing to decode.
 */

export function HomePage() {
  const { api, wid } = useWorkspace();
  const q = useQuery({
    queryKey: homeKeys.overview(wid),
    queryFn: () => api<Overview>("/overview"),
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
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1360px] flex-col gap-6 px-4 py-6 md:px-8 md:py-8">
        <h1 className="text-[20px] font-semibold tracking-[-0.3px] text-fg">Home</h1>
        <Stats s={d.stats} />
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <OpenTickets tickets={d.tickets} total={d.stats.open + d.stats.pending} />
          <Activity items={d.activity} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ counts */

function Stats({ s }: { s: Overview["stats"] }) {
  const { slug } = useWorkspace();
  const cards: { label: string; value: number; sub: React.ReactNode; view: string; highlight?: boolean }[] = [
    {
      label: "Unread",
      value: s.unread,
      sub: s.unread ? "new customer messages" : "you're all caught up",
      view: "inbox",
      highlight: s.unread > 0,
    },
    {
      label: "Open",
      value: s.open,
      sub: s.overdue ? <span className="text-danger">{s.overdue} overdue</span> : "customers waiting for a reply",
      view: "inbox",
    },
    { label: "Pending", value: s.pending, sub: "waiting on the customer", view: "inbox" },
    {
      label: "Solved in the last 24h",
      value: s.solved,
      sub: s.solvedByAi ? `${s.solvedByAi} by the AI` : "by your team",
      view: "resolved",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((c) => (
        <Link
          key={c.label}
          to="/w/$slug/inbox/$view"
          params={{ slug, view: c.view }}
          className={cn(
            "flex flex-col gap-1 border p-4 hover:border-line-strong",
            c.highlight ? "border-accent/40 bg-accent/[0.06]" : "border-line bg-raised",
          )}
        >
          <span className="text-[13px] text-muted">{c.label}</span>
          <span
            className={cn(
              "text-[28px] leading-tight font-semibold tabular-nums",
              c.highlight ? "text-accent-text" : "text-fg",
            )}
          >
            {c.value}
          </span>
          <span className="text-[12.5px] text-muted">{c.sub}</span>
        </Link>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ open tickets */

function Card({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col border border-line bg-raised">
      <header className="flex h-12 items-center justify-between border-b border-line px-4">
        <h2 className="text-[14px] font-semibold text-fg">{title}</h2>
        {right}
      </header>
      {children}
    </section>
  );
}

function OpenTickets({ tickets, total }: { tickets: TicketListItem[]; total: number }) {
  const { slug } = useWorkspace();
  return (
    <Card
      title="Open tickets"
      right={
        <Link
          to="/w/$slug/inbox/$view"
          params={{ slug, view: "inbox" }}
          className="text-[13px] text-muted hover:text-fg"
        >
          View all {total} →
        </Link>
      }
    >
      {tickets.length ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left sm:min-w-[640px]">
            <thead>
              <tr className="border-b border-line text-[12px] text-muted">
                <th className="w-[92px] px-4 py-2 font-medium">Status</th>
                <th className="px-2 py-2 font-medium">Ticket</th>
                <th className="w-[140px] px-2 py-2 font-medium max-sm:hidden">AI</th>
                <th className="w-[96px] px-2 py-2 font-medium max-sm:hidden">Waiting</th>
                <th className="w-[110px] px-4 py-2 font-medium max-md:hidden">Assignee</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => (
                <TicketRow key={t.id} t={t} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-4 py-10 text-center text-[13.5px] text-muted">No open tickets. Nice work.</p>
      )}
    </Card>
  );
}

function TicketRow({ t }: { t: TicketListItem }) {
  const { slug } = useWorkspace();
  const fresh = useJustArrived(t.id);
  const turn = turnOf(t);
  const navigate = useNavigate();
  const name = t.customer?.name ?? t.customer?.email ?? "Unknown visitor";
  return (
    <tr
      className={cn("cursor-pointer border-b border-line-2 last:border-b-0 hover:bg-white/[0.035]", fresh && "arrive")}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("a"))
          navigate({ to: "/w/$slug/inbox/$view/$ticket", params: { slug, view: "inbox", ticket: String(t.number) } });
      }}
    >
      <td className="px-4 py-3 align-top">
        <StatusPill t={t} />
      </td>
      <td className="max-w-0 px-2 py-3">
        <Link
          to="/w/$slug/inbox/$view/$ticket"
          params={{ slug, view: "inbox", ticket: String(t.number) }}
          className="flex min-w-0 items-center gap-2"
        >
          <span className={cn("truncate text-[14px]", t.unread ? "font-semibold text-fg" : "text-fg-2")}>
            {t.subject}
          </span>
          <UnreadBadge n={t.unreadCount} />
        </Link>
        <div className="truncate text-[12.5px] text-muted">
          {name} · #{t.number}
          {turn.late ? <span className="font-medium text-danger sm:hidden"> · overdue</span> : null}
        </div>
      </td>
      <td className="px-2 py-3 align-top max-sm:hidden">
        <AiPill state={t.aiState} />
      </td>
      <td className="px-2 py-3 align-top text-[13px] whitespace-nowrap max-sm:hidden">
        {turn.who === "us" ? (
          <span className={turn.late ? "font-medium text-danger" : "text-fg-3"}>
            {ago(t.lastCustomerMessageAt ?? t.createdAt)}
            {turn.late ? " · overdue" : ""}
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="truncate px-4 py-3 align-top text-[13px] text-fg-3 max-md:hidden">
        {t.assigneeName ?? <span className="text-muted">Unassigned</span>}
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------ activity */

function Activity({ items }: { items: Overview["activity"] }) {
  const { slug } = useWorkspace();
  return (
    <Card title="Recent activity">
      {items.length ? (
        <ol className="max-h-[720px] overflow-y-auto">
          {items.map((a) => (
            <li key={a.id}>
              <Link
                to="/w/$slug/inbox/$view/$ticket"
                params={{ slug, view: "inbox", ticket: String(a.number) }}
                className="flex gap-3 border-b border-line-2 px-4 py-3 hover:bg-white/[0.035]"
              >
                {a.actor === "ai" ? (
                  <span className="flex size-7 shrink-0 items-center justify-center bg-accent/15 text-accent-text">
                    <Sparkles className="size-3.5" />
                  </span>
                ) : a.actor === "system" ? (
                  <span className="flex size-7 shrink-0 items-center justify-center">
                    <span className="size-1.5 bg-white/30" />
                  </span>
                ) : (
                  <Avatar name={a.who} size={28} tone={a.actor === "customer" ? "neutral" : "accent"} />
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 text-[13px] text-fg-3">
                      {a.who ? <span className="font-semibold text-fg">{a.who} </span> : null}
                      {a.what}
                    </span>
                    <span className="shrink-0 text-[12px] text-muted">{ago(a.at)}</span>
                  </div>
                  <span className="truncate text-[12.5px] text-muted">
                    #{a.number} · {a.subject}
                  </span>
                  {a.preview ? <span className="line-clamp-2 text-[12.5px] text-body">{a.preview}</span> : null}
                </div>
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <p className="px-4 py-10 text-center text-[13.5px] text-muted">Nothing has happened yet.</p>
      )}
    </Card>
  );
}
