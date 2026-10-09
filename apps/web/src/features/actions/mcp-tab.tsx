import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  LogIn,
  MoreHorizontal,
  Play,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Dialog,
  Empty,
  Field,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Select,
  Spinner,
  Switch,
  Textarea,
} from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm";
import { ago, cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import {
  automationKeys,
  hostOf,
  type McpPreset,
  type McpServer,
  type McpSyncResult,
  type McpTool,
  prettyJson,
} from "./types";

type ServersResponse = { servers: McpServer[]; stdioAllowed: boolean };

/** Report a connect/sync result; sends the browser to the provider's sign-in page when needed. */
function useSyncFeedback() {
  return React.useCallback((r: McpSyncResult | undefined, name: string) => {
    if (!r) return;
    if (r.ok) {
      toast.success(`${name} connected · ${r.tools} tool${r.tools === 1 ? "" : "s"}`, {
        description: "Turn on the tools the agent may use.",
      });
    } else if ("needsAuth" in r) {
      if (r.authorizeUrl) {
        toast.message(`Signing in to ${name}…`);
        window.location.assign(r.authorizeUrl);
      } else
        toast.error(`${name} needs credentials`, {
          description: "It doesn't support sign-in from trace. Edit the server and add an access token.",
        });
    } else toast.error(`Couldn't connect to ${name}`, { description: r.error });
  }, []);
}

export function McpTab() {
  const { api, wid, isAdmin } = useWorkspace();
  const [adding, setAdding] = React.useState(false);
  const list = useQuery({
    queryKey: automationKeys.mcp(wid),
    queryFn: () => api<ServersResponse>("/mcp/servers"),
  });
  const servers = list.data?.servers ?? [];
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-line px-8 py-4">
        <p className="max-w-2xl text-[12px] leading-relaxed text-body">
          Connect MCP servers — Linear, Sentry, Jira, Notion, Stripe or your own — and the agent can look things up and
          act in those systems while it works a ticket. Pick which tools it may use; tools that change data wait for a
          human by default. Every call is a span on the ticket's trace.
        </p>
        <Button variant="primary" className="shrink-0" disabled={!isAdmin} onClick={() => setAdding(true)}>
          <Plus /> Add server
        </Button>
      </div>
      {list.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : !servers.length ? (
        <Empty icon={<Plug />} title="No MCP servers yet">
          Add one to let the agent check known bugs, errors, subscriptions or internal docs live — instead of guessing.
        </Empty>
      ) : (
        servers.map((s) => <ServerCard key={s.id} server={s} />)
      )}
      <AddServerDialog open={adding} onOpenChange={setAdding} stdioAllowed={!!list.data?.stdioAllowed} />
    </div>
  );
}

const STATUS: Record<McpServer["status"], { label: string; tone: "ok" | "warn" | "danger" | "neutral" }> = {
  connected: { label: "connected", tone: "ok" },
  needs_auth: { label: "needs sign-in", tone: "warn" },
  error: { label: "error", tone: "danger" },
  pending: { label: "not connected", tone: "neutral" },
};

