import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, BookOpen, Eye, Pencil, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { PageHeader } from "./customers";
import { Badge, Button, Empty, Input, Segmented, Spinner } from "@/components/ui";
import type { Article } from "@/lib/types";
import { ago, cn, md } from "@/lib/utils";
import { qk, useWorkspace } from "@/lib/workspace";
import { SearchPlayground } from "@/features/knowledge/search-playground";
import { EmbeddingStatus, SourcesPanel } from "@/features/knowledge/sources-panel";
import { useConfirm } from "@/components/ui/confirm";

type Tab = "articles" | "sources" | "search";
const TABS: Tab[] = ["articles", "sources", "search"];

function initialTab(): Tab {
  const t = new URLSearchParams(location.search).get("tab");
  return TABS.includes(t as Tab) ? (t as Tab) : "articles";
}

/** Knowledge: help articles, connected sources (websites, Confluence, Jira, Notion, Zendesk, files) and a retrieval playground. */
export function KnowledgePage() {
  const { isAdmin } = useWorkspace();
  const [tab, setTabState] = React.useState<Tab>(initialTab);
  const [addSource, setAddSource] = React.useState(false);
  const setTab = (t: Tab) => {
    setTabState(t);
    const url = new URL(location.href);
    if (t === "articles") url.searchParams.delete("tab");
    else url.searchParams.set("tab", t);
    history.replaceState(history.state, "", url);
  };
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Knowledge">
        <EmbeddingStatus />
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "articles", label: "Articles" },
            { value: "sources", label: "Sources" },
            { value: "search", label: "Search playground" },
          ]}
        />
        {tab === "sources" && isAdmin ? (
          <Button variant="primary" size="sm" onClick={() => setAddSource(true)}>
            <Plus /> Add source
          </Button>
        ) : null}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "articles" ? (
          <ArticlesTab />
        ) : tab === "sources" ? (
          <SourcesPanel addOpen={addSource} onAddOpenChange={setAddSource} />
        ) : (
          <SearchPlayground />
        )}
      </div>
    </div>
  );
}

function ArticlesTab() {
  const { api, wid, slug } = useWorkspace();
  const [q, setQ] = React.useState("");
  const [filter, setFilter] = React.useState<"all" | "published" | "draft">("all");
  const navigate = useNavigate();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: qk.articles(wid, q),
    queryFn: () => api<{ articles: Article[] }>(`/articles${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  });
  const create = useMutation({
    mutationFn: () =>
      api<{ article: Article }>("/articles", { method: "POST", json: { title: "Untitled article", body: "" } }),
    onSuccess: ({ article }) => {
      qc.invalidateQueries({ queryKey: ["articles", wid] });
      navigate({ to: "/w/$slug/knowledge/$articleId", params: { slug, articleId: article.id } });
    },
  });
  const rows = (list.data?.articles ?? []).filter((a) => filter === "all" || a.status === filter);
  const live = list.data?.articles.filter((a) => a.status === "published").length ?? 0;
  return (
    <div className="flex flex-col">
      <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-line px-4 py-2 md:px-5">
        <span className="mr-auto font-mono text-[11px] whitespace-nowrap text-dim">{live} live</span>
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "published", label: "Published" },
            { value: "draft", label: "Drafts" },
          ]}
        />
        <div className="flex h-7 items-center gap-2 border border-line-strong bg-input px-2">
          <Search className="size-3 text-dim" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search articles"
            className="w-44 bg-transparent text-[12px] text-fg placeholder:text-dim focus:outline-none"
          />
        </div>
        <Button variant="primary" size="sm" loading={create.isPending} onClick={() => create.mutate()}>
          <Plus /> New article
        </Button>
      </div>
      <div className="border-b border-line bg-accent/[0.04] px-5 py-2.5 text-[12px] text-muted">
        <Sparkles className="mr-1.5 inline size-3 text-accent-text" />
        The AI agent answers from <span className="text-fg-3">published</span> articles and connected sources, and cites
        them. Turn any resolved ticket into a draft article from its <span className="font-mono text-[11px]">⋯</span>{" "}
        menu.
      </div>
      {list.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : !rows.length ? (
        <Empty icon={<BookOpen />} title="No articles yet">
          Write your first help article — refunds, password resets, plans. The agent will start citing it immediately.
        </Empty>
      ) : (
        rows.map((a) => (
          <Link
            key={a.id}
            to="/w/$slug/knowledge/$articleId"
            params={{ slug, articleId: a.id }}
            className="flex items-start gap-4 border-b border-line-2 px-5 py-3.5 hover:bg-white/[0.02]"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13.5px] font-medium text-fg-2">{a.title}</span>
                {a.source === "ai" ? <Badge tone="solid-accent">ai-authored</Badge> : null}
              </div>
              <span className="line-clamp-1 text-[12px] text-dim">{a.excerpt?.replace(/[#*`]/g, "")}</span>
              {a.tags.length ? (
                <div className="flex gap-1.5 pt-0.5">
                  {a.tags.map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <Badge tone={a.status === "published" ? "ok" : "neutral"} upper>
                {a.status}
              </Badge>
              <span className="font-mono text-[11px] text-dim">
                cited {a.citations}× · {ago(a.updatedAt)}
              </span>
            </div>
          </Link>
        ))
      )}
    </div>
  );
}

