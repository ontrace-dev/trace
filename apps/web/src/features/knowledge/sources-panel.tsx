import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Database,
  ExternalLink,
  Eye,
  FileUp,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Dialog,
  Empty,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Spinner,
  Tip,
} from "@/components/ui";
import { ago, cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { SourceDialog } from "./source-dialog";
import { type KnowledgeDocumentRow, type KnowledgeSource, type KnowledgeStatus, SOURCE_META } from "./types";
import { useConfirm } from "@/components/ui/confirm";

export const kqk = {
  sources: (wid: string) => ["knowledge", wid, "sources"] as const,
  status: (wid: string) => ["knowledge", wid, "status"] as const,
  docs: (wid: string, sourceId: string, q: string) => ["knowledge", wid, "docs", sourceId, q] as const,
  search: (wid: string, q: string, internal: boolean) => ["knowledge", wid, "search", q, internal] as const,
};

export function useKnowledgeStatus() {
  const { api, wid } = useWorkspace();
  return useQuery({
    queryKey: kqk.status(wid),
    queryFn: () => api<KnowledgeStatus>("/knowledge/status"),
    refetchInterval: (q) => (q.state.data?.embeddings.status === "loading" ? 4000 : 30_000),
  });
}

/** Unobtrusive indicator for the local embedding model. */
export function EmbeddingStatus() {
  const status = useKnowledgeStatus();
  const e = status.data?.embeddings;
  if (!e) return null;
  const pending = status.data!.chunks.total - status.data!.chunks.embedded;
  const label =
    e.status === "ready"
      ? pending > 0
        ? `embedding ${pending} passages…`
        : "semantic search on"
      : e.status === "loading"
        ? "loading embedding model…"
        : e.status === "off"
          ? "keyword search only"
          : "embeddings unavailable";
  return (
    <Tip
      label={
        e.status === "error"
          ? `Falling back to keyword search: ${e.error}`
          : e.status === "off"
            ? "EMBEDDINGS=off — set it to on for semantic, cross-language search"
            : `${e.model} · runs locally · ${status.data!.chunks.embedded}/${status.data!.chunks.total} passages embedded`
      }
    >
      <span className="flex items-center gap-1.5 font-mono text-[11px] whitespace-nowrap text-dim max-sm:hidden">
        <span
          className={cn(
            "h-1.5 w-1.5",
            e.status === "ready" && pending <= 0
              ? "bg-ok"
              : e.status === "error"
                ? "bg-danger"
                : e.status === "off"
                  ? "bg-dim"
                  : "animate-pulse bg-warn",
          )}
        />
        {label}
      </span>
    </Tip>
  );
}

export function SourcesPanel({
  addOpen,
  onAddOpenChange,
}: {
  addOpen: boolean;
  onAddOpenChange: (v: boolean) => void;
}) {
  const { api, wid, isAdmin } = useWorkspace();
  const sources = useQuery({
    queryKey: kqk.sources(wid),
    queryFn: () => api<{ sources: KnowledgeSource[] }>("/knowledge/sources"),
    refetchInterval: (q) => (q.state.data?.sources.some((s) => s.syncing || s.status === "syncing") ? 2500 : false),
  });
  const status = useKnowledgeStatus();
  const articles = status.data?.byOrigin.find((o) => o.origin === "article")?.documents ?? 0;
  const list = sources.data?.sources ?? [];

  return (
    <div className="flex flex-col">
      <div className="border-b border-line bg-accent/[0.04] px-5 py-2.5 text-[12px] leading-relaxed text-muted">
        Connected knowledge is chunked and embedded <span className="text-fg-3">locally</span>, then searched by meaning
        and keywords — a German question finds an English page. <span className="text-fg-3">Public</span> sources can be
        quoted to customers; <span className="text-fg-3">internal</span> ones (like Jira) are context only. Your{" "}
        {articles} published articles are always included.
      </div>
      {sources.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : !list.length ? (
        <Empty icon={<Database />} title="No sources connected yet">
          Connect your docs site, Confluence spaces, Notion pages, Zendesk Help Center or Jira — or upload PDFs.
          {isAdmin ? (
            <div className="mt-4">
              <Button variant="primary" size="sm" onClick={() => onAddOpenChange(true)}>
                <Plus /> Add source
              </Button>
            </div>
          ) : null}
        </Empty>
      ) : (
        <div className="grid gap-px bg-line xl:grid-cols-2">
          {list.map((s) => (
            <SourceCard key={s.id} source={s} />
          ))}
          {list.length % 2 === 1 ? <div className="hidden bg-bg xl:block" /> : null}
        </div>
      )}
      <SourceDialog open={addOpen} onOpenChange={onAddOpenChange} />
    </div>
  );
}

function SourceCard({ source: s }: { source: KnowledgeSource }) {
  const confirm = useConfirm();
  const { api, wid, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const [edit, setEdit] = React.useState(false);
  const [docs, setDocs] = React.useState(false);
  const [drag, setDrag] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const meta = SOURCE_META[s.type];
  const syncing = s.syncing || s.status === "syncing";
  const refresh = () => qc.invalidateQueries({ queryKey: ["knowledge", wid] });

  const sync = useMutation({
    mutationFn: () => api(`/knowledge/sources/${s.id}/sync`, { method: "POST" }),
    onSuccess: refresh,
    onError: (e) => toast.error((e as Error).message),
  });
  const toggle = useMutation({
    mutationFn: () => api(`/knowledge/sources/${s.id}`, { method: "PATCH", json: { enabled: !s.enabled } }),
    onSuccess: refresh,
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api(`/knowledge/sources/${s.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Removed ${s.name} and its documents`);
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const upload = useMutation({
    mutationFn: async (files: FileList | File[]) => {
      const form = new FormData();
      for (const f of Array.from(files)) form.append("file", f);
      const res = await fetch(`/api/w/${wid}/knowledge/sources/${s.id}/files`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      const data = (await res.json()) as { results?: { name: string; ok: boolean; error?: string }[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      return data.results ?? [];
    },
    onSuccess: (results) => {
      const ok = results.filter((r) => r.ok).length;
      if (ok) toast.success(`${ok} file${ok === 1 ? "" : "s"} indexed`);
      for (const r of results.filter((x) => !x.ok)) toast.error(r.error ?? `${r.name} failed`);
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const isFiles = s.type === "files";
  const statusTone = !s.enabled
    ? "neutral"
    : syncing
      ? "accent"
      : s.status === "error"
        ? "danger"
        : s.status === "ready"
          ? "ok"
          : "neutral";
  const statusLabel = !s.enabled ? "paused" : syncing ? "syncing" : s.status === "idle" ? "queued" : s.status;
  const detail =
    (s.config as { url?: string; baseUrl?: string; subdomain?: string }).url ??
    (s.config as { baseUrl?: string }).baseUrl ??
    ((s.config as { subdomain?: string }).subdomain
      ? `${(s.config as { subdomain?: string }).subdomain}.zendesk.com`
      : null);

  return (
    <div
      className={cn("relative flex flex-col gap-3 bg-bg p-5", !s.enabled && "opacity-60", drag && "bg-accent/[0.06]")}
      onDragOver={(e) => {
        if (!isFiles || !isAdmin) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        if (!isFiles || !isAdmin) return;
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files.length) upload.mutate(e.dataTransfer.files);
      }}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-line-strong bg-white/[0.03] text-fg-3">
          <meta.icon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium text-fg">{s.name}</span>
            <Tip
              label={
                s.visibility === "public"
                  ? "Public: the agent may quote and cite it to customers"
                  : "Internal: context for the agent only — never quoted or linked to customers"
              }
            >
              <span>
                <Badge tone={s.visibility === "public" ? "neutral" : "warn"}>
                  {s.visibility === "public" ? <Eye className="size-2.5" /> : <Lock className="size-2.5" />}
                  {s.visibility}
                </Badge>
              </span>
            </Tip>
          </div>
          <span className="truncate font-mono text-[11.5px] text-dim">
            {meta.label}
            {detail ? ` · ${detail}` : ""}
          </span>
        </div>
        {isAdmin ? (
          <Menu>
            <MenuTrigger className="p-1 text-dim outline-none hover:text-fg">
              <MoreHorizontal className="size-4" />
            </MenuTrigger>
            <MenuContent>
              {!isFiles ? (
                <MenuItem onSelect={() => sync.mutate()}>
                  <RefreshCw /> Sync now
                </MenuItem>
              ) : (
                <MenuItem onSelect={() => fileRef.current?.click()}>
                  <FileUp /> Upload files
                </MenuItem>
              )}
              <MenuItem onSelect={() => setDocs(true)}>
                <Database /> Browse documents
              </MenuItem>
              <MenuItem onSelect={() => setEdit(true)}>
                <Pencil /> Edit
              </MenuItem>
              <MenuItem onSelect={() => toggle.mutate()}>
                <Power /> {s.enabled ? "Pause" : "Resume"}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                destructive
                onSelect={async () =>
                  (await confirm({
                    title: "Remove knowledge source?",
                    description: `"${s.name}" and its ${s.documentCount} synced documents will be removed. The agent stops using them immediately.`,
                    confirmLabel: "Remove",
                    destructive: true,
                  })) && remove.mutate()
                }
              >
                <Trash2 /> Remove
              </MenuItem>
            </MenuContent>
          </Menu>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        <Badge tone={statusTone as "ok"} upper className={syncing ? "animate-pulse" : ""}>
          {statusLabel}
        </Badge>
        <button onClick={() => setDocs(true)} className="font-mono text-[11px] text-fg-3 hover:text-fg">
          {s.documentCount.toLocaleString()} document{s.documentCount === 1 ? "" : "s"}
        </button>
        <span className="font-mono text-[11.5px] text-dim">
          {s.lastSyncedAt ? `${isFiles ? "updated" : "synced"} ${ago(s.lastSyncedAt)} ago` : "never synced"}
        </span>
        {!isFiles && isAdmin ? (
          <Button
            size="sm"
            className="ml-auto"
            loading={sync.isPending}
            disabled={syncing || !s.enabled}
            onClick={() => sync.mutate()}
          >
            <RefreshCw className={syncing ? "animate-spin" : ""} /> {syncing ? "Syncing" : "Sync now"}
          </Button>
        ) : null}
      </div>
      {s.statusMessage ? (
        <p className={cn("text-[11.5px] leading-relaxed", s.status === "error" ? "text-danger" : "text-dim")}>
          {s.statusMessage}
        </p>
      ) : null}

      {isFiles && isAdmin ? (
        <button
          onClick={() => fileRef.current?.click()}
          className={cn(
            "flex items-center justify-center gap-2 border border-dashed px-3 py-4 text-[12px]",
            drag ? "border-accent/60 text-accent-fg" : "border-line-strong text-dim hover:text-fg-3",
          )}
        >
          {upload.isPending ? <Spinner className="size-3.5" /> : <FileUp className="size-3.5" />}
          {upload.isPending ? "Indexing…" : "Drop PDF, Markdown, text or HTML files — or click to upload"}
        </button>
      ) : null}
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        accept=".pdf,.md,.markdown,.txt,.html,.htm"
        onChange={(e) => {
          if (e.target.files?.length) upload.mutate(e.target.files);
          e.target.value = "";
        }}
      />
      <SourceDialog open={edit} onOpenChange={setEdit} source={s} />
      <DocumentsDialog open={docs} onOpenChange={setDocs} source={s} />
    </div>
  );
}

function DocumentsDialog({
  open,
  onOpenChange,
  source,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  source: KnowledgeSource;
}) {
  const { api, wid, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const [q, setQ] = React.useState("");
  const [deb, setDeb] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDeb(q), 200);
    return () => clearTimeout(t);
  }, [q]);
  const docs = useInfiniteQuery({
    queryKey: kqk.docs(wid, source.id, deb),
    enabled: open,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api<{ documents: KnowledgeDocumentRow[]; nextCursor: string | null }>(
        `/knowledge/sources/${source.id}/documents?${new URLSearchParams({ ...(deb ? { q: deb } : {}), ...(pageParam ? { cursor: pageParam } : {}) })}`,
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/knowledge/documents/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge", wid] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const rows = docs.data?.pages.flatMap((p) => p.documents) ?? [];
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${source.name} · documents`}
      description={
        source.type === "website"
          ? "Pages are re-crawled on every sync; removed pages disappear automatically."
          : "Synced documents and how many searchable passages each produced."
      }
      className="w-[min(760px,calc(100vw-32px))]"
    >
      <div className="-mx-5 -my-4 flex flex-col">
        <div className="flex h-9 items-center gap-2 border-b border-line px-5">
          <Search className="size-3 text-dim" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by title or URL"
            className="flex-1 bg-transparent text-[12px] text-fg placeholder:text-dim focus:outline-none"
          />
        </div>
        {docs.isPending ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : !rows.length ? (
          <div className="px-5 py-8 text-center text-xs text-dim">{deb ? "No matches." : "No documents yet."}</div>
        ) : (
          rows.map((d) => (
            <div key={d.id} className="group flex items-center gap-3 border-b border-line-2 px-5 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[12.5px] text-fg-2">{d.title}</span>
                <span className="truncate font-mono text-[11px] text-dim">
                  {typeof d.metadata.status === "string" ? `${d.metadata.status} · ` : ""}
                  {d.chunks} passage{d.chunks === 1 ? "" : "s"} · {Math.round(d.chars / 100) / 10}k chars ·{" "}
                  {ago(d.externalUpdatedAt ?? d.updatedAt)} ago
                  {d.url ? ` · ${d.url.replace(/^https?:\/\//, "")}` : ""}
                </span>
              </div>
              {d.url ? (
                <a href={d.url} target="_blank" rel="noreferrer" className="text-dim hover:text-fg">
                  <ExternalLink className="size-3.5" />
                </a>
              ) : null}
              {isAdmin ? (
                <button
                  onClick={() => del.mutate(d.id)}
                  className="text-dim opacity-0 group-hover:opacity-100 hover:text-danger"
                  title="Remove from index"
                >
                  <Trash2 className="size-3.5" />
                </button>
              ) : null}
            </div>
          ))
        )}
        {docs.hasNextPage ? (
          <div className="flex justify-center py-3">
            <Button size="sm" variant="ghost" loading={docs.isFetchingNextPage} onClick={() => docs.fetchNextPage()}>
              Load more
            </Button>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
