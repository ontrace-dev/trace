import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ListChecks, Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button, Empty, Field, Input, Spinner, Switch, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { type Action, automationKeys, type Procedure } from "./types";
import { useConfirm } from "@/components/ui/confirm";

type Draft = Pick<Procedure, "name" | "trigger" | "instructions" | "enabled">;
const empty: Draft = { name: "", trigger: "", instructions: "", enabled: true };

export function ProceduresTab() {
  const { api, wid, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: automationKeys.procedures(wid),
    queryFn: () => api<{ procedures: Procedure[] }>("/automation/procedures"),
  });
  const actions = useQuery({
    queryKey: automationKeys.actions(wid),
    queryFn: () => api<{ actions: Action[] }>("/automation/actions"),
  });
  const [selected, setSelected] = React.useState<string | "new" | null>(null);
  const procs = list.data?.procedures ?? [];
  React.useEffect(() => {
    if (selected === null && procs.length) setSelected(procs[0]!.id);
  }, [procs, selected]);
  const current = selected && selected !== "new" ? procs.find((p) => p.id === selected) : undefined;

  const reorder = useMutation({
    mutationFn: (ids: string[]) => api("/automation/procedures/reorder", { method: "POST", json: { ids } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationKeys.procedures(wid) }),
  });
  const move = (i: number, dir: -1 | 1) => {
    const ids = procs.map((p) => p.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    reorder.mutate(ids);
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-line px-8 py-4">
        <p className="max-w-2xl text-[12px] leading-relaxed text-dim">
          Procedures are playbooks in plain language: <em>when</em> they apply and the steps to follow — which actions
          to call, what to check, when to hand over. The agent follows the first matching one.
        </p>
        <Button variant="primary" disabled={!isAdmin} onClick={() => setSelected("new")}>
          <Plus /> New procedure
        </Button>
      </div>
      {list.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : !procs.length && selected !== "new" ? (
        <Empty icon={<ListChecks />} title="No procedures yet">
          Write how your best agent handles a duplicate charge, an outage report or a cancellation — the AI follows it
          step by step.
        </Empty>
      ) : (
        <div className="grid min-h-[480px] lg:grid-cols-[280px_1fr]">
          <div className="border-r border-line">
            {procs.map((p, i) => (
              <div
                key={p.id}
                className={cn(
                  "group flex items-center gap-2 border-b border-line-2 px-4 py-2.5",
                  selected === p.id ? "bg-white/[0.04]" : "hover:bg-white/[0.02]",
                )}
              >
                <button className="flex min-w-0 flex-1 flex-col text-left" onClick={() => setSelected(p.id)}>
                  <span className={cn("truncate text-[13px]", p.enabled ? "text-fg-2" : "text-dim line-through")}>
                    {p.name}
                  </span>
                  <span className="truncate text-[11px] text-dim">{p.trigger}</span>
                </button>
                {isAdmin ? (
                  <span className="hidden flex-col group-hover:flex">
                    <button onClick={() => move(i, -1)} className="text-dim hover:text-fg">
                      <ArrowUp className="size-3" />
                    </button>
                    <button onClick={() => move(i, 1)} className="text-dim hover:text-fg">
                      <ArrowDown className="size-3" />
                    </button>
                  </span>
                ) : null}
              </div>
            ))}
          </div>
          {selected === "new" || current ? (
            <ProcedureEditor
              key={current?.id ?? "new"}
              procedure={current}
              actions={actions.data?.actions ?? []}
              onSaved={(id) => setSelected(id)}
              onDeleted={() => setSelected(null)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function ProcedureEditor({
  procedure,
  actions,
  onSaved,
  onDeleted,
}: {
  procedure?: Procedure;
  actions: Action[];
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const confirm = useConfirm();
  const { api, wid, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const [d, setD] = React.useState<Draft>(procedure ?? empty);
  const ta = React.useRef<HTMLTextAreaElement>(null);
  const save = useMutation({
    mutationFn: () =>
      procedure
        ? api<{ procedure: Procedure }>(`/automation/procedures/${procedure.id}`, { method: "PATCH", json: d })
        : api<{ procedure: Procedure }>("/automation/procedures", { method: "POST", json: d }),
    onSuccess: ({ procedure: p }) => {
      qc.invalidateQueries({ queryKey: automationKeys.procedures(wid) });
      toast.success("Procedure saved");
      onSaved(p.id);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({
    mutationFn: () => api(`/automation/procedures/${procedure!.id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.procedures(wid) });
      onDeleted();
    },
  });
  const insert = (text: string) => {
    const el = ta.current;
    if (!el) return setD({ ...d, instructions: d.instructions + text });
    const start = el.selectionStart;
    const next = d.instructions.slice(0, start) + text + d.instructions.slice(el.selectionEnd);
    setD({ ...d, instructions: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + text.length, start + text.length);
    });
  };
  return (
    <div className="flex flex-col gap-4 px-8 py-6">
      <div className="flex items-center gap-3">
        <Input
          value={d.name}
          onChange={(e) => setD({ ...d, name: e.target.value })}
          placeholder="Duplicate charge"
          className="text-[14px] font-medium"
        />
        <label className="flex shrink-0 items-center gap-2 text-xs text-muted">
          <Switch checked={d.enabled} onCheckedChange={(v) => setD({ ...d, enabled: v })} /> enabled
        </label>
      </div>
      <Field label="When to use" hint="Describe the situation as a customer would present it.">
        <Input
          value={d.trigger}
          onChange={(e) => setD({ ...d, trigger: e.target.value })}
          placeholder="The customer says they were charged twice for the same invoice."
        />
      </Field>
      <Field
        label="Steps"
        hint="Markdown. Name actions by their tool name; say what to verify before acting and when to escalate."
      >
        <Textarea
          ref={ta}
          rows={14}
          value={d.instructions}
          onChange={(e) => setD({ ...d, instructions: e.target.value })}
          className="font-mono text-[12px] leading-relaxed"
          placeholder={"1. Call **lookup_charges** …\n2. If … then …\n3. Otherwise escalate."}
        />
      </Field>
      {actions.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[11px] text-dim">insert action</span>
          {actions.map((a) => (
            <button
              key={a.id}
              onClick={() => insert(`**${a.name}**`)}
              className="border border-line-strong px-1.5 py-0.5 font-mono text-[11.5px] text-muted hover:border-accent/40 hover:text-fg"
            >
              {a.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={!isAdmin || !d.name || !d.trigger || !d.instructions}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          {procedure ? "Save procedure" : "Create procedure"}
        </Button>
        {procedure ? (
          <Button
            variant="ghost"
            disabled={!isAdmin}
            onClick={async () =>
              (await confirm({
                title: "Delete procedure?",
                description: `"${procedure.name}" will no longer guide the agent.`,
                confirmLabel: "Delete",
                destructive: true,
              })) && del.mutate()
            }
          >
            <Trash2 /> Delete
          </Button>
        ) : null}
      </div>
    </div>
  );
}
