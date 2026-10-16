import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui";
import { onArrival } from "@/lib/arrivals";
import type { TicketListItem } from "@/lib/types";
import { ago, cn } from "@/lib/utils";
import { qk, useWorkspace } from "@/lib/workspace";

/*
 * How a teammate notices news: a toast when a customer writes (unless they're looking at that ticket),
 * the unread count in the tab title, and the bell listing every conversation with an unseen customer message.
 */

export function useUnread() {
  const { api, wid } = useWorkspace();
  return useQuery({
    queryKey: qk.unread(wid),
    queryFn: () => api<{ tickets: TicketListItem[] }>("/unread"),
    refetchInterval: 60_000,
  });
}

/** Refresh everything that shows unread state after something was read. */
function useInvalidateUnread() {
  const qc = useQueryClient();
  const { wid } = useWorkspace();
  return React.useCallback(() => {
    qc.invalidateQueries({ queryKey: qk.unread(wid) });
    qc.invalidateQueries({ queryKey: qk.counts(wid) });
    qc.invalidateQueries({ queryKey: ["tickets", wid] });
    qc.invalidateQueries({ queryKey: ["home", wid] });
  }, [qc, wid]);
}

/** Marks a ticket read while it's open and visible, again whenever new messages arrive. */
export function useMarkRead(ticketId: string, messageCount: number) {
  const { api } = useWorkspace();
  const refresh = useInvalidateUnread();
  React.useEffect(() => {
    let done = false;
    const mark = () => {
      if (done || document.hidden) return;
      done = true;
      api(`/tickets/${ticketId}/read`, { method: "POST" })
        .then(refresh)
        .catch(() => {});
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [api, ticketId, messageCount, refresh]);
}

export function ArrivalToasts() {
  const { slug } = useWorkspace();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const path = React.useRef(pathname);
  path.current = pathname;
  React.useEffect(
    () =>
      onArrival((a) => {
        // Already looking at it: the thread updates in place.
        if (new RegExp(`/inbox/[^/]+/(${a.number}|${a.ticketId})$`).test(path.current)) return;
        toast(
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="size-1.5 shrink-0 bg-accent" />
              <span className="font-mono text-[11px] tracking-[0.08em] text-accent-text uppercase">
                {a.kind === "ticket" ? "New ticket" : "New reply"}
              </span>
              <span className="font-mono text-[11px] text-dim">
                #{a.number} · {a.channel}
              </span>
            </div>
            <div className="truncate text-[13px] font-semibold text-fg">{a.customer ?? "Unknown visitor"}</div>
            <div className="truncate text-[12.5px] text-fg-3">{a.subject}</div>
            {a.preview && a.preview !== a.subject ? (
              <div className="line-clamp-2 text-[12px] text-muted">{a.preview}</div>
            ) : null}
          </div>,
          {
            id: `arrival-${a.ticketId}`,
            duration: 8000,
            action: {
              label: "Open",
              onClick: () =>
                navigate({
                  to: "/w/$slug/inbox/$view/$ticket",
                  params: { slug, view: "inbox", ticket: String(a.number) },
                }),
            },
          },
        );
      }),
    [navigate, slug],
  );
  return null;
}

/** "(3) trace" while you have unread conversations. */
export function useUnreadTitle(count: number) {
  React.useEffect(() => {
    const base = document.title.replace(/^\(\d+\)\s*/, "");
    document.title = count ? `(${count}) ${base}` : base;
  }, [count]);
}

export function UnreadBell() {
  const { slug, api } = useWorkspace();
  const unread = useUnread();
  const refresh = useInvalidateUnread();
  const [open, setOpen] = React.useState(false);
  const list = unread.data?.tickets ?? [];
  const readAll = useMutation({
    mutationFn: () => api("/unread/read-all", { method: "POST" }),
    onSuccess: refresh,
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={list.length ? `${list.length} unread conversations` : "No unread conversations"}
        className={cn(
          "relative flex h-8 items-center gap-1.5 px-1.5 outline-none",
          list.length ? "text-fg hover:bg-white/[0.04]" : "text-muted hover:text-fg",
        )}
      >
        <Bell className="size-[15px]" />
        {list.length ? (
          <span className="min-w-[18px] bg-accent px-1 font-mono text-[11px] leading-[18px] font-semibold text-[#0b0b0e]">
            {list.length > 29 ? "30+" : list.length}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] p-0">
        <div className="flex h-10 items-center justify-between border-b border-line px-3.5">
          <span className="font-mono text-[11px] font-medium tracking-[0.12em] text-fg-2 uppercase">
            Unread <span className="text-dim">{list.length}</span>
          </span>
          {list.length ? (
            <button
              onClick={() => readAll.mutate()}
              disabled={readAll.isPending}
              className="font-mono text-[11px] text-dim hover:text-fg"
            >
              mark all read
            </button>
          ) : null}
        </div>
        {list.length ? (
          <ol className="max-h-[420px] overflow-y-auto">
            {list.map((t) => (
              <li key={t.id}>
                <Link
                  to="/w/$slug/inbox/$view/$ticket"
                  params={{ slug, view: "inbox", ticket: String(t.number) }}
                  onClick={() => setOpen(false)}
                  className="flex gap-2.5 border-b border-line-2 px-3.5 py-2.5 hover:bg-white/[0.04]"
                >
                  <span className="mt-[7px] size-1.5 shrink-0 bg-accent" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[13px] font-semibold text-fg">
                        {t.customer?.name ?? t.customer?.email ?? "Unknown visitor"}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-dim">
                        {ago(t.lastCustomerMessageAt ?? t.lastMessageAt)}
                      </span>
                    </span>
                    <span className="truncate text-[12.5px] text-fg-3">{t.subject}</span>
                    {t.preview ? <span className="truncate text-[12px] text-muted">{t.preview}</span> : null}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        ) : (
          <p className="px-3.5 py-6 text-[12.5px] text-muted">No unread customer messages.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
