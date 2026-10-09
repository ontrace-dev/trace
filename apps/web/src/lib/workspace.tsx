import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { wapi } from "./api";
import type { Bootstrap } from "./types";

interface WorkspaceCtx {
  wid: string;
  slug: string;
  boot: Bootstrap;
  /** Workspace-scoped fetch helper. */
  api: <T = unknown>(path: string, init?: RequestInit & { json?: unknown }) => Promise<T>;
  isAdmin: boolean;
}

const Ctx = React.createContext<WorkspaceCtx | null>(null);

export function useWorkspace() {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useWorkspace outside provider");
  return v;
}

/** Query keys are scoped by workspace id so switching workspaces never shows stale data. */
export const qk = {
  boot: (wid: string) => ["boot", wid] as const,
  counts: (wid: string) => ["counts", wid] as const,
  tickets: (wid: string, view: string, q?: string) => ["tickets", wid, view, q ?? ""] as const,
  ticket: (wid: string, ref: string) => ["ticket", wid, ref] as const,
  customers: (wid: string, q?: string) => ["customers", wid, q ?? ""] as const,
  customer: (wid: string, id: string) => ["customer", wid, id] as const,
  articles: (wid: string, q?: string) => ["articles", wid, q ?? ""] as const,
  article: (wid: string, id: string) => ["article", wid, id] as const,
  settings: (wid: string) => ["settings", wid] as const,
  channels: (wid: string) => ["channels", wid] as const,
  integrations: (wid: string) => ["integrations", wid] as const,
  apiKeys: (wid: string) => ["apiKeys", wid] as const,
  insights: (wid: string) => ["insights", wid] as const,
};

export function WorkspaceProvider({ wid, slug, children }: { wid: string; slug: string; children: React.ReactNode }) {
  const boot = useQuery({
    queryKey: qk.boot(wid),
    queryFn: () => wapi<Bootstrap>(wid, "/bootstrap"),
    staleTime: 30_000,
  });
  useRealtime(wid);

  React.useEffect(() => {
    const accent = boot.data?.settings.accentColor;
    if (accent) document.documentElement.style.setProperty("--tr-accent", accent);
  }, [boot.data?.settings.accentColor]);

  const value = React.useMemo<WorkspaceCtx | null>(
    () =>
      boot.data
        ? {
            wid,
            slug,
            boot: boot.data,
            api: (path, init) => wapi(wid, path, init),
            isAdmin: boot.data.role.split(",").some((r) => r === "owner" || r === "admin"),
          }
        : null,
    [boot.data, wid, slug],
  );

  if (boot.error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        Could not load workspace: {(boot.error as Error).message}
      </div>
    );
  }
  if (!value) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-4 w-4 animate-pulse bg-fg" />
      </div>
    );
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

type ChangeEvent = { type: string; ticketId?: string; changes?: string[] };

/** Live updates over SSE: every change in the workspace invalidates the affected queries. */
function useRealtime(wid: string) {
  const qc = useQueryClient();
  React.useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    let retry = 1000;
    let pending = new Set<string>();
    let flush: ReturnType<typeof setTimeout> | null = null;

    const schedule = (e: ChangeEvent) => {
      if (e.ticketId) pending.add(e.ticketId);
      if (e.type === "integration.updated") qc.invalidateQueries({ queryKey: qk.integrations(wid) });
      if (flush) return;
      flush = setTimeout(() => {
        flush = null;
        const ids = pending;
        pending = new Set();
        qc.invalidateQueries({ queryKey: ["tickets", wid] });
        qc.invalidateQueries({ queryKey: qk.counts(wid) });
        qc.invalidateQueries({ queryKey: ["home", wid] });
        qc.invalidateQueries({ queryKey: ["views-overview", wid] });
        // Ticket detail queries are keyed by id or number; refresh any that match.
        qc.invalidateQueries({
          predicate: (q) => {
            if (q.queryKey[0] !== "ticket" || q.queryKey[1] !== wid) return false;
            const data = q.state.data as { ticket?: { id: string } } | undefined;
            return !data?.ticket || ids.has(data.ticket.id);
          },
        });
        if (ids.size) qc.invalidateQueries({ queryKey: ["customer", wid] });
      }, 150);
    };

    const connect = () => {
      if (closed) return;
      es = new EventSource(`/api/w/${wid}/stream`, { withCredentials: true });
      es.addEventListener("ready", () => {
        retry = 1000;
      });
      es.addEventListener("change", (ev) => {
        try {
          schedule(JSON.parse((ev as MessageEvent).data));
        } catch {
          /* ignore malformed */
        }
      });
      es.onerror = () => {
        es?.close();
        if (!closed) setTimeout(connect, (retry = Math.min(retry * 2, 15000)));
      };
    };
    connect();
    return () => {
      closed = true;
      es?.close();
      if (flush) clearTimeout(flush);
    };
  }, [wid, qc]);
}
