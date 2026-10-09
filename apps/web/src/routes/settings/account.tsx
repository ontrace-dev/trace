import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Fingerprint, Key, Lock, Monitor, Plus, Smartphone } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { renderSVG } from "uqr";
import { SettingsHeader, SettingsSection } from "../settings";
import { Button, Dialog, Field, Input, Spinner } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm";
import { authClient, useSession } from "@/lib/auth";
import { cn, since } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

/* Designed in pen.dev ("trace — Settings · Account & security (app)"). Everything here is the signed-in
   person's own account, across all workspaces. */

const keys = {
  passkeys: ["account", "passkeys"] as const,
  sessions: ["account", "sessions"] as const,
  accounts: ["account", "accounts"] as const,
};

const PROVIDER_LABEL: Record<string, string> = {
  github: "GitHub",
  google: "Google",
  microsoft: "Microsoft",
  gitlab: "GitLab",
  credential: "Email & password",
};

const unwrap = <T,>(r: { data: T | null; error: { message?: string } | null }) => {
  if (r.error) throw new Error(r.error.message ?? "Request failed");
  return r.data as T;
};

function Row({
  icon,
  title,
  meta,
  tag,
  children,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  meta: React.ReactNode;
  tag?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[52px] items-center gap-3.5 border-b border-line-2 py-2">
      <span className="text-dim [&_svg]:size-[15px]">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2 text-[12.5px] text-fg-2">
          <span className="truncate">{title}</span>
          {tag}
        </span>
        <span className="truncate font-mono text-[11px] text-dim">{meta}</span>
      </div>
      {children}
    </div>
  );
}

export function AccountSettingsPage() {
  const accounts = useQuery({ queryKey: keys.accounts, queryFn: async () => unwrap(await authClient.listAccounts()) });
  const hasPassword = (accounts.data ?? []).some((a: { providerId: string }) => a.providerId === "credential");
  return (
    <div>
      <SettingsHeader
        title="Account & security"
        description="How you sign in to trace. These settings are yours; they apply in every workspace you're part of."
      />
      <Passkeys />
      <TwoFactor hasPassword={hasPassword} />
      <Password hasPassword={hasPassword} />
      <ConnectedLogins />
      <Sessions />
    </div>
  );
}

/* ------------------------------------------------------------------ passkeys */

