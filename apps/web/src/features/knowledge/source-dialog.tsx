import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Eye, Lock } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button, Dialog, Field, Input, Select, Segmented, Switch, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { type KnowledgeSource, SOURCE_META, type SourceType, type TestResult, type Visibility } from "./types";

type Form = {
  name: string;
  visibility: Visibility;
  secret: string;
  syncIntervalMinutes: number;
  // website
  url: string;
  maxPages: number;
  include: string;
  exclude: string;
  // atlassian
  baseUrl: string;
  email: string;
  spaceKeys: string;
  cql: string;
  jql: string;
  maxIssues: number;
  includeComments: boolean;
  // notion
  query: string;
  // zendesk
  subdomain: string;
  locale: string;
};

const blank = (type: SourceType): Form => ({
  name: SOURCE_META[type].label,
  visibility: SOURCE_META[type].defaultVisibility,
  secret: "",
  syncIntervalMinutes: 360,
  url: "",
  maxPages: type === "notion" ? 200 : 50,
  include: "",
  exclude: "",
  baseUrl: "",
  email: "",
  spaceKeys: "",
  cql: "",
  jql: "updated >= -180d ORDER BY updated DESC",
  maxIssues: 300,
  includeComments: true,
  query: "",
  subdomain: "",
  locale: "",
});

function fromSource(s: KnowledgeSource): Form {
  const c = s.config as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.join(", ") : "");
  return {
    ...blank(s.type),
    name: s.name,
    visibility: s.visibility,
    syncIntervalMinutes: s.syncIntervalMinutes,
    url: String(c.url ?? ""),
    maxPages: Number(c.maxPages ?? 50),
    include: list(c.include),
    exclude: list(c.exclude),
    baseUrl: String(c.baseUrl ?? ""),
    email: String(c.email ?? ""),
    spaceKeys: list(c.spaceKeys),
    cql: String(c.cql ?? ""),
    jql: String(c.jql ?? ""),
    maxIssues: Number(c.maxIssues ?? 300),
    includeComments: c.includeComments !== false,
    query: String(c.query ?? ""),
    subdomain: String(c.subdomain ?? ""),
    locale: String(c.locale ?? ""),
  };
}

const split = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

function toConfig(type: SourceType, f: Form) {
  switch (type) {
    case "website":
      return { type, url: f.url.trim(), maxPages: f.maxPages, include: split(f.include), exclude: split(f.exclude) };
    case "confluence":
      return {
        type,
        baseUrl: f.baseUrl.trim(),
        email: f.email.trim(),
        spaceKeys: split(f.spaceKeys),
        cql: f.cql.trim() || undefined,
      };
    case "jira":
      return {
        type,
        baseUrl: f.baseUrl.trim(),
        email: f.email.trim(),
        jql: f.jql.trim(),
        maxIssues: f.maxIssues,
        includeComments: f.includeComments,
      };
    case "notion":
      return { type, query: f.query.trim() || undefined, maxPages: f.maxPages };
    case "zendesk":
      return {
        type,
        subdomain: f.subdomain.trim(),
        locale: f.locale.trim() || undefined,
        email: f.email.trim() || undefined,
      };
    case "files":
      return { type };
  }
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-line bg-white/[0.02] px-3 py-2 text-[11.5px] leading-relaxed text-muted">
      {children}
    </div>
  );
}

const A = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="text-fg-3 underline underline-offset-2 hover:text-fg">
    {children}
  </a>
);

