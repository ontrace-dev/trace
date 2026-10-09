import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, ExternalLink, Plus, Sparkles, X } from "lucide-react";
import * as React from "react";
import { Avatar, Badge, Select } from "@/components/ui";
import type { TicketDetail } from "@/lib/types";
import { ago, clock, cn, monthYear } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { useTicketActions } from "./use-ticket";
import { FieldRows, LinkedIssues } from "@/features/issues/ticket-fields";
import { type RoutingData, routingKeys } from "@/features/routing/types";

const statusDot: Record<string, string> = { open: "bg-info", pending: "bg-warn", resolved: "bg-ok", closed: "bg-dim" };

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-[9px]">
      <span className="font-mono text-[11.5px] text-dim">{k}</span>
      <span className="truncate text-[12.5px] font-medium text-fg-2">{v}</span>
    </div>
  );
}

/** A panel section that starts collapsed, with a one-line hint; the choice sticks per section. */
function Fold({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  const key = `trace:panel-open:${id}`;
  const [open, setOpen] = React.useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setOpen((v) => {
      try {
        localStorage.setItem(key, v ? "0" : "1");
      } catch {}
      return !v;
    });
  return (
    <div className="flex flex-col border-b border-line">
      <button
        onClick={toggle}
        aria-expanded={open}
        className="flex h-9 shrink-0 items-center gap-1.5 px-4 text-left hover:bg-white/[0.02]"
      >
        <ChevronRight className={cn("size-3 text-dim transition-transform", open && "rotate-90")} />
        <span className="label-mono">{label}</span>
        {hint != null ? <span className="ml-auto truncate font-mono text-[11px] text-dim">{hint}</span> : null}
      </button>
      {open ? children : null}
    </div>
  );
}

function formatAttr(v: unknown) {
  if (typeof v === "number") return v.toLocaleString();
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (v == null) return "—";
  return String(v);
}

export function ContextPanel({ data, onIssue }: { data: TicketDetail; onIssue: (mode: "create" | "link") => void }) {
  const { slug, boot } = useWorkspace();
  const { ticket, customer, customerStats, recent } = data;
  const { update } = useTicketActions(ticket.id);
  const [tag, setTag] = React.useState("");
  // Attributes that feed a ticket field show up as that field — don't list them twice.
  const asFields = new Set(data.fields.filter((f) => f.setBy === "customer").map((f) => f.key));
  const attrs = Object.entries(customer?.attributes ?? {})
    .filter(([k, v]) => typeof v !== "object" && !asFields.has(k))
    .slice(0, 6);
  const plan = customer?.attributes.plan as string | undefined;
  const sentimentTone = ticket.aiSentiment === "negative" || ticket.aiSentiment === "angry" ? "text-warn" : "text-ok";

  return (
    <aside className="flex w-[322px] shrink-0 flex-col overflow-y-auto border-l border-line bg-bar">
      <div className="flex h-[42px] shrink-0 items-center justify-between border-b border-line px-4">
        <span className="label-mono">Customer</span>
        {customer ? (
          <Link
            to="/w/$slug/customers/$customerId"
            params={{ slug, customerId: customer.id }}
            className="text-dim hover:text-fg"
          >
            <ExternalLink className="size-[13px]" />
          </Link>
        ) : null}
      </div>
      {customer ? (
        <>
          <div className="flex flex-col gap-3.5 border-b border-line p-4">
            <div className="flex items-center gap-[11px]">
              <Avatar name={customer.name ?? customer.email} src={customer.avatarUrl} size={38} />
              <div className="flex min-w-0 flex-col gap-[3px]">
                <span className="truncate text-[14px] font-semibold text-[#f0f0f5]">{customer.name ?? "Unknown"}</span>
                <span className="truncate font-mono text-[11.5px] text-dim">{customer.email ?? "no email"}</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {plan ? (
                <Badge tone="accent" upper>
                  {plan} plan
                </Badge>
              ) : null}
              {customer.company ? <Badge upper>{customer.company}</Badge> : null}
              {ticket.aiLanguage ? <Badge upper>{ticket.aiLanguage}</Badge> : null}
              {typeof customer.attributes.nps === "number" ? (
                <Badge tone="ok" upper>
                  NPS {String(customer.attributes.nps)}
                </Badge>
              ) : null}
            </div>
          </div>
          <Fold
            id="customer"
            label="Details"
            hint={`${customerStats?.open ?? 0} open · ${customerStats?.total ?? 0} lifetime`}
          >
            <div className="pb-1">
              {attrs
                .filter(([k]) => !["plan", "nps"].includes(k))
                .map(([k, v]) => (
                  <Row key={k} k={k.replace(/_/g, " ")} v={formatAttr(v)} />
                ))}
              <Row k="open tickets" v={customerStats?.open ?? 0} />
              <Row k="lifetime tickets" v={customerStats?.total ?? 0} />
              <Row k="customer since" v={monthYear(customer.createdAt)} />
            </div>
          </Fold>
        </>
      ) : (
        <div className="border-b border-line p-4 text-xs text-dim">Anonymous visitor</div>
      )}

      {ticket.aiSummary || ticket.aiIntent ? (
        <div className="flex flex-col gap-2.5 border-b border-line bg-accent/[0.06] p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-[7px]">
              <Sparkles className="size-3 text-accent-text" />
              <span className="font-mono text-[11px] font-medium tracking-[0.14em] text-accent-text">
                {boot.settings.ai.agentName.toUpperCase()} READ
              </span>
            </div>
            {ticket.aiSentiment ? (
              <span className={cn("font-mono text-[11px]", sentimentTone)}>mood: {ticket.aiSentiment}</span>
            ) : null}
          </div>
          {ticket.aiSummary ? <p className="text-[12px] leading-[1.6] text-body">{ticket.aiSummary}</p> : null}
          {ticket.aiIntent ? (
            <div className="flex flex-wrap gap-1.5">
              <Badge tone="solid-accent">{ticket.aiIntent}</Badge>
              {ticket.aiConfidence != null && ticket.aiConfidence > 0 ? (
                <Badge>conf {Math.round(ticket.aiConfidence * 100)}%</Badge>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {ticket.routing?.auto && ticket.assigneeId ? <Assignment data={data} /> : null}

      <div className="flex flex-col gap-3 border-b border-line p-4">
        <span className="label-mono">Properties</span>
        <div className="grid grid-cols-[92px_1fr] items-center gap-x-3 gap-y-2">
          <span className="font-mono text-[11.5px] text-dim">status</span>
          <Select
            className="h-7 text-[12px]"
            value={ticket.status}
            onChange={(e) => update.mutate({ status: e.target.value as never })}
          >
            {["open", "pending", "resolved", "closed"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
          <span className="font-mono text-[11.5px] text-dim">priority</span>
          <Select
            className="h-7 text-[12px]"
            value={ticket.priority}
            onChange={(e) => update.mutate({ priority: e.target.value as never })}
          >
            {["low", "normal", "high", "urgent"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
          <span className="font-mono text-[11.5px] text-dim">assignee</span>
          <Select
            className="h-7 text-[12px]"
            value={ticket.assigneeId ?? ""}
            onChange={(e) => update.mutate({ assigneeId: e.target.value || null })}
          >
            <option value="">Unassigned</option>
            {boot.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
          <span className="self-start pt-1 font-mono text-[11.5px] text-dim">tags</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {ticket.tags.map((t) => (
              <span
                key={t}
                className="flex items-center gap-1 border border-accent/35 px-1.5 py-[1px] font-mono text-[11px] text-accent-fg"
              >
                {t}
                <button
                  onClick={() => update.mutate({ tags: ticket.tags.filter((x) => x !== t) })}
                  className="text-accent/60 hover:text-fg"
                >
                  <X className="size-2.5" />
                </button>
              </span>
            ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (tag.trim()) update.mutate({ tags: [...ticket.tags, tag.trim().toLowerCase()] });
                setTag("");
              }}
              className="flex items-center gap-1"
            >
              <Plus className="size-3 text-dim" />
              <input
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder="tag"
                className="w-16 bg-transparent font-mono text-[11.5px] text-fg placeholder:text-dim focus:outline-none"
              />
            </form>
          </div>
          <span className="font-mono text-[11.5px] text-dim">channel</span>
          <span className="font-mono text-[11px] text-fg-3">{ticket.channel}</span>
          <FieldRows data={data} />
        </div>
      </div>

      <LinkedIssues data={data} onCreate={onIssue} />

      {recent.length ? (
        <Fold id="recent" label="Recent tickets" hint={recent.length}>
          {recent.map((r) => (
            <Link
              key={r.id}
              to="/w/$slug/inbox/$view/$ticket"
              params={{ slug, view: "all", ticket: String(r.number) }}
              className="flex flex-col gap-[5px] border-t border-line px-4 py-2.5 hover:bg-white/[0.02]"
            >
              <span className="truncate text-[12.5px] text-fg-3">{r.subject}</span>
              <span className="flex items-center gap-[7px]">
                <span className={cn("h-1 w-1", statusDot[r.status])} />
                <span className="font-mono text-[11px] text-dim">
                  {r.status} · {ago(r.createdAt)}
                </span>
              </span>
            </Link>
          ))}
        </Fold>
      ) : null}

      <Sla data={data} />
    </aside>
  );
}

function Sla({ data }: { data: TicketDetail }) {
  const { ticket } = data;
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    const t = setInterval(force, 30_000);
    return () => clearInterval(t);
  }, []);
  if (!ticket.firstResponseDueAt) return null;
  const created = new Date(ticket.createdAt).getTime();
  const due = new Date(ticket.firstResponseDueAt).getTime();
  const responded = ticket.firstRespondedAt ? new Date(ticket.firstRespondedAt).getTime() : null;
  const now = responded ?? Date.now();
  const pct = Math.min(1, Math.max(0, (now - created) / Math.max(1, due - created)));
  const left = due - now;
  const breached = left < 0;
  const fmt = (ms: number) => {
    const m = Math.round(Math.abs(ms) / 60_000);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  };
  const label = responded
    ? breached
      ? `met late by ${fmt(left)}`
      : `met · ${fmt(responded - created)}`
    : breached
      ? `breached ${fmt(left)} ago`
      : `${fmt(left)} left`;
  const color = responded && !breached ? "#86efac" : breached ? "#fca5a5" : pct > 0.6 ? "#fdba74" : "#93c5fd";
  return (
    <div className="mt-auto flex flex-col gap-2.5 border-t border-line p-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] font-medium tracking-[0.13em] text-dim">FIRST RESPONSE SLA</span>
        <span className="font-mono text-[11.5px]" style={{ color }}>
          {label}
        </span>
      </div>
      <div className="h-1 bg-white/[0.08]">
        <div className="h-full" style={{ width: `${pct * 100}%`, background: color }} />
      </div>
    </div>
  );
}

/** Why trace routed this ticket to this person, and when it goes back to the group if nobody replies. */
function Assignment({ data }: { data: TicketDetail }) {
  const { api, wid, boot } = useWorkspace();
  const { ticket } = data;
  const r = ticket.routing!;
  const settings = useQuery({
    queryKey: routingKeys.all(wid),
    queryFn: () => api<RoutingData>("/routing"),
    staleTime: 60_000,
  }).data?.settings;
  const assignee = boot.members.find((m) => m.id === ticket.assigneeId);
  const [now, setNow] = React.useState(Date.now());
  const [why, setWhy] = React.useState(false);
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  // Mirrors the server's safety net: hand back when the window before the target opens, or after a grace
  // period when the ticket was assigned inside that window.
  let handBack: { at: number; from: number } | null = null;
  const net = settings?.reassign;
  if (
    net?.enabled &&
    ticket.status === "open" &&
    !ticket.firstRespondedAt &&
    ticket.firstResponseDueAt &&
    ticket.assignedAt &&
    r.reassignments < net.maxTimes
  ) {
    const window = net.minutesBeforeDue * 60_000;
    const start = new Date(ticket.firstResponseDueAt).getTime() - window;
    const from = new Date(ticket.assignedAt).getTime();
    handBack = { at: from < start ? start : from + Math.max(window, 5 * 60_000), from };
  }
  const left = handBack ? handBack.at - now : 0;
  const progress = handBack
    ? Math.min(1, Math.max(0, (now - handBack.from) / Math.max(1, handBack.at - handBack.from)))
    : 0;
  const rows: [string, React.ReactNode, string?][] = [
    ["routed by", `${boot.settings.ai.agentName} · ${clock(r.at)}`, "text-accent-text"],
    ["because", r.because],
    ["rule", r.ruleLabel],
    ["picked", r.pick],
  ];
  if (r.reassignments) rows.push(["handed on", `${r.reassignments}×`, "text-warn"]);
  return (
    <div className="flex flex-col border-b border-line">
      <div className="flex h-[42px] items-center justify-between px-4">
        <span className="label-mono">Assigned</span>
        <button
          onClick={() => setWhy((v) => !v)}
          aria-expanded={why}
          className="flex items-center gap-1 font-mono text-[11px] text-dim hover:text-fg"
        >
          why <ChevronRight className={cn("size-3 transition-transform", why && "rotate-90")} />
        </button>
      </div>
      <div className="flex items-center gap-2.5 px-4 pb-3">
        <Avatar name={assignee?.name} src={assignee?.image} size={28} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[13px] font-medium text-fg">{assignee?.name ?? "Someone"}</span>
          <span className="truncate font-mono text-[11px] text-dim">{r.groupName ?? "no group"}</span>
        </div>
      </div>
      <div className={cn("flex flex-col gap-2 px-4 pb-4", !why && "hidden")}>
        {rows.map(([k, v, tone]) => (
          <div key={k} className="flex items-baseline justify-between gap-3 font-mono text-[11px]">
            <span className="shrink-0 text-dim">{k}</span>
            <span
              className={cn("truncate text-right", tone ?? "text-fg-2")}
              title={typeof v === "string" ? v : undefined}
            >
              {v}
            </span>
          </div>
        ))}
      </div>
      {handBack ? (
        <div className="flex flex-col gap-2.5 border-t border-line p-4">
          <div className="flex items-center justify-between font-mono text-[11px]">
            <span className="font-medium tracking-[0.12em] text-dim">HANDS BACK</span>
            <span className="text-warn">
              {left > 60_000 ? `in ${ago(new Date(now - left))} if no reply` : "any moment now"}
            </span>
          </div>
          <div className="h-1 bg-white/[0.08]">
            <div className="h-full bg-warn" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
