import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy, RefreshCw, Sparkle } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button, Dialog, Field, Input, Segmented, Select, Spinner, Textarea } from "@/components/ui";
import type { TicketDetail } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { issueKeys, PROVIDER, type SimilarIssue, type Tracker } from "./types";

type Kind = "bug" | "feature request" | "task";
type Include = { link: boolean; trace: boolean; fields: boolean; customerEmail: boolean };

/** Designed in pen.dev ("trace — Create issue (dialog)"). */
export function CreateIssueDialog({
  data,
  mode,
  onClose,
}: {
  data: TicketDetail;
  mode: "create" | "link" | null;
  onClose: () => void;
}) {
  const { api, wid, slug, boot } = useWorkspace();
  const qc = useQueryClient();
  const open = mode !== null;
  const trackers = useQuery({
    queryKey: issueKeys.trackers(wid),
    queryFn: () => api<{ trackers: Tracker[] }>("/issues/trackers"),
    enabled: open,
    staleTime: 60_000,
  });
  const list = (trackers.data?.trackers ?? []).filter((t) => t.status === "connected");
  const classification = data.fields.find((f) => f.key === "type")?.value;
  const ref = `${boot.settings.ticketPrefix}-${data.ticket.number}`;

  const [view, setView] = React.useState<"create" | "link">("create");
  const [trackerId, setTrackerId] = React.useState("");
  const [container, setContainer] = React.useState("");
  const [kind, setKind] = React.useState<Kind>("bug");
  const [include, setInclude] = React.useState<Include>({
    link: true,
    trace: true,
    fields: true,
    customerEmail: false,
  });
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [edited, setEdited] = React.useState(false);
  const [key, setKey] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setView(mode ?? "create");
    setKind(classification === "feature request" ? "feature request" : classification === "bug" ? "bug" : "task");
    setEdited(false);
    setKey("");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const tracker = list.find((t) => t.id === trackerId) ?? list[0];
  React.useEffect(() => {
    if (!tracker) return;
    if (tracker.id !== trackerId) setTrackerId(tracker.id);
    const def = tracker.provider === "linear" ? tracker.config.defaultTeamId : tracker.config.defaultProjectKey;
    setContainer(def ?? tracker.containers[0]?.id ?? "");
  }, [tracker?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const draft = useMutation({
    mutationFn: () =>
      api<{ title: string; description: string; offline: boolean }>(`/issues/tickets/${data.ticket.id}/draft`, {
        method: "POST",
        json: { type: kind === "task" ? null : kind, include },
      }),
    onSuccess: (d) => {
      setTitle(d.title);
      setDescription(d.description);
      setEdited(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  // Draft when the dialog opens, and again when the type or what to include changes — unless you've edited it.
  React.useEffect(() => {
    if (open && view === "create" && !edited) draft.mutate();
  }, [open, view, kind, include.link, include.trace, include.fields, include.customerEmail]); // eslint-disable-line react-hooks/exhaustive-deps

  const [q, setQ] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setQ(title), 500);
    return () => clearTimeout(t);
  }, [title]);
  const similar = useQuery({
    queryKey: ["issues", wid, "similar", tracker?.id, container, q],
    enabled: open && view === "create" && !!tracker && q.trim().length > 6,
    queryFn: () =>
      api<{ issues: SimilarIssue[] }>(
        `/issues/tickets/${data.ticket.id}/similar?integration=${tracker!.id}&container=${encodeURIComponent(container)}&q=${encodeURIComponent(q)}`,
      ),
    staleTime: 60_000,
  });
  const already = new Set(data.links.map((l) => l.key));
  const dup = similar.data?.issues.find((i) => !already.has(i.key));

  const done = (msg: string) => {
    qc.invalidateQueries({ queryKey: ["ticket", wid] });
    toast.success(msg);
    onClose();
  };
  const create = useMutation({
    mutationFn: () =>
      api<{ issue: { key: string } }>(`/issues/tickets/${data.ticket.id}/links`, {
        method: "POST",
        json: {
          integrationId: tracker!.id,
          container,
          type: kind === "task" ? null : kind,
          title,
          description,
          link: include.link,
        },
      }),
    onSuccess: (r) => done(`Filed ${r.issue.key} in ${PROVIDER[tracker!.provider]}`),
    onError: (e) => toast.error((e as Error).message),
  });
  const linkExisting = useMutation({
    mutationFn: (k: string) =>
      api<{ issue: { key: string } }>(`/issues/tickets/${data.ticket.id}/links/existing`, {
        method: "POST",
        json: { integrationId: tracker!.id, key: k },
      }),
    onSuccess: (r) => done(`Linked ${r.issue.key}`),
    onError: (e) => toast.error((e as Error).message),
  });

  const noTrackers = trackers.isSuccess && !list.length;
  const providerName = tracker ? PROVIDER[tracker.provider] : "";
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title={view === "create" ? `Create issue from ${ref}` : `Link an issue to ${ref}`}
      description={
        view === "create"
          ? `${boot.settings.ai.agentName} drafted this from the conversation and its trace. Edit anything.`
          : "Paste an issue key or link. Status changes will show up on this ticket."
      }
      className="w-[min(700px,calc(100vw-32px))]"
      footer={
        noTrackers ? (
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <button
              onClick={() => setView(view === "create" ? "link" : "create")}
              className="mr-auto font-mono text-[11px] text-body hover:text-fg"
            >
              {view === "create" ? "link an existing issue instead" : "create a new issue instead"}
            </button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {view === "create" ? (
              <Button
                variant="primary"
                disabled={!tracker || !container || title.trim().length < 3 || draft.isPending}
                loading={create.isPending}
                onClick={() => create.mutate()}
              >
                Create in {providerName}
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={!tracker || key.trim().length < 3}
                loading={linkExisting.isPending}
                onClick={() => linkExisting.mutate(key)}
              >
                Link issue
              </Button>
            )}
          </>
        )
      }
    >
      {trackers.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : noTrackers ? (
        <div className="flex flex-col gap-2 py-4 text-[13px] text-body">
          No issue tracker connected yet.
          <Link
            to="/w/$slug/settings/$section"
            params={{ slug, section: "fields" }}
            onClick={onClose}
            className="w-fit font-mono text-[11.5px] text-accent-text hover:text-fg"
          >
            connect Linear or Jira →
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-4">
            {list.length > 1 ? (
              <Field label="Tracker">
                <Segmented
                  value={tracker?.id ?? ""}
                  onChange={setTrackerId}
                  options={list.map((t) => ({ value: t.id, label: PROVIDER[t.provider] }))}
                  className="h-8 border border-line-strong"
                />
              </Field>
            ) : null}
            {view === "create" ? (
              <Field label="Type">
                <Segmented
                  value={kind}
                  onChange={setKind}
                  options={[
                    { value: "bug", label: "Bug" },
                    { value: "feature request", label: "Feature request" },
                    { value: "task", label: "Task" },
                  ]}
                  className="h-8 border border-line-strong"
                />
              </Field>
            ) : null}
            {view === "create" ? (
              <Field label={tracker?.provider === "jira" ? "Project" : "Team"} className="min-w-[200px] flex-1">
                <Select value={container} onChange={(e) => setContainer(e.target.value)}>
                  {(tracker?.containers ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {c.key}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </div>

          {view === "link" ? (
            <Field label="Issue" hint={`e.g. ${tracker?.provider === "jira" ? "SUP-219" : "ENG-482"} or a link to it`}>
              <Input
                autoFocus
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && key.trim() && linkExisting.mutate(key)}
                className="font-mono"
              />
            </Field>
          ) : (
            <>
              {dup ? (
                <div className="flex items-center gap-2.5 border border-warn/25 bg-warn/[0.05] px-3 py-2.5">
                  <Copy className="size-3.5 shrink-0 text-warn" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <a
                      href={dup.url}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-[12.5px] text-fg-2 hover:text-fg"
                    >
                      Looks like {dup.key} · {dup.title}
                    </a>
                    <span className="font-mono text-[11px] text-dim">
                      {providerName} · {dup.status}
                      {dup.tickets ? ` · ${dup.tickets} ticket${dup.tickets === 1 ? "" : "s"} linked` : ""}
                    </span>
                  </div>
                  <Button size="sm" loading={linkExisting.isPending} onClick={() => linkExisting.mutate(dup.key)}>
                    Link instead
                  </Button>
                </div>
              ) : null}
              <Field
                label={
                  <span className="flex items-center gap-1.5">
                    Title <Sparkle className="size-2.5 fill-accent text-accent" />
                    {draft.isPending ? <Spinner /> : null}
                  </span>
                }
              >
                <Input
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setEdited(true);
                  }}
                />
              </Field>
              <Field
                label={
                  <span className="flex w-full items-center gap-1.5">
                    Description <Sparkle className="size-2.5 fill-accent text-accent" />
                    <button
                      type="button"
                      onClick={() => draft.mutate()}
                      disabled={draft.isPending}
                      className="ml-auto flex items-center gap-1 font-mono text-[11px] font-normal text-body hover:text-fg disabled:opacity-60"
                    >
                      <RefreshCw className="size-3" /> redraft
                    </button>
                  </span>
                }
              >
                <Textarea
                  rows={12}
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    setEdited(true);
                  }}
                  className="font-mono text-[12px] leading-relaxed"
                  spellCheck={false}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="font-mono text-[11px] text-dim">include</span>
                {(
                  [
                    ["link", "link back to the ticket"],
                    ["trace", "trace summary"],
                    ["fields", "properties"],
                    ["customerEmail", "customer email"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    role="checkbox"
                    aria-checked={include[k]}
                    onClick={() => {
                      setInclude({ ...include, [k]: !include[k] });
                      setEdited(false);
                    }}
                    className="flex items-center gap-1.5 text-[12px]"
                  >
                    <span
                      className={cn(
                        "flex size-3.5 items-center justify-center border",
                        include[k] ? "border-accent bg-accent/30" : "border-line-strong",
                      )}
                    >
                      {include[k] ? <span className="size-1.5 bg-accent-fg" /> : null}
                    </span>
                    <span className={include[k] ? "text-fg-2" : "text-dim"}>{label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
