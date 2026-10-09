import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { CopyField, SettingsHeader, SettingsSection } from "../settings";
import { Avatar, Badge, Button, Input, Select } from "@/components/ui";
import { authClient, useSession } from "@/lib/auth";
import { ago } from "@/lib/utils";
import { qk, useWorkspace } from "@/lib/workspace";
import { useConfirm } from "@/components/ui/confirm";

export function MembersSettings() {
  const confirm = useConfirm();
  const { boot, wid, isAdmin } = useWorkspace();
  const { data: session } = useSession();
  const qc = useQueryClient();
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<"member" | "admin">("member");
  const [lastLink, setLastLink] = React.useState<string | null>(null);
  const invites = useQuery({
    queryKey: ["invites", wid],
    queryFn: async () => (await authClient.organization.listInvitations({ query: { organizationId: wid } })).data ?? [],
  });
  const invite = useMutation({
    mutationFn: async () => {
      const { data, error } = await authClient.organization.inviteMember({ email, role, organizationId: wid });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: (data) => {
      setEmail("");
      setLastLink(data ? `${location.origin}/invite/${data.id}` : null);
      qc.invalidateQueries({ queryKey: ["invites", wid] });
      toast.success("Invitation sent", { description: "Locally, emails land in Mailpit (http://localhost:8025)." });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const updateRole = useMutation({
    mutationFn: async ({ memberId, role }: { memberId: string; role: string }) => {
      const { error } = await authClient.organization.updateMemberRole({
        memberId,
        role: role as "member",
        organizationId: wid,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.boot(wid) }),
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: async (memberIdOrEmail: string) => {
      const { error } = await authClient.organization.removeMember({ memberIdOrEmail, organizationId: wid });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.boot(wid) }),
    onError: (e) => toast.error((e as Error).message),
  });
  const cancel = useMutation({
    mutationFn: async (invitationId: string) => {
      await authClient.organization.cancelInvitation({ invitationId });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invites", wid] }),
  });
  const pending = (invites.data ?? []).filter((i) => i.status === "pending");
  return (
    <div>
      <SettingsHeader
        title="Members"
        description="Everyone in this workspace can work tickets. Admins can change settings, channels and integrations."
      />
      {isAdmin ? (
        <SettingsSection
          title="Invite teammates"
          description="They get an email with a link. They can sign up with any email address."
        >
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              invite.mutate();
            }}
          >
            <Input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@company.com"
            />
            <Select className="w-32" value={role} onChange={(e) => setRole(e.target.value as "member")}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </Select>
            <Button variant="primary" loading={invite.isPending}>
              Invite
            </Button>
          </form>
          {lastLink ? <CopyField label="Or share the invitation link directly" value={lastLink} /> : null}
          {pending.length ? (
            <div className="flex flex-col border border-line">
              {pending.map((i) => (
                <div key={i.id} className="flex items-center gap-3 border-b border-line-2 px-3 py-2 last:border-b-0">
                  <span className="flex-1 truncate text-[12.5px] text-fg-3">{i.email}</span>
                  <Badge>{i.role}</Badge>
                  <span className="font-mono text-[11px] text-dim">pending · expires {ago(i.expiresAt)}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      navigator.clipboard
                        .writeText(`${location.origin}/invite/${i.id}`)
                        .then(() => toast("Link copied"))
                    }
                  >
                    Copy link
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => cancel.mutate(i.id)}>
                    Revoke
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </SettingsSection>
      ) : null}
      <SettingsSection title={`Team · ${boot.members.length}`}>
        <div className="flex flex-col border border-line">
          {boot.members.map((m) => (
            <div key={m.id} className="flex items-center gap-3 border-b border-line-2 px-3 py-2.5 last:border-b-0">
              <Avatar name={m.name} src={m.image} size={28} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13px] text-fg-2">
                  {m.name} {m.id === session?.user.id ? <span className="text-dim">(you)</span> : null}
                </span>
                <span className="font-mono text-[11.5px] text-dim">{m.email}</span>
              </div>
              {isAdmin && m.role !== "owner" && m.id !== session?.user.id ? (
                <>
                  <Select
                    className="h-7 w-28 text-[12px]"
                    value={m.role}
                    onChange={(e) => updateRole.mutate({ memberId: m.memberId, role: e.target.value })}
                  >
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () =>
                      (await confirm({
                        title: `Remove ${m.name}?`,
                        description: "They lose access to this workspace. Tickets assigned to them stay assigned.",
                        confirmLabel: "Remove",
                        destructive: true,
                      })) && remove.mutate(m.email)
                    }
                  >
                    Remove
                  </Button>
                </>
              ) : (
                <Badge tone={m.role === "owner" ? "accent" : "neutral"}>{m.role}</Badge>
              )}
            </div>
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}