function Passkeys() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const list = useQuery({
    queryKey: keys.passkeys,
    queryFn: async () => unwrap(await authClient.passkey.listUserPasskeys()),
  });
  const add = useMutation({
    mutationFn: async () => {
      const res = await authClient.passkey.addPasskey({ name: device(navigator.userAgent) });
      if (res?.error) throw new Error(res.error.message ?? "Cancelled");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.passkeys });
      toast.success("Passkey added. You can sign in with it now");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({
    mutationFn: async (id: string) => unwrap(await authClient.passkey.deletePasskey({ id })),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.passkeys }),
  });
  const passkeys = (list.data ?? []) as {
    id: string;
    name?: string | null;
    createdAt?: string | Date | null;
    deviceType: string;
  }[];
  return (
    <SettingsSection
      title="Passkeys"
      description="Sign in with Face ID, Touch ID, Windows Hello or a security key. Nothing to type, nothing to phish."
    >
      <div className="flex flex-col">
        {list.isPending ? <Spinner /> : null}
        {passkeys.map((p) => (
          <Row
            key={p.id}
            icon={p.deviceType === "singleDevice" ? <Key /> : <Fingerprint />}
            title={p.name || "Passkey"}
            meta={`${p.createdAt ? `added ${since(p.createdAt)} · ` : ""}${p.deviceType === "multiDevice" ? "synced across devices" : "this device only"}`}
          >
            <Button
              size="sm"
              onClick={async () =>
                (await confirm({
                  title: "Remove this passkey?",
                  description: "You won't be able to sign in with it anymore.",
                  confirmLabel: "Remove",
                  destructive: true,
                })) && del.mutate(p.id)
              }
            >
              Remove
            </Button>
          </Row>
        ))}
        {list.isSuccess && !passkeys.length ? <p className="pb-1 text-[12.5px] text-dim">No passkeys yet.</p> : null}
        <div className="pt-3.5">
          <Button size="sm" loading={add.isPending} onClick={() => add.mutate()}>
            <Plus /> Add a passkey
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------ two-factor */

function TwoFactor({ hasPassword }: { hasPassword: boolean }) {
  const { data: session, refetch } = useSession();
  const enabled = !!(session?.user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled;
  const [dialog, setDialog] = React.useState<"enable" | "disable" | "codes" | null>(null);
  return (
    <SettingsSection
      title="Two-factor authentication"
      description="A code from an authenticator app after your password. Passkeys and SSO don't need it."
    >
      <div className="flex items-center gap-3.5 pb-1">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-2 text-[12.5px] text-fg-2">
            <span className={cn("size-1.5", enabled ? "bg-ok" : "bg-white/30")} />
            {enabled ? "On · authenticator app" : "Off"}
          </span>
          <span className="font-mono text-[11px] text-dim">
            {enabled
              ? "you'll be asked for a code after your password"
              : hasPassword
                ? "recommended if you sign in with a password"
                : "you sign in without a password; passkeys and SSO are already strong"}
          </span>
        </div>
        {enabled ? (
          <>
            <Button size="sm" onClick={() => setDialog("codes")}>
              New backup codes
            </Button>
            <Button size="sm" onClick={() => setDialog("disable")}>
              Turn off
            </Button>
          </>
        ) : (
          <Button size="sm" variant="primary" disabled={!hasPassword} onClick={() => setDialog("enable")}>
            Turn on
          </Button>
        )}
      </div>
      <TwoFactorDialog
        mode={dialog}
        onClose={() => {
          setDialog(null);
          void refetch();
        }}
      />
    </SettingsSection>
  );
}

function BackupCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 border border-line bg-cell p-3 font-mono text-[12.5px] text-fg-2">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <Button
        size="sm"
        className="w-fit"
        onClick={() => {
          navigator.clipboard.writeText(codes.join("\n"));
          setCopied(true);
        }}
      >
        {copied ? <Check /> : <Copy />} Copy codes
      </Button>
      <p className="text-[12px] text-dim">
        Each code works once. Keep them somewhere safe: they get you in if you lose your phone.
      </p>
    </div>
  );
}

