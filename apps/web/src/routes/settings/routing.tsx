import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, CornerDownRight, GripVertical, Pencil, Plus } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { SettingsHeader, SettingsSection } from "../settings";
import { Avatar, Button, Dialog, Field, Input, Segmented, Select, Spinner, Switch } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm";
import {
  conditionParts,
  type RoutingConditions,
  type RoutingData,
  type RoutingGroup,
  type RoutingLogEntry,
  type RoutingRule,
  type RoutingSettings,
  routingKeys,
} from "@/features/routing/types";
import { clock, cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

/*
 * Routing — designed in pen.dev ("trace — Settings · Routing (app)"). Behaviour settings save with
 * "Save changes"; groups and rules are saved as you edit them.
 */

export function RoutingSettingsPage() {
  const { api, wid, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: routingKeys.all(wid), queryFn: () => api<RoutingData>("/routing") });
  const [draft, setDraft] = React.useState<RoutingSettings | null>(null);
  React.useEffect(() => {
    if (q.data) setDraft(q.data.settings);
  }, [q.data]);
  const save = useMutation({
    mutationFn: (s: RoutingSettings) => api("/routing/settings", { method: "PUT", json: s }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: routingKeys.all(wid) });
      toast.success("Routing saved");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!q.data || !draft)
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  const data = q.data;
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings);
  const set = (patch: Partial<RoutingSettings>) => setDraft({ ...draft, ...patch });
  const setT = (patch: Partial<RoutingSettings["triggers"]>) => set({ triggers: { ...draft.triggers, ...patch } });
  const canEnable = data.groups.length > 0;

  return (
    <div>
      <SettingsHeader
        title="Routing"
        description="Who gets a ticket once it needs a human. trace answers first; routing runs only when it hands off, asks for approval, is unsure, or the first reply is about to slip."
      >
        <button
          disabled={!isAdmin || (!draft.enabled && !canEnable)}
          title={canEnable ? "Turn auto-assignment on or off" : "Create a group first"}
          onClick={() => set({ enabled: !draft.enabled })}
          className={cn(
            "flex items-center gap-1.5 border px-2 py-[5px] font-mono text-[11px] tracking-[0.08em] disabled:opacity-60",
            draft.enabled ? "border-ok/30 text-ok" : "border-line-strong text-dim hover:text-fg-2",
          )}
        >
          <span className={cn("size-1.5", draft.enabled ? "bg-ok" : "bg-dim")} />
          {draft.enabled ? "AUTO-ASSIGN ON" : "AUTO-ASSIGN OFF"}
        </button>
        <Button
          variant="primary"
          disabled={!isAdmin || !dirty}
          loading={save.isPending}
          onClick={() => save.mutate(draft)}
        >
          {dirty ? "Save changes" : "Saved"}
        </Button>
      </SettingsHeader>

      <SettingsSection
        title="When to assign"
        description="trace answers first. A ticket goes to a person only at one of these moments."
      >
        <div className="flex flex-col">
          <Toggle
            on={draft.triggers.handoff}
            onChange={(v) => setT({ handoff: v })}
            label="trace hands a ticket off"
            hint="escalations, upset customers, legal or security"
          />
          <Toggle
            on={draft.triggers.approval}
            onChange={(v) => setT({ approval: v })}
            label="an action waits for approval"
            hint="refunds, plan changes, anything you marked consequential"
          />
          <Toggle
            on={draft.triggers.lowConfidence}
            onChange={(v) => setT({ lowConfidence: v })}
            label={
              <>
                trace's draft is below
                <NumberBox
                  value={Math.round(draft.triggers.confidenceBelow * 100)}
                  suffix="%"
                  min={5}
                  max={100}
                  onChange={(n) => setT({ confidenceBelow: n / 100 })}
                />
                confidence
              </>
            }
            hint="the draft stays attached for the person to edit"
          />
          <Toggle
            on={draft.triggers.slaSoon}
            onChange={(v) => setT({ slaSoon: v })}
            label={
              <>
                the first reply is due within
                <NumberBox
                  value={draft.triggers.slaMinutes}
                  suffix="min"
                  min={1}
                  max={1440}
                  onChange={(n) => setT({ slaMinutes: n })}
                />
              </>
            }
            hint="even if trace is still working on it"
          />
          <Toggle
            on={draft.triggers.everyTicket}
            onChange={(v) => setT({ everyTicket: v })}
            label="every new ticket, immediately"
            hint="classic helpdesk mode, skips the AI-first step"
          />
        </div>
      </SettingsSection>

      <RulesSection
        data={data}
        fallbackGroupId={draft.fallbackGroupId}
        onFallback={(id) => set({ fallbackGroupId: id })}
      />
      <GroupsSection data={data} />

      <SettingsSection
        title="Picking a person"
        description="Inside the group. People mark themselves away from the avatar menu, or with “/trace away” in Slack."
      >
        <Segmented
          value={draft.method}
          onChange={(m) => set({ method: m })}
          options={[
            { value: "least_open", label: "Fewest open tickets" },
            { value: "round_robin", label: "Round robin" },
          ]}
          className="w-fit border border-line-strong"
        />
        <div className="flex flex-col">
          <Row
            label={
              <>
                At most
                <NumberBox
                  value={draft.maxOpenPerAgent}
                  min={0}
                  max={1000}
                  onChange={(n) => set({ maxOpenPerAgent: n })}
                />
                open tickets per person
              </>
            }
            hint={draft.maxOpenPerAgent ? "full people are skipped until they close something" : "0 = no limit"}
          />
          <Toggle
            on={draft.stickyHours > 0}
            onChange={(v) => set({ stickyHours: v ? 72 : 0 })}
            label={
              <>
                Keep a customer with their last agent for
                <NumberBox
                  value={draft.stickyHours || 72}
                  suffix="h"
                  min={1}
                  max={720}
                  disabled={!draft.stickyHours}
                  onChange={(n) => set({ stickyHours: n })}
                />
              </>
            }
            hint="if that person is in the group and available"
          />
          <Toggle
            on={draft.skipAway}
            onChange={(v) => set({ skipAway: v })}
            label="Skip people who are away"
            hint="nobody available → the fallback group"
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Safety net"
        description="An assigned ticket that nobody touches doesn't get stuck with one person."
      >
        <Toggle
          on={draft.reassign.enabled}
          onChange={(v) => set({ reassign: { ...draft.reassign, enabled: v } })}
          label={
            <>
              Hand back to the group
              <NumberBox
                value={draft.reassign.minutesBeforeDue}
                suffix="min"
                min={1}
                max={1440}
                onChange={(n) => set({ reassign: { ...draft.reassign, minutesBeforeDue: n } })}
              />
              before the first-reply target if the assignee hasn't replied
            </>
          }
          hint={`the next person is picked the same way; at most ${draft.reassign.maxTimes} times per ticket`}
          last
        />
      </SettingsSection>

      <DecisionLog />
    </div>
  );
}

