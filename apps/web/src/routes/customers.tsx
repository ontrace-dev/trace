import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, Search, Users } from "lucide-react";
import * as React from "react";
import { Avatar, Badge, Empty, Spinner } from "@/components/ui";
import { channelIcon, priorityTone } from "./inbox";
import type { Customer, TicketChannel, TicketPriority, TicketStatus } from "@/lib/types";
import { ago, monthYear } from "@/lib/utils";
import { qk, useWorkspace } from "@/lib/workspace";

export function PageHeader({
  title,
  count,
  children,
}: {
  title: string;
  count?: number | string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[42px] shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-1.5 md:px-5">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-[#e8e8ef]">{title}</span>
        {count !== undefined ? <span className="font-mono text-[11px] text-dim">{count}</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

type CustomerRow = Customer & { tickets: number; openTickets: number };

export function CustomersPage() {
  const { api, wid, slug } = useWorkspace();
  const [q, setQ] = React.useState("");
  const list = useQuery({
    queryKey: qk.customers(wid, q),
    queryFn: () => api<{ customers: CustomerRow[] }>(`/customers${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  });
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Customers" count={list.data?.customers.length}>
        <div className="flex h-7 items-center gap-2 border border-line-strong bg-input px-2">
          <Search className="size-3 text-dim" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, email, company"
            className="w-56 bg-transparent text-[12px] text-fg placeholder:text-dim focus:outline-none"
          />
        </div>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isPending ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : !list.data?.customers.length ? (
          <Empty icon={<Users />} title="No customers yet">
            Customers are created automatically from email senders, widget visitors, Slack users and API calls.
          </Empty>
        ) : (
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-bg">
              <tr className="border-b border-line font-mono text-[11px] tracking-[0.1em] text-dim uppercase">
                <th className="px-5 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Company</th>
                <th className="px-3 py-2 font-medium">Plan</th>
                <th className="px-3 py-2 text-right font-medium">Open</th>
                <th className="px-3 py-2 text-right font-medium">Tickets</th>
                <th className="px-5 py-2 text-right font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {list.data.customers.map((c) => (
                <tr key={c.id} className="border-b border-line-2 hover:bg-white/[0.02]">
                  <td className="px-5 py-2.5">
                    <Link
                      to="/w/$slug/customers/$customerId"
                      params={{ slug, customerId: c.id }}
                      className="flex items-center gap-2.5"
                    >
                      <Avatar name={c.name ?? c.email} src={c.avatarUrl} size={26} tone="neutral" />
                      <span className="flex flex-col">
                        <span className="text-[13px] text-fg-2">{c.name ?? "—"}</span>
                        <span className="font-mono text-[11.5px] text-dim">{c.email ?? "anonymous"}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 text-[12.5px] text-muted">{c.company ?? "—"}</td>
                  <td className="px-3">
                    {c.attributes.plan ? (
                      <Badge tone="accent" upper>
                        {String(c.attributes.plan)}
                      </Badge>
                    ) : (
                      <span className="text-dim">—</span>
                    )}
                  </td>
                  <td className="px-3 text-right font-mono text-[12px] text-fg-3">{c.openTickets || ""}</td>
                  <td className="px-3 text-right font-mono text-[12px] text-muted">{c.tickets}</td>
                  <td className="px-5 text-right font-mono text-[11px] text-dim">{ago(c.lastSeenAt ?? c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

interface CustomerTicket {
  id: string;
  number: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  channel: TicketChannel;
  createdAt: string;
  lastMessageAt: string;
}

export function CustomerDetail() {
  const { customerId } = useParams({ from: "/w/$slug/customers/$customerId" });
  const { api, wid, slug, boot } = useWorkspace();
  const q = useQuery({
    queryKey: qk.customer(wid, customerId),
    queryFn: () => api<{ customer: Customer; tickets: CustomerTicket[] }>(`/customers/${customerId}`),
  });
  if (q.isPending)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  if (!q.data) return <Empty title="Customer not found" />;
  const { customer: c, tickets } = q.data;
  return (
    <div className="flex h-full flex-col">
      <PageHeader title={c.name ?? c.email ?? "Customer"}>
        <Link
          to="/w/$slug/customers"
          params={{ slug }}
          className="flex items-center gap-1.5 text-xs text-muted hover:text-fg"
        >
          <ArrowLeft className="size-3" /> All customers
        </Link>
      </PageHeader>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="border-b border-line px-5 py-2 label-mono">Conversations · {tickets.length}</div>
          {tickets.map((t) => {
            const Ch = channelIcon[t.channel];
            return (
              <Link
                key={t.id}
                to="/w/$slug/inbox/$view/$ticket"
                params={{ slug, view: "all", ticket: String(t.number) }}
                className="flex items-center gap-3 border-b border-line-2 px-5 py-3 hover:bg-white/[0.02]"
              >
                <span className="w-16 font-mono text-[11.5px] text-dim">
                  {boot.settings.ticketPrefix}-{t.number}
                </span>
                <Ch className="size-3.5 text-dim" />
                <span className="flex-1 truncate text-[13px] text-fg-3">{t.subject}</span>
                <Badge tone={priorityTone(t.priority)} upper>
                  {t.priority}
                </Badge>
                <Badge tone={t.status === "resolved" || t.status === "closed" ? "ok" : "neutral"} upper>
                  {t.status}
                </Badge>
                <span className="w-10 text-right font-mono text-[11.5px] text-dim">{ago(t.lastMessageAt)}</span>
              </Link>
            );
          })}
        </div>
        <aside className="w-[322px] shrink-0 border-l border-line bg-bar">
          <div className="flex items-center gap-3 border-b border-line p-4">
            <Avatar name={c.name ?? c.email} src={c.avatarUrl} size={42} />
            <div className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-[15px] font-semibold text-fg">{c.name}</span>
              <span className="truncate font-mono text-[11.5px] text-muted">{c.email}</span>
            </div>
          </div>
          <div className="py-1">
            {[
              ["company", c.company ?? "—"],
              ["customer since", monthYear(c.createdAt)],
              ["last seen", c.lastSeenAt ? `${ago(c.lastSeenAt)} ago` : "—"],
              ...Object.entries(c.attributes).map(([k, v]) => [
                k.replace(/_/g, " "),
                typeof v === "object" ? JSON.stringify(v) : String(v),
              ]),
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3 px-4 py-[9px]">
                <span className="font-mono text-[11.5px] text-dim">{k}</span>
                <span className="truncate text-[12.5px] text-fg-2">{v}</span>
              </div>
            ))}
          </div>
          <div className="border-t border-line p-4 text-[11.5px] leading-relaxed text-dim">
            Enrich customers from your backend with <span className="font-mono text-muted">PUT /api/v1/customers</span>{" "}
            — attributes like plan, MRR or NPS show up next to every ticket and are available to the AI agent.
          </div>
        </aside>
      </div>
    </div>
  );
}
