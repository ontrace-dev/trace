import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Sparkle, UserRound, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Input, Select, Switch, Tip } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm";
import type { TicketDetail } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { type IssueLink, PROVIDER, type ResolvedField, showValue, statusDot, toneDot } from "./types";

function useSetField(ticketId: string) {
  const { api, wid } = useWorkspace();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { key: string; value: unknown }) =>
      api(`/tickets/${ticketId}/fields`, { method: "PATCH", json: b }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ticket", wid] }),
    onError: (e) => toast.error((e as Error).message),
  });
}

/** ✦ — the value was filled by trace. Changing it counts as a correction trace learns from. */
function AiMark({ agentName }: { agentName: string }) {
  return (
    <Tip
      label={`Set by ${agentName} from the conversation. Change it to correct; ${agentName} learns from corrections.`}
    >
      <Sparkle className="size-2.5 shrink-0 fill-accent text-accent" aria-label={`set by ${agentName}`} />
    </Tip>
  );
}

/* ------------------------------------------------------------------ header chips */

/** Key facts next to the subject: header fields (org_id, type, …) and linked issues. */
export function FactChips({ data }: { data: TicketDetail }) {
  const header = data.fields.filter((f) => f.shown === "header" && showValue(f.value));
  if (!header.length && !data.links.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {header.map((f) => (
        <FactChip key={f.key} field={f} />
      ))}
      {data.links.map((l) => (
        <a
          key={l.id}
          href={l.url}
          target="_blank"
          rel="noreferrer"
          title={`${PROVIDER[l.provider]} · ${l.title}`}
          className={cn(
            "flex h-[22px] items-center gap-1.5 border px-[7px] font-mono text-[11px] text-fg-2 hover:text-fg",
            l.statusCategory === "started"
              ? "border-info/30"
              : l.statusCategory === "done"
                ? "border-ok/30"
                : "border-line-strong",
          )}
        >
          <span className={cn("size-1.5", statusDot[l.statusCategory])} />
          {l.key} · {l.status.toLowerCase() || "linked"}
        </a>
      ))}
    </div>
  );
}

function FactChip({ field: f }: { field: ResolvedField }) {
  const [copied, setCopied] = React.useState(false);
  const text = showValue(f.value);
  const option = f.type === "select" ? f.options.find((o) => o.value === f.value) : undefined;
  if (f.type === "select" || f.type === "multiselect")
    return (
      <span className="flex h-[22px] items-center gap-1.5 border border-line-strong bg-white/[0.02] px-[7px] font-mono text-[11px]">
        {f.system ? (
          <span className={cn("size-1.5", toneDot[option?.color ?? "neutral"])} />
        ) : (
          <span className="text-dim">{f.key}</span>
        )}
        <span className="text-fg-2">{text}</span>
      </span>
    );
  // Ids and versions are what people copy into other tools — one click.
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      title={`Copy ${f.label}`}
      className="group flex h-[22px] items-center gap-1.5 border border-line-strong bg-white/[0.02] px-[7px] font-mono text-[11px] hover:border-white/30"
    >
      <span className="text-dim">{f.key}</span>
      <span className="max-w-[180px] truncate text-fg-2">{text}</span>
      {copied ? <Check className="size-3 text-ok" /> : <Copy className="size-3 text-dim group-hover:text-fg" />}
    </button>
  );
}

/* ------------------------------------------------------------------ panel rows */

/** Custom fields as rows of the Properties grid, edited in place. */
export function FieldRows({ data }: { data: TicketDetail }) {
  const { boot } = useWorkspace();
  const set = useSetField(data.ticket.id);
  const fields = data.fields.filter((f) => f.shown !== "hidden");
  return (
    <>
      {fields.map((f) => (
        <React.Fragment key={f.key}>
          <span
            className="flex items-center gap-1 self-center truncate font-mono text-[11.5px] text-dim"
            title={f.label}
          >
            {f.label.toLowerCase()}
            {f.requiredToResolve && f.value == null ? <span className="text-warn">*</span> : null}
          </span>
          <div className="flex min-w-0 items-center gap-1.5">
            <FieldEditor field={f} onSave={(value) => set.mutate({ key: f.key, value })} />
            {f.setBy === "ai" ? <AiMark agentName={boot.settings.ai.agentName} /> : null}
            {f.setBy === "customer" ? (
              <Tip label="From the customer record. Typing a value overrides it for this ticket.">
                <UserRound className="size-3 shrink-0 text-dim" aria-label="from the customer record" />
              </Tip>
            ) : null}
          </div>
        </React.Fragment>
      ))}
    </>
  );
}

