import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Play, Plus, Trash2, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Badge, Button, Field, Input, Select, Segmented, Switch, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import {
  type Action,
  type ActionParameter,
  type ActionResult,
  automationKeys,
  type HttpMethod,
  prettyJson,
} from "./types";
import { useConfirm } from "@/components/ui/confirm";

export type ActionDraft = Omit<Action, "id" | "preset" | "updatedAt">;

export const emptyAction = (): ActionDraft => ({
  name: "",
  title: "",
  description: "",
  method: "GET",
  url: "https://",
  headers: {},
  body: null,
  bodyFormat: "none",
  parameters: [],
  requiresApproval: false,
  readOnly: true,
  enabled: true,
  timeoutMs: 10_000,
});

const PLACEHOLDERS = [
  ["{{param}}", "a parameter the AI fills in"],
  ["{{secrets.NAME}}", "an encrypted workspace secret"],
  ["{{customer.email}}", "the ticket's customer"],
  ["{{customer.externalId}}", "your user id for them"],
  ["{{ticket.number}}", "the ticket number"],
] as const;

export function ActionEditor({ action, onBack }: { action: Action | null; onBack: () => void }) {
  const confirm = useConfirm();
  const { api, wid, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const [d, setD] = React.useState<ActionDraft>(() => (action ? { ...action } : emptyAction()));
  const [headers, setHeaders] = React.useState<[string, string][]>(() => Object.entries(action?.headers ?? {}));
  const set = <K extends keyof ActionDraft>(k: K, v: ActionDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const payload = () => ({
    ...d,
    headers: Object.fromEntries(headers.filter(([k]) => k.trim())),
    body: d.bodyFormat === "none" ? null : d.body,
  });

  const save = useMutation({
    mutationFn: () =>
      action
        ? api<{ action: Action }>(`/automation/actions/${action.id}`, { method: "PATCH", json: payload() })
        : api<{ action: Action }>("/automation/actions", { method: "POST", json: payload() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.actions(wid) });
      toast.success(action ? "Action saved" : "Action created");
      if (!action) onBack();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({
    mutationFn: () => api(`/automation/actions/${action!.id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.actions(wid) });
      onBack();
    },
  });

  const setParam = (i: number, patch: Partial<ActionParameter>) =>
    set(
      "parameters",
      d.parameters.map((p, j) => (j === i ? { ...p, ...patch } : p)),
    );

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-line px-8 py-4">
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-muted hover:text-fg">
          <ArrowLeft className="size-3" /> All actions
        </button>
        <div className="flex items-center gap-2">
          {action ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={!isAdmin}
              onClick={async () =>
                (await confirm({
                  title: `Delete action ${action.name}?`,
                  description: "The agent can no longer call it. Past runs stay in the ticket history.",
                  confirmLabel: "Delete",
                  destructive: true,
                })) && del.mutate()
              }
            >
              <Trash2 /> Delete
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={!isAdmin || !d.name || !d.title || !d.description}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            {action ? "Save action" : "Create action"}
          </Button>
        </div>
      </div>

      <div className="grid gap-0 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-6 px-8 py-6">
          <section className="flex flex-col gap-4">
            <span className="label-mono">What it does</span>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Tool name" hint="lowercase_snake_case — what the AI calls">
                <Input
                  value={d.name}
                  onChange={(e) => set("name", e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
                  placeholder="lookup_order"
                  className="font-mono text-[12.5px]"
                />
              </Field>
              <Field label="Title" hint="Shown to your team">
                <Input value={d.title} onChange={(e) => set("title", e.target.value)} placeholder="Look up order" />
              </Field>
            </div>
            <Field
              label="Description"
              hint="This is what the AI reads to decide when to call the action. Say what it returns and when (not) to use it."
            >
              <Textarea
                rows={3}
                value={d.description}
                onChange={(e) => set("description", e.target.value)}
                placeholder="Find an order by its number and return status, tracking and items. Use for 'where is my order' questions."
              />
            </Field>
          </section>

          <section className="flex flex-col gap-4">
            <span className="label-mono">Request</span>
            <div className="flex gap-2">
              <Select
                className="w-28 font-mono text-[12px]"
                value={d.method}
                onChange={(e) => set("method", e.target.value as HttpMethod)}
              >
                {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </Select>
              <Input
                value={d.url}
                onChange={(e) => set("url", e.target.value)}
                className="font-mono text-[12px]"
                placeholder="https://api.example.com/orders/{{order_number}}"
              />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {PLACEHOLDERS.map(([p, h]) => (
                <span key={p} className="font-mono text-[11.5px] text-dim">
                  <span className="text-accent-fg">{p}</span> {h}
                </span>
              ))}
            </div>
            <Field label="Headers">
              <div className="flex flex-col gap-1.5">
                {headers.map(([k, v], i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      value={k}
                      onChange={(e) => setHeaders(headers.map((h, j) => (j === i ? [e.target.value, h[1]] : h)))}
                      placeholder="Authorization"
                      className="w-48 font-mono text-[12px]"
                    />
                    <Input
                      value={v}
                      onChange={(e) => setHeaders(headers.map((h, j) => (j === i ? [h[0], e.target.value] : h)))}
                      placeholder="Bearer {{secrets.API_KEY}}"
                      className="font-mono text-[12px]"
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setHeaders(headers.filter((_, j) => j !== i))}
                    >
                      <X />
                    </Button>
                  </div>
                ))}
                <div>
                  <Button size="sm" variant="ghost" onClick={() => setHeaders([...headers, ["", ""]])}>
                    <Plus /> Header
                  </Button>
                </div>
              </div>
            </Field>
            {d.method !== "GET" ? (
              <Field
                label="Body"
                hint='A JSON template. A value that is exactly "{{param}}" keeps its type (numbers stay numbers); form format sends application/x-www-form-urlencoded (Stripe).'
              >
                <div className="flex flex-col gap-2">
                  <Segmented
                    value={d.bodyFormat}
                    onChange={(v) => set("bodyFormat", v)}
                    options={[
                      { value: "json", label: "JSON" },
                      { value: "form", label: "Form" },
                      { value: "none", label: "No body" },
                    ]}
                  />
                  {d.bodyFormat !== "none" ? (
                    <Textarea
                      rows={7}
                      value={d.body ?? ""}
                      onChange={(e) => set("body", e.target.value)}
                      className="font-mono text-[12px] leading-relaxed"
                      placeholder={'{\n  "order": "{{order_number}}",\n  "email": "{{customer.email}}"\n}'}
                    />
                  ) : null}
                </div>
              </Field>
            ) : null}
          </section>

          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="label-mono">Parameters the AI fills in</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  set("parameters", [...d.parameters, { name: "", type: "string", description: "", required: true }])
                }
              >
                <Plus /> Parameter
              </Button>
            </div>
            {!d.parameters.length ? (
              <p className="text-xs text-dim">None — the action only uses ticket/customer context and secrets.</p>
            ) : null}
            {d.parameters.map((p, i) => (
              <div key={i} className="flex flex-col gap-2 border border-line p-3">
                <div className="flex gap-2">
                  <Input
                    value={p.name}
                    onChange={(e) => setParam(i, { name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}
                    placeholder="order_number"
                    className="w-44 font-mono text-[12px]"
                  />
                  <Select
                    className="w-28"
                    value={p.type}
                    onChange={(e) => setParam(i, { type: e.target.value as ActionParameter["type"] })}
                  >
                    {["string", "number", "integer", "boolean"].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </Select>
                  <label className="flex items-center gap-2 px-2 text-xs text-muted">
                    <Switch checked={p.required} onCheckedChange={(v) => setParam(i, { required: v })} /> required
                  </label>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="ml-auto"
                    onClick={() =>
                      set(
                        "parameters",
                        d.parameters.filter((_, j) => j !== i),
                      )
                    }
                  >
                    <X />
                  </Button>
                </div>
                <Input
                  value={p.description}
                  onChange={(e) => setParam(i, { description: e.target.value })}
                  placeholder="What the value is, with an example"
                />
                <Input
                  value={(p.enum ?? []).join(", ")}
                  onChange={(e) => {
                    const values = e.target.value
                      .split(",")
                      .map((x) => x.trim())
                      .filter(Boolean);
                    setParam(i, { enum: values.length ? values : undefined });
                  }}
                  placeholder="Allowed values (optional, comma separated)"
                  className="font-mono text-[11.5px]"
                />
              </div>
            ))}
          </section>

          <section className="flex flex-col gap-3">
            <span className="label-mono">Safety</span>
            <Toggle
              checked={d.requiresApproval}
              onChange={(v) => set("requiresApproval", v)}
              title="Requires human approval"
              text="Each run waits on the ticket until a teammate approves it (they can edit the values). Use for refunds, cancellations, anything that changes data."
            />
            <Toggle
              checked={d.readOnly}
              onChange={(v) => set("readOnly", v)}
              title="Read-only"
              text="It only reads data. Read-only actions also run during simulations and tests; others are only simulated there."
            />
            <Toggle
              checked={d.enabled}
              onChange={(v) => set("enabled", v)}
              title="Enabled"
              text="Disabled actions are hidden from the AI."
            />
            <Field label={`Timeout · ${(d.timeoutMs / 1000).toFixed(1)}s`} className="max-w-xs">
              <input
                type="range"
                min={1000}
                max={30000}
                step={500}
                value={d.timeoutMs}
                onChange={(e) => set("timeoutMs", Number(e.target.value))}
                className="accent-[var(--tr-accent)]"
              />
            </Field>
          </section>
        </div>
        <aside className="border-t border-line xl:border-t-0 xl:border-l">
          {action ? (
            <TestPanel action={action} />
          ) : (
            <div className="px-6 py-6 text-xs text-dim">Save the action to test it.</div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  title,
  text,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  text: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border border-line px-3 py-2.5">
      <div className="flex flex-col">
        <span className="text-[13px] text-fg-2">{title}</span>
        <span className="text-[11.5px] leading-relaxed text-dim">{text}</span>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function TestPanel({ action }: { action: Action }) {
  const { api, isAdmin } = useWorkspace();
  const [input, setInput] = React.useState<Record<string, string>>({});
  const [ticket, setTicket] = React.useState("");
  const [email, setEmail] = React.useState("");
  const run = useMutation({
    mutationFn: () =>
      api<{ result: ActionResult }>(`/automation/actions/${action.id}/test`, {
        method: "POST",
        json: {
          input: Object.fromEntries(Object.entries(input).filter(([, v]) => v !== "")),
          ticket: ticket.trim() || undefined,
          customerEmail: email.trim() || undefined,
        },
      }),
    onError: (e) => toast.error((e as Error).message),
  });
  const r = run.data?.result;
  return (
    <div className="flex flex-col gap-4 px-6 py-6 xl:sticky xl:top-0">
      <div className="flex flex-col gap-1">
        <span className="label-mono">Test</span>
        <p className="text-[11.5px] leading-relaxed text-dim">
          Calls the endpoint <span className="text-warn">for real</span> with the saved configuration
          {action.readOnly ? "." : " — careful with actions that change data."}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Ticket (optional)" hint="fills {{ticket.*}} / {{customer.*}}">
          <Input
            value={ticket}
            onChange={(e) => setTicket(e.target.value)}
            placeholder="4814"
            className="font-mono text-[12px]"
          />
        </Field>
        <Field label="or customer email">
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="anna@northwind.io" />
        </Field>
      </div>
      {action.parameters.map((p) => (
        <Field
          key={p.name}
          label={
            <span className="font-mono">
              {p.name}
              {p.required ? " *" : ""}
            </span>
          }
          hint={p.description}
        >
          {p.enum?.length ? (
            <Select value={input[p.name] ?? ""} onChange={(e) => setInput({ ...input, [p.name]: e.target.value })}>
              <option value="">—</option>
              {p.enum.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </Select>
          ) : (
            <Input
              value={input[p.name] ?? ""}
              onChange={(e) => setInput({ ...input, [p.name]: e.target.value })}
              className="font-mono text-[12px]"
            />
          )}
        </Field>
      ))}
      <div>
        <Button variant="primary" size="sm" disabled={!isAdmin} loading={run.isPending} onClick={() => run.mutate()}>
          <Play /> Run test
        </Button>
      </div>
      {r ? (
        <div className="flex flex-col gap-2 border border-line bg-cell">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Badge tone={r.ok ? "ok" : "danger"} upper>
              {r.status ?? "error"}
            </Badge>
            <span className="truncate font-mono text-[11.5px] text-muted">
              {r.request.method} {r.request.url}
            </span>
            <span className="ml-auto font-mono text-[11px] text-dim">{r.durationMs}ms</span>
          </div>
          {r.error ? <div className="px-3 text-xs text-danger">{r.error}</div> : null}
          <pre
            className={cn(
              "max-h-[420px] overflow-auto px-3 pb-3 font-mono text-[11px] leading-relaxed",
              r.ok ? "text-fg-3" : "text-muted",
            )}
          >
            {prettyJson(r.output) || "(empty response)"}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