/* ------------------------------------------------------------------ small controls */

function Toggle({
  on,
  onChange,
  label,
  hint,
  last,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;
  hint?: string;
  last?: boolean;
}) {
  const { isAdmin } = useWorkspace();
  return (
    <div className={cn("flex items-center gap-3.5 py-3", !last && "border-b border-line-2")}>
      <Switch checked={on} disabled={!isAdmin} onCheckedChange={onChange} />
      <div className="flex min-w-0 flex-col gap-1">
        <span className={cn("flex flex-wrap items-center gap-2 text-[13px]", on ? "text-fg-2" : "text-dim")}>
          {label}
        </span>
        {hint ? <span className="font-mono text-[11px] text-dim">{hint}</span> : null}
      </div>
    </div>
  );
}

function Row({ label, hint }: { label: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-line-2 py-3">
      <span className="flex flex-wrap items-center gap-2 text-[13px] text-fg-2">{label}</span>
      {hint ? <span className="font-mono text-[11px] text-dim">{hint}</span> : null}
    </div>
  );
}

/** Inline number in a sentence: "below [70%] confidence". */
function NumberBox({
  value,
  onChange,
  suffix,
  min,
  max,
  disabled,
}: {
  value: number;
  onChange: (n: number) => void;
  suffix?: string;
  min: number;
  max: number;
  disabled?: boolean;
}) {
  const { isAdmin } = useWorkspace();
  const [text, setText] = React.useState(String(value));
  React.useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(text));
    if (!Number.isFinite(n)) return setText(String(value));
    const clamped = Math.min(max, Math.max(min, n));
    setText(String(clamped));
    if (clamped !== value) onChange(clamped);
  };
  return (
    <span className="inline-flex h-6 items-center border border-line-strong bg-input pr-1.5 font-mono text-[11.5px] text-fg-2 focus-within:border-accent/60">
      <input
        value={text}
        disabled={disabled || !isAdmin}
        inputMode="numeric"
        onChange={(e) => setText(e.target.value.replace(/[^\d]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="w-9 bg-transparent px-1.5 text-right outline-none disabled:opacity-60"
        aria-label={suffix ? `value in ${suffix}` : "value"}
      />
      {suffix ? <span className="text-dim">{suffix}</span> : null}
    </span>
  );
}

/* ------------------------------------------------------------------ rules */

function RulesSection({
  data,
  fallbackGroupId,
  onFallback,
}: {
  data: RoutingData;
  fallbackGroupId: string | null;
  onFallback: (id: string | null) => void;
}) {
  const { api, wid, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const [editing, setEditing] = React.useState<RoutingRule | "new" | null>(null);
  const [order, setOrder] = React.useState(data.rules);
  const [dragId, setDragId] = React.useState<string | null>(null);
  React.useEffect(() => setOrder(data.rules), [data.rules]);
  const reorder = useMutation({
    mutationFn: (ids: string[]) => api("/routing/rules/reorder", { method: "POST", json: { ids } }),
    onSettled: () => qc.invalidateQueries({ queryKey: routingKeys.all(wid) }),
  });
  const groupName = (id: string | null) => data.groups.find((g) => g.id === id)?.name;
  const size = (id: string | null) => data.groups.find((g) => g.id === id)?.memberIds.length ?? 0;

  return (
    <SettingsSection
      title="Rules"
      description="Checked top to bottom; the first match decides the group. Conditions use what trace's triage already found."
    >
      <div className="flex flex-col">
        {order.map((r, i) => (
          <div
            key={r.id}
            draggable={isAdmin}
            onDragStart={() => setDragId(r.id)}
            onDragOver={(e) => {
              e.preventDefault();
              if (!dragId || dragId === r.id) return;
              const from = order.findIndex((x) => x.id === dragId);
              const next = [...order];
              next.splice(i, 0, next.splice(from, 1)[0]!);
              setOrder(next);
            }}
            onDragEnd={() => {
              setDragId(null);
              if (order.map((x) => x.id).join() !== data.rules.map((x) => x.id).join())
                reorder.mutate(order.map((x) => x.id));
            }}
            className={cn(
              "group flex h-12 items-center gap-3.5 border-b border-line-2 pr-1",
              dragId === r.id && "opacity-50",
              !r.enabled && "opacity-60",
            )}
          >
            <GripVertical className="size-3.5 shrink-0 cursor-grab text-dim" />
            <span className="w-5 shrink-0 font-mono text-[11px] text-dim">{String(i + 1).padStart(2, "0")}</span>
            <button
              onClick={() => setEditing(r)}
              disabled={!isAdmin}
              className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 text-left font-mono text-[11.5px]"
            >
              <ConditionText conditions={r.conditions} match={r.match} />
              {!r.enabled ? <span className="text-dim">· paused</span> : null}
            </button>
            <ArrowRight className="size-3.5 shrink-0 text-dim" />
            <span className="flex w-44 shrink-0 items-baseline gap-2">
              <span className="truncate text-[12.5px] text-fg">{groupName(r.groupId)}</span>
              <span className="shrink-0 font-mono text-[11px] text-dim">{size(r.groupId)} people</span>
            </span>
          </div>
        ))}
        <div className="flex h-12 items-center gap-3.5 border-b border-line-2 pr-1">
          <CornerDownRight className="size-3.5 shrink-0 text-dim" />
          <span className="w-5 shrink-0 font-mono text-[11px] text-dim">··</span>
          <span className="flex-1 font-mono text-[11.5px] text-dim">
            {order.length ? "everything else" : "every ticket"}
          </span>
          <ArrowRight className="size-3.5 shrink-0 text-dim" />
          <span className="w-44 shrink-0">
            <Select
              value={fallbackGroupId ?? ""}
              disabled={!isAdmin}
              onChange={(e) => onFallback(e.target.value || null)}
              placeholder="nobody (stay unassigned)"
              className="h-7 text-[12.5px]"
            >
              <option value="">nobody (stay unassigned)</option>
              {data.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </span>
        </div>
        <div className="flex items-center justify-between gap-4 pt-3.5">
          <button
            disabled={!isAdmin || !data.groups.length}
            onClick={() => setEditing("new")}
            className="flex items-center gap-1.5 font-mono text-[11px] text-body hover:text-fg disabled:opacity-60"
            title={data.groups.length ? undefined : "Create a group first"}
          >
            <Plus className="size-3" /> add rule
          </button>
          <PreviewBox />
        </div>
      </div>
      <RuleDialog rule={editing} groups={data.groups} onClose={() => setEditing(null)} />
    </SettingsSection>
  );
}

function ConditionText({ conditions, match }: { conditions: RoutingConditions; match: "any" | "all" }) {
  const parts = conditionParts(conditions);
  if (!parts.length) return <span className="text-dim">every ticket</span>;
  return (
    <>
      {parts.map(([k, v], i) => (
        <React.Fragment key={k}>
          {i ? <span className="text-dim">{match === "all" ? "and" : "or"}</span> : null}
          <span className="text-dim">{k === "MRR ≥" || i ? k : `${k} is`}</span>
          <span className="text-fg-2">{v}</span>
        </React.Fragment>
      ))}
    </>
  );
}

/** "Where would #4814 go right now?" — without assigning anything. */
function PreviewBox() {
  const { api } = useWorkspace();
  const [n, setN] = React.useState("");
  const run = useMutation({
    mutationFn: (num: string) =>
      api<{
        rule: string;
        group: string | null;
        assignee: { name: string } | null;
        pick: string | null;
        why: string | null;
      }>(`/routing/preview?ticket=${encodeURIComponent(num)}`),
  });
  const r = run.data;
  return (
    <form
      className="flex min-w-0 items-center gap-2 font-mono text-[11px]"
      onSubmit={(e) => {
        e.preventDefault();
        if (n) run.mutate(n);
      }}
    >
      <span className="text-dim">try ticket #</span>
      <input
        value={n}
        onChange={(e) => {
          setN(e.target.value.replace(/\D/g, ""));
          run.reset();
        }}
        placeholder="4814"
        className="h-6 w-16 border border-line-strong bg-input px-1.5 text-fg-2 outline-none placeholder:text-dim focus:border-accent/60"
        aria-label="Ticket number to preview"
      />
      {run.isPending ? <Spinner /> : null}
      {run.error ? <span className="text-danger">{(run.error as Error).message}</span> : null}
      {r ? (
        <span className="truncate text-body" title={r.why ?? r.pick ?? ""}>
          {r.rule === "fallback" ? "fallback" : `rule ${r.rule.slice(0, 2)}`} → {r.group ?? "no group"}
          {r.assignee ? ` · ${r.assignee.name}` : ` · ${r.why}`}
        </span>
      ) : null}
    </form>
  );
}

const CHANNELS = ["email", "widget", "slack", "discord", "api", "web"];
const PRIORITIES = ["urgent", "high", "normal", "low"];
const csv = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

function RuleDialog({
  rule,
  groups,
  onClose,
}: {
  rule: RoutingRule | "new" | null;
  groups: RoutingGroup[];
  onClose: () => void;
}) {
  const { api, wid } = useWorkspace();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const existing = rule && rule !== "new" ? rule : null;
  const [groupId, setGroupId] = React.useState("");
  const [match, setMatch] = React.useState<"any" | "all">("any");
  const [enabled, setEnabled] = React.useState(true);
  const [text, setText] = React.useState({ intents: "", tags: "", languages: "", plans: "", minMrr: "" });
  const [channels, setChannels] = React.useState<string[]>([]);
  const [priorities, setPriorities] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (!rule) return;
    const c = existing?.conditions ?? {};
    setGroupId(existing?.groupId ?? groups[0]?.id ?? "");
    setMatch(existing?.match ?? "any");
    setEnabled(existing?.enabled ?? true);
    setText({
      intents: (c.intents ?? []).join(", "),
      tags: (c.tags ?? []).join(", "),
      languages: (c.languages ?? []).join(", "),
      plans: (c.plans ?? []).join(", "),
      minMrr: c.minMrr != null ? String(c.minMrr) : "",
    });
    setChannels(c.channels ?? []);
    setPriorities(c.priorities ?? []);
  }, [rule]); // eslint-disable-line react-hooks/exhaustive-deps
  const conditions: RoutingConditions = {
    intents: csv(text.intents).map((x) => x.toLowerCase().replace(/\s+/g, "_")),
    tags: csv(text.tags).map((x) => x.replace(/^#/, "").toLowerCase()),
    languages: csv(text.languages).map((x) => x.toLowerCase().slice(0, 2)),
    channels,
    priorities,
    plans: csv(text.plans).map((x) => x.toLowerCase()),
    minMrr: text.minMrr ? Number(text.minMrr) : null,
  };
  const done = () => {
    qc.invalidateQueries({ queryKey: routingKeys.all(wid) });
    onClose();
  };
  const save = useMutation({
    mutationFn: () =>
      existing
        ? api(`/routing/rules/${existing.id}`, { method: "PATCH", json: { groupId, match, conditions, enabled } })
        : api("/routing/rules", { method: "POST", json: { groupId, match, conditions, enabled } }),
    onSuccess: () => {
      toast.success(existing ? "Rule saved" : "Rule added");
      done();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({
    mutationFn: () => api(`/routing/rules/${existing!.id}`, { method: "DELETE" }),
    onSuccess: done,
  });
  const chips = (all: string[], value: string[], set: (v: string[]) => void) => (
    <div className="flex flex-wrap gap-1.5">
      {all.map((o) => {
        const on = value.includes(o);
        return (
          <button
            key={o}
            type="button"
            onClick={() => set(on ? value.filter((x) => x !== o) : [...value, o])}
            className={cn(
              "border px-2 py-1 font-mono text-[11px]",
              on ? "border-accent/50 bg-accent/10 text-accent-fg" : "border-line-strong text-muted hover:text-fg",
            )}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
  return (
    <Dialog
      open={!!rule}
      onOpenChange={(v) => !v && onClose()}
      title={existing ? "Edit rule" : "Add rule"}
      description="Leave a field empty to ignore it. With no conditions the rule matches every ticket."
      className="w-[min(620px,calc(100vw-32px))]"
      footer={
        <>
          {existing ? (
            <Button
              variant="danger"
              className="mr-auto"
              onClick={async () =>
                (await confirm({
                  title: "Delete this rule?",
                  description: "Tickets it matched fall through to the next rule or the fallback group.",
                  confirmLabel: "Delete",
                  destructive: true,
                })) && del.mutate()
              }
            >
              Delete
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!groupId} loading={save.isPending} onClick={() => save.mutate()}>
            {existing ? "Save rule" : "Add rule"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Field label="Send to group">
            <Select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Match">
            <Segmented
              value={match}
              onChange={setMatch}
              options={[
                { value: "any", label: "any condition" },
                { value: "all", label: "all conditions" },
              ]}
              className="h-8 border border-line-strong"
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Intent" hint="as triage names it, e.g. billing_issue, refund">
            <Input
              value={text.intents}
              onChange={(e) => setText({ ...text, intents: e.target.value })}
              placeholder="e.g. billing_issue, refund"
            />
          </Field>
          <Field label="Tags">
            <Input
              value={text.tags}
              onChange={(e) => setText({ ...text, tags: e.target.value })}
              placeholder="e.g. billing, refund"
            />
          </Field>
          <Field label="Language" hint="two letters: de, fr, es">
            <Input
              value={text.languages}
              onChange={(e) => setText({ ...text, languages: e.target.value })}
              placeholder="e.g. de, fr"
            />
          </Field>
          <Field label="Customer plan" hint="customer attribute “plan”">
            <Input
              value={text.plans}
              onChange={(e) => setText({ ...text, plans: e.target.value })}
              placeholder="e.g. enterprise"
            />
          </Field>
          <Field label="Customer MRR at least" hint="customer attribute “mrr”">
            <Input
              value={text.minMrr}
              inputMode="numeric"
              onChange={(e) => setText({ ...text, minMrr: e.target.value.replace(/[^\d]/g, "") })}
              placeholder="e.g. 2000"
            />
          </Field>
        </div>
        <Field label="Channel">{chips(CHANNELS, channels, setChannels)}</Field>
        <Field label="Priority">{chips(PRIORITIES, priorities, setPriorities)}</Field>
        {existing ? (
          <label className="flex items-center gap-3 text-[13px] text-fg-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} /> Rule is active
          </label>
        ) : null}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ groups */

function GroupsSection({ data }: { data: RoutingData }) {
  const { boot, isAdmin } = useWorkspace();
  const [editing, setEditing] = React.useState<RoutingGroup | "new" | null>(null);
  const byId = new Map(boot.members.map((m) => [m.id, m]));
  return (
    <SettingsSection title="Groups" description="People who share a kind of ticket. Someone can be in several groups.">
      <div className="flex flex-col">
        {data.groups.length ? (
          <div className="grid h-[30px] grid-cols-[160px_1fr_96px_64px_32px] items-center border-b border-line font-mono text-[11px] tracking-[0.1em] text-dim uppercase">
            <span>Group</span>
            <span>People</span>
            <span className="text-right">Available</span>
            <span className="text-right">Open</span>
            <span />
          </div>
        ) : (
          <p className="pb-1 text-[12.5px] text-dim">
            No groups yet. Start with one group for everyone; add more when tickets need specialists.
          </p>
        )}
        {data.groups.map((g) => (
          <div
            key={g.id}
            className="grid h-[46px] grid-cols-[160px_1fr_96px_64px_32px] items-center border-b border-line-2"
          >
            <span className="truncate text-[12.5px] text-fg-2">{g.name}</span>
            <span className="flex items-center">
              {g.memberIds.slice(0, 8).map((id, i) => {
                const m = byId.get(id);
                return (
                  <Avatar
                    key={id}
                    name={m?.name}
                    src={m?.image}
                    size={26}
                    className={cn("ring-2 ring-bg", i && "-ml-1", data.statuses[id] === "away" && "opacity-50")}
                  />
                );
              })}
              {!g.memberIds.length ? <span className="font-mono text-[11px] text-dim">nobody yet</span> : null}
            </span>
            <span className="flex items-center justify-end gap-1.5 font-mono text-[12px] text-fg-2">
              <span className={cn("size-[5px]", g.available ? "bg-ok" : "bg-warn")} />
              {g.available} of {g.memberIds.length}
            </span>
            <span className="text-right font-mono text-[12px] text-fg-2">{g.open}</span>
            <span className="flex justify-end">
              <button
                aria-label={`Edit ${g.name}`}
                disabled={!isAdmin}
                onClick={() => setEditing(g)}
                className="p-1 text-dim hover:text-fg disabled:opacity-60"
              >
                <Pencil className="size-[13px]" />
              </button>
            </span>
          </div>
        ))}
        <button
          disabled={!isAdmin}
          onClick={() => setEditing("new")}
          className="flex w-fit items-center gap-1.5 pt-3.5 font-mono text-[11px] text-body hover:text-fg disabled:opacity-60"
        >
          <Plus className="size-3" /> new group
        </button>
      </div>
      <GroupDialog group={editing} statuses={data.statuses} onClose={() => setEditing(null)} />
    </SettingsSection>
  );
}

function GroupDialog({
  group,
  statuses,
  onClose,
}: {
  group: RoutingGroup | "new" | null;
  statuses: RoutingData["statuses"];
  onClose: () => void;
}) {
  const { api, wid, boot } = useWorkspace();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const existing = group && group !== "new" ? group : null;
  const [name, setName] = React.useState("");
  const [members, setMembers] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (!group) return;
    setName(existing?.name ?? "");
    setMembers(existing?.memberIds ?? []);
  }, [group]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = () => {
    qc.invalidateQueries({ queryKey: routingKeys.all(wid) });
    onClose();
  };
  const save = useMutation({
    mutationFn: () =>
      existing
        ? api(`/routing/groups/${existing.id}`, { method: "PATCH", json: { name, memberIds: members } })
        : api("/routing/groups", { method: "POST", json: { name, memberIds: members } }),
    onSuccess: () => {
      toast.success(existing ? "Group saved" : "Group created");
      done();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({
    mutationFn: () => api(`/routing/groups/${existing!.id}`, { method: "DELETE" }),
    onSuccess: done,
  });
  return (
    <Dialog
      open={!!group}
      onOpenChange={(v) => !v && onClose()}
      title={existing ? `Edit ${existing.name}` : "New group"}
      footer={
        <>
          {existing ? (
            <Button
              variant="danger"
              className="mr-auto"
              onClick={async () =>
                (await confirm({
                  title: `Delete ${existing.name}?`,
                  description: "Rules that send tickets here are deleted too. Assigned tickets keep their assignee.",
                  confirmLabel: "Delete",
                  destructive: true,
                })) && del.mutate()
              }
            >
              Delete
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim()} loading={save.isPending} onClick={() => save.mutate()}>
            {existing ? "Save group" : "Create group"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Billing" />
        </Field>
        <Field label="People">
          <div className="flex max-h-72 flex-col overflow-y-auto border border-line">
            {boot.members.map((m) => {
              const on = members.includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMembers(on ? members.filter((x) => x !== m.id) : [...members, m.id])}
                  className={cn(
                    "flex items-center gap-2.5 border-b border-line-2 px-3 py-2 text-left last:border-b-0",
                    on ? "bg-accent/[0.08]" : "hover:bg-white/[0.03]",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-3.5 items-center justify-center border",
                      on ? "border-accent bg-accent/30" : "border-line-strong",
                    )}
                  >
                    {on ? <span className="size-1.5 bg-accent-fg" /> : null}
                  </span>
                  <Avatar name={m.name} src={m.image} size={26} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] text-fg-2">{m.name}</span>
                    <span className="truncate font-mono text-[11px] text-dim">{m.email}</span>
                  </span>
                  <span className={cn("font-mono text-[11px]", statuses[m.id] === "away" ? "text-warn" : "text-dim")}>
                    {statuses[m.id] === "away" ? "away" : "available"}
                  </span>
                </button>
              );
            })}
          </div>
        </Field>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ log */

function DecisionLog() {
  const { api, wid, slug } = useWorkspace();
  const q = useQuery({
    queryKey: routingKeys.log(wid),
    queryFn: () => api<{ entries: RoutingLogEntry[] }>("/routing/log"),
    refetchInterval: 30_000,
  });
  const entries = q.data?.entries ?? [];
  return (
    <SettingsSection
      title="Recent decisions"
      description="Each assignment is also a span on the ticket's trace. Last 24 hours."
      className="border-b-0"
    >
      {!entries.length ? (
        <p className="text-[12.5px] text-dim">Nothing routed in the last 24 hours.</p>
      ) : (
        <div className="flex flex-col">
          {entries.map((e) => (
            <div key={e.id} className="flex h-[34px] items-center gap-4 border-b border-line-2 font-mono text-[11.5px]">
              <span className="shrink-0 text-dim">{clock(e.at)}</span>
              <Link
                to="/w/$slug/inbox/$view/$ticket"
                params={{ slug, view: "all", ticket: String(e.number) }}
                className="shrink-0 text-fg-2 hover:text-fg"
                title={e.subject}
              >
                #{e.number}
              </Link>
              <span
                className={cn(
                  "truncate",
                  e.name === "route.unassigned" || e.summary?.startsWith("reassigned") ? "text-warn" : "text-body",
                )}
              >
                {e.summary}
              </span>
            </div>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
