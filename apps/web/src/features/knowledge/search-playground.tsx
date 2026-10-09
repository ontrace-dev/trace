import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, Lock, Search, Sparkles } from "lucide-react";
import * as React from "react";
import { Badge, Empty, Spinner, Switch } from "@/components/ui";
import { md } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { kqk } from "./sources-panel";
import { type KnowledgeHit, ORIGIN_ICON, ORIGIN_LABEL } from "./types";

const EXAMPLES = [
  "I was charged twice for my invoice",
  "Wie exportiere ich meine Tickets?",
  "okta login keeps looping",
  "API returns 429",
];

/** Ask a question and see exactly what the agent's search_knowledge_base tool would retrieve. */
export function SearchPlayground() {
  const { api, wid, slug } = useWorkspace();
  const [q, setQ] = React.useState("");
  const [deb, setDeb] = React.useState("");
  const [internal, setInternal] = React.useState(true);
  React.useEffect(() => {
    const t = setTimeout(() => setDeb(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const search = useQuery({
    queryKey: kqk.search(wid, deb, internal),
    enabled: deb.length > 1,
    queryFn: () =>
      api<{ hits: KnowledgeHit[]; tookMs: number }>(
        `/knowledge/search?q=${encodeURIComponent(deb)}&internal=${internal}`,
      ),
  });
  const hits = search.data?.hits ?? [];
  const max = Math.max(...hits.map((h) => h.score), 0.0001);

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-3 border-b border-line px-5 py-4">
        <div className="flex h-10 items-center gap-2.5 border border-line-strong bg-input px-3 focus-within:border-accent/50">
          <Sparkles className="size-3.5 text-accent-text" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Ask like a customer would — in any language"
            className="flex-1 bg-transparent text-[13.5px] text-fg placeholder:text-dim focus:outline-none focus-visible:outline-none"
          />
          {search.isFetching ? <Spinner className="size-3.5" /> : <Search className="size-3.5 text-dim" />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              onClick={() => setQ(e)}
              className="border border-line px-2 py-0.5 font-mono text-[11.5px] text-dim hover:border-line-strong hover:text-fg-3"
            >
              {e}
            </button>
          ))}
          <label className="ml-auto flex items-center gap-2 text-[11.5px] text-muted">
            Include internal sources
            <Switch checked={internal} onCheckedChange={setInternal} />
          </label>
        </div>
        <p className="text-[11.5px] text-dim">
          This is exactly what the AI agent's knowledge search returns: semantic + keyword ranking fused, grouped per
          document, best passages shown.
          {search.data ? (
            <span className="ml-1 font-mono">
              · {hits.length} hits in {search.data.tookMs}ms
            </span>
          ) : null}
        </p>
      </div>
      {deb.length <= 1 ? (
        <Empty icon={<Search />} title="Test retrieval">
          Type a question to see which articles, pages and issues the agent would read before answering.
        </Empty>
      ) : search.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : !hits.length ? (
        <Empty icon={<Search />} title="Nothing relevant found">
          Connect more sources or write an article covering this question — it's a content gap.
        </Empty>
      ) : (
        hits.map((h, i) => {
          const Icon = ORIGIN_ICON[h.origin] ?? Search;
          return (
            <div key={h.documentId} className="flex gap-4 border-b border-line-2 px-5 py-4">
              <span className="w-5 shrink-0 pt-0.5 text-right font-mono text-[11px] text-dim">{i + 1}</span>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Icon className="size-3.5 shrink-0 text-dim" />
                  {h.articleId ? (
                    <Link
                      to="/w/$slug/knowledge/$articleId"
                      params={{ slug, articleId: h.articleId }}
                      className="truncate text-[13.5px] font-medium text-fg-2 hover:text-fg"
                    >
                      {h.title}
                    </Link>
                  ) : h.url ? (
                    <a
                      href={h.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-w-0 items-center gap-1.5 text-[13.5px] font-medium text-fg-2 hover:text-fg"
                    >
                      <span className="truncate">{h.title}</span> <ExternalLink className="size-3 shrink-0 text-dim" />
                    </a>
                  ) : (
                    <span className="truncate text-[13.5px] font-medium text-fg-2">{h.title}</span>
                  )}
                  <Badge>{ORIGIN_LABEL[h.origin] ?? h.origin}</Badge>
                  {h.visibility === "internal" ? (
                    <Badge tone="warn">
                      <Lock className="size-2.5" /> internal
                    </Badge>
                  ) : null}
                  {typeof h.metadata.status === "string" ? <Badge tone="info">{h.metadata.status}</Badge> : null}
                </div>
                <div
                  className="prose-trace line-clamp-6 text-[12.5px] text-muted [&_h1]:my-1 [&_h1]:text-[12.5px] [&_h2]:my-1 [&_h2]:text-[12.5px] [&_h3]:my-1 [&_h3]:text-[12.5px] [&_p]:mb-1.5"
                  dangerouslySetInnerHTML={{ __html: md(h.content.slice(0, 1400)) }}
                />
              </div>
              <div className="flex w-20 shrink-0 flex-col items-end gap-1.5 pt-1">
                <span className="font-mono text-[11.5px] text-fg-3">{h.score.toFixed(3)}</span>
                <span className="h-1 w-full bg-white/[0.06]">
                  <span className="block h-full bg-accent" style={{ width: `${(h.score / max) * 100}%` }} />
                </span>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
