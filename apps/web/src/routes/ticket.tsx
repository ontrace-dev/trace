import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  BookPlus,
  Bug,
  CircleCheck,
  CircleX,
  Clock,
  Ellipsis,
  FileText,
  ListTree,
  Lock,
  Paperclip,
  PanelRight,
  PenLine,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  UserRoundPlus,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import {
  Avatar,
  Button,
  Empty,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  Spinner,
  Tip,
} from "@/components/ui";
import { channelIcon } from "./inbox";
import { ActionNote, TicketActionRuns } from "@/features/actions/ticket-runs";
import { SourceChips } from "@/features/source-chips";
import { Composer, type ComposerHandle } from "@/features/ticket/composer";
import { ContextPanel } from "@/features/ticket/context-panel";
import { CreateIssueDialog } from "@/features/issues/create-issue";
import { AiPill, CHANNEL_LABEL, StatusPill } from "@/features/ticket/badges";
import { useMarkRead } from "@/features/notifications";
import { FactChips } from "@/features/issues/ticket-fields";
import { TraceAnalysis, TraceWaterfall } from "@/features/ticket/trace-view";
import { useTicket, useTicketActions } from "@/features/ticket/use-ticket";
import type { Draft, Message, TicketDetail } from "@/lib/types";
import { bytes, clock, cn, md } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

export function TicketPane() {
  const { ticket: ref } = useParams({ strict: false }) as { ticket: string };
  const q = useTicket(ref);
  if (q.isPending)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  if (q.error || !q.data) return <Empty title="Ticket not found">{(q.error as Error)?.message}</Empty>;
  return <TicketView data={q.data} />;
}

