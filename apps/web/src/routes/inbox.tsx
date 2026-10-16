import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowDownUp,
  ArrowUp,
  Clock,
  Hand,
  PenLine,
  UserRoundCheck,
  Inbox as InboxIcon,
  LifeBuoy,
  Mail,
  MessageCircle,
  Pencil,
  Search,
  SlidersHorizontal,
  Sparkles,
  Webhook,
  X,
} from "lucide-react";
import { DiscordIcon, SlackIcon } from "@/components/brand-icons";
import { useJustArrived } from "@/lib/arrivals";
import { turnOf } from "@/lib/ticket-state";
import * as React from "react";
import { Avatar, Empty, Kbd, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Spinner, Tip } from "@/components/ui";
import { ViewDialog } from "@/features/view-dialog";
import type { TicketListItem } from "@/lib/types";
import { ago, cn } from "@/lib/utils";
import { qk, useWorkspace } from "@/lib/workspace";

const SYSTEM_TITLES: Record<string, string> = {
  inbox: "Inbox",
  ai: "AI queue",
  unassigned: "Unassigned",
  mine: "Assigned to me",
  resolved: "Resolved",
  all: "All tickets",
};

/** The built-in views, as tabs at the top of the inbox list. Saved views live in the sidebar. */
const INBOX_TABS: { view: string; label: string }[] = [
  { view: "inbox", label: "Open" },
  { view: "mine", label: "Mine" },
  { view: "unassigned", label: "Unassigned" },
  { view: "ai", label: "AI" },
  { view: "resolved", label: "Resolved" },
];
export const INBOX_VIEWS = Object.keys(SYSTEM_TITLES);

export const channelIcon = {
  email: Mail,
  widget: MessageCircle,
  slack: SlackIcon,
  discord: DiscordIcon,
  api: Webhook,
  web: Pencil,
  portal: LifeBuoy,
} as const;

export function priorityTone(p: string) {
  return p === "urgent" ? "danger" : p === "high" ? "warn" : p === "low" ? "neutral" : "info";
}

type Sort = "recent" | "oldest" | "priority";