function TwoFactorDialog({ mode, onClose }: { mode: "enable" | "disable" | "codes" | null; onClose: () => void }) {
  const [password, setPassword] = React.useState("");
  const [setup, setSetup] = React.useState<{ uri: string; codes: string[] } | null>(null);
  const [code, setCode] = React.useState("");
  const [codes, setCodes] = React.useState<string[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    setPassword("");
    setSetup(null);
    setCode("");
    setCodes(null);
  }, [mode]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const secret = setup ? new URL(setup.uri).searchParams.get("secret") : null;
  const title =
    mode === "enable" ? "Turn on two-factor" : mode === "disable" ? "Turn off two-factor" : "New backup codes";
  let body: React.ReactNode;
  let action: React.ReactNode;
  if (codes) {
    body = <BackupCodes codes={codes} />;
    action = (
      <Button variant="primary" onClick={onClose}>
        Done
      </Button>
    );
  } else if (mode === "enable" && setup) {
    body = (
      <div className="flex flex-col gap-4">
        <p className="text-[12.5px] text-body">
          Scan this with your authenticator app (1Password, Authy, Google Authenticator), then enter the code it shows.
        </p>
        <div className="flex items-start gap-4">
          <div
            className="size-40 shrink-0 bg-white p-2 [&_svg]:size-full"
            // uqr renders a self-contained SVG from the otpauth URI.
            dangerouslySetInnerHTML={{ __html: renderSVG(setup.uri, { border: 1 }) }}
          />
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="font-mono text-[11px] text-dim">or enter this key</span>
            <code className="font-mono text-[12px] break-all text-fg-2">{secret}</code>
          </div>
        </div>
        <Field label="6-digit code">
          <Input
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="w-40 font-mono tracking-[0.3em]"
          />
        </Field>
      </div>
    );
    action = (
      <Button
        variant="primary"
        disabled={code.length !== 6}
        loading={busy}
        onClick={() =>
          run(async () => {
            unwrap(await authClient.twoFactor.verifyTotp({ code }));
            toast.success("Two-factor is on");
            setCodes(setup.codes);
          })
        }
      >
        Verify and turn on
      </Button>
    );
  } else {
    body = (
      <Field label="Your password" hint={mode === "disable" ? "Confirm it's you." : undefined}>
        <Input
          autoFocus
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
    );
    action = (
      <Button
        variant={mode === "disable" ? "danger" : "primary"}
        disabled={!password}
        loading={busy}
        onClick={() =>
          run(async () => {
            if (mode === "enable") {
              const r = unwrap(await authClient.twoFactor.enable({ password })) as {
                totpURI: string;
                backupCodes: string[];
              };
              setSetup({ uri: r.totpURI, codes: r.backupCodes });
            } else if (mode === "disable") {
              unwrap(await authClient.twoFactor.disable({ password }));
              toast.success("Two-factor is off");
              onClose();
            } else {
              const r = unwrap(await authClient.twoFactor.generateBackupCodes({ password })) as {
                backupCodes: string[];
              };
              setCodes(r.backupCodes);
            }
          })
        }
      >
        {mode === "disable" ? "Turn off" : "Continue"}
      </Button>
    );
  }
  return (
    <Dialog
      open={!!mode}
      onOpenChange={(v) => !v && onClose()}
      title={title}
      footer={
        <>
          {!codes ? (
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          ) : null}
          {action}
        </>
      }
    >
      {body}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ password */

function Password({ hasPassword }: { hasPassword: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [f, setF] = React.useState({ current: "", next: "", others: true });
  const [busy, setBusy] = React.useState(false);
  const change = async () => {
    setBusy(true);
    const { error } = await authClient.changePassword({
      currentPassword: f.current,
      newPassword: f.next,
      revokeOtherSessions: f.others,
    });
    setBusy(false);
    if (error) return toast.error(error.message ?? "Could not change the password");
    toast.success("Password changed");
    setOpen(false);
    setF({ current: "", next: "", others: true });
  };
  return (
    <SettingsSection
      title="Password"
      description="Used with your email. You can also sign in without one, using a passkey or a sign-in link."
    >
      <Row
        icon={<Lock />}
        title="Password"
        meta={hasPassword ? "set" : "you sign in without a password (passkey, link, SSO or a connected login)"}
      >
        {hasPassword ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            Change password
          </Button>
        ) : null}
      </Row>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Change password"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!f.current || f.next.length < 8} loading={busy} onClick={change}>
              Change password
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Current password">
            <Input
              autoFocus
              type="password"
              autoComplete="current-password"
              value={f.current}
              onChange={(e) => setF({ ...f, current: e.target.value })}
            />
          </Field>
          <Field label="New password" hint="At least 8 characters.">
            <Input
              type="password"
              autoComplete="new-password"
              value={f.next}
              onChange={(e) => setF({ ...f, next: e.target.value })}
            />
          </Field>
          <label className="flex items-center gap-2 text-[12.5px] text-fg-2">
            <input
              type="checkbox"
              checked={f.others}
              onChange={(e) => setF({ ...f, others: e.target.checked })}
              className="accent-[var(--color-accent)]"
            />
            Sign out my other devices
          </label>
        </div>
      </Dialog>
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------ connected logins */

function ConnectedLogins() {
  const { slug } = useWorkspace();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const accounts = useQuery({ queryKey: keys.accounts, queryFn: async () => unwrap(await authClient.listAccounts()) });
  const config = useQuery({
    queryKey: ["config"],
    queryFn: () => fetch("/api/config").then((r) => r.json() as Promise<{ providers: string[] }>),
    staleTime: Infinity,
  });
  const linked = (accounts.data ?? []) as {
    id: string;
    providerId: string;
    accountId: string;
    createdAt: string | Date;
  }[];
  const unlink = useMutation({
    mutationFn: async (id: string) => unwrap(await authClient.unlinkAccount({ accountId: id })),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.accounts }),
    onError: (e) => toast.error((e as Error).message),
  });
  const providers = [
    ...new Set([
      ...(config.data?.providers ?? []),
      ...linked.map((a) => a.providerId).filter((p) => p !== "credential"),
    ]),
  ];
  return (
    <SettingsSection
      title="Connected logins"
      description="Accounts you can sign in with. Google and Microsoft link automatically when the email matches."
    >
      <div className="flex flex-col">
        {!providers.length ? (
          <p className="text-[12.5px] text-dim">No social logins are configured on this trace server.</p>
        ) : (
          providers.map((p) => {
            const acc = linked.find((a) => a.providerId === p);
            return (
              <Row
                key={p}
                icon={<Monitor />}
                title={PROVIDER_LABEL[p] ?? p}
                meta={acc ? `connected ${since(acc.createdAt)}` : "not connected"}
              >
                {acc ? (
                  <Button
                    size="sm"
                    disabled={linked.length <= 1}
                    title={linked.length <= 1 ? "It's your only way to sign in" : undefined}
                    onClick={async () =>
                      (await confirm({
                        title: `Disconnect ${PROVIDER_LABEL[p] ?? p}?`,
                        description: "You won't be able to sign in with it until you connect it again.",
                        confirmLabel: "Disconnect",
                      })) && unlink.mutate(acc.id)
                    }
                  >
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() =>
                      authClient.linkSocial({ provider: p as "github", callbackURL: `/w/${slug}/settings/account` })
                    }
                  >
                    Connect
                  </Button>
                )}
              </Row>
            );
          })
        )}
      </div>
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------ sessions */

/** "Chrome on macOS" from a user agent. */
function device(ua: string | null | undefined) {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

function Sessions() {
  const qc = useQueryClient();
  const { data: session } = useSession();
  const list = useQuery({ queryKey: keys.sessions, queryFn: async () => unwrap(await authClient.listSessions()) });
  const revoke = useMutation({
    mutationFn: async (token: string) => unwrap(await authClient.revokeSession({ token })),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.sessions }),
  });
  const revokeOthers = useMutation({
    mutationFn: async () => unwrap(await authClient.revokeOtherSessions()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.sessions });
      toast.success("Signed out everywhere else");
    },
  });
  const sessions = (
    (list.data ?? []) as {
      id: string;
      token: string;
      ipAddress?: string | null;
      userAgent?: string | null;
      updatedAt: string | Date;
    }[]
  )
    .slice()
    .sort((a, b) =>
      a.id === session?.session.id
        ? -1
        : b.id === session?.session.id
          ? 1
          : +new Date(b.updatedAt) - +new Date(a.updatedAt),
    );
  return (
    <SettingsSection
      title="Sessions"
      description="Where you're signed in. Sign out anywhere you don't recognize."
      className="border-b-0"
    >
      <div className="flex flex-col">
        {list.isPending ? <Spinner /> : null}
        {sessions.map((s) => {
          const current = s.id === session?.session.id;
          const mobile = /iPhone|Android|iPad/.test(s.userAgent ?? "");
          return (
            <Row
              key={s.id}
              icon={mobile ? <Smartphone /> : <Monitor />}
              title={device(s.userAgent)}
              tag={current ? <span className="font-mono text-[11px] text-ok">current</span> : null}
              meta={`${s.ipAddress || "unknown IP"} · ${current ? "this device" : `active ${since(s.updatedAt)}`}`}
            >
              {!current ? (
                <Button
                  size="sm"
                  loading={revoke.isPending && revoke.variables === s.token}
                  onClick={() => revoke.mutate(s.token)}
                >
                  Sign out
                </Button>
              ) : null}
            </Row>
          );
        })}
        {sessions.length > 1 ? (
          <div className="pt-3.5">
            <Button size="sm" loading={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>
              Sign out everywhere else
            </Button>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