function TicketView({ data }: { data: TicketDetail }) {
  const { boot, slug } = useWorkspace();
  const { ticket, messages, draft, customer } = data;
  const composer = React.useRef<ComposerHandle>(null);
  const scroller = React.useRef<HTMLDivElement>(null);
  const actions = useTicketActions(ticket.id);
  const navigate = useNavigate();
  const [waterfall, setWaterfall] = React.useState(false);
  const [issueMode, setIssueMode] = React.useState<"create" | "link" | null>(null);
  const [details, setDetails] = React.useState(false);
  const { view } = useParams({ strict: false }) as { view?: string };
  React.useEffect(() => {
    if (!details) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDetails(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [details]);
  useMarkRead(ticket.id, messages.length);
  const ref = `${boot.settings.ticketPrefix}-${ticket.number}`;
  const latestTrace = data.traces[0];
  const Channel = channelIcon[ticket.channel];

  React.useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [ticket.id, messages.length, draft?.id]);

  // Insert the analysis card right after the customer message that triggered the latest trace.
  const analysisAfter = React.useMemo(() => {
    if (!latestTrace) return null;
    const t = new Date(latestTrace.spans[0]!.startedAt).getTime();
    const before = messages.filter(
      (m) => m.authorType === "customer" && m.kind === "message" && new Date(m.createdAt).getTime() <= t + 2000,
    );
    return before.at(-1)?.id ?? null;
  }, [latestTrace, messages]);

  const resolved = ticket.status === "resolved" || ticket.status === "closed";

  return (
    <div className="flex h-full">
      <section className="@container flex min-w-0 flex-1 flex-col bg-bg">
        <header className="flex shrink-0 flex-col gap-2.5 border-b border-line px-4 py-3 md:px-5">
          <div className="flex flex-col gap-2.5 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-4">
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex min-w-0 items-center gap-2">
                {view ? (
                  <Link
                    to="/w/$slug/inbox/$view"
                    params={{ slug, view }}
                    aria-label="Back to the list"
                    className="-ml-1 p-1 text-muted hover:text-fg md:hidden"
                  >
                    <ArrowLeft className="size-4" />
                  </Link>
                ) : null}
                <h1 className="truncate text-[15px] font-semibold tracking-[-0.2px] text-[#f4f4f8]">
                  {ticket.subject}
                </h1>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
                <StatusPill t={ticket} />
                <AiPill state={ticket.aiState} />
                <span className="font-mono text-[12px] whitespace-nowrap text-muted">{ref}</span>
                <span className="text-faint">·</span>
                <span className="truncate text-fg-3">{customer?.name ?? customer?.email ?? "Unknown visitor"}</span>
                <span className="text-faint">·</span>
                <span className="flex items-center gap-1 text-muted">
                  <Channel className="size-3" /> {CHANNEL_LABEL[ticket.channel] ?? ticket.channel}
                </span>
                {ticket.priority === "urgent" || ticket.priority === "high" ? (
                  <>
                    <span className="text-faint">·</span>
                    <span
                      className={ticket.priority === "urgent" ? "font-medium text-danger" : "font-medium text-warn"}
                    >
                      {ticket.priority === "urgent" ? "Urgent" : "High priority"}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Tip label="Customer & details">
                <button
                  onClick={() => setDetails(true)}
                  aria-label="Customer & details"
                  className="flex h-[26px] w-[26px] items-center justify-center border border-line bg-white/[0.02] text-dim outline-none hover:text-fg lg:hidden"
                >
                  <PanelRight className="size-[13px]" />
                </button>
              </Tip>
              <Menu>
                <Tip label="Assign">
                  <MenuTrigger className="flex h-[26px] w-[26px] items-center justify-center border border-line bg-white/[0.02] text-dim outline-none hover:text-fg">
                    {data.assignee ? (
                      <Avatar name={data.assignee.name} size={18} />
                    ) : (
                      <UserRoundPlus className="size-[13px]" />
                    )}
                  </MenuTrigger>
                </Tip>
                <MenuContent>
                  <MenuLabel>Assign to</MenuLabel>
                  {boot.members.map((m) => (
                    <MenuItem key={m.id} onSelect={() => actions.update.mutate({ assigneeId: m.id })}>
                      <Avatar name={m.name} size={16} /> {m.name}
                    </MenuItem>
                  ))}
                  <MenuSeparator />
                  <MenuItem onSelect={() => actions.update.mutate({ assigneeId: null })}>Unassign</MenuItem>
                </MenuContent>
              </Menu>
              <Menu>
                <Tip label="More">
                  <MenuTrigger
                    aria-label="More"
                    className="flex h-[26px] w-[26px] items-center justify-center border border-line bg-white/[0.02] text-dim outline-none hover:text-fg"
                  >
                    <Ellipsis className="size-[13px]" />
                  </MenuTrigger>
                </Tip>
                <MenuContent>
                  {ticket.status === "pending" ? (
                    <MenuItem onSelect={() => actions.update.mutate({ status: "open" })}>
                      <Clock /> Mark open
                    </MenuItem>
                  ) : !resolved ? (
                    <MenuItem onSelect={() => actions.update.mutate({ status: "pending" })}>
                      <Clock /> Mark pending (waiting on customer)
                    </MenuItem>
                  ) : null}
                  {resolved ? null : (
                    <MenuItem onSelect={() => actions.update.mutate({ status: "closed" })}>
                      <CircleX /> Close without reply
                    </MenuItem>
                  )}
                  <MenuItem onSelect={() => setIssueMode("create")}>
                    <Bug /> Create issue
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem onSelect={() => actions.runAi.mutate()}>
                    <Sparkles /> Run {boot.settings.ai.agentName} again
                  </MenuItem>
                  <MenuItem
                    onSelect={() =>
                      actions.summarize.mutate(undefined, {
                        onSuccess: (r) =>
                          toast(r.offline ? "Summary (offline)" : "Summary updated", {
                            description: r.summary.slice(0, 300),
                          }),
                      })
                    }
                  >
                    <FileText /> Summarize conversation
                  </MenuItem>
                  <MenuItem
                    onSelect={() =>
                      actions.toArticle.mutate(undefined, {
                        onSuccess: ({ article }) => {
                          toast.success("Draft article created from this ticket");
                          navigate({ to: "/w/$slug/knowledge/$articleId", params: { slug, articleId: article.id } });
                        },
                      })
                    }
                  >
                    <BookPlus /> Turn into help article
                  </MenuItem>
                  {data.traces.length ? (
                    <MenuItem onSelect={() => setWaterfall(true)}>
                      <ListTree /> View full trace
                    </MenuItem>
                  ) : null}
                </MenuContent>
              </Menu>
              {resolved ? (
                <Button size="sm" className="h-[26px]" onClick={() => actions.update.mutate({ status: "open" })}>
                  <RotateCcw /> Reopen
                </Button>
              ) : (
                <Button size="sm" className="h-[26px]" onClick={() => actions.update.mutate({ status: "resolved" })}>
                  <CircleCheck /> Resolve
                </Button>
              )}
            </div>
          </div>
          <FactChips data={data} />
        </header>

        <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-4 md:p-5">
          {messages.map((m, i) => (
            <React.Fragment key={m.id}>
              {i === 0 || dayKey(messages[i - 1]!.createdAt) !== dayKey(m.createdAt) ? (
                <DayDivider date={m.createdAt} />
              ) : null}
              <MessageItem m={m} />
              {m.id === analysisAfter && latestTrace ? (
                <div className={OURS}>
                  <TraceAnalysis spans={latestTrace.spans} agentName={boot.settings.ai.agentName} />
                </div>
              ) : null}
            </React.Fragment>
          ))}
          <TicketActionRuns runs={data.runs} />
          {ticket.aiState === "processing" ? (
            <div className={OURS}>
              <Thinking name={boot.settings.ai.agentName} />
            </div>
          ) : null}
          {draft && ticket.aiState !== "processing" ? (
            <DraftCard
              className={OURS}
              draft={draft}
              ticketId={ticket.id}
              escalated={ticket.aiState === "escalated"}
              onEdit={() => composer.current?.load(draft.body)}
            />
          ) : null}
        </div>
        <Composer ref={composer} ticket={ticket} draft={draft} customerName={customer?.name} />
      </section>
      {/* Below lg the panel slides over the conversation on demand. */}
      {details ? <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={() => setDetails(false)} /> : null}
      <div
        className={cn(
          "flex max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-50 max-lg:max-w-[88vw] max-lg:shadow-2xl max-lg:shadow-black/60",
          !details && "max-lg:hidden",
        )}
      >
        <ContextPanel data={data} onIssue={setIssueMode} />
      </div>
      {latestTrace ? <TraceWaterfall open={waterfall} onOpenChange={setWaterfall} spans={latestTrace.spans} /> : null}
      <CreateIssueDialog data={data} mode={issueMode} onClose={() => setIssueMode(null)} />
    </div>
  );
}

function Thinking({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-2.5 border border-accent/25 bg-accent/[0.05] px-3.5 py-3">
      <Sparkles className="size-[13px] animate-pulse text-accent-text" />
      <span className="font-mono text-[11.5px] tracking-wide text-accent-text">
        {name} is reading the conversation, searching your knowledge base and past tickets…
      </span>
    </div>
  );
}

const dayKey = (iso: string) => new Date(iso).toDateString();

function DayDivider({ date }: { date: string }) {
  const d = new Date(date);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const label =
    d.toDateString() === today.toDateString()
      ? "Today"
      : d.toDateString() === yesterday.toDateString()
        ? "Yesterday"
        : d.toLocaleDateString([], {
            weekday: "short",
            month: "short",
            day: "numeric",
            year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
          });
  return (
    <div className="flex items-center gap-3 pt-1 text-[11.5px] text-dim">
      <span className="h-px flex-1 bg-line-2" />
      {label}
      <span className="h-px flex-1 bg-line-2" />
    </div>
  );
}

/**
 * Customer messages sit on the left, everything from your side (team replies, AI replies, notes, drafts) on
 * the right, each with its own color: neutral for the customer, blue for teammates, purple for the AI,
 * amber for internal notes. You can tell who said what without reading the names.
 */
const OURS = "@2xl:ml-16";
const THEIRS = "@2xl:mr-16";

const ROLE = {
  customer: { card: "border-line bg-white/[0.025]", rail: "", tag: "Customer", tagTone: "text-muted" },
  agent: {
    card: "border-line-strong bg-raised",
    rail: "border-l-2 border-l-info/70",
    tag: "Reply",
    tagTone: "text-info",
  },
  ai: {
    card: "border-accent/25 bg-accent/[0.05]",
    rail: "border-l-2 border-l-accent",
    tag: "AI reply",
    tagTone: "text-accent-text",
  },
  note: {
    card: "border-warn/25 bg-warn/[0.05]",
    rail: "border-l-2 border-l-warn/80",
    tag: "Internal note · team only",
    tagTone: "text-warn",
  },
} as const;

function MessageItem({ m }: { m: Message }) {
  const { boot, wid } = useWorkspace();
  if (m.kind === "event") {
    return (
      <div className={cn("flex items-center justify-center gap-2 py-0.5 text-[11.5px] text-dim", OURS)}>
        <span className="h-px w-4 bg-line-strong" />
        {m.body}
        <span className="text-faint">· {clock(m.createdAt)}</span>
        <span className="h-px w-4 bg-line-strong" />
      </div>
    );
  }
  if (m.meta.action)
    return (
      <div className={OURS}>
        <ActionNote m={m} />
      </div>
    );
  const isNote = m.kind === "note";
  const isAi = m.authorType === "ai";
  const isCustomer = m.authorType === "customer";
  const role = isNote ? ROLE.note : isAi ? ROLE.ai : isCustomer ? ROLE.customer : ROLE.agent;
  const name = m.authorName ?? (isAi ? boot.settings.ai.agentName : isCustomer ? "Customer" : "Agent");
  return (
    <article className={cn("flex flex-col gap-2 border p-3.5", role.card, role.rail, isCustomer ? THEIRS : OURS)}>
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {isAi ? (
          <span className="flex size-6 shrink-0 items-center justify-center bg-accent/15 text-accent-text">
            <Sparkles className="size-3" />
          </span>
        ) : (
          <Avatar name={name} size={24} tone={isCustomer ? "neutral" : "accent"} />
        )}
        <span className="text-[13px] font-semibold text-fg">{name}</span>
        <span className={cn("flex items-center gap-1 text-[12px] font-medium", role.tagTone)}>
          {isNote ? <Lock className="size-2.5" /> : null}
          {role.tag}
        </span>
        {m.meta.via && m.meta.via !== "web" && m.meta.via !== "ai" ? (
          <span className="text-[11.5px] text-dim">via {m.meta.via}</span>
        ) : null}
        {m.meta.delivery?.status === "failed" ? (
          <Tip label={m.meta.delivery.error ?? "Delivery failed"}>
            <span className="flex items-center gap-1 text-[11.5px] text-danger">
              <AlertTriangle className="size-3" /> not delivered
            </span>
          </Tip>
        ) : null}
        <Tip label={new Date(m.createdAt).toLocaleString()}>
          <span className="ml-auto text-[11.5px] text-dim tabular-nums">{clock(m.createdAt)}</span>
        </Tip>
      </header>
      <div
        className={cn("prose-trace text-[14px] leading-[1.6]", isCustomer ? "text-fg" : "text-fg-2")}
        dangerouslySetInnerHTML={{ __html: md(m.body) }}
      />
      {m.attachments.length ? (
        <div className="flex flex-wrap gap-1.5">
          {m.attachments.map((a) => (
            <a
              key={a.id}
              href={`/api/w/${wid}/attachments/${a.id}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 border border-line-strong px-2 py-1 text-[11.5px] text-muted hover:text-fg"
            >
              <Paperclip className="size-3" /> {a.name} <span className="text-dim">{bytes(a.size)}</span>
            </a>
          ))}
        </div>
      ) : null}
      {m.meta.sources?.length ? <Sources sources={m.meta.sources} /> : null}
    </article>
  );
}

function Sources({ sources }: { sources: NonNullable<Message["meta"]["sources"]> }) {
  return <SourceChips sources={sources} />;
}

function DraftCard({
  draft,
  ticketId,
  escalated,
  onEdit,
  className,
}: {
  draft: Draft;
  ticketId: string;
  escalated: boolean;
  onEdit: () => void;
  className?: string;
}) {
  const { sendDraft, discardDraft, runAi } = useTicketActions(ticketId);
  const pct = Math.round(draft.confidence * 100);
  const color = pct >= 80 ? "bg-accent" : pct >= 50 ? "bg-warn" : "bg-danger/70";
  return (
    <div className={cn("flex flex-col gap-3 border border-dashed border-accent/40 bg-accent/[0.03] p-3.5", className)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-[7px]">
          <PenLine className="size-[13px] text-accent-text" />
          <span className="text-[12px] font-semibold text-[#e8e8ef]">
            {escalated ? "Suggested reply for the human" : "Suggested reply"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] tracking-[0.08em] text-dim">CONFIDENCE {pct}%</span>
          <span className="h-1 w-14 bg-white/[0.08]">
            <span className={cn("block h-full", color)} style={{ width: `${pct}%` }} />
          </span>
        </div>
      </div>
      <div
        className="prose-trace text-[13px] leading-[1.65] text-fg-3"
        dangerouslySetInnerHTML={{ __html: md(draft.body) }}
      />
      {draft.sources.length ? <Sources sources={draft.sources} /> : null}
      <div className="flex items-center justify-between gap-3 pt-0.5">
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            className="h-[30px] px-3.5"
            loading={sendDraft.isPending}
            onClick={() => sendDraft.mutate(undefined)}
          >
            Send reply
          </Button>
          <Button size="sm" className="h-[30px] px-3.5" onClick={onEdit}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-[30px]"
            loading={runAi.isPending}
            onClick={() => runAi.mutate()}
          >
            <RefreshCw /> Regenerate
          </Button>
          <Tip label="Discard draft">
            <Button variant="ghost" size="sm" className="h-[30px] px-2" onClick={() => discardDraft.mutate()}>
              <Trash2 />
            </Button>
          </Tip>
        </div>
        <span className="truncate font-mono text-[11px] text-dim">
          grounded in {draft.sources.length} source{draft.sources.length === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}