export function InboxPage() {
  const { view, ...rest } = useParams({ strict: false }) as { view: string; ticket?: string };
  const { api, wid, slug, boot, isAdmin } = useWorkspace();
  const navigate = useNavigate();
  const [q, setQ] = React.useState("");
  const [deb, setDeb] = React.useState("");
  const [sort, setSort] = React.useState<Sort>("recent");
  const [editView, setEditView] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    const t = setTimeout(() => setDeb(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  const tickets = useQuery({
    queryKey: qk.tickets(wid, view, deb),
    queryFn: () =>
      api<{ tickets: TicketListItem[] }>(`/tickets?view=${view}${deb ? `&q=${encodeURIComponent(deb)}` : ""}`),
  });
  const counts = useQuery({
    queryKey: qk.counts(wid),
    queryFn: () => api<Record<string, number>>("/counts"),
    refetchInterval: 60_000,
  });
  const customView = boot.views.find((v) => v.id === view);
  const tabbed = !customView && INBOX_VIEWS.includes(view);
  const title =
    customView?.name ?? (INBOX_TABS.some((t) => t.view === view) ? "Inbox" : SYSTEM_TITLES[view]) ?? "Tickets";
  const list = React.useMemo(() => {
    const rows = [...(tickets.data?.tickets ?? [])];
    const prio = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
    if (sort === "oldest") rows.reverse();
    if (sort === "priority") rows.sort((a, b) => prio[a.priority] - prio[b.priority]);
    return rows;
  }, [tickets.data, sort]);

  // j/k keyboard navigation through the list.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, [contenteditable=true]")) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key !== "j" && e.key !== "k") return;
      const idx = list.findIndex((t) => String(t.number) === rest.ticket);
      const next = list[e.key === "j" ? Math.min(list.length - 1, idx + 1) : Math.max(0, idx - 1)];
      if (next) navigate({ to: "/w/$slug/inbox/$view/$ticket", params: { slug, view, ticket: String(next.number) } });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list, rest.ticket, navigate, slug, view]);

  return (
    <div className="flex h-full">
      <section
        className={cn(
          "flex w-full shrink-0 flex-col border-line bg-cell md:w-[332px] md:border-r",
          rest.ticket && "max-md:hidden",
        )}
      >
        <div className="flex h-[42px] shrink-0 items-center justify-between border-b border-line px-3.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-medium text-[#e8e8ef]">{title}</span>
            {tabbed ? null : (
              <span className="font-mono text-[11px] text-dim">{tickets.data?.tickets.length ?? ""}</span>
            )}
          </div>
          <div className="flex items-center gap-2.5 text-dim">
            {customView && isAdmin ? (
              <Tip label="Edit view">
                <button onClick={() => setEditView(true)} className="hover:text-fg">
                  <SlidersHorizontal className="size-[13px]" />
                </button>
              </Tip>
            ) : null}
            <Menu>
              <MenuTrigger className="outline-none hover:text-fg">
                <ArrowDownUp className="size-[13px]" />
              </MenuTrigger>
              <MenuContent>
                <MenuLabel>Sort</MenuLabel>
                {(["recent", "oldest", "priority"] as Sort[]).map((s) => (
                  <MenuItem key={s} onSelect={() => setSort(s)} className={sort === s ? "text-fg" : ""}>
                    {s === "recent" ? "Most recent" : s === "oldest" ? "Oldest first" : "Priority"}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          </div>
        </div>
        {tabbed ? (
          <div className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-line px-2">
            {INBOX_TABS.map((t) => (
              <Link
                key={t.view}
                to="/w/$slug/inbox/$view"
                params={{ slug, view: t.view }}
                className={cn(
                  "-mb-px flex items-center gap-1.5 border-b px-1.5 py-2 text-[12px] whitespace-nowrap",
                  view === t.view ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg-2",
                )}
              >
                {t.label}
                {t.view !== "resolved" && counts.data?.[t.view] ? (
                  <span className={cn("font-mono text-[11px]", view === t.view ? "text-accent-fg" : "text-dim")}>
                    {counts.data[t.view]}
                  </span>
                ) : null}
              </Link>
            ))}
          </div>
        ) : null}
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3.5">
          <Search className="size-3 text-dim" />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by subject, customer, #number"
            className="flex-1 bg-transparent text-[12px] text-fg placeholder:text-dim focus:outline-none"
          />
          {q ? (
            <button onClick={() => setQ("")} className="text-dim hover:text-fg">
              <X className="size-3" />
            </button>
          ) : (
            <Kbd>/</Kbd>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tickets.isPending ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : !list.length ? (
            <Empty icon={<InboxIcon />} title={deb ? "No matches" : "All caught up"}>
              {deb
                ? "Try a different search."
                : view === "ai"
                  ? "No drafts or escalations waiting for a human."
                  : "New conversations from email, the widget, Slack and the API land here."}
            </Empty>
          ) : (
            list.map((t) => (
              <TicketRow
                key={t.id}
                t={t}
                active={rest.ticket === String(t.number) || rest.ticket === t.id}
                view={view}
              />
            ))
          )}
        </div>
      </section>
      {/* Phones show the list or the open ticket, not both. */}
      <div className={cn("min-w-0 flex-1", !rest.ticket && "max-md:hidden")}>
        <Outlet />
      </div>
      {customView ? <ViewDialog open={editView} onOpenChange={setEditView} view={customView} /> : null}
    </div>
  );
}

/**
 * Unread rows are bold with an accent marker; read rows step back. The right edge carries what matters at a
 * glance as icons (AI draft, hand-off, priority, assignee) and the time, orange when the first reply is late.
 */
function TicketRow({ t, active, view }: { t: TicketListItem; active: boolean; view: string }) {
  const { slug, boot } = useWorkspace();
  const agent = boot.settings.ai.agentName;
  const fresh = useJustArrived(t.id);
  const turn = turnOf(t);
  const name = t.customer?.name ?? t.customer?.email ?? "Unknown visitor";
  const author = t.lastAuthorType === "agent" ? "Team" : t.lastAuthorType === "ai" ? agent : null;
  return (
    <Link
      to="/w/$slug/inbox/$view/$ticket"
      params={{ slug, view, ticket: String(t.number) }}
      className={cn(
        "relative flex gap-2 border-b border-line-2 py-2.5 pr-3.5 pl-2",
        active ? "bg-white/[0.06]" : "hover:bg-white/[0.03]",
        fresh && "arrive",
      )}
    >
      {active ? <span className="absolute inset-y-0 left-0 w-[2px] bg-fg" /> : null}
      <span className="flex w-2.5 shrink-0 justify-center pt-[6px]">
        {t.unread ? <span className="size-1.5 bg-accent" aria-label="Unread" /> : null}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-[13px]", t.unread ? "font-semibold text-fg" : "text-body")}>
            {name}
          </span>
          <RowSignals t={t} agent={agent} />
          <Tip
            label={
              turn.late
                ? `First reply ${ago(t.firstResponseDueAt)} overdue`
                : new Date(t.lastMessageAt).toLocaleString()
            }
          >
            <span
              className={cn(
                "shrink-0 font-mono text-[11px] tabular-nums",
                fresh ? "text-accent-text" : turn.late ? "text-warn" : "text-dim",
              )}
            >
              {fresh ? "new" : ago(t.lastMessageAt)}
            </span>
          </Tip>
        </div>
        <div className={cn("truncate text-[12.5px]", t.unread ? "font-medium text-fg-2" : "text-muted")}>
          {t.subject}
        </div>
        {t.preview && (author || !t.preview.startsWith(t.subject.replace(/…$/, ""))) ? (
          <div className={cn("truncate text-[12px]", t.unread ? "text-muted" : "text-faint")}>
            {author ? <span className="font-mono text-[11px] text-dim">{author} › </span> : null}
            {t.preview}
          </div>
        ) : null}
      </div>
    </Link>
  );
}

/** Icons only, each with a tooltip: what the AI did, whether a person must step in, priority, owner. */
function RowSignals({ t, agent }: { t: TicketListItem; agent: string }) {
  const icons: { key: string; label: string; el: React.ReactNode }[] = [];
  if (t.aiState === "draft_ready")
    icons.push({
      key: "draft",
      label: `${agent} drafted a reply`,
      el: <PenLine className="size-3 text-accent-text" />,
    });
  if (t.aiState === "processing")
    icons.push({
      key: "ai",
      label: `${agent} is working on it`,
      el: <Sparkles className="size-3 animate-pulse text-accent-text" />,
    });
  if (t.aiState === "awaiting_approval")
    icons.push({ key: "approval", label: "Waiting for your approval", el: <Hand className="size-3 text-warn" /> });
  if (t.aiState === "escalated")
    icons.push({
      key: "handoff",
      label: `Handed off by ${agent}`,
      el: <UserRoundCheck className="size-3 text-warn" />,
    });
  if (t.aiState === "error")
    icons.push({
      key: "error",
      label: `${agent} failed on this`,
      el: <AlertTriangle className="size-3 text-danger" />,
    });
  if (t.status === "pending")
    icons.push({ key: "pending", label: "Waiting on the customer", el: <Clock className="size-3 text-dim" /> });
  if (t.priority === "urgent" || t.priority === "high")
    icons.push({
      key: "prio",
      label: `${t.priority} priority`,
      el: <ArrowUp className={cn("size-3", t.priority === "urgent" ? "text-danger" : "text-warn")} />,
    });
  if (t.assigneeName)
    icons.push({
      key: "owner",
      label: `Assigned to ${t.assigneeName}`,
      el: <Avatar name={t.assigneeName} size={15} />,
    });
  if (!icons.length) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {icons.map((i) => (
        <Tip key={i.key} label={i.label}>
          <span className="flex items-center">{i.el}</span>
        </Tip>
      ))}
    </span>
  );
}

export function InboxEmpty() {
  const { boot } = useWorkspace();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <Sparkles className="size-5 text-accent-text" />
      <div className="text-[13px] text-fg-3">Select a conversation</div>
      <div className="flex items-center gap-3 font-mono text-[11.5px] text-dim">
        <span>
          <Kbd>j</Kbd>/<Kbd>k</Kbd> move
        </span>
        <span>
          <Kbd>/</Kbd> filter
        </span>
        <span>
          <Kbd>⌘K</Kbd> ask {boot.settings.ai.agentName}
        </span>
      </div>
    </div>
  );
}