/** Add (type picker → form) or edit a knowledge source, with a live connection test. */
export function SourceDialog({
  open,
  onOpenChange,
  source,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  source?: KnowledgeSource;
  onCreated?: (s: KnowledgeSource) => void;
}) {
  const { api, wid } = useWorkspace();
  const qc = useQueryClient();
  const [type, setType] = React.useState<SourceType | null>(source?.type ?? null);
  const [f, setF] = React.useState<Form>(source ? fromSource(source) : blank("website"));
  const [test, setTest] = React.useState<TestResult | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setType(source?.type ?? null);
    setF(source ? fromSource(source) : blank("website"));
    setTest(null);
  }, [open, source]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    setTest(null);
  };
  const pick = (t: SourceType) => {
    setType(t);
    setF(blank(t));
    setTest(null);
  };

  const runTest = useMutation({
    mutationFn: () =>
      api<TestResult>("/knowledge/test", {
        method: "POST",
        json: { config: toConfig(type!, f), secret: f.secret || undefined, sourceId: source?.id },
      }),
    onSuccess: setTest,
    onError: (e) => setTest({ ok: false, error: (e as Error).message }),
  });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name.trim() || SOURCE_META[type!].label,
        visibility: f.visibility,
        config: toConfig(type!, f),
        secret: f.secret || undefined,
        syncIntervalMinutes: f.syncIntervalMinutes,
      };
      return source
        ? api<{ source: KnowledgeSource }>(`/knowledge/sources/${source.id}`, { method: "PATCH", json: body })
        : api<{ source: KnowledgeSource }>("/knowledge/sources", { method: "POST", json: body });
    },
    onSuccess: ({ source: s }) => {
      qc.invalidateQueries({ queryKey: ["knowledge", wid] });
      toast.success(
        source
          ? "Source updated"
          : type === "files"
            ? "Source created — drop files onto it"
            : "Source added — first sync started",
      );
      onOpenChange(false);
      if (!source) onCreated?.(s);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const meta = type ? SOURCE_META[type] : null;
  const canSave =
    !!type &&
    (type !== "website" || f.url.trim()) &&
    (!["confluence", "jira"].includes(type) || f.baseUrl.trim()) &&
    (type !== "zendesk" || f.subdomain.trim()) &&
    (!meta?.needsSecret || !!f.secret || source?.hasSecret);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={source ? `Edit ${source.name}` : type ? `Connect ${meta!.label}` : "Add a knowledge source"}
      description={
        type
          ? meta!.blurb
          : "Everything you connect is chunked, embedded locally and searchable by the AI agent — across languages."
      }
      className="w-[min(640px,calc(100vw-32px))]"
      footer={
        type ? (
          <>
            {!source ? (
              <Button variant="ghost" className="mr-auto" onClick={() => setType(null)}>
                Back
              </Button>
            ) : null}
            {type !== "files" ? (
              <Button loading={runTest.isPending} disabled={!canSave} onClick={() => runTest.mutate()}>
                Test connection
              </Button>
            ) : null}
            <Button variant="primary" loading={save.isPending} disabled={!canSave} onClick={() => save.mutate()}>
              {source ? "Save" : type === "files" ? "Create" : "Connect & sync"}
            </Button>
          </>
        ) : null
      }
    >
      {!type ? (
        <div className="grid grid-cols-2 gap-px border border-line bg-line">
          {(Object.keys(SOURCE_META) as SourceType[]).map((t) => {
            const m = SOURCE_META[t];
            return (
              <button
                key={t}
                onClick={() => pick(t)}
                className="flex flex-col items-start gap-1.5 bg-bar p-4 text-left hover:bg-white/[0.03]"
              >
                <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
                  <m.icon className="size-4 text-accent-text" /> {m.label}
                </span>
                <span className="text-[11.5px] leading-relaxed text-dim">{m.blurb}</span>
                {m.defaultVisibility === "internal" ? (
                  <span className="flex items-center gap-1 font-mono text-[11px] text-warn">
                    <Lock className="size-2.5" /> internal by default
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-[1fr_auto] items-end gap-3">
            <Field label="Name">
              <Input value={f.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            {type !== "files" ? (
              <Field label="Re-sync">
                <Select
                  className="w-36"
                  value={f.syncIntervalMinutes}
                  onChange={(e) => set("syncIntervalMinutes", Number(e.target.value))}
                >
                  <option value={60}>every hour</option>
                  <option value={360}>every 6 hours</option>
                  <option value={1440}>daily</option>
                  <option value={10080}>weekly</option>
                </Select>
              </Field>
            ) : null}
          </div>

          <Field label="Visibility">
            <div className="flex flex-col gap-2">
              <Segmented
                value={f.visibility}
                onChange={(v) => set("visibility", v)}
                options={[
                  {
                    value: "public",
                    label: (
                      <span className="flex items-center gap-1.5">
                        <Eye className="size-3" /> Public
                      </span>
                    ),
                  },
                  {
                    value: "internal",
                    label: (
                      <span className="flex items-center gap-1.5">
                        <Lock className="size-3" /> Internal
                      </span>
                    ),
                  },
                ]}
              />
              <span className="text-[11.5px] leading-relaxed text-dim">
                {f.visibility === "public"
                  ? "The agent may quote and cite this content to customers."
                  : "Context only: the agent uses it to understand the situation (e.g. a known bug) but never quotes or links it to customers."}
              </span>
            </div>
          </Field>

          {type === "website" ? (
            <>
              <Field
                label="Start URL"
                hint="Pages on the same site under this path are crawled. A sitemap.xml is used when present."
              >
                <Input
                  value={f.url}
                  onChange={(e) => set("url", e.target.value)}
                  placeholder="https://docs.acme.com/help"
                />
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Max pages">
                  <Input
                    type="number"
                    min={1}
                    max={500}
                    value={f.maxPages}
                    onChange={(e) => set("maxPages", Number(e.target.value))}
                  />
                </Field>
                <Field label="Only paths" className="col-span-2" hint="Optional, comma separated, e.g. /docs, /guides">
                  <Input value={f.include} onChange={(e) => set("include", e.target.value)} placeholder="/docs" />
                </Field>
              </div>
              <Field label="Skip paths" hint="Optional, e.g. /blog, /changelog">
                <Input value={f.exclude} onChange={(e) => set("exclude", e.target.value)} />
              </Field>
            </>
          ) : null}

          {type === "confluence" || type === "jira" ? (
            <>
              <Hint>
                Atlassian Cloud: use your account email and an API token from{" "}
                <A href="https://id.atlassian.com/manage-profile/security/api-tokens">
                  id.atlassian.com → Security → API tokens
                </A>
                . Data Center / Server: leave email empty and paste a personal access token. Only content the token's
                user can see is synced.
              </Hint>
              <Field
                label="Base URL"
                hint={
                  type === "confluence" ? "e.g. https://acme.atlassian.net/wiki" : "e.g. https://acme.atlassian.net"
                }
              >
                <Input
                  value={f.baseUrl}
                  onChange={(e) => set("baseUrl", e.target.value)}
                  placeholder={type === "confluence" ? "https://acme.atlassian.net/wiki" : "https://acme.atlassian.net"}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Account email">
                  <Input value={f.email} onChange={(e) => set("email", e.target.value)} placeholder="you@acme.com" />
                </Field>
                <SecretField f={f} set={set} has={source?.hasSecret} label="API token" />
              </div>
            </>
          ) : null}

          {type === "confluence" ? (
            <>
              <Field
                label="Space keys"
                hint="Comma separated, e.g. HELP, DOCS. Leave empty for every space the user can read."
              >
                <Input
                  value={f.spaceKeys}
                  onChange={(e) => set("spaceKeys", e.target.value)}
                  placeholder="HELP, DOCS"
                />
              </Field>
              <Field label="Extra CQL filter (optional)" hint={'e.g. label = "customer-facing"'}>
                <Input value={f.cql} onChange={(e) => set("cql", e.target.value)} className="font-mono text-[12px]" />
              </Field>
            </>
          ) : null}

          {type === "jira" ? (
            <>
              <Field label="JQL" hint="Which issues to sync. Bugs and incidents are the most useful context.">
                <Textarea
                  rows={2}
                  value={f.jql}
                  onChange={(e) => set("jql", e.target.value)}
                  className="font-mono text-[12px]"
                />
              </Field>
              <div className="grid grid-cols-2 items-end gap-3">
                <Field label="Max issues">
                  <Input
                    type="number"
                    min={1}
                    max={5000}
                    value={f.maxIssues}
                    onChange={(e) => set("maxIssues", Number(e.target.value))}
                  />
                </Field>
                <label className="flex h-8 items-center justify-between gap-3 border border-line px-3">
                  <span className="text-[12.5px] text-fg-3">Include recent comments</span>
                  <Switch checked={f.includeComments} onCheckedChange={(v) => set("includeComments", v)} />
                </label>
              </div>
            </>
          ) : null}

          {type === "notion" ? (
            <>
              <Hint>
                Create an internal integration at{" "}
                <A href="https://www.notion.so/profile/integrations">notion.so → Integrations</A>, copy its secret, then
                share the pages to sync with it (page menu ••• → Connections). Child pages of shared pages are included.
              </Hint>
              <SecretField f={f} set={set} has={source?.hasSecret} label="Integration secret" placeholder="ntn_…" />
              <div className="grid grid-cols-3 gap-3">
                <Field label="Title contains (optional)" className="col-span-2">
                  <Input value={f.query} onChange={(e) => set("query", e.target.value)} placeholder="Help" />
                </Field>
                <Field label="Max pages">
                  <Input
                    type="number"
                    min={1}
                    max={2000}
                    value={f.maxPages}
                    onChange={(e) => set("maxPages", Number(e.target.value))}
                  />
                </Field>
              </div>
            </>
          ) : null}

          {type === "zendesk" ? (
            <>
              <div className="grid grid-cols-[1fr_120px] gap-3">
                <Field label="Subdomain" hint="acme for acme.zendesk.com">
                  <Input value={f.subdomain} onChange={(e) => set("subdomain", e.target.value)} placeholder="acme" />
                </Field>
                <Field label="Locale" hint="optional">
                  <Input value={f.locale} onChange={(e) => set("locale", e.target.value)} placeholder="en-us" />
                </Field>
              </div>
              <Hint>
                Public articles need no credentials. For restricted articles add an agent email and a Zendesk API token.
              </Hint>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Agent email (optional)">
                  <Input value={f.email} onChange={(e) => set("email", e.target.value)} />
                </Field>
                <SecretField f={f} set={set} has={source?.hasSecret} label="API token (optional)" />
              </div>
            </>
          ) : null}

          {type === "files" ? (
            <Hint>
              After creating the source, drag PDF, Markdown, text or HTML files onto its card (max 20 MB each).
              Re-uploading a file with the same name replaces it.
            </Hint>
          ) : null}

          {test ? (
            <div
              className={cn(
                "flex flex-col gap-2 border px-3 py-2.5",
                test.ok ? "border-ok/30 bg-ok/[0.04]" : "border-danger/30 bg-danger/[0.04]",
              )}
            >
              <span className={cn("flex items-center gap-1.5 text-[12.5px]", test.ok ? "text-ok" : "text-danger")}>
                {test.ok ? <CircleCheck className="size-3.5" /> : <CircleAlert className="size-3.5" />}
                {test.ok ? "Connected — sample documents:" : test.error}
              </span>
              {test.samples?.map((s) => (
                <span key={s.title + s.url} className="truncate pl-5 font-mono text-[11px] text-fg-3">
                  {s.title}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

function SecretField({
  f,
  set,
  has,
  label,
  placeholder,
}: {
  f: Form;
  set: <K extends keyof Form>(k: K, v: Form[K]) => void;
  has?: boolean;
  label: string;
  placeholder?: string;
}) {
  return (
    <Field
      label={label}
      hint={has ? "Stored encrypted. Leave empty to keep the current one." : "Stored encrypted at rest."}
    >
      <Input
        type="password"
        autoComplete="off"
        value={f.secret}
        onChange={(e) => set("secret", e.target.value)}
        placeholder={has ? "••••••••" : placeholder}
      />
    </Field>
  );
}
