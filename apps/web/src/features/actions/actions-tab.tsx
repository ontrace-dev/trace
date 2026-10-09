import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, ShieldCheck, Workflow } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Badge, Button, Dialog, Empty, Spinner, Switch } from "@/components/ui";
import { useWorkspace } from "@/lib/workspace";
import { ActionEditor } from "./action-editor";
import { type Action, type ActionPreset, automationKeys, hostOf, type Secret } from "./types";

export function ActionsTab() {
  const { api, wid, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const [editing, setEditing] = React.useState<Action | "new" | null>(null);
  const [gallery, setGallery] = React.useState(false);
  const list = useQuery({
    queryKey: automationKeys.actions(wid),
    queryFn: () => api<{ actions: Action[] }>("/automation/actions"),
  });
  const toggle = useMutation({
    mutationFn: (a: Action) => api(`/automation/actions/${a.id}`, { method: "PATCH", json: { enabled: !a.enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationKeys.actions(wid) }),
    onError: (e) => toast.error((e as Error).message),
  });

  if (editing) {
    const fresh = editing === "new" ? null : (list.data?.actions.find((a) => a.id === editing.id) ?? editing);
    return <ActionEditor key={fresh?.id ?? "new"} action={fresh} onBack={() => setEditing(null)} />;
  }

  const actions = list.data?.actions ?? [];
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-line px-8 py-4">
        <p className="max-w-2xl text-[12px] leading-relaxed text-dim">
          Actions are API calls the AI agent can make while working a ticket — look up an order, refund a charge, file a
          Jira bug. Each call is a span on the ticket's trace.
        </p>
        <div className="flex shrink-0 gap-2">
          <Button disabled={!isAdmin} onClick={() => setGallery(true)}>
            <Workflow /> From template
          </Button>
          <Button variant="primary" disabled={!isAdmin} onClick={() => setEditing("new")}>
            <Plus /> New action
          </Button>
        </div>
      </div>
      {list.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : !actions.length ? (
        <Empty icon={<Workflow />} title="No actions yet">
          Start from a template (Stripe, Shopify, Jira, Linear, a webhook) or the built-in demo billing API.
        </Empty>
      ) : (
        actions.map((a) => (
          <div key={a.id} className="flex items-center gap-4 border-b border-line-2 px-8 py-3 hover:bg-white/[0.02]">
            <button className="flex min-w-0 flex-1 flex-col gap-1 text-left" onClick={() => setEditing(a)}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12.5px] text-fg-2">{a.name}</span>
                <span className="truncate text-[12.5px] text-muted">{a.title}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11.5px] text-accent-fg">{a.method}</span>
                <span className="truncate font-mono text-[11.5px] text-dim">{hostOf(a.url)}</span>
                {a.readOnly ? <Badge>read-only</Badge> : <Badge tone="info">writes</Badge>}
                {a.requiresApproval ? (
                  <Badge tone="warn">
                    <ShieldCheck className="size-2.5" /> approval
                  </Badge>
                ) : null}
                {a.parameters.length ? (
                  <span className="font-mono text-[11px] text-dim">{a.parameters.map((p) => p.name).join(", ")}</span>
                ) : null}
              </div>
            </button>
            <Switch checked={a.enabled} disabled={!isAdmin} onCheckedChange={() => toggle.mutate(a)} />
          </div>
        ))
      )}
      <PresetGallery
        open={gallery}
        onOpenChange={setGallery}
        onCreated={(a) => {
          setGallery(false);
          setEditing(a);
        }}
      />
    </div>
  );
}

function PresetGallery({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (a: Action) => void;
}) {
  const { api, wid } = useWorkspace();
  const qc = useQueryClient();
  const presets = useQuery({
    queryKey: automationKeys.presets(wid),
    enabled: open,
    queryFn: () => api<{ presets: ActionPreset[] }>("/automation/presets"),
  });
  const secrets = useQuery({
    queryKey: automationKeys.secrets(wid),
    enabled: open,
    queryFn: () => api<{ secrets: Secret[] }>("/automation/secrets"),
  });
  const create = useMutation({
    mutationFn: (presetId: string) =>
      api<{ action: Action }>("/automation/actions/from-preset", { method: "POST", json: { presetId } }),
    onSuccess: ({ action }) => {
      qc.invalidateQueries({ queryKey: automationKeys.actions(wid) });
      toast.success(`Added ${action.name}`);
      onCreated(action);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const have = new Set((secrets.data?.secrets ?? []).map((s) => s.name));
  const groups = new Map<string, ActionPreset[]>();
  for (const p of presets.data?.presets ?? []) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Action templates"
      description="Pre-configured requests. Add one, then set the secrets it references under Secrets."
      className="w-[min(860px,calc(100vw-32px))]"
    >
      <div className="flex flex-col gap-5">
        {presets.isPending ? <Spinner /> : null}
        {[...groups.entries()].map(([group, items]) => (
          <div key={group} className="flex flex-col gap-2">
            <span className="label-mono">{group}</span>
            <div className="grid gap-px bg-line sm:grid-cols-2">
              {items.map((p) => {
                const missing = p.secrets.filter((s) => !have.has(s));
                return (
                  <button
                    key={p.id}
                    disabled={create.isPending}
                    onClick={() => create.mutate(p.id)}
                    className="flex flex-col gap-1.5 bg-bar p-3.5 text-left hover:bg-white/[0.03] disabled:opacity-60"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-fg">{p.title}</span>
                      {p.requiresApproval ? <Badge tone="warn">approval</Badge> : null}
                      {p.readOnly ? <Badge>read-only</Badge> : null}
                    </div>
                    <span className="font-mono text-[11.5px] text-dim">
                      {p.method} {hostOf(p.url)}
                    </span>
                    <span className="line-clamp-2 text-[11.5px] leading-relaxed text-muted">{p.description}</span>
                    {p.secrets.length ? (
                      <span className="flex flex-wrap items-center gap-1.5 pt-0.5">
                        <KeyRound className="size-2.5 text-dim" />
                        {p.secrets.map((s) => (
                          <span
                            key={s}
                            className={
                              missing.includes(s) ? "font-mono text-[11px] text-warn" : "font-mono text-[11px] text-ok"
                            }
                          >
                            {s}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
