import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import {
  BarChart3,
  Bell,
  Bot,
  Check,
  ChevronDown,
  CircleHelp,
  House,
  Inbox,
  Layers,
  LogOut,
  type LucideIcon,
  Menu as MenuIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { Dialog as D } from "radix-ui";
import * as React from "react";
import { FullSpinner } from "./auth";
import { Mark } from "@/components/logo";
import { Avatar, Kbd, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tip } from "@/components/ui";
import { CommandBar } from "@/features/command-bar";
import { NewTicketDialog } from "@/features/new-ticket";
import { INBOX_VIEWS } from "./inbox";
import { routingKeys } from "@/features/routing/types";
import { ViewDialog } from "@/features/view-dialog";
import { authClient, signOut, useSession } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { viewIcons } from "@/lib/view-icons";
import { qk, useWorkspace, WorkspaceProvider } from "@/lib/workspace";

export function WorkspaceLayout() {
  const { slug } = useParams({ from: "/w/$slug" });
  const { data: session, isPending } = useSession();
  const orgs = useQuery({
    queryKey: ["orgs", session?.user.id],
    enabled: !!session,
    queryFn: async () => (await authClient.organization.list()).data ?? [],
  });
  if (isPending || (session && orgs.isPending)) return <FullSpinner />;
  if (!session) return <Navigate to="/login" search={{ next: location.pathname } as never} />;
  const org = orgs.data?.find((o) => o.slug === slug);
  if (!org) return <Navigate to="/" />;
  localStorage.setItem("trace:last-workspace", slug);
  return (
    <WorkspaceProvider wid={org.id} slug={slug} key={org.id}>
      <Shell />
    </WorkspaceProvider>
  );
}

const RAIL_KEY = "trace:rail-collapsed";

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

function Shell() {
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [newTicket, setNewTicket] = React.useState(false);
  const [navOpen, setNavOpen] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(RAIL_KEY);
    } catch {}
    // Until someone picks, narrower windows start with the icon rail to leave room for the ticket.
    return saved ? saved === "1" : window.innerWidth < 1280;
  });
  const toggleRail = React.useCallback(() => {
    setCollapsed((v) => {
      try {
        localStorage.setItem(RAIL_KEY, v ? "0" : "1");
      } catch {}
      return !v;
    });
  }, []);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  React.useEffect(() => setNavOpen(false), [pathname]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((v) => !v);
      } else if (e.key === "[" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)) {
        e.preventDefault();
        toggleRail();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleRail]);
  return (
    <div className="flex h-full flex-col">
      <AppBar
        onCommand={() => setCmdOpen(true)}
        onNewTicket={() => setNewTicket(true)}
        onMenu={() => setNavOpen(true)}
      />
      <div className="flex min-h-0 flex-1">
        <Rail collapsed={collapsed} onToggle={toggleRail} className="max-md:hidden" />
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
      <NavDrawer open={navOpen} onOpenChange={setNavOpen} />
      <CommandBar open={cmdOpen} onOpenChange={setCmdOpen} onNewTicket={() => setNewTicket(true)} />
      <NewTicketDialog open={newTicket} onOpenChange={setNewTicket} />
    </div>
  );
}

