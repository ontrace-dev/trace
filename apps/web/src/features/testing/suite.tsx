import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FlaskConical, Pencil, Play, Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Badge, Button, Dialog, Empty, Spinner, Tip } from "@/components/ui";
import { ago, cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { CaseDialog } from "./case-dialog";
import { SimulationView } from "./simulation-view";
import type { TestCase, TestRun } from "./types";
import { useConfirm } from "@/components/ui/confirm";

const outcomeLabel = { reply: "reply", escalate: "escalate", any: "either" } as const;

export function Suite() {
  const confirm = useConfirm();
  const { api, wid, boot } = useWorkspace();
  const qc = useQueryClient();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [editing, setEditing] = React.useState<TestCase | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [viewing, setViewing] = React.useState<TestCase | null>(null);
  const [runId, setRunId] = React.useState<string | null>(null);

  const cases = useQuery({
    queryKey: ["testing", wid, "cases"],
    queryFn: () => api<{ cases: TestCase[] }>("/testing/cases"),
  });
  const latest = useQuery({
    queryKey: ["testing", wid, "run", "latest"],
    queryFn: () => api<{ run: TestRun | null }>("/testing/runs/latest"),
  });
  // Pick up a run that is still in progress (e.g. after a reload).
  React.useEffect(() => {
    if (!runId && latest.data?.run?.status === "running") setRunId(latest.data.run.id);
  }, [latest.data, runId]);
  const progress = useQuery({
    queryKey: ["testing", wid, "run", runId],
    enabled: !!runId,
    queryFn: () => api<{ run: TestRun }>(`/testing/runs/${runId}`),
    refetchInterval: (q) => (q.state.data?.run.status === "running" ? 1000 : false),
  });
  const run = progress.data?.run ?? latest.data?.run ?? null;
  const running = run?.status === "running";

  // Refresh case results as the run advances, and once more when it finishes.
  const completed = progress.data?.run.completed;
  React.useEffect(() => {
    if (completed === undefined) return;
    qc.invalidateQueries({ queryKey: ["testing", wid, "cases"] });
    if (progress.data?.run.status !== "running") qc.invalidateQueries({ queryKey: ["testing", wid, "run", "latest"] });
  }, [completed, progress.data?.run.status, qc, wid]);

  const start = useMutation({
    mutationFn: (caseIds?: string[]) => api<{ run: TestRun }>("/testing/runs", { method: "POST", json: { caseIds } }),
    onSuccess: ({ run }) => {
      setRunId(run.id);
      qc.setQueryData(["testing", wid, "run", run.id], { run });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const importCases = useMutation({
    mutationFn: () => api<{ cases: TestCase[] }>("/testing/cases/import", { method: "POST", json: { limit: 10 } }),
    onSuccess: ({ cases }) => {
      qc.invalidateQueries({ queryKey: ["testing", wid, "cases"] });
      toast(
        cases.length ? `Imported ${cases.length} cases from resolved tickets` : "No new resolved tickets to import",
      );
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/testing/cases/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["testing", wid, "cases"] }),
  });

  const list = cases.data?.cases ?? [];
  const allSelected = list.length > 0 && list.every((c) => selected.has(c.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const passRate = run && run.status !== "running" && run.total ? Math.round((run.passed / run.total) * 100) : null;

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-4 border-b border-line px-8 py-4">
        <div className="flex flex-col gap-1">
          <span className="label-mono">Latest run</span>
          {run ? (
            running ? (
              <span className="flex items-center gap-2 text-[13px] text-fg-3">
                <Spinner className="size-3.5" /> Running {run.completed}/{run.total}
              </span>
            ) : (
              <span className="text-[13px] text-fg-2">
                <span
                  className={cn(
                    "text-[20px] font-semibold tracking-tight",
                    passRate! >= 80 ? "text-ok" : passRate! >= 50 ? "text-warn" : "text-danger",
                  )}
                >
                  {passRate}%
                </span>{" "}
                <span className="text-muted">
                  passed · {run.passed}/{run.total} · {ago(run.finishedAt ?? run.createdAt)} ago
                </span>
              </span>
            )
          ) : (
            <span className="text-[13px] text-muted">No runs yet</span>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button onClick={() => setCreating(true)}>
            <Plus /> New case
          </Button>
          <Button loading={importCases.isPending} onClick={() => importCases.mutate()}>
            <Download /> Import from resolved tickets
          </Button>
          {selected.size ? (
            <Button disabled={running} loading={start.isPending} onClick={() => start.mutate([...selected])}>
              <Play /> Run selected ({selected.size})
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={running || !list.length}
            loading={start.isPending}
            onClick={() => start.mutate(undefined)}
          >
            <Play /> Run all
          </Button>
        </div>
        {running ? (
          <div className="h-1 w-full bg-white/[0.06]">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${(run!.completed / Math.max(1, run!.total)) * 100}%` }}
            />
          </div>
        ) : null}
      </div>

      {cases.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : !list.length ? (
        <Empty icon={<FlaskConical />} title="No test cases yet">
          Save a case from the playground, write one by hand, or import resolved tickets — each becomes a check that{" "}
          {boot.settings.ai.agentName} still answers the way your team would.
        </Empty>
      ) : (
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-line font-mono text-[11px] tracking-[0.1em] text-dim uppercase">
              <th className="w-10 py-2 pl-8">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(list.map((c) => c.id)))}
                  className="accent-[var(--tr-accent)]"
                />
              </th>
              <th className="px-3 py-2 font-medium">Case</th>
              <th className="px-3 py-2 font-medium">Expected → actual</th>
              <th className="px-3 py-2 font-medium">Result</th>
              <th className="px-3 py-2 font-medium">Verdict</th>
              <th className="px-3 py-2 text-right font-medium">Ran</th>
              <th className="w-20 py-2 pr-8" />
            </tr>
          </thead>
          <tbody>
            {list.map((c) => {
              const r = c.lastResult;
              return (
                <tr
                  key={c.id}
                  className="cursor-pointer border-b border-line-2 hover:bg-white/[0.02]"
                  onClick={() => setViewing(c)}
                >
                  <td className="py-2.5 pl-8" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(c.id)}
                      onChange={() => toggle(c.id)}
                      className="accent-[var(--tr-accent)]"
                    />
                  </td>
                  <td className="max-w-[320px] px-3 py-2.5">
                    <div className="truncate text-[13px] text-fg-2">{c.name}</div>
                    <div className="truncate text-[11.5px] text-dim">{c.message}</div>
                  </td>
                  <td className="px-3 font-mono text-[11px] whitespace-nowrap text-muted">
                    {outcomeLabel[c.expectedOutcome]}
                    {r ? (
                      <>
                        {" → "}
                        <span className={r.outcomeMatched ? "text-fg-3" : "text-danger"}>{r.simulation.outcome}</span>
                      </>
                    ) : null}
                  </td>
                  <td className="px-3 whitespace-nowrap">
                    {r ? (
                      <span className="flex items-center gap-2">
                        <Badge tone={r.passed ? "ok" : "danger"} upper>
                          {r.passed ? "pass" : "fail"}
                        </Badge>
                        <span className="font-mono text-[11.5px] text-dim">{Math.round(r.score * 100)}%</span>
                      </span>
                    ) : (
                      <span className="font-mono text-[11.5px] text-dim">not run</span>
                    )}
                  </td>
                  <td className="max-w-[360px] px-3">
                    {r ? (
                      <Tip label={<span className="block max-w-sm whitespace-normal">{r.verdict}</span>}>
                        <span className="line-clamp-1 text-[12px] text-muted">{r.verdict}</span>
                      </Tip>
                    ) : null}
                  </td>
                  <td className="px-3 text-right font-mono text-[11.5px] whitespace-nowrap text-dim">
                    {r ? `${ago(r.ranAt)} ago` : ""}
                  </td>
                  <td className="py-2.5 pr-8" onClick={(e) => e.stopPropagation()}>
                    <span className="flex justify-end gap-1">
                      <Button size="icon-sm" onClick={() => setEditing(c)} aria-label="Edit">
                        <Pencil />
                      </Button>
                      <Button
                        size="icon-sm"
                        onClick={async () =>
                          (await confirm({
                            title: "Delete test case?",
                            description: `"${c.name}" and its latest result will be removed.`,
                            confirmLabel: "Delete",
                            destructive: true,
                          })) && remove.mutate(c.id)
                        }
                        aria-label="Delete"
                      >
                        <Trash2 />
                      </Button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <CaseDialog open={creating} onOpenChange={setCreating} />
      <CaseDialog open={!!editing} onOpenChange={(v) => !v && setEditing(null)} existing={editing} />
      <CaseResultDialog
        testCase={viewing ? (list.find((c) => c.id === viewing.id) ?? viewing) : null}
        onClose={() => setViewing(null)}
        onRun={(id) => start.mutate([id])}
        running={running}
      />
    </div>
  );
}

function CaseResultDialog({
  testCase,
  onClose,
  onRun,
  running,
}: {
  testCase: TestCase | null;
  onClose: () => void;
  onRun: (id: string) => void;
  running: boolean;
}) {
  const { boot } = useWorkspace();
  const r = testCase?.lastResult;
  return (
    <Dialog
      open={!!testCase}
      onOpenChange={(v) => !v && onClose()}
      title={testCase?.name ?? ""}
      description={
        r ? `Last run ${ago(r.ranAt)} ago · score ${Math.round(r.score * 100)}%` : "This case hasn't been run yet."
      }
      className="top-[6vh] max-h-[88vh] w-[min(920px,calc(100vw-32px))]"
      footer={
        <Button variant="primary" disabled={running} onClick={() => testCase && onRun(testCase.id)}>
          <Play /> Run this case
        </Button>
      }
    >
      {testCase ? (
        <div className="grid gap-6 md:grid-cols-[280px_1fr]">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="label-mono">Customer says</span>
              <div className="border border-line bg-cell p-3 text-[12.5px] leading-relaxed whitespace-pre-wrap text-fg-3">
                {testCase.message}
              </div>
              <span className="font-mono text-[11px] text-dim">
                {testCase.channel}
                {testCase.customerEmail ? ` · ${testCase.customerEmail}` : " · anonymous"}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="label-mono">Expected</span>
              <Badge upper className="self-start">
                {outcomeLabel[testCase.expectedOutcome]}
              </Badge>
              <div className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-muted">
                {testCase.expectation || "No content expectation."}
              </div>
            </div>
            {r ? (
              <div
                className={cn(
                  "flex flex-col gap-1.5 border p-3",
                  r.passed ? "border-ok/25 bg-ok/[0.04]" : "border-danger/30 bg-danger/[0.04]",
                )}
              >
                <Badge tone={r.passed ? "ok" : "danger"} upper className="self-start">
                  {r.passed ? "pass" : "fail"} · {Math.round(r.score * 100)}%
                </Badge>
                <p className="text-[12.5px] leading-relaxed text-fg-3">{r.verdict}</p>
              </div>
            ) : null}
          </div>
          <div className="min-w-0">
            {r ? (
              <SimulationView result={r.simulation} agentName={boot.settings.ai.agentName} />
            ) : (
              <Empty icon={<FlaskConical />} title="Not run yet">
                Run the case to see what the agent would do.
              </Empty>
            )}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
