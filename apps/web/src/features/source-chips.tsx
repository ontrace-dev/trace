import { useNavigate } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import type { Source } from "@/lib/types";
import { useWorkspace } from "@/lib/workspace";

const prefix = (s: Source) => (s.type === "article" ? "kb/" : s.type === "ticket" ? "#" : `${s.origin ?? "doc"}/`);

/** Citations on AI replies and drafts: help articles, past tickets and synced documents. */
export function SourceChips({
  sources,
  label = "sources",
  onNavigate,
}: {
  sources: Source[];
  label?: string;
  onNavigate?: () => void;
}) {
  const { slug } = useWorkspace();
  const navigate = useNavigate();
  const open = (s: Source) => {
    onNavigate?.();
    if (s.type === "article") navigate({ to: "/w/$slug/knowledge/$articleId", params: { slug, articleId: s.id } });
    else if (s.type === "ticket")
      navigate({ to: "/w/$slug/inbox/$view/$ticket", params: { slug, view: "all", ticket: s.id } });
    else if (s.url) window.open(s.url, "_blank", "noopener");
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      {label ? <span className="font-mono text-[11px] text-dim">{label}</span> : null}
      {sources.map((s) => (
        <button
          key={`${s.type}:${s.id}`}
          onClick={() => open(s)}
          title={
            s.visibility === "internal"
              ? "Internal source — used as context, never shown to the customer"
              : (s.url ?? s.title)
          }
          className="flex max-w-[260px] items-center gap-1 truncate border border-line-strong px-1.5 py-[1px] font-mono text-[11px] text-muted hover:border-accent/40 hover:text-fg"
        >
          {s.visibility === "internal" ? <Lock className="size-2.5 shrink-0 text-warn" /> : null}
          <span className="truncate">
            {prefix(s)}
            {s.title}
          </span>
        </button>
      ))}
    </div>
  );
}
