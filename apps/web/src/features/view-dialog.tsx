import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { Button, Dialog, Field, Input, Select } from "@/components/ui";
import type { View, ViewFilters } from "@/lib/types";
import { cn } from "@/lib/utils";
import { qk, useWorkspace } from "@/lib/workspace";
import { viewIcons } from "@/lib/view-icons";
import { useConfirm } from "@/components/ui/confirm";
import { homeKeys } from "@/features/home/types";

const STATUSES = ["open", "pending", "resolved", "closed"] as const;
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const CHANNELS = ["email", "widget", "slack", "discord", "api", "web"] as const;
const AI_STATES = ["draft_ready", "escalated", "awaiting_approval", "auto_replied", "processing"] as const;

function Chips<T extends string>({
  options,
  value = [],
  onChange,
}: {
  options: readonly T[];
  value?: T[];
  onChange: (v: T[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button
            key={o}
            type="button"
            onClick={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])}
            className={cn(
              "border px-2 py-1 font-mono text-[11px]",
              on ? "border-accent/50 bg-accent/10 text-accent-fg" : "border-line-strong text-muted hover:text-fg",
            )}
          >
            {o.replace("_", " ")}
          </button>
        );
      })}
    </div>
  );
}

/** Create or edit a saved view (a named set of ticket filters shown in the rail). */
export function ViewDialog({
  open,
  onOpenChange,
  view,
  stay,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  view?: View;
  /** Stay on the current page after saving instead of opening the view. */
  stay?: boolean;
}) {
  const confirm = useConfirm();
  const { api, wid, slug, boot } = useWorkspace();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = React.useState(view?.name ?? "");
  const [icon, setIcon] = React.useState(view?.icon ?? "layers");
  const [f, setF] = React.useState<ViewFilters>(view?.filters ?? { status: ["open", "pending"] });
  const [tags, setTags] = React.useState((view?.filters.tags ?? []).join(", "));
  React.useEffect(() => {
    if (open) {
      setName(view?.name ?? "");
      setIcon(view?.icon ?? "layers");
      setF(view?.filters ?? { status: ["open", "pending"] });
      setTags((view?.filters.tags ?? []).join(", "));
    }
  }, [open, view]);
  const save = useMutation({
    mutationFn: () => {
      const filters = {
        ...f,
        tags: tags
          .split(",")
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
      };
      return view
        ? api<{ view: View }>(`/views/${view.id}`, { method: "PATCH", json: { name, icon, filters } })
        : api<{ view: View }>("/views", { method: "POST", json: { name, icon, filters } });
    },
    onSuccess: ({ view: v }) => {
      qc.invalidateQueries({ queryKey: qk.boot(wid) });
      qc.invalidateQueries({ queryKey: qk.counts(wid) });
      qc.invalidateQueries({ queryKey: ["tickets", wid] });
      qc.invalidateQueries({ queryKey: homeKeys.views(wid) });
      qc.invalidateQueries({ queryKey: homeKeys.home(wid) });
      onOpenChange(false);
      if (stay) toast.success(view ? "View saved" : `View ${v.name} created`);
      else navigate({ to: "/w/$slug/inbox/$view", params: { slug, view: v.id } });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api(`/views/${view!.id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.boot(wid) });
      qc.invalidateQueries({ queryKey: homeKeys.views(wid) });
      qc.invalidateQueries({ queryKey: homeKeys.home(wid) });
      onOpenChange(false);
      if (!stay) navigate({ to: "/w/$slug/inbox/$view", params: { slug, view: "inbox" } });
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={view ? "Edit view" : "New view"}
      description="Views are saved filters everyone in the workspace sees in the sidebar."
      footer={
        <>
          {view ? (
            <Button
              variant="danger"
              className="mr-auto"
              onClick={async () =>
                (await confirm({
                  title: `Delete “${view.name}”?`,
                  description: "The view disappears for everyone. Tickets aren't affected.",
                  confirmLabel: "Delete",
                  destructive: true,
                })) && remove.mutate()
              }
            >
              Delete view
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name} loading={save.isPending} onClick={() => save.mutate()}>
            Save view
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Billing disputes" />
        </Field>
        <Field label="Icon">
          <div className="flex gap-1">
            {Object.entries(viewIcons).map(([k, Icon]) => (
              <button
                key={k}
                type="button"
                onClick={() => setIcon(k)}
                className={cn(
                  "flex h-7 w-7 items-center justify-center border",
                  icon === k ? "border-accent/60 text-accent-fg" : "border-line text-dim hover:text-fg",
                )}
              >
                <Icon className="size-[14px]" />
              </button>
            ))}
          </div>
        </Field>
        <Field label="Status">
          <Chips options={STATUSES} value={f.status} onChange={(status) => setF({ ...f, status })} />
        </Field>
        <Field label="Priority">
          <Chips options={PRIORITIES} value={f.priority} onChange={(priority) => setF({ ...f, priority })} />
        </Field>
        <Field label="Channel">
          <Chips
            options={CHANNELS}
            value={f.channel as (typeof CHANNELS)[number][]}
            onChange={(channel) => setF({ ...f, channel })}
          />
        </Field>
        <Field label="AI state">
          <Chips
            options={AI_STATES}
            value={f.aiState as (typeof AI_STATES)[number][]}
            onChange={(aiState) => setF({ ...f, aiState })}
          />
        </Field>
        <Field label="Tags (any of)" hint="Comma separated, e.g. billing, refunds">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
        <Field label="Assignee">
          <Select value={f.assignee ?? ""} onChange={(e) => setF({ ...f, assignee: e.target.value || undefined })}>
            <option value="">Anyone</option>
            <option value="me">Me (whoever views it)</option>
            <option value="none">Unassigned</option>
            {boot.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}