function ServerCard({ server }: { server: McpServer }) {
  const { api, wid, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const feedback = useSyncFeedback();
  const [editing, setEditing] = React.useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: automationKeys.mcp(wid) });
  const sync = useMutation({
    mutationFn: () => api<{ result: McpSyncResult }>(`/mcp/servers/${server.id}/sync`, { method: "POST" }),
    onSuccess: ({ result }) => {
      invalidate();
      feedback(result, server.name);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const patch = useMutation({
    mutationFn: (json: Partial<McpServer>) => api(`/mcp/servers/${server.id}`, { method: "PATCH", json }),
    onSuccess: invalidate,
    onError: (e) => toast.error((e as Error).message),
  });
  const bulk = useMutation({
    mutationFn: (enable: "read_only" | "all" | "none") =>
      api(`/mcp/servers/${server.id}/tools`, { method: "POST", json: { enable } }),
    onSuccess: invalidate,
  });
  const signOut = useMutation({
    mutationFn: () => api(`/mcp/servers/${server.id}/sign-out`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const del = useMutation({
    mutationFn: () => api(`/mcp/servers/${server.id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
  const status = STATUS[server.status];
  const enabledCount = server.tools.filter((t) => t.enabled).length;
  const where =
    server.transport === "stdio" ? [server.command, ...server.args].join(" ") : server.url ? hostOf(server.url) : "";

  return (
    <div className={cn("border-b border-line", !server.enabled && "opacity-70")}>
      <div className="flex items-center gap-3 px-8 py-3.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-line-strong text-fg-3">
          {server.transport === "stdio" ? <TerminalSquare className="size-4" /> : <Plug className="size-4" />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-medium text-fg">{server.name}</span>
            <Badge tone={status.tone}>{status.label}</Badge>
            {server.authType === "oauth" ? <Badge>{server.signedIn ? "signed in" : "OAuth"}</Badge> : null}
            {server.authType === "headers" && server.headerNames.length ? <Badge>token</Badge> : null}
          </div>
          <div className="flex min-w-0 items-center gap-2 font-mono text-[11.5px] text-dim">
            <span className="truncate">{where}</span>
            <span className="shrink-0">· {server.slug}__*</span>
            {server.lastSyncedAt ? <span className="shrink-0">· synced {ago(server.lastSyncedAt)} ago</span> : null}
          </div>
          {server.statusMessage && server.status !== "connected" ? (
            <span className="text-[12px] text-danger">{server.statusMessage}</span>
          ) : null}
        </div>
        {server.status === "needs_auth" ? (
          <Button
            size="sm"
            variant="primary"
            disabled={!isAdmin}
            loading={sync.isPending}
            onClick={() => sync.mutate()}
          >
            <LogIn /> Sign in
          </Button>
        ) : (
          <Button size="sm" disabled={!isAdmin} loading={sync.isPending} onClick={() => sync.mutate()}>
            <RefreshCw /> {server.status === "connected" ? "Refresh tools" : "Connect"}
          </Button>
        )}
        <Switch checked={server.enabled} disabled={!isAdmin} onCheckedChange={(enabled) => patch.mutate({ enabled })} />
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant="ghost" disabled={!isAdmin} aria-label="Server options">
              <MoreHorizontal />
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => setEditing(true)}>Edit connection</MenuItem>
            {server.authType === "oauth" && server.signedIn ? (
              <MenuItem
                onSelect={async () =>
                  (await confirm({
                    title: `Sign out of ${server.name}?`,
                    description: "trace forgets its tokens. The agent can't use these tools until you sign in again.",
                    confirmLabel: "Sign out",
                  })) && signOut.mutate()
                }
              >
                Sign out
              </MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuItem
              destructive
              onSelect={async () =>
                (await confirm({
                  title: `Remove ${server.name}?`,
                  description: "Its tools disappear from the agent. Past calls stay on ticket traces.",
                  confirmLabel: "Remove",
                  destructive: true,
                })) && del.mutate()
              }
            >
              Remove server
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>

      {server.tools.length ? (
        <div className="px-8 pb-4">
          <div className="flex items-center gap-3 border border-b-0 border-line bg-cell px-3 py-2">
            <span className="label-mono">
              Tools · {enabledCount}/{server.tools.length} on
            </span>
            <span className="ml-auto flex items-center gap-1">
              <span className="text-[11.5px] text-dim">Turn on:</span>
              {(
                [
                  ["read_only", "read-only"],
                  ["all", "all"],
                  ["none", "none"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  disabled={!isAdmin || bulk.isPending}
                  onClick={() => bulk.mutate(v)}
                  className="px-1.5 py-0.5 font-mono text-[11px] text-muted hover:bg-white/[0.05] hover:text-fg disabled:opacity-50"
                >
                  {label}
                </button>
              ))}
            </span>
          </div>
          <div className="flex flex-col border border-line">
            {server.tools.map((t) => (
              <ToolRow key={t.id} tool={t} />
            ))}
          </div>
        </div>
      ) : server.status === "connected" ? (
        <p className="px-8 pb-4 text-[12px] text-dim">This server exposes no tools.</p>
      ) : null}
      <EditServerDialog server={editing ? server : null} onClose={() => setEditing(false)} />
    </div>
  );
}

type Mode = "read" | "write" | "approval";
const modeOf = (t: McpTool): Mode => (t.readOnly ? "read" : t.requiresApproval ? "approval" : "write");
const MODE_FIELDS: Record<Mode, Pick<McpTool, "readOnly" | "requiresApproval">> = {
  read: { readOnly: true, requiresApproval: false },
  write: { readOnly: false, requiresApproval: false },
  approval: { readOnly: false, requiresApproval: true },
};

function ToolRow({ tool }: { tool: McpTool }) {
  const { api, wid, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const [testing, setTesting] = React.useState(false);
  const patch = useMutation({
    mutationFn: (json: Partial<McpTool>) => api(`/mcp/tools/${tool.id}`, { method: "PATCH", json }),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationKeys.mcp(wid) }),
    onError: (e) => toast.error((e as Error).message),
  });
  const params = Object.keys(tool.inputSchema.properties ?? {});
  const hint = tool.annotations.readOnlyHint
    ? "server marks it read-only"
    : tool.annotations.destructiveHint
      ? "server marks it destructive"
      : null;
  return (
    <div className="flex items-start gap-3 border-b border-line-2 px-3 py-2.5 last:border-b-0">
      <div className="pt-0.5">
        <Switch checked={tool.enabled} disabled={!isAdmin} onCheckedChange={(enabled) => patch.mutate({ enabled })} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("font-mono text-[12.5px]", tool.enabled ? "text-fg" : "text-fg-3")}>{tool.name}</span>
          {tool.title && tool.title !== tool.name ? <span className="text-[12px] text-muted">{tool.title}</span> : null}
          {tool.annotations.destructiveHint ? <Badge tone="danger">destructive</Badge> : null}
        </div>
        {tool.description ? (
          <p className="line-clamp-2 text-[12px] leading-relaxed text-body" title={tool.description}>
            {tool.description}
          </p>
        ) : null}
        {params.length ? <span className="truncate font-mono text-[11px] text-dim">{params.join(", ")}</span> : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <div className="flex items-center gap-1.5">
          <Select
            value={modeOf(tool)}
            disabled={!isAdmin}
            onChange={(e) => patch.mutate(MODE_FIELDS[e.target.value as Mode])}
            className="h-7 w-[178px] text-[12px]"
          >
            <option value="read">Read-only · runs freely</option>
            <option value="approval">Writes · needs approval</option>
            <option value="write">Writes · runs freely</option>
          </Select>
          <Button size="sm" variant="ghost" disabled={!isAdmin} onClick={() => setTesting(true)} aria-label="Test tool">
            <Play />
          </Button>
        </div>
        {hint ? <span className="text-[11px] text-dim">{hint}</span> : null}
      </div>
      <TestToolDialog tool={testing ? tool : null} onClose={() => setTesting(false)} />
    </div>
  );
}

function sampleInput(tool: McpTool) {
  const out: Record<string, unknown> = {};
  const props = tool.inputSchema.properties ?? {};
  for (const name of tool.inputSchema.required ?? Object.keys(props)) {
    const type = props[name]?.type;
    out[name] = type === "number" || type === "integer" ? 0 : type === "boolean" ? false : type === "array" ? [] : "";
  }
  return JSON.stringify(out, null, 2);
}

function TestToolDialog({ tool, onClose }: { tool: McpTool | null; onClose: () => void }) {
  const { api } = useWorkspace();
  const confirm = useConfirm();
  const [input, setInput] = React.useState("");
  React.useEffect(() => {
    if (tool) setInput(sampleInput(tool));
  }, [tool]);
  const run = useMutation({
    mutationFn: (json: Record<string, unknown>) =>
      api<{ result: { ok: boolean; output: string; error?: string; durationMs: number } }>(
        `/mcp/tools/${tool!.id}/test`,
        { method: "POST", json: { input: json } },
      ),
  });
  const submit = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(input || "{}");
    } catch {
      toast.error("Input must be valid JSON");
      return;
    }
    if (
      !tool!.readOnly &&
      !(await confirm({
        title: "Run a tool that changes data?",
        description: `${tool!.name} is not read-only — this really runs it against ${tool!.toolName.split("__")[0]}.`,
        confirmLabel: "Run it",
        destructive: true,
      }))
    )
      return;
    run.mutate(parsed);
  };
  const res = run.data?.result;
  return (
    <Dialog
      open={!!tool}
      onOpenChange={(v) => {
        if (!v) {
          run.reset();
          onClose();
        }
      }}
      title={`Test ${tool?.name ?? ""}`}
      description="Calls the tool now with this input. Not tied to a ticket."
      className="w-[min(720px,calc(100vw-32px))]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" loading={run.isPending} onClick={submit}>
            <Play /> Run
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Input (JSON)">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={6}
            className="font-mono text-[12px]"
            spellCheck={false}
          />
        </Field>
        {run.error ? <p className="text-[12px] text-danger">{(run.error as Error).message}</p> : null}
        {res ? (
          <div className="flex flex-col gap-1.5">
            <span className={cn("font-mono text-[11.5px]", res.ok ? "text-ok" : "text-danger")}>
              {res.ok ? "OK" : `Error: ${res.error}`} · {res.durationMs}ms
            </span>
            <pre className="max-h-72 overflow-auto border border-line bg-cell p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-3">
              {prettyJson(res.output) || "(empty)"}
            </pre>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ add / edit */

interface FormState {
  name: string;
  transport: "http" | "stdio";
  url: string;
  auth: "none" | "oauth" | "headers";
  headerName: string;
  token: string;
  commandLine: string;
  envText: string;
}

const emptyForm: FormState = {
  name: "",
  transport: "http",
  url: "",
  auth: "oauth",
  headerName: "Authorization",
  token: "",
  commandLine: "",
  envText: "",
};

/** Split a command line on spaces, honouring quotes. */
function splitCommand(line: string) {
  const parts = [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
  return { command: parts[0] ?? "", args: parts.slice(1) };
}

function parseEnv(text: string) {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

/** Request body for create/patch. Credentials are only sent when entered (they're write-only). */
function toPayload(f: FormState) {
  const base: Record<string, unknown> = { name: f.name.trim(), authType: f.transport === "stdio" ? "none" : f.auth };
  if (f.transport === "stdio") {
    const { command, args } = splitCommand(f.commandLine.trim());
    Object.assign(base, { transport: "stdio", command, args, url: null });
    if (f.envText.trim()) base.env = parseEnv(f.envText);
  } else {
    Object.assign(base, { transport: "http", url: f.url.trim(), command: null, args: [] });
    if (f.auth === "headers" && f.token.trim()) {
      const token = f.token.trim();
      // "Authorization: <token>" almost always means a bearer token.
      const value = f.headerName.toLowerCase() === "authorization" && !token.includes(" ") ? `Bearer ${token}` : token;
      base.headers = { [f.headerName.trim() || "Authorization"]: value };
    }
  }
  return base;
}

function ServerForm({
  form,
  setForm,
  stdioAllowed,
  preset,
  storedHeaders,
  storedEnv,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  stdioAllowed: boolean;
  preset?: McpPreset | null;
  storedHeaders?: string[];
  storedEnv?: string[];
}) {
  const set = (patch: Partial<FormState>) => setForm({ ...form, ...patch });
  return (
    <div className="flex flex-col gap-4">
      <Field label="Name">
        <Input autoFocus value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Linear" />
      </Field>
      {!preset && stdioAllowed ? (
        <Field label="Runs">
          <Select value={form.transport} onChange={(e) => set({ transport: e.target.value as FormState["transport"] })}>
            <option value="http">Remote — URL (Streamable HTTP or SSE)</option>
            <option value="stdio">Local command on the trace server (stdio)</option>
          </Select>
        </Field>
      ) : null}
      {form.transport === "http" ? (
        <>
          <Field label="Server URL">
            <Input
              value={form.url}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="https://mcp.example.com/mcp"
              className="font-mono text-[12px]"
            />
          </Field>
          <Field
            label="Authentication"
            hint={
              form.auth === "oauth"
                ? "You'll be sent to the provider to sign in and approve access. Tokens are stored encrypted and refreshed automatically."
                : form.auth === "headers"
                  ? (preset?.tokenHeader?.hint ?? "Sent with every request. Stored encrypted; it can't be read back.")
                  : "For servers on your own network that need no credentials."
            }
          >
            <Select value={form.auth} onChange={(e) => set({ auth: e.target.value as FormState["auth"] })}>
              <option value="oauth">Sign in (OAuth)</option>
              <option value="headers">Access token / API key</option>
              <option value="none">None</option>
            </Select>
          </Field>
          {form.auth === "headers" ? (
            <div className="grid grid-cols-[180px_1fr] gap-3">
              <Field label="Header">
                <Input
                  value={form.headerName}
                  onChange={(e) => set({ headerName: e.target.value })}
                  className="font-mono text-[12px]"
                />
              </Field>
              <Field
                label="Token"
                hint={
                  storedHeaders?.length ? `Stored: ${storedHeaders.join(", ")}. Leave empty to keep it.` : undefined
                }
              >
                <Input
                  type="password"
                  autoComplete="off"
                  value={form.token}
                  onChange={(e) => set({ token: e.target.value })}
                  placeholder={storedHeaders?.length ? "••••••••" : "paste token"}
                />
              </Field>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <Field label="Command" hint="Runs on the trace server, without trace's own environment variables.">
            <Input
              value={form.commandLine}
              onChange={(e) => set({ commandLine: e.target.value })}
              placeholder="npx -y @acme/mcp-server --read-only"
              className="font-mono text-[12px]"
            />
          </Field>
          <Field
            label="Environment"
            hint={
              storedEnv?.length
                ? `Stored: ${storedEnv.join(", ")}. Enter new values to replace all of them.`
                : "One KEY=value per line. Stored encrypted."
            }
          >
            <Textarea
              rows={3}
              value={form.envText}
              onChange={(e) => set({ envText: e.target.value })}
              placeholder="ACME_API_KEY=…"
              className="font-mono text-[12px]"
              spellCheck={false}
            />
          </Field>
        </>
      )}
    </div>
  );
}

function AddServerDialog({
  open,
  onOpenChange,
  stdioAllowed,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  stdioAllowed: boolean;
}) {
  const { api, wid } = useWorkspace();
  const qc = useQueryClient();
  const feedback = useSyncFeedback();
  const [step, setStep] = React.useState<"pick" | "form">("pick");
  const [preset, setPreset] = React.useState<McpPreset | null>(null);
  const [form, setForm] = React.useState<FormState>(emptyForm);
  const presets = useQuery({
    queryKey: [...automationKeys.mcp(wid), "presets"],
    enabled: open,
    queryFn: () => api<{ presets: McpPreset[] }>("/mcp/presets"),
  });
  const close = (v: boolean) => {
    onOpenChange(v);
    if (!v) {
      setStep("pick");
      setPreset(null);
      setForm(emptyForm);
    }
  };
  const pick = (p: McpPreset | null) => {
    setPreset(p);
    setForm(
      p
        ? {
            ...emptyForm,
            name: p.name,
            url: p.url,
            auth: p.authType,
            headerName: p.tokenHeader?.name ?? "Authorization",
          }
        : emptyForm,
    );
    setStep("form");
  };
  const create = useMutation({
    mutationFn: () =>
      api<{ server: McpServer; result: McpSyncResult }>("/mcp/servers", { method: "POST", json: toPayload(form) }),
    onSuccess: ({ server, result }) => {
      qc.invalidateQueries({ queryKey: automationKeys.mcp(wid) });
      close(false);
      feedback(result, server.name);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const valid =
    !!form.name.trim() &&
    (form.transport === "stdio" ? !!form.commandLine.trim() : /^https?:\/\//.test(form.url.trim())) &&
    (form.transport === "stdio" || form.auth !== "headers" || !!form.token.trim());

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={step === "pick" ? "Add an MCP server" : `Connect ${form.name || "server"}`}
      description={
        step === "pick"
          ? "Hosted servers from tools your team already uses, or any server that speaks MCP."
          : preset?.description
      }
      className={step === "pick" ? "w-[min(820px,calc(100vw-32px))]" : undefined}
      footer={
        step === "form" ? (
          <>
            <Button variant="ghost" className="mr-auto" onClick={() => setStep("pick")}>
              <ArrowLeft /> Back
            </Button>
            <Button variant="primary" disabled={!valid} loading={create.isPending} onClick={() => create.mutate()}>
              {form.transport === "http" && form.auth === "oauth" ? "Connect & sign in" : "Connect"}
            </Button>
          </>
        ) : undefined
      }
    >
      {step === "pick" ? (
        <div className="grid gap-px bg-line sm:grid-cols-2">
          {(presets.data?.presets ?? []).map((p) => (
            <button
              key={p.id}
              onClick={() => pick(p)}
              className="flex flex-col gap-1.5 bg-bar p-3.5 text-left hover:bg-white/[0.03]"
            >
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-fg">{p.name}</span>
                <Badge>{p.authType === "oauth" ? "sign in" : "token"}</Badge>
              </div>
              <span className="font-mono text-[11.5px] text-dim">{hostOf(p.url)}</span>
              <span className="text-[12px] leading-relaxed text-body">{p.description}</span>
            </button>
          ))}
          <button
            onClick={() => pick(null)}
            className="flex flex-col gap-1.5 bg-bar p-3.5 text-left hover:bg-white/[0.03]"
          >
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-fg">Custom server</span>
            </div>
            <span className="font-mono text-[11.5px] text-dim">any URL{stdioAllowed ? " or local command" : ""}</span>
            <span className="text-[12px] leading-relaxed text-body">
              Your own MCP server or one not listed here — internal admin APIs, databases, status pages.
            </span>
          </button>
          {presets.isPending ? (
            <div className="flex justify-center bg-bar p-6">
              <Spinner />
            </div>
          ) : null}
        </div>
      ) : (
        <ServerForm form={form} setForm={setForm} stdioAllowed={stdioAllowed} preset={preset} />
      )}
    </Dialog>
  );
}

function EditServerDialog({ server, onClose }: { server: McpServer | null; onClose: () => void }) {
  const { api, wid } = useWorkspace();
  const qc = useQueryClient();
  const feedback = useSyncFeedback();
  const [form, setForm] = React.useState<FormState>(emptyForm);
  React.useEffect(() => {
    if (!server) return;
    setForm({
      ...emptyForm,
      name: server.name,
      transport: server.transport === "stdio" ? "stdio" : "http",
      url: server.url ?? "",
      auth: server.authType,
      headerName: server.headerNames[0] ?? "Authorization",
      commandLine: [server.command ?? "", ...server.args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(" ").trim(),
    });
  }, [server]);
  const save = useMutation({
    mutationFn: () => {
      const payload = toPayload(form);
      // Unchanged connection settings are dropped so a rename doesn't reconnect.
      if (server && payload.url === server.url) delete payload.url;
      if (server && payload.authType === server.authType) delete payload.authType;
      if (
        server &&
        payload.command === server.command &&
        JSON.stringify(payload.args) === JSON.stringify(server.args)
      ) {
        delete payload.command;
        delete payload.args;
      }
      if (server && payload.transport === (server.transport === "stdio" ? "stdio" : "http")) delete payload.transport;
      return api<{ server: McpServer; result?: McpSyncResult }>(`/mcp/servers/${server!.id}`, {
        method: "PATCH",
        json: payload,
      });
    },
    onSuccess: ({ server: s, result }) => {
      qc.invalidateQueries({ queryKey: automationKeys.mcp(wid) });
      onClose();
      if (result) feedback(result, s.name);
      else toast.success("Saved");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog
      open={!!server}
      onOpenChange={(v) => !v && onClose()}
      title={`Edit ${server?.name ?? ""}`}
      description="Changing the URL, authentication or credentials reconnects and reloads the tools."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!form.name.trim()} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      {server ? (
        <ServerForm
          form={form}
          setForm={setForm}
          stdioAllowed={server.transport === "stdio"}
          storedHeaders={server.headerNames}
          storedEnv={server.envNames}
        />
      ) : null}
      {server?.instructions ? (
        <div className="mt-4 flex flex-col gap-1.5">
          <span className="label-mono flex items-center gap-1.5">
            <ShieldCheck className="size-3" /> Instructions from the server (given to the agent)
          </span>
          <p className="max-h-32 overflow-auto border border-line bg-cell p-2.5 text-[12px] leading-relaxed whitespace-pre-wrap text-body">
            {server.instructions}
          </p>
        </div>
      ) : null}
    </Dialog>
  );
}
