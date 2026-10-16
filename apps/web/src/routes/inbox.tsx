import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowDownUp,
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
import { aiTagOf, turnOf } from "@/lib/ticket-state";
import * as React from "react";
import {
  Avatar,
  Empty,
  Kbd,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuTrigger,
  Spinner,
  StatusDot,
  Tip,
} from "@/components/ui";
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
 * One line of "who and what" (customer, subject), one line of the latest message with its author,
 * and one line of state: whose turn it is first, then the AI's part, then priority and assignee.
 */
function TicketRow({ t, active, view }: { t: TicketListItem; active: boolean; view: string }) {
  const { slug, boot } = useWorkspace();
  const Channel = channelIcon[t.channel] ?? Mail;
  const turn = turnOf(t);
  const ai = aiTagOf(t.aiState, boot.settings.ai.agentName);
  // Our turn and the customer spoke last: nobody has answered their latest message yet.
  const unanswered = turn.who === "us" && t.lastAuthorType !== "agent" && t.lastAuthorType !== "ai";
  const name = t.customer?.name ?? t.customer?.email ?? "Unknown visitor";
  const author = t.lastAuthorType === "agent" ? "Team" : t.lastAuthorType === "ai" ? boot.settings.ai.agentName : null;
  const high = t.priority === "urgent" || t.priority === "high";
  return (
    <Link
      to="/w/$slug/inbox/$view/$ticket"
      params={{ slug, view, ticket: String(t.number) }}
      className={cn(
        "relative flex gap-3 border-b border-line-2 px-3.5 py-3",
        active ? "bg-white/[0.05]" : "hover:bg-white/[0.025]",
      )}
    >
      {active ? <span className="absolute inset-y-0 left-0 w-[2px] bg-accent" /> : null}
      <span className="relative mt-0.5 shrink-0">
        <Avatar name={name} src={t.customer?.avatarUrl} size={30} tone="neutral" />
        {unanswered ? (
          <span
            className={cn("absolute -top-0.5 -right-0.5 size-2 ring-2 ring-cell", turn.late ? "bg-warn" : "bg-accent")}
            aria-label="Waiting for a reply"
          />
        ) : null}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <div className="flex items-baseline justify-between gap-2">
          <span className={cn("truncate text-[13px]", unanswered ? "font-semibold text-fg" : "font-medium text-fg-3")}>
            {name}
          </span>
          <Tip label={`${t.channel} · last message ${new Date(t.lastMessageAt).toLocaleString()}`}>
            <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-dim">
              <Channel className="size-3" />
              {ago(t.lastMessageAt)}
            </span>
          </Tip>
        </div>
        <div className={cn("truncate text-[12.5px] leading-[1.35]", unanswered ? "text-fg-2" : "text-fg-3")}>
          {t.subject}
        </div>
        {t.preview ? (
          <div className="truncate text-[12px] leading-[1.4] text-faint">
            {author ? <span className="text-muted">{author}: </span> : null}
            {t.preview}
          </div>
        ) : null}
        <div className="flex items-center gap-3 pt-1">
          {view === "resolved" && turn.who === "done" ? null : (
            <StatusDot tone={turn.tone}>{turn.late ? `${turn.label} · late` : turn.label}</StatusDot>
          )}
          {ai && ai.label !== turn.label ? (
            <StatusDot tone={ai.tone} pulse={ai.pulse}>
              {ai.label}
            </StatusDot>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {high ? (
              <span
                className={cn(
                  "text-[11px] font-semibold tracking-wide uppercase",
                  t.priority === "urgent" ? "text-danger" : "text-warn",
                )}
              >
                {t.priority}
              </span>
            ) : null}
            {t.assigneeName ? (
              <Tip label={`Assigned to ${t.assigneeName}`}>
                <span>
                  <Avatar name={t.assigneeName} size={18} />
                </span>
              </Tip>
            ) : null}
          </span>
        </div>
      </div>
    </Link>
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
