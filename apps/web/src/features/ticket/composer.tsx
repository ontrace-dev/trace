import { useMutation, useQuery } from "@tanstack/react-query";
import { BookOpen, ChevronDown, Paperclip, Sparkles, Wand2, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import {
  Button,
  Kbd,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Segmented,
  Spinner,
  Tip,
} from "@/components/ui";
import type { Article, Attachment, Draft, Ticket } from "@/lib/types";
import { bytes, cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { useTicketActions } from "./use-ticket";

export interface ComposerHandle {
  load: (text: string) => void;
}

export const Composer = React.forwardRef<
  ComposerHandle,
  { ticket: Ticket; draft: Draft | null; customerName?: string | null }
>(function Composer({ ticket, draft, customerName }, ref) {
  const { api, boot } = useWorkspace();
  const [mode, setMode] = React.useState<"message" | "note">("message");
  const [text, setText] = React.useState("");
  const [files, setFiles] = React.useState<Attachment[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const { reply, sendDraft } = useTicketActions(ticket.id);
  const editingDraft = React.useRef(false);

  // Reset when switching tickets.
  React.useEffect(() => {
    setText("");
    setFiles([]);
    setMode("message");
    editingDraft.current = false;
  }, [ticket.id]);

  React.useImperativeHandle(ref, () => ({
    load: (t: string) => {
      setMode("message");
      setText(t);
      editingDraft.current = true;
      requestAnimationFrame(() => {
        taRef.current?.focus();
        taRef.current?.setSelectionRange(t.length, t.length);
      });
    },
  }));

  const rewrite = useMutation({
    mutationFn: (b: { mode: string; language?: string }) =>
      api<{ text: string; offline: boolean }>("/ai/rewrite", { method: "POST", json: { text, ...b } }),
    onSuccess: (r) => {
      if (r.offline) toast("AI rewrite needs an Anthropic key (Agent → Setup).");
      else setText(r.text);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const send = (status?: Ticket["status"]) => {
    if (!text.trim()) return;
    const body = text.trim();
    const done = () => {
      setText("");
      setFiles([]);
      editingDraft.current = false;
    };
    // Sending an (edited) AI draft goes through the draft endpoint so the trace records it.
    if (mode === "message" && editingDraft.current && draft && !files.length && !status) {
      sendDraft.mutate(body, { onSuccess: done });
      return;
    }
    reply.mutate({ body, kind: mode, attachments: files, status }, { onSuccess: done });
  };

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    const form = new FormData();
    for (const f of Array.from(list)) form.append("file", f);
    setUploading(true);
    try {
      const res = await fetch(`/api/w/${ticket.orgId}/uploads`, { method: "POST", body: form, credentials: "include" });
      const data = (await res.json()) as { attachments?: Attachment[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      setFiles((f) => [...f, ...(data.attachments ?? [])]);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab" && !e.shiftKey && !text && draft && mode === "message") {
      e.preventDefault();
      setText(draft.body);
      editingDraft.current = true;
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send(e.shiftKey ? "resolved" : undefined);
    }
  };

  const isNote = mode === "note";
  const busy = reply.isPending || sendDraft.isPending;
  const channelHint =
    ticket.channel === "email"
      ? "via email"
      : ticket.channel === "widget"
        ? "via chat widget"
        : ticket.channel === "slack"
          ? "via Slack"
          : ticket.channel === "discord"
            ? "via Discord"
            : ticket.channel === "api"
              ? "via API"
              : "";

  return (
    <div
      className={cn("flex shrink-0 flex-col gap-2.5 border-t border-line bg-bar p-4", isNote && "bg-[#16150f]")}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        upload(e.dataTransfer.files);
      }}
    >
      <div className="flex items-center justify-between">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "message", label: "Reply" },
            { value: "note", label: "Internal note" },
          ]}
        />
        <span className="font-mono text-[11px] text-dim">
          {isNote ? "only visible to your team" : `to ${customerName ?? "customer"} ${channelHint}`}
        </span>
      </div>
      <div
        className={cn(
          "flex flex-col border bg-input",
          isNote ? "border-warn/30" : "border-line-strong focus-within:border-accent/50",
        )}
      >
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              upload(e.clipboardData.files);
            }
          }}
          rows={Math.min(14, Math.max(3, text.split("\n").length + 1))}
          placeholder={
            isNote
              ? "Write a note for your team — @mention not required, everyone sees it"
              : draft
                ? `Write a reply — or press ⇥ to accept ${boot.settings.ai.agentName}'s draft`
                : "Write a reply…"
          }
          className="w-full resize-none bg-transparent px-3 py-2.5 text-[13px] leading-relaxed text-fg placeholder:text-dim focus:outline-none"
        />
        {files.length ? (
          <div className="flex flex-wrap gap-1.5 px-3 pb-2.5">
            {files.map((f) => (
              <span
                key={f.id}
                className="flex items-center gap-1.5 border border-line-strong px-1.5 py-0.5 font-mono text-[11.5px] text-muted"
              >
                {f.name} <span className="text-dim">{bytes(f.size)}</span>
                <button onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))} className="hover:text-fg">
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-dim">
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
          <Tip label="Attach files">
            <button onClick={() => fileRef.current?.click()} className="hover:text-fg">
              {uploading ? <Spinner className="size-[14px]" /> : <Paperclip className="size-[14px]" />}
            </button>
          </Tip>
          <Menu>
            <Tip label="Rewrite with AI">
              <MenuTrigger
                className="outline-none hover:text-fg disabled:opacity-40"
                disabled={!text.trim() || rewrite.isPending}
              >
                {rewrite.isPending ? <Spinner className="size-[14px]" /> : <Wand2 className="size-[14px]" />}
              </MenuTrigger>
            </Tip>
            <MenuContent align="start">
              <MenuLabel>Rewrite</MenuLabel>
              {[
                ["improve", "Improve writing"],
                ["shorten", "Make shorter"],
                ["friendlier", "Friendlier"],
                ["formal", "More formal"],
                ["fix", "Fix spelling & grammar"],
              ].map(([m, l]) => (
                <MenuItem key={m} onSelect={() => rewrite.mutate({ mode: m! })}>
                  <Sparkles /> {l}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuLabel>Translate to</MenuLabel>
              {[
                "English",
                "German",
                "French",
                "Spanish",
                ticket.aiLanguage && !["en", "de", "fr", "es"].includes(ticket.aiLanguage) ? ticket.aiLanguage : null,
              ]
                .filter(Boolean)
                .map((l) => (
                  <MenuItem key={l} onSelect={() => rewrite.mutate({ mode: "translate", language: l! })}>
                    {l}
                  </MenuItem>
                ))}
            </MenuContent>
          </Menu>
          <ArticlePicker onPick={(snippet) => setText((t) => (t ? `${t}\n\n${snippet}` : snippet))} />
        </div>
        <div className="flex items-center gap-2.5">
          <Kbd>⌘ ⏎</Kbd>
          <div className="flex">
            <Button
              variant="primary"
              className="h-[30px] px-3.5"
              loading={busy}
              disabled={!text.trim()}
              onClick={() => send()}
            >
              {isNote ? "Add note" : "Send"}
            </Button>
            {!isNote ? (
              <Menu>
                <MenuTrigger
                  className="flex h-[30px] items-center border-l border-black/20 bg-fg px-1.5 text-[#080808] outline-none hover:bg-white disabled:opacity-50"
                  disabled={!text.trim() || busy}
                >
                  <ChevronDown className="size-3.5" />
                </MenuTrigger>
                <MenuContent>
                  <MenuItem onSelect={() => send("resolved")}>
                    Send & resolve <Kbd className="ml-auto">⌘⇧⏎</Kbd>
                  </MenuItem>
                  <MenuItem onSelect={() => send("pending")}>Send & mark pending</MenuItem>
                  <MenuItem onSelect={() => send("open")}>Send & keep open</MenuItem>
                </MenuContent>
              </Menu>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
});

function ArticlePicker({ onPick }: { onPick: (snippet: string) => void }) {
  const { api, wid } = useWorkspace();
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const list = useQuery({
    queryKey: ["articles-pick", wid, q],
    enabled: open,
    queryFn: () => api<{ articles: Article[] }>(`/articles${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label="Insert from knowledge base">
        <PopoverTrigger className="outline-none hover:text-fg">
          <BookOpen className="size-[14px]" />
        </PopoverTrigger>
      </Tip>
      <PopoverContent className="w-80 p-0">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search articles…"
          className="h-9 w-full border-b border-line bg-transparent px-3 text-[12.5px] text-fg focus:outline-none"
        />
        <div className="max-h-64 overflow-y-auto p-1">
          {(list.data?.articles ?? [])
            .filter((a) => a.status === "published")
            .slice(0, 12)
            .map((a) => (
              <button
                key={a.id}
                onClick={async () => {
                  const { article } = await api<{ article: Article }>(`/articles/${a.id}`);
                  const para = article.body.split(/\n{2,}/).find((p) => p.trim() && !p.startsWith("#")) ?? "";
                  onPick(`${para.trim()}\n\n(From our guide: “${article.title}”)`);
                  setOpen(false);
                }}
                className="flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left hover:bg-white/[0.05]"
              >
                <span className="text-[12.5px] text-fg-3">{a.title}</span>
                <span className="line-clamp-1 text-[11px] text-dim">{a.excerpt}</span>
              </button>
            ))}
          {list.data && !list.data.articles.length ? (
            <div className="px-2 py-3 text-xs text-dim">No articles found.</div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
