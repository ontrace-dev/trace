import { useMutation } from "@tanstack/react-query";
import { FlaskConical, Play, Plus, Save, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button, Empty, Field, Input, Kbd, Select, Segmented, Textarea } from "@/components/ui";
import type { TicketChannel } from "@/lib/types";
import { useWorkspace } from "@/lib/workspace";
import { CaseDialog, type CaseDraft } from "./case-dialog";
import { SimulationView } from "./simulation-view";
import type { SimulationInput, SimulationResult } from "./types";

type Inherit<T extends string> = T | "current";

export function Playground() {
  const { api, boot } = useWorkspace();
  const ai = boot.settings.ai;
  const [message, setMessage] = React.useState("");
  const [subject, setSubject] = React.useState("");
  const [channel, setChannel] = React.useState<TicketChannel>("email");
  const [email, setEmail] = React.useState("");
  const [turns, setTurns] = React.useState<{ from: "customer" | "agent"; body: string }[]>([]);
  const [mode, setMode] = React.useState<Inherit<"draft" | "auto">>("current");
  const [tone, setTone] = React.useState<Inherit<"friendly" | "formal" | "concise">>("current");
  const [threshold, setThreshold] = React.useState(ai.autoSendThreshold);
  const [guidance, setGuidance] = React.useState("");
  const [saveOpen, setSaveOpen] = React.useState(false);

  const input = (): SimulationInput => {
    const aiOverrides: SimulationInput["aiOverrides"] = {};
    if (mode !== "current") aiOverrides.mode = mode;
    if (tone !== "current") aiOverrides.tone = tone;
    if (threshold !== ai.autoSendThreshold) aiOverrides.autoSendThreshold = threshold;
    if (guidance.trim()) aiOverrides.guidance = [ai.guidance, guidance.trim()].filter(Boolean).join("\n");
    return {
      message,
      subject: subject || undefined,
      channel,
      customerEmail: email || undefined,
      history: turns.filter((t) => t.body.trim()),
      aiOverrides: Object.keys(aiOverrides).length ? aiOverrides : undefined,
    };
  };
  const run = useMutation({
    mutationFn: () => api<SimulationResult>("/testing/simulate", { method: "POST", json: input() }),
    onError: (e) => toast.error((e as Error).message),
  });
  const result = run.data;
  const caseInitial = React.useMemo<Partial<CaseDraft>>(
    () => ({
      name: (subject || message).slice(0, 60),
      subject,
      message,
      channel,
      customerEmail: email,
      expectedOutcome: result?.outcome ?? "reply",
      expectation: "",
    }),
    [subject, message, channel, email, result?.outcome],
  );

  return (
    <div className="grid min-h-0 gap-px bg-line xl:grid-cols-[minmax(380px,460px)_1fr]">
      <div className="flex flex-col gap-4 bg-bg px-8 py-6">
        <Field label="Customer message">
          <Textarea
            rows={6}
            autoFocus
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && message.trim()) {
                e.preventDefault();
                run.mutate();
              }
            }}
            placeholder="Hallo, ich wurde für Rechnung 4821 zweimal belastet…"
          />
        </Field>
        <div className="grid grid-cols-[1fr_130px] gap-3">
          <Field label="Subject (optional)">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Channel">
            <Select value={channel} onChange={(e) => setChannel(e.target.value as TicketChannel)}>
              {["email", "widget", "slack", "discord", "api"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Customer email (optional)" hint="Use a real customer to test profile-aware answers.">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="anna@northwind.io"
          />
        </Field>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-fg-2">Earlier turns</span>
            <button
              onClick={() =>
                setTurns((t) => [...t, { from: t.at(-1)?.from === "customer" ? "agent" : "customer", body: "" }])
              }
              className="flex items-center gap-1 font-mono text-[11.5px] text-muted hover:text-fg"
            >
              <Plus className="size-3" /> add turn
            </button>
          </div>
          {turns.length ? (
            turns.map((t, i) => (
              <div key={i} className="flex gap-2">
                <Select
                  className="h-7 w-28 text-[12px]"
                  value={t.from}
                  onChange={(e) =>
                    setTurns((x) => x.map((y, j) => (j === i ? { ...y, from: e.target.value as "customer" } : y)))
                  }
                >
                  <option value="customer">customer</option>
                  <option value="agent">agent</option>
                </Select>
                <Textarea
                  rows={2}
                  className="text-[12px]"
                  value={t.body}
                  onChange={(e) => setTurns((x) => x.map((y, j) => (j === i ? { ...y, body: e.target.value } : y)))}
                />
                <button
                  onClick={() => setTurns((x) => x.filter((_, j) => j !== i))}
                  className="self-start pt-1.5 text-dim hover:text-fg"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))
          ) : (
            <span className="text-[11.5px] text-dim">Optional — the message above is the latest customer turn.</span>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <span className="label-mono">What if…</span>
          <Field label="Autonomy">
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: "current", label: `current (${ai.mode})` },
                { value: "draft", label: "draft" },
                { value: "auto", label: "autopilot" },
              ]}
            />
          </Field>
          <Field label="Tone">
            <Segmented
              value={tone}
              onChange={setTone}
              options={[
                { value: "current", label: `current (${ai.tone})` },
                { value: "friendly", label: "friendly" },
                { value: "formal", label: "formal" },
                { value: "concise", label: "concise" },
              ]}
            />
          </Field>
          <Field label={`Auto-send threshold · ${Math.round(threshold * 100)}%`}>
            <input
              type="range"
              min={0.5}
              max={0.99}
              step={0.01}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="accent-[var(--tr-accent)]"
            />
          </Field>
          <Field
            label="Extra guidance"
            hint="Appended to the team guidance for this run only — try a policy change before saving it."
          >
            <Textarea rows={3} value={guidance} onChange={(e) => setGuidance(e.target.value)} />
          </Field>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="primary" loading={run.isPending} disabled={!message.trim()} onClick={() => run.mutate()}>
            <Play /> Run simulation
          </Button>
          <Kbd>⌘ ⏎</Kbd>
          {result ? (
            <Button className="ml-auto" onClick={() => setSaveOpen(true)}>
              <Save /> Save as test case
            </Button>
          ) : null}
        </div>
      </div>

      <div className="min-w-0 bg-bg px-8 py-6">
        {result ? (
          <SimulationView result={result} agentName={ai.agentName} />
        ) : (
          <Empty icon={<FlaskConical />} title={run.isPending ? "Simulating…" : "Nothing run yet"}>
            Write a customer message and run it. You'll see exactly what {ai.agentName} would do — triage, research,
            actions, the reply and whether policy would let it auto-send — without anything reaching a customer.
          </Empty>
        )}
      </div>
      <CaseDialog open={saveOpen} onOpenChange={setSaveOpen} initial={caseInitial} />
    </div>
  );
}
