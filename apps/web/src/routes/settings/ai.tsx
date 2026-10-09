import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { SettingsHeader, SettingsSection } from "../settings";
import { Badge, Button, Field, Input, Select, Segmented, Switch, Textarea } from "@/components/ui";
import type { AiSettings, WorkspaceSettings } from "@/lib/types";
import { cn } from "@/lib/utils";
import { qk, useWorkspace } from "@/lib/workspace";

const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 — best quality (default)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 — faster, cheaper" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — fastest" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1 — most capable" },
];

export function AiSettingsPage() {
  const { api, wid, boot, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: qk.settings(wid),
    queryFn: () => api<{ settings: WorkspaceSettings; aiApiKeyMasked: string }>("/settings"),
  });
  const [ai, setAi] = React.useState<AiSettings | null>(null);
  const [apiKey, setApiKey] = React.useState<string | undefined>(undefined);
  React.useEffect(() => {
    if (q.data) setAi(q.data.settings.ai);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => {
      const { hasApiKey: _h, apiKey: _k, ...rest } = ai!;
      return api("/settings", {
        method: "PATCH",
        json: { ai: { ...rest, ...(apiKey !== undefined ? { apiKey } : {}) } },
      });
    },
    onSuccess: () => {
      setApiKey(undefined);
      qc.invalidateQueries({ queryKey: qk.settings(wid) });
      qc.invalidateQueries({ queryKey: qk.boot(wid) });
      toast.success("AI agent updated");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!ai) return null;
  const set = <K extends keyof AiSettings>(k: K, v: AiSettings[K]) => setAi({ ...ai, [k]: v });
  return (
    <div>
      <SettingsHeader
        title="AI agent"
        description="The agent triages every inbound conversation, researches your knowledge base and past tickets, and drafts — or sends — a grounded reply. Every step is recorded as a trace you can audit."
      >
        <Badge tone={boot.ai.online ? "solid-accent" : "neutral"} upper>
          {boot.ai.online ? `online · ${boot.ai.model}` : "offline · local heuristics"}
        </Badge>
        <Button variant="primary" disabled={!isAdmin} loading={save.isPending} onClick={() => save.mutate()}>
          Save changes
        </Button>
      </SettingsHeader>

      <SettingsSection
        title="Agent"
        description="Turn the agent on, name it, and pick how much it is allowed to do on its own."
      >
        <div className="flex items-center justify-between border border-line px-3 py-2.5">
          <div className="flex flex-col">
            <span className="text-[13px] text-fg-2">Enable AI agent</span>
            <span className="text-[11.5px] text-dim">Triage + drafts on every inbound customer message.</span>
          </div>
          <Switch checked={ai.enabled} onCheckedChange={(v) => set("enabled", v)} />
        </div>
        <Field label="Agent name" hint="Shown to agents in the inbox and to customers on AI-authored replies.">
          <Input value={ai.agentName} onChange={(e) => set("agentName", e.target.value)} className="max-w-xs" />
        </Field>
        <Field label="Autonomy">
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                [
                  "draft",
                  "Draft for review",
                  "The agent prepares a reply; a human sends it with one click (or ⇥ in the composer).",
                ],
                [
                  "auto",
                  "Autopilot",
                  "Replies are sent automatically when confidence clears the threshold and no policy blocks it.",
                ],
              ] as const
            ).map(([v, t, d]) => (
              <button
                key={v}
                onClick={() => set("mode", v)}
                className={cn(
                  "flex flex-col gap-1 border p-3 text-left",
                  ai.mode === v ? "border-accent/60 bg-accent/[0.06]" : "border-line hover:border-line-strong",
                )}
              >
                <span className="text-[13px] font-medium text-fg-2">{t}</span>
                <span className="text-[11.5px] leading-relaxed text-dim">{d}</span>
              </button>
            ))}
          </div>
        </Field>
        <Field
          label={`Auto-send threshold · ${Math.round(ai.autoSendThreshold * 100)}%`}
          hint="Minimum self-reported confidence for autopilot and widget instant answers."
        >
          <input
            type="range"
            min={0.5}
            max={0.99}
            step={0.01}
            value={ai.autoSendThreshold}
            onChange={(e) => set("autoSendThreshold", Number(e.target.value))}
            className="accent-[var(--tr-accent)]"
          />
        </Field>
        <div className="flex items-center justify-between border border-line px-3 py-2.5">
          <div className="flex flex-col">
            <span className="text-[13px] text-fg-2">Instant answers in the chat widget</span>
            <span className="text-[11.5px] text-dim">
              Visitors get an immediate answer when confident; otherwise a holding message and a human follows up.
            </span>
          </div>
          <Switch checked={ai.widgetInstantAnswers} onCheckedChange={(v) => set("widgetInstantAnswers", v)} />
        </div>
        <div className="flex items-center justify-between border border-line px-3 py-2.5">
          <div className="flex flex-col">
            <span className="text-[13px] text-fg-2">Auto-triage</span>
            <span className="text-[11.5px] text-dim">
              Apply priority, tags, intent, language and sentiment on arrival.
            </span>
          </div>
          <Switch checked={ai.autoTriage} onCheckedChange={(v) => set("autoTriage", v)} />
        </div>
      </SettingsSection>

      <SettingsSection title="Policy" description="Hard limits the agent cannot override, whatever its confidence.">
        <Field
          label="Never auto-send when the conversation mentions"
          hint="Comma separated keywords. Matching tickets always wait for a human."
        >
          <Input
            value={ai.neverAutoSend.join(", ")}
            onChange={(e) =>
              set(
                "neverAutoSend",
                e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
          />
        </Field>
      </SettingsSection>

      <SettingsSection
        title="Voice & instructions"
        description="How the agent writes. Guidance is appended to its instructions on every run."
      >
        <Field label="Tone">
          <Segmented
            value={ai.tone}
            onChange={(v) => set("tone", v)}
            options={[
              { value: "friendly", label: "Friendly" },
              { value: "formal", label: "Formal" },
              { value: "concise", label: "Concise" },
            ]}
          />
        </Field>
        <Field
          label="Team guidance"
          hint="E.g. refund policy, escalation rules, product facts, things to never promise."
        >
          <Textarea
            rows={7}
            value={ai.guidance}
            onChange={(e) => set("guidance", e.target.value)}
            placeholder={
              "- Refunds under €100 can be promised; above that, escalate.\n- Never share roadmap dates.\n- Sign off with “— the Northwind team”."
            }
          />
        </Field>
      </SettingsSection>

      <SettingsSection
        title="Model"
        description={
          <>
            trace calls Claude through the Anthropic API. Without a key it falls back to a local heuristic agent that
            triages and drafts from your knowledge base but never auto-sends.
          </>
        }
      >
        <Field label="Model">
          <Select value={ai.model} onChange={(e) => set("model", e.target.value)}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            {!MODELS.some((m) => m.id === ai.model) ? <option value={ai.model}>{ai.model}</option> : null}
          </Select>
        </Field>
        <Field label="Effort" hint="Higher effort = more thorough research per ticket, more tokens.">
          <Segmented
            value={ai.effort}
            onChange={(v) => set("effort", v)}
            options={[
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
            ]}
          />
        </Field>
        <Field
          label="Anthropic API key (optional)"
          hint={
            q.data?.aiApiKeyMasked
              ? `Workspace key set: ${q.data.aiApiKeyMasked}. Leave empty to keep it; enter "-" to remove.`
              : "Overrides the server's ANTHROPIC_API_KEY for this workspace."
          }
        >
          <Input
            type="password"
            value={apiKey ?? ""}
            placeholder="sk-ant-…"
            onChange={(e) => setApiKey(e.target.value === "-" ? "" : e.target.value || undefined)}
          />
        </Field>
        <div className="flex items-center gap-2 text-[11.5px] text-dim">
          <Sparkles className="size-3 text-accent-text" /> Replies include server-side refusal fallbacks and prompt
          caching by default.
        </div>
      </SettingsSection>
    </div>
  );
}
