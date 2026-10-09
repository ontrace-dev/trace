import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Plus, Send } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { CopyField, SettingsHeader, SettingsSection } from "../settings";
import { Badge, Button, Dialog, Empty, Field, Input, Switch, Textarea } from "@/components/ui";
import { qk, useWorkspace } from "@/lib/workspace";
import { useConfirm } from "@/components/ui/confirm";

interface Channel {
  id: string;
  type: "email" | "widget" | "api" | "slack";
  name: string;
  enabled: boolean;
  address: string | null;
  inboundToken: string;
  config: { fromName?: string; signature?: string; smtpUrl?: string };
  forwardingAddress?: string;
  webhookUrl?: string;
}

export function ChannelsSettings() {
  const { api, wid, isAdmin, boot } = useWorkspace();
  const qc = useQueryClient();
  const [adding, setAdding] = React.useState(false);
  const list = useQuery({ queryKey: qk.channels(wid), queryFn: () => api<{ channels: Channel[] }>("/channels") });
  const emails = (list.data?.channels ?? []).filter((c) => c.type === "email");
  return (
    <div>
      <SettingsHeader
        title="Email"
        description="Connect support addresses like support@yourcompany.com. Incoming mail becomes tickets, replies go out from the same address and stay threaded."
      >
        <Button variant="primary" disabled={!isAdmin} onClick={() => setAdding(true)}>
          <Plus /> Add address
        </Button>
      </SettingsHeader>
      {!emails.length && !list.isPending ? (
        <Empty icon={<Mail />} title="No email address connected">
          Add your support address, then forward its mail to trace (or point an inbound-parse webhook at it).
        </Empty>
      ) : null}
      {emails.map((c) => (
        <EmailChannel key={c.id} c={c} onChange={() => qc.invalidateQueries({ queryKey: qk.channels(wid) })} />
      ))}
      <SettingsSection
        title="How inbound works"
        description="Three ways to get mail into trace — pick whichever your mail setup allows."
      >
        <ol className="flex list-decimal flex-col gap-2 pl-4 text-[12.5px] leading-relaxed text-muted">
          <li>
            <span className="text-fg-3">Forwarding</span> — in Google Workspace / Microsoft 365 / your mail host,
            forward support@ to the channel's forwarding address. The forwarding domain must resolve to this server's
            built-in SMTP listener (port <span className="font-mono">{boot.env.smtpPort}</span>, set{" "}
            <span className="font-mono">INBOUND_DOMAIN</span>).
          </li>
          <li>
            <span className="text-fg-3">MX record</span> — point a (sub)domain's MX at this server and use addresses on
            it directly. The support address itself is matched.
          </li>
          <li>
            <span className="text-fg-3">Inbound webhook</span> — Postmark, SendGrid Inbound Parse, Mailgun routes,
            Cloudflare Email Workers or raw MIME POSTs to the channel's webhook URL.
          </li>
        </ol>
        <div className="border border-line bg-cell p-3 font-mono text-[11px] leading-relaxed text-muted">
          <div className="mb-1 text-dim"># try it locally (swaks or any SMTP client)</div>
          swaks --server localhost:{boot.env.smtpPort} --to {emails[0]?.address ?? "support@yourcompany.com"} --from
          you@example.com --header "Subject: Help!" --body "I was charged twice"
        </div>
        <p className="text-[12px] text-dim">
          Outbound replies use <span className="font-mono">SMTP_URL</span> (Mailpit locally — open{" "}
          <a className="underline" href="http://localhost:8025" target="_blank" rel="noreferrer">
            localhost:8025
          </a>
          ) or a per-address SMTP override.
        </p>
      </SettingsSection>
      <AddEmailDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}

function EmailChannel({ c, onChange }: { c: Channel; onChange: () => void }) {
  const confirm = useConfirm();
  const { api, isAdmin } = useWorkspace();
  const [form, setForm] = React.useState({
    name: c.name,
    fromName: c.config.fromName ?? "",
    signature: c.config.signature ?? "",
    smtpUrl: c.config.smtpUrl ?? "",
  });
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api(`/channels/${c.id}`, { method: "PATCH", json: patch }),
    onSuccess: () => {
      onChange();
      toast.success("Saved");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; ticketId?: string; reason?: string }>(`/channels/${c.id}/test`, { method: "POST", json: {} }),
    onSuccess: (r) =>
      r.ok ? toast.success("Test email received — check the inbox") : toast.error(r.reason ?? "Test failed"),
  });
  const del = useMutation({ mutationFn: () => api(`/channels/${c.id}`, { method: "DELETE" }), onSuccess: onChange });
  return (
    <SettingsSection
      title={c.address ?? c.name}
      description={
        <span className="flex items-center gap-2">
          <Badge tone={c.enabled ? "ok" : "neutral"} upper>
            {c.enabled ? "receiving" : "paused"}
          </Badge>
          {c.name}
        </span>
      }
    >
      <CopyField label="Forwarding address" value={c.forwardingAddress ?? ""} />
      <CopyField label="Inbound webhook URL" value={c.webhookUrl ?? ""} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Channel name">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="From name" hint="e.g. Northwind Support">
          <Input value={form.fromName} onChange={(e) => setForm({ ...form, fromName: e.target.value })} />
        </Field>
      </div>
      <Field label="Signature" hint="Appended to every outbound reply.">
        <Textarea rows={3} value={form.signature} onChange={(e) => setForm({ ...form, signature: e.target.value })} />
      </Field>
      <Field
        label="SMTP override (optional)"
        hint="smtp://user:pass@smtp.postmarkapp.com:587 — otherwise the server default is used."
      >
        <Input
          value={form.smtpUrl}
          onChange={(e) => setForm({ ...form, smtpUrl: e.target.value })}
          className="font-mono text-[12px]"
        />
      </Field>
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={!isAdmin}
          loading={save.isPending}
          onClick={() => save.mutate(form)}
        >
          Save
        </Button>
        <Button size="sm" loading={test.isPending} onClick={() => test.mutate()}>
          <Send /> Send test email
        </Button>
        <span className="ml-auto flex items-center gap-2 text-xs text-dim">
          Receiving{" "}
          <Switch checked={c.enabled} disabled={!isAdmin} onCheckedChange={(v) => save.mutate({ enabled: v })} />
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={!isAdmin}
          onClick={async () =>
            (await confirm({
              title: "Remove email address?",
              description: "Mail sent to it will no longer create tickets. Existing tickets are kept.",
              confirmLabel: "Remove",
              destructive: true,
            })) && del.mutate()
          }
        >
          Remove
        </Button>
      </div>
    </SettingsSection>
  );
}

function AddEmailDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { api, wid } = useWorkspace();
  const qc = useQueryClient();
  const [form, setForm] = React.useState({ name: "Support", address: "", fromName: "" });
  const add = useMutation({
    mutationFn: () => api("/channels", { method: "POST", json: form }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.channels(wid) });
      qc.invalidateQueries({ queryKey: qk.boot(wid) });
      onOpenChange(false);
      setForm({ name: "Support", address: "", fromName: "" });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Connect an email address"
      description="You'll get a forwarding address and a webhook URL for it."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={add.isPending} disabled={!form.address} onClick={() => add.mutate()}>
            Connect
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Support address">
          <Input
            autoFocus
            type="email"
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
            placeholder="support@northwind.io"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Channel name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="From name">
            <Input
              value={form.fromName}
              onChange={(e) => setForm({ ...form, fromName: e.target.value })}
              placeholder="Northwind Support"
            />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
