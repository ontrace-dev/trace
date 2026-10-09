import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { SettingsHeader, SettingsSection } from "../settings";
import { Button, Field, Input } from "@/components/ui";
import { authClient } from "@/lib/auth";
import type { TicketPriority } from "@/lib/types";
import { qk, useWorkspace } from "@/lib/workspace";

const ACCENTS = ["#b9a3ff", "#93c5fd", "#86efac", "#fdba74", "#f9a8d4", "#fde68a", "#ededed"];

export function GeneralSettings() {
  const { boot, api, wid, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const [name, setName] = React.useState(boot.org.name);
  const [prefix, setPrefix] = React.useState(boot.settings.ticketPrefix);
  const [accent, setAccent] = React.useState(boot.settings.accentColor);
  const [sla, setSla] = React.useState(boot.settings.sla.firstResponse);
  const save = useMutation({
    mutationFn: async () => {
      if (name !== boot.org.name) {
        const { error } = await authClient.organization.update({ organizationId: wid, data: { name } });
        if (error) throw new Error(error.message);
      }
      await api("/settings", {
        method: "PATCH",
        json: { ticketPrefix: prefix, accentColor: accent, sla: { firstResponse: sla } },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.boot(wid) });
      qc.invalidateQueries({ queryKey: ["orgs"] });
      toast.success("Settings saved");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div>
      <SettingsHeader
        title="General"
        description="Name, ticket numbering, brand color and response targets for this workspace."
      >
        <Button variant="primary" disabled={!isAdmin} loading={save.isPending} onClick={() => save.mutate()}>
          Save changes
        </Button>
      </SettingsHeader>
      <SettingsSection title="Workspace" description="Shown in the switcher, emails and the chat widget.">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="URL slug" hint="Used in links. Set at creation.">
          <Input value={boot.org.slug} disabled />
        </Field>
      </SettingsSection>
      <SettingsSection
        title="Ticket numbers"
        description="Tickets are numbered per workspace. The prefix appears in subjects of outbound emails for threading."
      >
        <Field label="Prefix" hint={`Tickets look like ${prefix || "TR"}-4821`} className="w-40">
          <Input
            value={prefix}
            maxLength={6}
            onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))}
          />
        </Field>
      </SettingsSection>
      <SettingsSection
        title="Accent color"
        description="Tints highlights, AI surfaces and the active state across the app."
      >
        <div className="flex items-center gap-2">
          {ACCENTS.map((c) => (
            <button
              key={c}
              onClick={() => setAccent(c)}
              className="h-7 w-7 border-2"
              style={{ background: c, borderColor: accent === c ? "#fff" : "transparent" }}
              aria-label={c}
            />
          ))}
          <input
            type="color"
            value={accent}
            onChange={(e) => setAccent(e.target.value)}
            className="h-7 w-10 cursor-pointer border border-line-strong bg-transparent"
          />
          <span className="font-mono text-[11px] text-muted">{accent}</span>
        </div>
      </SettingsSection>
      <SettingsSection
        title="First response SLA"
        description="Targets in minutes per priority. Shown on every ticket and tracked in Insights."
      >
        <div className="grid grid-cols-4 gap-3">
          {(["urgent", "high", "normal", "low"] as TicketPriority[]).map((p) => (
            <Field key={p} label={p}>
              <Input
                type="number"
                min={1}
                value={sla[p]}
                onChange={(e) => setSla({ ...sla, [p]: Number(e.target.value) })}
              />
            </Field>
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}
