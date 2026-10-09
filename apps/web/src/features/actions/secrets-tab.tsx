import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Lock } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button, Empty, Field, Input, Spinner } from "@/components/ui";
import { ago } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { automationKeys, type Secret } from "./types";
import { useConfirm } from "@/components/ui/confirm";

export function SecretsTab() {
  const confirm = useConfirm();
  const { api, wid, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const [name, setName] = React.useState("");
  const [value, setValue] = React.useState("");
  const [rotating, setRotating] = React.useState<string | null>(null);
  const [rotateValue, setRotateValue] = React.useState("");
  const list = useQuery({
    queryKey: automationKeys.secrets(wid),
    enabled: isAdmin,
    queryFn: () => api<{ secrets: Secret[] }>("/automation/secrets"),
  });
  const put = useMutation({
    mutationFn: ({ name, value }: { name: string; value: string }) =>
      api(`/automation/secrets/${encodeURIComponent(name)}`, { method: "PUT", json: { value } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.secrets(wid) });
      toast.success("Secret saved");
      setName("");
      setValue("");
      setRotating(null);
      setRotateValue("");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({
    mutationFn: (n: string) => api(`/automation/secrets/${encodeURIComponent(n)}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationKeys.secrets(wid) }),
  });
  if (!isAdmin)
    return (
      <Empty icon={<Lock />} title="Admins only">
        Ask a workspace admin to manage secrets.
      </Empty>
    );
  const secrets = list.data?.secrets ?? [];
  return (
    <div className="flex max-w-3xl flex-col gap-6 px-8 py-6">
      <p className="text-[12px] leading-relaxed text-dim">
        Secrets are encrypted at rest and only ever inserted into requests — reference them as{" "}
        <span className="font-mono text-accent-fg">{"{{secrets.NAME}}"}</span> in URLs, headers or bodies. Values can't
        be read back.
      </p>
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          put.mutate({ name, value });
        }}
      >
        <Field label="Name" className="w-64">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
            placeholder="STRIPE_SECRET_KEY"
            className="font-mono text-[12px]"
          />
        </Field>
        <Field label="Value" className="flex-1">
          <Input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="sk_live_…"
            autoComplete="off"
          />
        </Field>
        <Button variant="primary" disabled={!name || !value} loading={put.isPending}>
          Save secret
        </Button>
      </form>
      {list.isPending ? (
        <Spinner />
      ) : !secrets.length ? (
        <Empty icon={<KeyRound />} title="No secrets yet" />
      ) : (
        <div className="flex flex-col border border-line">
          {secrets.map((s) => (
            <div key={s.id} className="flex items-center gap-3 border-b border-line-2 px-3 py-2.5 last:border-b-0">
              <KeyRound className="size-3.5 text-dim" />
              <span className="font-mono text-[12.5px] text-fg-2">{s.name}</span>
              <span className="font-mono text-[11px] text-dim">••••••••</span>
              {rotating === s.name ? (
                <form
                  className="ml-auto flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    put.mutate({ name: s.name, value: rotateValue });
                  }}
                >
                  <Input
                    autoFocus
                    type="password"
                    value={rotateValue}
                    onChange={(e) => setRotateValue(e.target.value)}
                    placeholder="New value"
                    className="h-7 w-56"
                  />
                  <Button size="sm" variant="primary" disabled={!rotateValue}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" type="button" onClick={() => setRotating(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <span className="ml-auto font-mono text-[11px] text-dim">updated {ago(s.updatedAt)} ago</span>
                  <Button size="sm" variant="ghost" onClick={() => setRotating(s.name)}>
                    Rotate
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () =>
                      (await confirm({
                        title: `Delete secret ${s.name}?`,
                        description: "Actions that use it will fail until you add it again.",
                        confirmLabel: "Delete",
                        destructive: true,
                      })) && del.mutate(s.name)
                    }
                  >
                    Delete
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