/** Below md the rail lives in a drawer that slides in from the left. */
function NavDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { slug } = useWorkspace();
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/60 md:hidden" />
        <D.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 left-0 z-50 flex w-[264px] max-w-[85vw] animate-[trace-drawer-in_160ms_ease-out] flex-col border-r border-line bg-bar shadow-2xl shadow-black/60 outline-none md:hidden"
        >
          <D.Title className="sr-only">Navigation</D.Title>
          <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-line px-4">
            <Link to="/w/$slug" params={{ slug }} className="flex items-center gap-3 text-fg">
              <Mark />
              <span className="font-mono text-[13px] font-semibold tracking-[0.12em]">TRACE.</span>
            </Link>
            <D.Close aria-label="Close navigation" className="-mr-1.5 p-1.5 text-muted outline-none hover:text-fg">
              <X className="size-[17px]" />
            </D.Close>
          </div>
          <Rail className="min-h-0 w-full flex-1 border-r-0" />
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function AppBar({
  onCommand,
  onNewTicket,
  onMenu,
}: {
  onCommand: () => void;
  onNewTicket: () => void;
  onMenu: () => void;
}) {
  const { boot, slug } = useWorkspace();
  const { data: session } = useSession();
  const navigate = useNavigate();
  const orgs = useQuery({
    queryKey: ["orgs", session?.user.id],
    queryFn: async () => (await authClient.organization.list()).data ?? [],
  });
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line bg-bar px-3 md:gap-0 md:px-4">
      <div className="flex min-w-0 items-center gap-2.5 md:min-w-[300px] md:shrink-0 md:gap-3">
        <button
          onClick={onMenu}
          aria-label="Open navigation"
          className="-ml-1 p-1.5 text-muted hover:text-fg md:hidden"
        >
          <MenuIcon className="size-[18px]" />
        </button>
        <Link to="/w/$slug" params={{ slug }} className="flex shrink-0 items-center gap-3 text-fg">
          <Mark />
          <span className="font-mono text-[13px] font-semibold tracking-[0.12em] max-sm:hidden">TRACE.</span>
        </Link>
        <span className="h-4 w-px bg-white/15 max-sm:hidden" />
        <Menu>
          <MenuTrigger className="flex min-w-0 items-center gap-2 border border-line bg-white/[0.03] px-[9px] py-[5px] font-mono text-[11.5px] text-[#c9c9d4] outline-none hover:border-line-strong">
            <span className="truncate">{boot.org.slug}</span>
            <ChevronDown className="size-3 shrink-0 text-dim" />
          </MenuTrigger>
          <MenuContent align="start" className="w-60">
            <MenuLabel>Workspaces</MenuLabel>
            {(orgs.data ?? []).map((o) => (
              <MenuItem key={o.id} onSelect={() => navigate({ to: "/w/$slug", params: { slug: o.slug } })}>
                <Avatar name={o.name} size={18} />
                <span className="flex-1 truncate">{o.name}</span>
                {o.slug === slug ? <Check /> : null}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem onSelect={() => navigate({ to: "/onboarding" })}>
              <Plus /> New workspace
            </MenuItem>
            <MenuItem
              onSelect={() => navigate({ to: "/w/$slug/settings/$section", params: { slug, section: "general" } })}
            >
              <Settings /> Workspace settings
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <div className="flex min-w-0 flex-1 justify-end md:justify-center md:px-4">
        <button
          onClick={onCommand}
          aria-label="Search"
          className="flex h-8 items-center gap-[9px] border border-line-strong bg-white/[0.03] text-left hover:border-white/25 max-md:w-8 max-md:justify-center md:w-[460px] md:max-w-full md:px-2.5"
        >
          <Search className="size-[13px] shrink-0 text-dim" />
          <span className="flex-1 truncate text-[12.5px] text-dim max-md:hidden">
            Ask {boot.settings.ai.agentName} anything, or jump to a ticket
          </span>
          <Kbd className="max-md:hidden">⌘K</Kbd>
        </button>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2.5 md:min-w-[300px]">
        <AiStatus />
        <Tip label="Activity">
          <Link
            to="/w/$slug/inbox/$view"
            params={{ slug, view: "ai" }}
            className="p-1 text-muted hover:text-fg max-sm:hidden"
          >
            <Bell className="size-[15px]" />
          </Link>
        </Tip>
        <Tip label="Docs & shortcuts">
          <a
            href="https://github.com/"
            target="_blank"
            rel="noreferrer"
            className="p-1 text-muted hover:text-fg max-sm:hidden"
          >
            <CircleHelp className="size-[15px]" />
          </a>
        </Tip>
        <button
          onClick={onNewTicket}
          aria-label="New ticket"
          className="flex h-8 shrink-0 items-center justify-center gap-1.5 bg-fg text-[12.5px] font-medium whitespace-nowrap text-[#080808] hover:bg-white max-sm:w-8 sm:px-3"
        >
          <Plus className="size-[13px]" /> <span className="max-sm:hidden">New ticket</span>
        </button>
        <Menu>
          <MenuTrigger className="outline-none">
            <Avatar name={session?.user.name} src={session?.user.image} size={26} />
          </MenuTrigger>
          <MenuContent>
            <div className="px-2 py-1.5">
              <div className="text-[12.5px] text-fg">{session?.user.name}</div>
              <div className="font-mono text-[11.5px] text-dim">{session?.user.email}</div>
            </div>
            <MenuSeparator />
            <AvailabilityItems />
            <MenuSeparator />
            <MenuItem
              onSelect={() => navigate({ to: "/w/$slug/settings/$section", params: { slug, section: "account" } })}
            >
              <ShieldCheck /> Account & security
            </MenuItem>
            <MenuItem
              onSelect={async () => {
                await signOut();
                navigate({ to: "/login" });
              }}
            >
              <LogOut /> Sign out
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </header>
  );
}

/** Available / away for auto-assignment, from the avatar menu. */
function AvailabilityItems() {
  const { api, wid } = useWorkspace();
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: routingKeys.me(wid),
    queryFn: () => api<{ status: "available" | "away"; open: number }>("/routing/me"),
  });
  const set = useMutation({
    mutationFn: (status: "available" | "away") => api("/routing/me", { method: "PUT", json: { status } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: routingKeys.me(wid) });
      qc.invalidateQueries({ queryKey: routingKeys.all(wid) });
    },
  });
  const status = me.data?.status ?? "available";
  return (
    <>
      <MenuLabel>Routing</MenuLabel>
      {(
        [
          ["available", "Available", "bg-ok", `${me.data?.open ?? 0} open`],
          ["away", "Away", "bg-warn", "no new tickets"],
        ] as const
      ).map(([value, label, dot, hint]) => (
        <MenuItem
          key={value}
          onSelect={(e) => {
            e.preventDefault();
            if (status !== value) set.mutate(value);
          }}
          className={status === value ? "bg-white/[0.05] text-fg" : undefined}
        >
          <span className={cn("size-1.5", dot)} />
          <span className="flex-1">{label}</span>
          <span className="font-mono text-[11px] text-dim">{hint}</span>
        </MenuItem>
      ))}
    </>
  );
}

