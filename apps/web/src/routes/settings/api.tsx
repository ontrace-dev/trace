import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { CopyField, SettingsHeader, SettingsSection } from "../settings";
import { Button, Input } from "@/components/ui";
import { ago } from "@/lib/utils";
import { qk, useWorkspace } from "@/lib/workspace";
import { useConfirm } from "@/components/ui/confirm";

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export function ApiSettings() {
  const confirm = useConfirm();
  const { api, wid, boot, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const [name, setName] = React.useState("");
  const [created, setCreated] = React.useState<string | null>(null);
  const keys = useQuery({
    queryKey: qk.apiKeys(wid),
    enabled: isAdmin,
    queryFn: () => api<{ apiKeys: ApiKey[] }>("/api-keys"),
  });
  const create = useMutation({
    mutationFn: () => api<{ key: string }>("/api-keys", { method: "POST", json: { name } }),
    onSuccess: (r) => {
      setCreated(r.key);
      setName("");
      qc.invalidateQueries({ queryKey: qk.apiKeys(wid) });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.apiKeys(wid) }),
  });
  const base = boot.env.publicUrl;
  return (
    <div>
      <SettingsHeader
        title="API & keys"
        description="The REST API is the inbound channel for everything else: contact forms, product error reports, CRMs and internal tools can open and update tickets."
      />
      {isAdmin ? (
        <SettingsSection title="API keys" description="Keys are scoped to this workspace. The full key is shown once.">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Key name, e.g. Contact form"
            />
            <Button variant="primary" loading={create.isPending}>
              Create key
            </Button>
          </form>
          {created ? <CopyField label="New key — copy it now, it won't be shown again" value={created} /> : null}
          <div className="flex flex-col border border-line">
            {(keys.data?.apiKeys ?? []).map((k) => (
              <div key={k.id} className="flex items-center gap-3 border-b border-line-2 px-3 py-2 last:border-b-0">
                <span className="flex-1 text-[12.5px] text-fg-3">{k.name}</span>
                <span className="font-mono text-[11px] text-muted">{k.prefix}…</span>
                <span className="w-28 text-right font-mono text-[11px] text-dim">
                  {k.lastUsedAt ? `used ${ago(k.lastUsedAt)} ago` : "never used"}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () =>
                    (await confirm({
                      title: "Revoke API key?",
                      description: `Anything using “${k.name}” stops working immediately.`,
                      confirmLabel: "Revoke",
                      destructive: true,
                    })) && revoke.mutate(k.id)
                  }
                >
                  Revoke
                </Button>
              </div>
            ))}
            {keys.data && !keys.data.apiKeys.length ? (
              <div className="px-3 py-3 text-xs text-dim">No keys yet.</div>
            ) : null}
          </div>
        </SettingsSection>
      ) : null}
      <SettingsSection
        title="Quickstart"
        description="All endpoints accept and return JSON. Authenticate with a Bearer key."
      >
        <pre className="overflow-x-auto border border-line bg-cell p-3.5 font-mono text-[11px] leading-relaxed text-fg-3">{`# open a ticket (the AI agent triages and drafts immediately)
curl -X POST ${base}/api/v1/tickets \\
  -H "Authorization: Bearer trk_…" -H "content-type: application/json" \\
  -d '{"subject":"Checkout fails","body":"Card declined on step 3",
       "customer":{"email":"ana@acme.io","name":"Ana","attributes":{"plan":"scale","mrr":2480}}}'

# add a customer reply / an internal note / an agent reply
curl -X POST ${base}/api/v1/tickets/42/messages -H "Authorization: Bearer trk_…" \\
  -H "content-type: application/json" -d '{"body":"Still broken","author":"customer"}'

# update status, priority or tags
curl -X PATCH ${base}/api/v1/tickets/42 -H "Authorization: Bearer trk_…" \\
  -H "content-type: application/json" -d '{"status":"resolved"}'

# upsert a customer with attributes the agent can use
curl -X PUT ${base}/api/v1/customers -H "Authorization: Bearer trk_…" \\
  -H "content-type: application/json" -d '{"email":"ana@acme.io","attributes":{"plan":"enterprise"}}'`}</pre>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[11px] text-muted">
          {[
            ["GET", "/api/v1/tickets?status=open&q="],
            ["POST", "/api/v1/tickets"],
            ["GET", "/api/v1/tickets/:id|number"],
            ["PATCH", "/api/v1/tickets/:id|number"],
            ["POST", "/api/v1/tickets/:id/messages"],
            ["PUT", "/api/v1/customers"],
            ["GET", "/api/v1/articles/search?q="],
          ].map(([m, p]) => (
            <span key={p}>
              <span className="inline-block w-12 text-accent-text">{m}</span>
              {p}
            </span>
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}
