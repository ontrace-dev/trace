import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Sparkle, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { SettingsHeader, SettingsSection } from "../settings";
import { Button, Dialog, Field, Input, Segmented, Select, Spinner, Switch, Textarea } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm";
import {
  type FieldDef,
  type FieldOption,
  type FieldType,
  issueKeys,
  PROVIDER,
  type Tracker,
  toneDot,
} from "@/features/issues/types";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

/* Designed in pen.dev ("trace — Settings · Ticket fields (app)"). Changes save as you make them. */

type FieldsData = { fields: FieldDef[]; stats: { classified: number; corrected: number } };

export function FieldsSettingsPage() {
  const { api, wid, boot, isAdmin } = useWorkspace();
  const q = useQuery({ queryKey: issueKeys.fields(wid), queryFn: () => api<FieldsData>("/fields") });
  const [editing, setEditing] = React.useState<FieldDef | "new" | null>(null);
  if (!q.data)
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  const { fields, stats } = q.data;
  const typeField = fields.find((f) => f.key === "type");
  const custom = fields.filter((f) => f.key !== "type");
  const agent = boot.settings.ai.agentName;
  return (
    <div>
      <SettingsHeader
        title="Ticket fields"
        description={`Properties every ticket carries. ${agent} fills the ones marked ✦ from the conversation; others come from the customer record or are set by hand. They're on every ticket, in issues you file, and in the API.`}
      />

      {typeField ? (
        <SettingsSection
          title="Classification"
          description={`What kind of ticket this is for your team. ${agent} sets it on every ticket; anyone can correct it, and corrections teach the next guess.`}
        >
          <div className="flex flex-wrap items-center gap-2">
            {typeField.options.map((o) => (
              <span
                key={o.value}
                className="flex items-center gap-[7px] border border-line-strong px-[9px] py-[5px] font-mono text-[11.5px] text-fg-2"
              >
                <span className={cn("size-1.5", toneDot[o.color ?? "neutral"])} />
                {o.value}
              </span>
            ))}
            <button
              disabled={!isAdmin}
              onClick={() => setEditing(typeField)}
              className="flex items-center gap-1.5 px-2 py-[5px] font-mono text-[11px] text-body hover:text-fg disabled:opacity-60"
            >
              <Pencil className="size-3" /> edit types
            </button>
          </div>
          <p className="border-t border-line-2 pt-3 font-mono text-[11px]">
            <span className="text-dim">last 30 days: </span>
            <span className="text-fg-2">
              {agent} classified {stats.classified} · people changed {stats.corrected}
              {stats.classified ? ` (${((stats.corrected / stats.classified) * 100).toFixed(1)}%)` : ""}
            </span>
          </p>
        </SettingsSection>
      ) : null}

      <SettingsSection
        title="Fields"
        description="Each field says where its value comes from. Fields marked “header” show next to the subject on every ticket."
      >
        <div className="flex flex-col">
          <div className="grid h-[30px] grid-cols-[180px_100px_1fr_72px_28px] items-center border-b border-line font-mono text-[11px] tracking-[0.1em] text-dim uppercase">
            <span>Field</span>
            <span>Type</span>
            <span>Value from</span>
            <span>Shown</span>
            <span />
          </div>
          {custom.map((f) => (
            <div
              key={f.id}
              className="grid h-[52px] grid-cols-[180px_100px_1fr_72px_28px] items-center border-b border-line-2"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[12.5px] text-fg-2">{f.label}</span>
                <span className="truncate font-mono text-[11px] text-dim">{f.key}</span>
              </span>
              <span className="font-mono text-[11px] text-body">
                {f.type}
                {f.options.length ? ` · ${f.options.length}` : ""}
              </span>
              <span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-[11.5px]">
                {f.source === "ai" ? (
                  <span className="flex items-center gap-1.5 truncate text-accent-text">
                    <Sparkle className="size-2.5 shrink-0 fill-accent text-accent" /> {agent} fills it
                  </span>
                ) : f.source === "customer" ? (
                  <span className="truncate text-fg-2">customer attribute {f.customerAttribute}</span>
                ) : (
                  <span className="text-body">set by hand</span>
                )}
                {f.requiredToResolve ? <span className="shrink-0 text-dim">· needed to resolve</span> : null}
              </span>
              <span className={cn("font-mono text-[11px]", f.shown === "header" ? "text-fg-2" : "text-dim")}>
                {f.shown}
              </span>
              <span className="flex justify-end">
                <button
                  aria-label={`Edit ${f.label}`}
                  disabled={!isAdmin}
                  onClick={() => setEditing(f)}
                  className="p-1 text-dim hover:text-fg disabled:opacity-60"
                >
                  <Pencil className="size-[13px]" />
                </button>
              </span>
            </div>
          ))}
          {!custom.length ? (
            <p className="py-3 text-[12.5px] text-dim">
              No custom fields yet. Common first ones: an account id read from the customer record (org_id), the app
              version, and a severity people set.
            </p>
          ) : null}
          <button
            disabled={!isAdmin}
            onClick={() => setEditing("new")}
            className="flex w-fit items-center gap-1.5 pt-3.5 font-mono text-[11px] text-body hover:text-fg disabled:opacity-60"
          >
            <Plus className="size-3" /> new field
          </button>
        </div>
      </SettingsSection>

      <TrackersSection classification={typeField?.options ?? []} />
      <FieldDialog field={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

/* ------------------------------------------------------------------ field dialog */

const TYPES: { value: FieldType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "select", label: "Single choice" },
  { value: "multiselect", label: "Multiple choice" },
  { value: "checkbox", label: "Yes / no" },
  { value: "date", label: "Date" },
  { value: "url", label: "Link" },
];
const COLORS = ["neutral", "danger", "warn", "ok", "info"];

function FieldDialog({ field, onClose }: { field: FieldDef | "new" | null; onClose: () => void }) {
  const { api, wid, boot } = useWorkspace();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const existing = field && field !== "new" ? field : null;
  const [f, setF] = React.useState<Omit<FieldDef, "id" | "position" | "key"> & { key: string }>(blank());
  const [newOption, setNewOption] = React.useState("");
  React.useEffect(() => {
    if (!field) return;
    setF(existing ? { ...existing } : blank());
    setNewOption("");
  }, [field]); // eslint-disable-line react-hooks/exhaustive-deps
  const choice = f.type === "select" || f.type === "multiselect";
  const done = (msg: string) => {
    qc.invalidateQueries({ queryKey: issueKeys.fields(wid) });
    qc.invalidateQueries({ queryKey: ["ticket", wid] });
    toast.success(msg);
    onClose();
  };
  const body = {
    label: f.label,
    type: f.type,
    options: choice ? f.options : [],
    source: f.source,
    customerAttribute: f.source === "customer" ? f.customerAttribute : null,
    aiInstruction: f.aiInstruction,
    shown: f.shown,
    requiredToResolve: f.requiredToResolve,
  };
  const save = useMutation({
    mutationFn: () =>
      existing
        ? api(`/fields/${existing.id}`, { method: "PATCH", json: body })
        : api("/fields", { method: "POST", json: { ...body, key: f.key || undefined } }),
    onSuccess: () => done(existing ? "Field saved" : "Field added"),
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({
    mutationFn: () => api(`/fields/${existing!.id}`, { method: "DELETE" }),
    onSuccess: () => done("Field deleted"),
  });
  const addOption = () => {
    const v = newOption.trim();
    if (!v || f.options.some((o) => o.value.toLowerCase() === v.toLowerCase())) return;
    setF({ ...f, options: [...f.options, { value: v, color: "neutral" }] });
    setNewOption("");
  };
  const setOption = (i: number, o: FieldOption) => setF({ ...f, options: f.options.map((x, j) => (j === i ? o : x)) });
  const agent = boot.settings.ai.agentName;
  return (
    <Dialog
      open={!!field}
      onOpenChange={(v) => !v && onClose()}
      title={existing?.system ? "Classification types" : existing ? `Edit ${existing.label}` : "New field"}
      className="w-[min(620px,calc(100vw-32px))]"
      footer={
        <>
          {existing && !existing.system ? (
            <Button
              variant="danger"
              className="mr-auto"
              onClick={async () =>
                (await confirm({
                  title: `Delete ${existing.label}?`,
                  description: "Its values disappear from every ticket.",
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
          <Button
            variant="primary"
            disabled={!f.label.trim() || (choice && !f.options.length)}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            {existing ? "Save" : "Add field"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!existing?.system ? (
          <div className="grid grid-cols-[1fr_180px] gap-3">
            <Field label="Name">
              <Input
                autoFocus
                value={f.label}
                onChange={(e) => setF({ ...f, label: e.target.value })}
                placeholder="e.g. Org ID"
              />
            </Field>
            <Field label="Type">
              <Select
                value={f.type}
                disabled={!!existing}
                onChange={(e) => setF({ ...f, type: e.target.value as FieldType })}
              >
                {TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : null}
        {!existing ? (
          <Field label="Key" hint="Used in the API, views and issue templates. Leave empty to derive it from the name.">
            <Input
              value={f.key}
              onChange={(e) => setF({ ...f, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}
              placeholder={
                f.label
                  ? f.label
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, "_")
                      .replace(/^_|_$/g, "")
                  : "e.g. org_id"
              }
              className="font-mono"
            />
          </Field>
        ) : null}
        {choice ? (
          <Field label="Options">
            <div className="flex flex-col border border-line">
              {f.options.map((o, i) => (
                <div key={i} className="flex items-center gap-2 border-b border-line-2 px-2.5 py-1.5">
                  <span className={cn("size-1.5 shrink-0", toneDot[o.color ?? "neutral"])} />
                  <input
                    value={o.value}
                    onChange={(e) => setOption(i, { ...o, value: e.target.value })}
                    className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-fg-2 outline-none"
                    aria-label="Option"
                  />
                  <Select
                    value={o.color ?? "neutral"}
                    onChange={(e) => setOption(i, { ...o, color: e.target.value })}
                    className="h-6 w-28 text-[11.5px]"
                  >
                    {COLORS.map((c) => (
                      <option key={c} value={c}>
                        {c === "neutral"
                          ? "grey"
                          : c === "danger"
                            ? "red"
                            : c === "warn"
                              ? "orange"
                              : c === "ok"
                                ? "green"
                                : "blue"}
                      </option>
                    ))}
                  </Select>
                  <button
                    aria-label={`Remove ${o.value}`}
                    onClick={() => setF({ ...f, options: f.options.filter((_, j) => j !== i) })}
                    className="p-1 text-dim hover:text-fg"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-2 px-2.5 py-1.5">
                <Plus className="size-3 text-dim" />
                <input
                  value={newOption}
                  onChange={(e) => setNewOption(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addOption())}
                  onBlur={addOption}
                  placeholder="add option"
                  className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-fg-2 outline-none placeholder:text-dim"
                />
              </div>
            </div>
          </Field>
        ) : null}
        {!existing?.system ? (
          <>
            <Field label="Value comes from">
              <Segmented
                value={f.source}
                onChange={(source) => setF({ ...f, source })}
                options={[
                  { value: "ai", label: `${agent} fills it` },
                  { value: "customer", label: "customer record" },
                  { value: "manual", label: "set by hand" },
                ]}
                className="h-8 w-fit border border-line-strong"
              />
            </Field>
            {f.source === "customer" ? (
              <Field label="Customer attribute" hint="Read live from the customer, e.g. what your app sends as org_id.">
                <Input
                  value={f.customerAttribute ?? ""}
                  onChange={(e) => setF({ ...f, customerAttribute: e.target.value.trim() })}
                  placeholder="e.g. org_id"
                  className="font-mono"
                />
              </Field>
            ) : null}
            {f.source !== "manual" ? (
              <Field
                label={
                  f.source === "ai"
                    ? `How ${agent} finds it`
                    : `If the customer has none, ${agent} looks for it (optional)`
                }
                hint="Say what it is and what it looks like. trace leaves it empty when the conversation doesn't say."
              >
                <Textarea
                  rows={2}
                  value={f.aiInstruction}
                  onChange={(e) => setF({ ...f, aiInstruction: e.target.value })}
                  placeholder="e.g. The app version the customer runs, like 3.18.2"
                />
              </Field>
            ) : null}
          </>
        ) : (
          <Field label={`How ${agent} classifies`}>
            <Textarea
              rows={3}
              value={f.aiInstruction}
              onChange={(e) => setF({ ...f, aiInstruction: e.target.value })}
            />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Shown">
            <Select value={f.shown} onChange={(e) => setF({ ...f, shown: e.target.value as FieldDef["shown"] })}>
              <option value="header">next to the subject</option>
              <option value="panel">in the side panel</option>
              <option value="hidden">hidden (API only)</option>
            </Select>
          </Field>
          {!existing?.system ? (
            <label className="flex items-center gap-3 self-end pb-1.5 text-[13px] text-fg-2">
              <Switch checked={f.requiredToResolve} onCheckedChange={(v) => setF({ ...f, requiredToResolve: v })} />
              Needed to resolve
            </label>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

function blank() {
  return {
    key: "",
    label: "",
    type: "text" as FieldType,
    options: [] as FieldOption[],
    source: "manual" as FieldDef["source"],
    customerAttribute: null as string | null,
    aiInstruction: "",
    shown: "panel" as FieldDef["shown"],
    requiredToResolve: false,
    system: false,
  };
}

/* ------------------------------------------------------------------ issue trackers */

function TrackersSection({ classification }: { classification: FieldOption[] }) {
  const { api, wid, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [connecting, setConnecting] = React.useState<"linear" | "jira" | null>(null);
  const [configuring, setConfiguring] = React.useState<Tracker | null>(null);
  const q = useQuery({
    queryKey: issueKeys.trackers(wid),
    queryFn: () => api<{ trackers: Tracker[] }>("/issues/trackers"),
  });
  const disconnect = useMutation({
    mutationFn: (t: Tracker) => api(`/integrations/${t.id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: issueKeys.trackers(wid) }),
  });
  const trackers = q.data?.trackers ?? [];
  const rows: ("linear" | "jira")[] = ["linear", "jira"];
  return (
    <SettingsSection
      title="Issue trackers"
      description="File bugs and feature requests from a ticket. Status changes come back as notes on every linked ticket."
      className="border-b-0"
    >
      <div className="flex flex-col">
        {rows.map((p) => {
          const t = trackers.find((x) => x.provider === p);
          const container = t
            ? t.containers.find((c) => c.id === (p === "linear" ? t.config.defaultTeamId : t.config.defaultProjectKey))
            : undefined;
          const map = t ? (p === "linear" ? t.config.typeLabels : t.config.typeIssueTypes) : undefined;
          return (
            <div key={p} className="flex min-h-[54px] items-center gap-3.5 border-b border-line-2 py-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-center gap-2">
                  <span className="text-[12.5px] text-fg-2">{PROVIDER[p]}</span>
                  <span
                    className={cn("size-[5px]", t ? (t.status === "connected" ? "bg-ok" : "bg-danger") : "bg-white/25")}
                  />
                  <span
                    className={cn(
                      "font-mono text-[11px]",
                      t ? (t.status === "connected" ? "text-ok" : "text-danger") : "text-dim",
                    )}
                  >
                    {t ? (t.status === "connected" ? "connected" : "error") : "not connected"}
                  </span>
                </span>
                {t ? (
                  <span className="truncate font-mono text-[11px] text-dim">
                    {t.statusMessage ??
                      [
                        p === "jira" ? t.config.site?.replace(/^https?:\/\//, "") : t.config.workspace,
                        container ? `default ${p === "linear" ? "team" : "project"} ${container.name}` : null,
                        map && Object.keys(map).length
                          ? Object.entries(map)
                              .map(([k, v]) => `${k} → ${p === "linear" ? "label" : v}`)
                              .join(", ")
                          : `${p === "linear" ? "labels" : "issue types"} matched by name`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                  </span>
                ) : null}
              </div>
              {t ? (
                <>
                  <Button size="sm" disabled={!isAdmin} onClick={() => setConfiguring(t)}>
                    Configure
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!isAdmin}
                    onClick={async () =>
                      (await confirm({
                        title: `Disconnect ${PROVIDER[p]}?`,
                        description: "Linked issues stay on tickets but stop updating.",
                        confirmLabel: "Disconnect",
                        destructive: true,
                      })) && disconnect.mutate(t)
                    }
                  >
                    Disconnect
                  </Button>
                </>
              ) : (
                <Button size="sm" disabled={!isAdmin} onClick={() => setConnecting(p)}>
                  Connect
                </Button>
              )}
            </div>
          );
        })}
      </div>
      <ConnectDialog provider={connecting} onClose={() => setConnecting(null)} />
      <ConfigureDialog tracker={configuring} classification={classification} onClose={() => setConfiguring(null)} />
    </SettingsSection>
  );
}

function ConnectDialog({ provider, onClose }: { provider: "linear" | "jira" | null; onClose: () => void }) {
  const { api, wid } = useWorkspace();
  const qc = useQueryClient();
  const [v, setV] = React.useState({ apiKey: "", site: "", email: "", apiToken: "" });
  React.useEffect(() => setV({ apiKey: "", site: "", email: "", apiToken: "" }), [provider]);
  const connect = useMutation({
    mutationFn: () =>
      provider === "linear"
        ? api("/issues/trackers/linear", { method: "POST", json: { apiKey: v.apiKey } })
        : api("/issues/trackers/jira", {
            method: "POST",
            json: { site: v.site, email: v.email, apiToken: v.apiToken },
          }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: issueKeys.trackers(wid) });
      toast.success(`${PROVIDER[provider!]} connected`);
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const ready = provider === "linear" ? v.apiKey.length > 10 : v.site && v.email && v.apiToken;
  return (
    <Dialog
      open={!!provider}
      onOpenChange={(o) => !o && onClose()}
      title={provider ? `Connect ${PROVIDER[provider]}` : ""}
      description="The key is stored encrypted and only used to file, link and read issues."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} loading={connect.isPending} onClick={() => connect.mutate()}>
            Connect
          </Button>
        </>
      }
    >
      {provider === "linear" ? (
        <Field label="Personal API key" hint="Linear → Settings → Security & access → Personal API keys.">
          <Input
            autoFocus
            type="password"
            autoComplete="off"
            value={v.apiKey}
            onChange={(e) => setV({ ...v, apiKey: e.target.value })}
            placeholder="lin_api_…"
          />
        </Field>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="Site" hint="acme, acme.atlassian.net or the full URL">
            <Input
              autoFocus
              value={v.site}
              onChange={(e) => setV({ ...v, site: e.target.value })}
              placeholder="acme.atlassian.net"
            />
          </Field>
          <Field label="Email">
            <Input value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} placeholder="you@acme.com" />
          </Field>
          <Field label="API token" hint="id.atlassian.com → Security → API tokens.">
            <Input
              type="password"
              autoComplete="off"
              value={v.apiToken}
              onChange={(e) => setV({ ...v, apiToken: e.target.value })}
            />
          </Field>
        </div>
      )}
    </Dialog>
  );
}

function ConfigureDialog({
  tracker,
  classification,
  onClose,
}: {
  tracker: Tracker | null;
  classification: FieldOption[];
  onClose: () => void;
}) {
  const { api, wid } = useWorkspace();
  const qc = useQueryClient();
  const linear = tracker?.provider === "linear";
  const [container, setContainer] = React.useState("");
  const [map, setMap] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (!tracker) return;
    setContainer(
      (linear ? tracker.config.defaultTeamId : tracker.config.defaultProjectKey) ?? tracker.containers[0]?.id ?? "",
    );
    setMap((linear ? tracker.config.typeLabels : tracker.config.typeIssueTypes) ?? {});
  }, [tracker]); // eslint-disable-line react-hooks/exhaustive-deps
  const kinds = useQuery({
    queryKey: ["issues", wid, "kinds", tracker?.id, container],
    enabled: !!tracker && !!container,
    queryFn: () =>
      api<{ kinds: { id: string; name: string }[] }>(
        `/issues/trackers/${tracker!.id}/kinds?container=${encodeURIComponent(container)}`,
      ),
  });
  const save = useMutation({
    mutationFn: () =>
      api(`/issues/trackers/${tracker!.id}`, {
        method: "PATCH",
        json: {
          defaultContainer: container || null,
          typeMap: Object.fromEntries(Object.entries(map).filter(([, v]) => v)),
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: issueKeys.trackers(wid) });
      toast.success("Saved");
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const filing = classification
    .filter((o) => ["bug", "feature request"].includes(o.value))
    .concat(classification.filter((o) => !["bug", "feature request"].includes(o.value)).slice(0, 2));
  return (
    <Dialog
      open={!!tracker}
      onOpenChange={(o) => !o && onClose()}
      title={tracker ? `Configure ${PROVIDER[tracker.provider]}` : ""}
      description={`Where new issues go, and which ${linear ? "label" : "issue type"} each classification gets.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      {tracker ? (
        <div className="flex flex-col gap-4">
          <Field label={linear ? "Default team" : "Default project"}>
            <Select value={container} onChange={(e) => setContainer(e.target.value)}>
              {tracker.containers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.key}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={linear ? "Labels by classification" : "Issue types by classification"}
            hint={
              linear
                ? "Unset = a label with the same name is used if it exists."
                : "Unset = Bug for bugs, Story for feature requests, Task otherwise."
            }
          >
            <div className="flex flex-col border border-line">
              {filing.map((o) => (
                <div
                  key={o.value}
                  className="grid grid-cols-[140px_1fr] items-center gap-3 border-b border-line-2 px-3 py-2 last:border-b-0"
                >
                  <span className="flex items-center gap-2 font-mono text-[11.5px] text-fg-2">
                    <span className={cn("size-1.5", toneDot[o.color ?? "neutral"])} />
                    {o.value}
                  </span>
                  <Select
                    value={map[o.value] ?? ""}
                    onChange={(e) => setMap({ ...map, [o.value]: e.target.value })}
                    className="h-7 text-[12px]"
                    placeholder="automatic"
                  >
                    <option value="">automatic</option>
                    {(kinds.data?.kinds ?? []).map((k) => (
                      <option key={k.id} value={linear ? k.id : k.name}>
                        {k.name}
                      </option>
                    ))}
                  </Select>
                </div>
              ))}
            </div>
          </Field>
        </div>
      ) : null}
    </Dialog>
  );
}