export function ArticleEditor() {
  const confirm = useConfirm();
  const { articleId } = useParams({ from: "/w/$slug/knowledge/$articleId" });
  const { api, wid, slug } = useWorkspace();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: qk.article(wid, articleId),
    queryFn: () => api<{ article: Article }>(`/articles/${articleId}`),
  });
  const [draft, setDraft] = React.useState<Pick<Article, "title" | "body" | "status" | "tags"> | null>(null);
  const [tab, setTab] = React.useState<"write" | "preview">("write");
  React.useEffect(() => {
    if (q.data)
      setDraft({
        title: q.data.article.title,
        body: q.data.article.body,
        status: q.data.article.status,
        tags: q.data.article.tags,
      });
  }, [q.data]);
  const save = useMutation({
    mutationFn: (patch: Partial<Article>) => api(`/articles/${articleId}`, { method: "PATCH", json: patch }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["articles", wid] });
      qc.invalidateQueries({ queryKey: qk.article(wid, articleId) });
      toast.success("Saved");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({
    mutationFn: () => api(`/articles/${articleId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["articles", wid] });
      navigate({ to: "/w/$slug/knowledge", params: { slug } });
    },
  });
  if (q.isPending || !draft)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  const a = q.data!.article;
  const dirty = draft.title !== a.title || draft.body !== a.body || draft.tags.join() !== a.tags.join();
  return (
    <div className="flex h-full flex-col">
      <PageHeader title={a.status === "published" ? "Published article" : "Draft article"}>
        <Link
          to="/w/$slug/knowledge"
          params={{ slug }}
          className="mr-2 flex items-center gap-1.5 text-xs text-muted hover:text-fg"
        >
          <ArrowLeft className="size-3" /> Articles
        </Link>
        <Button
          variant="ghost"
          size="sm"
          onClick={async () =>
            (await confirm({
              title: "Delete article?",
              description: "It's removed from the knowledge base and the agent stops citing it.",
              confirmLabel: "Delete",
              destructive: true,
            })) && del.mutate()
          }
        >
          <Trash2 />
        </Button>
        <Button
          size="sm"
          disabled={!dirty}
          loading={save.isPending}
          onClick={() => save.mutate({ title: draft.title, body: draft.body, tags: draft.tags })}
        >
          Save
        </Button>
        {a.status === "published" ? (
          <Button size="sm" onClick={() => save.mutate({ ...draft, status: "draft" })}>
            Unpublish
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={() => save.mutate({ ...draft, status: "published" })}>
            Publish
          </Button>
        )}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-6 py-8">
          {a.source === "ai" ? (
            <div className="flex items-center gap-2 border border-accent/25 bg-accent/[0.05] px-3 py-2 text-[12px] text-muted">
              <Sparkles className="size-3 text-accent-text" /> Drafted by AI from a resolved ticket — review before
              publishing.
            </div>
          ) : null}
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            className="bg-transparent text-[24px] font-semibold tracking-tight text-fg placeholder:text-dim focus:outline-none"
            placeholder="Article title"
          />
          <div className="flex items-center gap-3">
            <Input
              value={draft.tags.join(", ")}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  tags: e.target.value
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean),
                })
              }
              placeholder="tags, comma separated"
              className="h-7 max-w-xs font-mono text-[11.5px]"
            />
            <span className="ml-auto font-mono text-[11.5px] text-dim">
              {a.views} views · cited {a.citations}×
            </span>
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: "write", label: <Pencil className="size-3" /> },
                { value: "preview", label: <Eye className="size-3" /> },
              ]}
            />
          </div>
          {tab === "write" ? (
            <textarea
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              placeholder={"Write in markdown.\n\n## When does this happen?\n\n## How to fix it"}
              className={cn(
                "min-h-[55vh] w-full resize-none border border-line bg-cell p-4 font-mono text-[12.5px] leading-[1.7] text-fg-3 focus:border-accent/40 focus:outline-none",
              )}
            />
          ) : (
            <div
              className="prose-trace min-h-[55vh] border border-line bg-cell p-5 text-[13.5px]"
              dangerouslySetInnerHTML={{ __html: md(draft.body || "_Nothing yet._") }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