function FieldEditor({ field: f, onSave }: { field: ResolvedField; onSave: (v: unknown) => void }) {
  const [text, setText] = React.useState(showValue(f.value));
  React.useEffect(() => setText(showValue(f.value)), [f.value]);
  if (f.type === "select")
    return (
      <Select
        className="h-7 min-w-0 flex-1 text-[12px]"
        value={(f.value as string) ?? ""}
        placeholder="—"
        onChange={(e) => onSave(e.target.value || null)}
      >
        <option value="">—</option>
        {f.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.value}
          </option>
        ))}
      </Select>
    );
  if (f.type === "checkbox") return <Switch checked={f.value === true} onCheckedChange={(v) => onSave(v)} />;
  const commit = () => {
    if (text === showValue(f.value)) return;
    onSave(
      f.type === "multiselect"
        ? text
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        : text.trim() || null,
    );
  };
  return (
    <div className="flex min-w-0 flex-1 items-center">
      <Input
        value={text}
        type={f.type === "date" ? "date" : "text"}
        inputMode={f.type === "number" ? "decimal" : undefined}
        placeholder={f.setBy === null && f.source === "customer" ? "not on customer" : "—"}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setText(showValue(f.value));
        }}
        className="h-7 min-w-0 flex-1 font-mono text-[12px]"
        title={
          f.setBy === "customer" ? "From the customer record — typing here overrides it for this ticket" : undefined
        }
      />
      {f.type === "url" && f.value ? (
        <a
          href={String(f.value)}
          target="_blank"
          rel="noreferrer"
          className="px-1.5 text-dim hover:text-fg"
          aria-label="Open link"
        >
          <ExternalLink className="size-3" />
        </a>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ linked issues */

export function LinkedIssues({ data, onCreate }: { data: TicketDetail; onCreate: (mode: "create" | "link") => void }) {
  const { api, wid } = useWorkspace();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const unlink = useMutation({
    mutationFn: (l: IssueLink) => api(`/issues/tickets/${data.ticket.id}/links/${l.id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ticket", wid] }),
  });
  return (
    <div className="flex flex-col border-b border-line">
      <div className="flex h-10 items-center justify-between px-4">
        <span className="label-mono">Linked issues</span>
        <span className="flex gap-3 font-mono text-[11px]">
          <button onClick={() => onCreate("create")} className="text-body hover:text-fg">
            + create
          </button>
          <button onClick={() => onCreate("link")} className="text-body hover:text-fg">
            link
          </button>
        </span>
      </div>
      {!data.links.length ? (
        <p className="px-4 pb-3.5 text-[12px] leading-relaxed text-dim">
          File a bug or feature request in Linear or Jira; status changes come back here.
        </p>
      ) : (
        data.links.map((l) => (
          <div key={l.id} className="group flex flex-col gap-1.5 border-t border-line-2 px-4 py-2.5">
            <div className="flex min-w-0 items-baseline gap-2">
              <a
                href={l.url}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 font-mono text-[11.5px] text-fg-2 hover:text-fg"
              >
                {l.key}
              </a>
              <a
                href={l.url}
                target="_blank"
                rel="noreferrer"
                className="truncate text-[12.5px] text-fg-2 hover:text-fg"
                title={l.title}
              >
                {l.title}
              </a>
              <button
                aria-label={`Unlink ${l.key}`}
                onClick={async () =>
                  (await confirm({
                    title: `Unlink ${l.key}?`,
                    description: "The issue stays in the tracker; this ticket just stops following it.",
                    confirmLabel: "Unlink",
                  })) && unlink.mutate(l)
                }
                className="ml-auto shrink-0 text-dim opacity-0 group-hover:opacity-100 hover:text-fg focus-visible:opacity-100"
              >
                <X className="size-3" />
              </button>
            </div>
            <div className="flex items-center gap-1.5 font-mono text-[11px]">
              <span className={cn("size-1.5", statusDot[l.statusCategory])} />
              <span className="text-fg-2">{l.status || "linked"}</span>
              <span className="text-dim">
                · {PROVIDER[l.provider]}
                {l.tickets > 1 ? ` · ${l.tickets} tickets` : ""}
              </span>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
