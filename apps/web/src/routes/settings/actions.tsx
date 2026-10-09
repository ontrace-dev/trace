import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { SettingsHeader } from "../settings";
import { ActionsTab } from "@/features/actions/actions-tab";
import { ApprovalsTab } from "@/features/actions/approvals-tab";
import { McpTab } from "@/features/actions/mcp-tab";
import { ProceduresTab } from "@/features/actions/procedures-tab";
import { SecretsTab } from "@/features/actions/secrets-tab";
import { automationKeys, type InboxRun } from "@/features/actions/types";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

type Tab = "actions" | "mcp" | "procedures" | "secrets" | "approvals";
const TABS: Tab[] = ["actions", "mcp", "procedures", "secrets", "approvals"];

/** Actions, procedures, secrets and the approvals inbox. */
export function ActionsSettings() {
  const { api, wid } = useWorkspace();
  const [tab, setTab] = React.useState<Tab>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("tab") as Tab | null;
    if (fromUrl && TABS.includes(fromUrl)) return fromUrl;
    try {
      const saved = localStorage.getItem("trace:actions-tab") as Tab | null;
      return saved && TABS.includes(saved) ? saved : "actions";
    } catch {
      return "actions";
    }
  });
  // Back from an MCP server's sign-in page (see /api/mcp/oauth/callback).
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("mcp");
    if (!outcome) return;
    if (outcome === "connected") toast.success("Signed in — turn on the tools the agent may use.");
    else toast.error("Sign-in didn't complete", { description: "See the server's status below and try again." });
    window.history.replaceState(null, "", window.location.pathname);
  }, []);
  React.useEffect(() => {
    try {
      localStorage.setItem("trace:actions-tab", tab);
    } catch {
      /* ignore */
    }
  }, [tab]);
  const pending = useQuery({
    queryKey: automationKeys.runs(wid, "pending_approval"),
    queryFn: () => api<{ runs: InboxRun[] }>("/automation/runs?status=pending_approval"),
    refetchInterval: 15_000,
  });
  const waiting = pending.data?.runs.length ?? 0;
  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "actions", label: "Actions" },
    { id: "mcp", label: "MCP servers" },
    { id: "procedures", label: "Procedures" },
    { id: "secrets", label: "Secrets" },
    { id: "approvals", label: "Approvals", badge: waiting },
  ];
  return (
    <div>
      <SettingsHeader
        title="Actions & procedures"
        description="Let the agent resolve tickets, not just answer them: give it API actions (look up, refund, file a bug), tools from MCP servers, and procedures that say when to use them. Consequential actions wait for a human."
      />
      <div className="flex gap-1 border-b border-line px-8">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "-mb-px flex items-center gap-2 border-b px-3 py-2.5 text-[12.5px]",
              tab === t.id ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg-2",
            )}
          >
            {t.label}
            {t.badge ? <span className="bg-warn/20 px-1.5 font-mono text-[11px] text-warn">{t.badge}</span> : null}
          </button>
        ))}
      </div>
      {tab === "actions" ? (
        <ActionsTab />
      ) : tab === "mcp" ? (
        <McpTab />
      ) : tab === "procedures" ? (
        <ProceduresTab />
      ) : tab === "secrets" ? (
        <SecretsTab />
      ) : (
        <ApprovalsTab />
      )}
    </div>
  );
}
