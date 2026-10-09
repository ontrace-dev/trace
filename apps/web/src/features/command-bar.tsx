import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { Dialog as D } from "radix-ui";
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  Bot,
  CornerDownLeft,
  Hash,
  Inbox,
  Plus,
  Settings,
  Sparkles,
  Ticket,
  User,
  Users,
} from "lucide-react";
import * as React from "react";
import { Badge, Spinner } from "@/components/ui";
import { SourceChips } from "@/features/source-chips";
import type { Source, TicketListItem } from "@/lib/types";
import { md } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

export function CommandBar({
  open,
  onOpenChange,
  onNewTicket,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onNewTicket: () => void;
}) {
  const { api, slug, boot, wid } = useWorkspace();
  const navigate = useNavigate();
  const [q, setQ] = React.useState("");
  const [deb, setDeb] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDeb(q), 150);
    return () => clearTimeout(t);
  }, [q]);
  React.useEffect(() => {
    if (!open) {
      setQ("");
      ask.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const tickets = useQuery({
    queryKey: ["cmd-tickets", wid, deb],
    enabled: open && deb.trim().length > 0,
    queryFn: () => api<{ tickets: TicketListItem[] }>(`/tickets?view=all&q=${encodeURIComponent(deb)}`),
  });
  const ask = useMutation({
    mutationFn: (question: string) =>
      api<{ answer: string; sources: Source[]; offline: boolean }>("/ai/ask", { method: "POST", json: { question } }),
  });

  const go = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };
  const prefix = boot.settings.ticketPrefix;
  const nav = [
    {
      label: "Inbox",
      icon: Inbox,
      run: () => navigate({ to: "/w/$slug/inbox/$view", params: { slug, view: "inbox" } }),
    },
    {
      label: "AI queue",
      icon: Sparkles,
      run: () => navigate({ to: "/w/$slug/inbox/$view", params: { slug, view: "ai" } }),
    },
    {
      label: "Assigned to me",
      icon: User,
      run: () => navigate({ to: "/w/$slug/inbox/$view", params: { slug, view: "mine" } }),
    },
    { label: "Knowledge base", icon: BookOpen, run: () => navigate({ to: "/w/$slug/knowledge", params: { slug } }) },
    { label: "Customers", icon: Users, run: () => navigate({ to: "/w/$slug/customers", params: { slug } }) },
    { label: "Insights", icon: BarChart3, run: () => navigate({ to: "/w/$slug/insights", params: { slug } }) },
    {
      label: "AI agent settings",
      icon: Bot,
      run: () => navigate({ to: "/w/$slug/agent/$section", params: { slug, section: "ai" } }),
    },
    {
      label: "Slack integration",
      icon: Hash,
      run: () => navigate({ to: "/w/$slug/settings/$section", params: { slug, section: "slack" } }),
    },
    {
      label: "Discord integration",
      icon: Hash,
      run: () => navigate({ to: "/w/$slug/settings/$section", params: { slug, section: "discord" } }),
    },
    {
      label: "Workspace settings",
      icon: Settings,
      run: () => navigate({ to: "/w/$slug/settings/$section", params: { slug, section: "general" } }),
    },
  ];
  const openTicket = (number: number) =>
    navigate({ to: "/w/$slug/inbox/$view/$ticket", params: { slug, view: "all", ticket: String(number) } });
  const refMatch = q.trim().match(new RegExp(`^(?:${prefix}-)?#?(\\d+)$`, "i"));

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/55" />
        <D.Content className="fixed top-[10vh] left-1/2 z-50 w-[min(640px,calc(100vw-32px))] -translate-x-1/2 border border-line-strong bg-bar shadow-2xl shadow-black/70 focus:outline-none">
          <D.Title className="sr-only">Command bar</D.Title>
          <D.Description className="sr-only">Search tickets, navigate, or ask the AI</D.Description>
          <Command shouldFilter={false} loop className="flex flex-col">
            <div className="flex items-center gap-2.5 border-b border-line px-3.5">
              <Sparkles className="size-[14px] text-accent-text" />
              <Command.Input
                autoFocus
                value={q}
                onValueChange={setQ}
                placeholder={`Ask ${boot.settings.ai.agentName} anything, or jump to a ticket…`}
                className="h-12 flex-1 bg-transparent text-[14px] text-fg placeholder:text-dim focus:outline-none focus-visible:outline-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && q.trim()) {
                    e.preventDefault();
                    ask.mutate(q.trim());
                  }
                }}
              />
              {ask.isPending ? <Spinner /> : <span className="font-mono text-[11px] text-dim">⌘⏎ ask</span>}
            </div>

            {ask.data ? (
              <div className="max-h-[50vh] overflow-y-auto border-b border-line bg-accent/[0.04] px-4 py-3.5">
                <div className="mb-2 flex items-center gap-2">
                  <Sparkles className="size-3 text-accent-text" />
                  <span className="font-mono text-[11px] font-medium tracking-[0.12em] text-accent-text">
                    {boot.settings.ai.agentName.toUpperCase()} ANSWERS
                  </span>
                  {ask.data.offline ? <Badge>offline</Badge> : null}
                </div>
                <div className="prose-trace text-[13px]" dangerouslySetInnerHTML={{ __html: md(ask.data.answer) }} />
                {ask.data.sources.length ? (
                  <div className="mt-2">
                    <SourceChips
                      sources={ask.data.sources.slice(0, 8)}
                      label=""
                      onNavigate={() => onOpenChange(false)}
                    />
                  </div>
                ) : null}
              </div>
            ) : ask.error ? (
              <div className="border-b border-line px-4 py-3 text-xs text-danger">{(ask.error as Error).message}</div>
            ) : null}

            <Command.List className="max-h-[52vh] overflow-y-auto p-1.5">
              {q.trim() ? (
                <Group heading="Ask">
                  <Item onSelect={() => ask.mutate(q.trim())} icon={<Sparkles className="text-accent-text" />}>
                    Ask {boot.settings.ai.agentName}: <span className="text-fg">“{q.trim()}”</span>
                  </Item>
                </Group>
              ) : null}
              {refMatch ? (
                <Group heading="Jump">
                  <Item onSelect={() => go(() => openTicket(Number(refMatch[1])))} icon={<Ticket />}>
                    Open {prefix}-{refMatch[1]}
                  </Item>
                </Group>
              ) : null}
              {tickets.data?.tickets.length ? (
                <Group heading="Tickets">
                  {tickets.data.tickets.slice(0, 8).map((t) => (
                    <Item key={t.id} onSelect={() => go(() => openTicket(t.number))} icon={<Ticket />}>
                      <span className="w-16 shrink-0 font-mono text-[11.5px] text-dim">
                        {prefix}-{t.number}
                      </span>
                      <span className="flex-1 truncate">{t.subject}</span>
                      <span className="font-mono text-[11px] text-dim">{t.customer?.name}</span>
                    </Item>
                  ))}
                </Group>
              ) : null}
              <Group heading="Actions">
                <Item onSelect={() => go(onNewTicket)} icon={<Plus />}>
                  New ticket
                </Item>
              </Group>
              <Group heading="Go to">
                {nav
                  .filter((n) => !q.trim() || n.label.toLowerCase().includes(q.trim().toLowerCase()))
                  .map((n) => (
                    <Item key={n.label} onSelect={() => go(n.run)} icon={<n.icon />}>
                      {n.label}
                    </Item>
                  ))}
              </Group>
            </Command.List>
            <div className="flex items-center justify-between border-t border-line px-3.5 py-2 font-mono text-[11px] text-dim">
              <span className="flex items-center gap-3">
                <span>↑↓ navigate</span>
                <span className="flex items-center gap-1">
                  <CornerDownLeft className="size-3" /> select
                </span>
              </span>
              <span className="flex items-center gap-1">
                answers grounded in your tickets & articles <ArrowRight className="size-3" />
              </span>
            </div>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function Group({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <Command.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:tracking-[0.12em] [&_[cmdk-group-heading]]:text-dim [&_[cmdk-group-heading]]:uppercase"
    >
      {children}
    </Command.Group>
  );
}

function Item({
  children,
  onSelect,
  icon,
}: {
  children: React.ReactNode;
  onSelect: () => void;
  icon: React.ReactNode;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex cursor-default items-center gap-2.5 px-2 py-2 text-[13px] text-fg-3 data-[selected=true]:bg-white/[0.06] data-[selected=true]:text-fg [&_svg]:size-[14px] [&_svg]:shrink-0 [&_svg]:text-dim"
    >
      {icon}
      {children}
    </Command.Item>
  );
}