function AiStatus() {
  const { boot, slug } = useWorkspace();
  const online = boot.ai.online;
  return (
    <Tip
      label={
        online
          ? `AI agent online · ${boot.ai.model}`
          : "AI offline — add an Anthropic key in Agent → Setup (using local heuristics)"
      }
    >
      <Link
        to="/w/$slug/agent/$section"
        params={{ slug, section: "ai" }}
        className={cn(
          "mr-1 hidden shrink-0 items-center gap-1.5 border px-1.5 py-[3px] font-mono text-[11px] tracking-wide whitespace-nowrap lg:flex",
          online ? "border-accent/30 text-accent-text" : "border-line-strong text-dim",
        )}
      >
        <span className={cn("h-1.5 w-1.5", online ? "bg-accent" : "bg-dim")} />
        {online ? "AI ON" : "AI LOCAL"}
      </Link>
    </Tip>
  );
}

/** Collapsed rails show icons only, with the label in a tooltip. */
const RailCollapsed = React.createContext(false);

function RailSection({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  if (React.useContext(RailCollapsed))
    return <div className="mx-2 mt-3 mb-1.5 h-px bg-line first:mt-1.5 first:bg-transparent" />;
  return (
    <div className="flex items-center justify-between px-2 pt-3 pb-1.5">
      <span className="font-mono text-[11px] font-medium tracking-[0.12em] text-dim">{children}</span>
      {action}
    </div>
  );
}

function RailItem({
  to,
  params,
  icon: Icon,
  label,
  count,
  active,
}: {
  to: string;
  params: Record<string, string>;
  icon: LucideIcon;
  label: string;
  count?: number;
  active: boolean;
}) {
  if (React.useContext(RailCollapsed))
    return (
      <Tip
        side="right"
        label={
          <span className="flex items-center gap-3">
            {label}
            {count ? <span className="font-mono text-dim">{count}</span> : null}
          </span>
        }
      >
        <Link
          to={to as "/"}
          params={params as never}
          aria-label={label}
          className={cn(
            "flex h-8 shrink-0 items-center justify-center",
            active ? "bg-accent/12 text-accent-fg" : "text-dim hover:bg-white/[0.03] hover:text-fg-2",
          )}
        >
          <Icon className="size-[15px]" />
        </Link>
      </Tip>
    );
  return (
    <Link
      to={to as "/"}
      params={params as never}
      className={cn(
        "flex items-center justify-between gap-2 px-2 py-1.5 text-[13px]",
        active ? "bg-accent/12 text-[#f0f0f5]" : "text-body hover:bg-white/[0.03] hover:text-fg-2",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon className={cn("size-[15px] shrink-0", active ? "text-accent-fg" : "text-dim")} />
        <span className="truncate">{label}</span>
      </span>
      {count ? (
        <span className={cn("font-mono text-[11px]", active ? "text-accent-fg" : "text-dim")}>{count}</span>
      ) : null}
    </Link>
  );
}

function Rail({
  collapsed = false,
  onToggle,
  className,
}: {
  collapsed?: boolean;
  onToggle?: () => void;
  className?: string;
}) {
  const { wid, slug, boot, api } = useWorkspace();
  const [viewDialog, setViewDialog] = React.useState(false);
  const counts = useQuery({
    queryKey: qk.counts(wid),
    queryFn: () => api<Record<string, number>>("/counts"),
    refetchInterval: 60_000,
  });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const inboxView = pathname.match(/\/inbox\/([^/]+)/)?.[1];
  const c = counts.data ?? {};
  const isInbox = !!inboxView && INBOX_VIEWS.includes(inboxView);
  const at = (part: string) => pathname.includes(`/${part}`);
  return (
    <nav
      className={cn(
        "flex shrink-0 flex-col border-r border-line bg-bar",
        collapsed ? "w-[52px]" : "w-[206px]",
        className,
      )}
    >
      <RailCollapsed.Provider value={collapsed}>
        <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto pt-2 pb-3", collapsed ? "px-2" : "px-2.5")}>
          <RailItem
            to="/w/$slug"
            params={{ slug }}
            icon={House}
            label="Home"
            active={/^\/w\/[^/]+\/?$/.test(pathname)}
          />
          <RailItem
            to="/w/$slug/inbox/$view"
            params={{ slug, view: "inbox" }}
            icon={Inbox}
            label="Inbox"
            count={c.inbox}
            active={isInbox}
          />
          <RailItem to="/w/$slug/customers" params={{ slug }} icon={Users} label="Customers" active={at("customers")} />
          <RailItem
            to="/w/$slug/insights"
            params={{ slug }}
            icon={BarChart3}
            label="Insights"
            active={at("insights")}
          />
          <RailItem
            to="/w/$slug/agent/$section"
            params={{ slug, section: "ai" }}
            icon={Bot}
            label="Agent"
            active={at("agent/") || at("knowledge")}
          />
          <RailSection
            action={
              <Tip label="New view" side="right">
                <button onClick={() => setViewDialog(true)} className="text-dim hover:text-fg">
                  <Plus className="size-3" />
                </button>
              </Tip>
            }
          >
            <Tip label="All views, with live numbers" side="right">
              <Link
                to="/w/$slug/views"
                params={{ slug }}
                className={cn("hover:text-fg", pathname.endsWith("/views") && "text-fg")}
              >
                VIEWS
              </Link>
            </Tip>
          </RailSection>
          {boot.views.map((v) => (
            <RailItem
              key={v.id}
              to="/w/$slug/inbox/$view"
              params={{ slug, view: v.id }}
              icon={viewIcons[v.icon] ?? Layers}
              label={v.name}
              count={c[v.id]}
              active={inboxView === v.id}
            />
          ))}
          {!boot.views.length && !collapsed ? <div className="px-2 py-1 text-xs text-dim">No views yet</div> : null}
          <div className="mt-auto pt-3">
            <RailItem
              to="/w/$slug/settings/$section"
              params={{ slug, section: "general" }}
              icon={Settings}
              label="Settings"
              active={at("settings/") && !pathname.endsWith("/settings/account")}
            />
          </div>
        </div>
      </RailCollapsed.Provider>
      {onToggle ? (
        <div className={cn("shrink-0 border-t border-line py-2", collapsed ? "px-2" : "px-2.5")}>
          <Tip
            side="right"
            label={
              <span className="flex items-center gap-2">
                {collapsed ? "Expand sidebar" : "Collapse sidebar"} <Kbd>[</Kbd>
              </span>
            }
          >
            <button
              onClick={onToggle}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className={cn(
                "flex h-8 w-full items-center gap-2 text-[13px] text-dim hover:bg-white/[0.03] hover:text-fg-2",
                collapsed ? "justify-center" : "px-2",
              )}
            >
              {collapsed ? (
                <PanelLeftOpen className="size-[15px]" />
              ) : (
                <>
                  <PanelLeftClose className="size-[15px]" /> Collapse
                </>
              )}
            </button>
          </Tip>
        </div>
      ) : null}
      <ViewDialog open={viewDialog} onOpenChange={setViewDialog} />
    </nav>
  );
}
