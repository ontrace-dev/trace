import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { Button, Dialog, Field, Input, Select, Segmented, Textarea } from "@/components/ui";
import type { Ticket, TicketPriority } from "@/lib/types";
import { useWorkspace } from "@/lib/workspace";

export function NewTicketDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { api, slug, boot, wid } = useWorkspace();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [mode, setMode] = React.useState<"customer" | "outbound">("customer");
  const [form, setForm] = React.useState({
    subject: "",
    body: "",
    customerEmail: "",
    customerName: "",
    priority: "normal" as TicketPriority,
  });
  const hasEmail = boot.channels.some((c) => c.type === "email");
  const create = useMutation({
    mutationFn: () =>
      api<{ ticket: Ticket }>("/tickets", {
        method: "POST",
        json: {
          ...form,
          mode,
          customerEmail: form.customerEmail || undefined,
          customerName: form.customerName || undefined,
        },
      }),
    onSuccess: ({ ticket }) => {
      qc.invalidateQueries({ queryKey: ["tickets", wid] });
      onOpenChange(false);
      setForm({ subject: "", body: "", customerEmail: "", customerName: "", priority: "normal" });
      navigate({ to: "/w/$slug/inbox/$view/$ticket", params: { slug, view: "inbox", ticket: String(ticket.number) } });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New ticket"
      description={
        mode === "customer"
          ? "Log a request on behalf of a customer (e.g. from a call). The AI agent triages and drafts a reply."
          : hasEmail
            ? "Start a conversation with a customer. Your message is sent by email from your support address."
            : "Start a conversation with a customer. Connect an email channel to deliver it by email."
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={!form.subject || !form.body}
            onClick={() => create.mutate()}
          >
            Create ticket
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "customer", label: "On behalf of customer" },
            { value: "outbound", label: "Outbound message" },
          ]}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Customer email">
            <Input
              type="email"
              value={form.customerEmail}
              onChange={set("customerEmail")}
              placeholder="anna@northwind.io"
            />
          </Field>
          <Field label="Customer name">
            <Input value={form.customerName} onChange={set("customerName")} placeholder="Anna Møller" />
          </Field>
        </div>
        <Field label="Subject">
          <Input autoFocus value={form.subject} onChange={set("subject")} placeholder="Invoice charged twice" />
        </Field>
        <Field label={mode === "customer" ? "What the customer said" : "Your message"}>
          <Textarea rows={6} value={form.body} onChange={set("body")} />
        </Field>
        <Field label="Priority" className="w-40">
          <Select value={form.priority} onChange={set("priority")}>
            {["low", "normal", "high", "urgent"].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}
