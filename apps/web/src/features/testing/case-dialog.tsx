import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { Button, Dialog, Field, Input, Select, Segmented, Textarea } from "@/components/ui";
import type { TicketChannel } from "@/lib/types";
import { useWorkspace } from "@/lib/workspace";
import type { ExpectedOutcome, TestCase } from "./types";

export interface CaseDraft {
  name: string;
  subject: string;
  message: string;
  channel: TicketChannel;
  customerEmail: string;
  expectation: string;
  expectedOutcome: ExpectedOutcome;
}

export const emptyCase: CaseDraft = {
  name: "",
  subject: "",
  message: "",
  channel: "email",
  customerEmail: "",
  expectation: "",
  expectedOutcome: "reply",
};

/** Create or edit a test case. `initial` prefills a new case (e.g. from the playground). */
export function CaseDialog({
  open,
  onOpenChange,
  existing,
  initial,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  existing?: TestCase | null;
  initial?: Partial<CaseDraft>;
}) {
  const { api, wid } = useWorkspace();
  const qc = useQueryClient();
  const [f, setF] = React.useState<CaseDraft>(emptyCase);
  React.useEffect(() => {
    if (!open) return;
    setF(
      existing
        ? {
            name: existing.name,
            subject: existing.subject,
            message: existing.message,
            channel: existing.channel,
            customerEmail: existing.customerEmail ?? "",
            expectation: existing.expectation,
            expectedOutcome: existing.expectedOutcome,
          }
        : { ...emptyCase, ...initial },
    );
  }, [open, existing, initial]);
  const save = useMutation({
    mutationFn: () =>
      existing
        ? api(`/testing/cases/${existing.id}`, { method: "PATCH", json: f })
        : api("/testing/cases", { method: "POST", json: f }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["testing", wid, "cases"] });
      toast.success(existing ? "Test case updated" : "Test case saved");
      onOpenChange(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const set = (k: keyof CaseDraft) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={existing ? "Edit test case" : "New test case"}
      description="A scripted customer message and what a good answer must do. Runs simulate the agent — nothing is sent."
      className="w-[min(640px,calc(100vw-32px))]"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!f.name || !f.message}
            onClick={() => save.mutate()}
          >
            {existing ? "Save" : "Create case"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input autoFocus value={f.name} onChange={set("name")} placeholder="Duplicate charge (German)" />
        </Field>
        <Field label="Customer message">
          <Textarea rows={5} value={f.message} onChange={set("message")} />
        </Field>
        <div className="grid grid-cols-[1fr_140px] gap-3">
          <Field label="Subject (optional)">
            <Input value={f.subject} onChange={set("subject")} />
          </Field>
          <Field label="Channel">
            <Select value={f.channel} onChange={set("channel")}>
              {["email", "widget", "slack", "discord", "api"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Field
          label="Customer email (optional)"
          hint="Use a real customer to test profile-aware answers (plan, history)."
        >
          <Input type="email" value={f.customerEmail} onChange={set("customerEmail")} placeholder="anna@northwind.io" />
        </Field>
        <Field label="Expected outcome">
          <Segmented
            value={f.expectedOutcome}
            onChange={(v) => setF((x) => ({ ...x, expectedOutcome: v }))}
            options={[
              { value: "reply", label: "Replies" },
              { value: "escalate", label: "Escalates to a human" },
              { value: "any", label: "Either" },
            ]}
          />
        </Field>
        <Field
          label="Expectation"
          hint="What a good answer must convey, one criterion per line. Graded by an LLM judge (or keyword coverage offline)."
        >
          <Textarea
            rows={4}
            value={f.expectation}
            onChange={set("expectation")}
            placeholder={"- Confirms the duplicate charge is refunded in full\n- Says refunds take 3-5 business days"}
          />
        </Field>
      </div>
    </Dialog>
  );
}
