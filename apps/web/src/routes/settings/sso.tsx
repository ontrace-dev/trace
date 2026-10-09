import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Copy, Plus, RefreshCw } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { SettingsHeader, SettingsSection } from "../settings";
import { Button, Dialog, Field, Input, Segmented, Select, Spinner, Switch, Textarea } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm";
import { authClient } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

/* Designed in pen.dev ("trace — Settings · Single sign-on (app)"). Providers live in Better Auth's SSO plugin. */

interface Provider {
  providerId: string;
  type: "oidc" | "saml";
  issuer: string;
  domain: string;
  organizationId: string | null;
  domainVerified: boolean;
  spMetadataUrl: string;
  oidcConfig?: { clientIdLastFour?: string; discoveryEndpoint?: string };
  samlConfig?: { entryPoint?: string; callbackUrl?: string; audience?: string };
}
type OidcDiscovery = {
  issuer: string;
  discoveryEndpoint: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksEndpoint: string;
  userInfoEndpoint?: string;
  tokenEndpointAuthentication: "client_secret_basic" | "client_secret_post";
};

type SsoSettings = { defaultRole: "member" | "admin"; enforcedDomains: string[] };

const keys = {
  providers: (wid: string) => ["sso", wid, "providers"] as const,
  settings: (wid: string) => ["sso", wid, "settings"] as const,
};

const domainsOf = (p: Provider) =>
  p.domain
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

export function SsoSettingsPage() {
  const { api, wid, isAdmin } = useWorkspace();
  const [adding, setAdding] = React.useState(false);
  const providers = useQuery({
    queryKey: keys.providers(wid),
    queryFn: async () => {
      const { data, error } = await authClient.sso.providers();
      if (error) throw new Error(error.message);
      return (data?.providers ?? []).filter((p) => p.organizationId === wid) as Provider[];
    },
  });
  const settings = useQuery({
    queryKey: keys.settings(wid),
    queryFn: () => api<{ settings: SsoSettings; authBaseUrl: string }>("/sso"),
  });
  const list = providers.data ?? [];
  const authBase = settings.data?.authBaseUrl ?? `${location.origin}/api/auth`;
  return (
    <div>
      <SettingsHeader
        title="Single sign-on"
        description="Let your team sign in with your identity provider: Okta, Microsoft Entra ID, Google Workspace, or any OIDC or SAML 2.0 provider. People join this workspace on their first sign-in."
      />
      <SettingsSection
        title="Providers"
        description="Each provider covers one or more email domains. trace only uses it after you prove you own the domain with a DNS record."
      >
        {providers.isPending ? (
          <Spinner />
        ) : providers.error ? (
          <p className="text-[12.5px] text-danger">{(providers.error as Error).message}</p>
        ) : (
          <div className="flex flex-col">
            {!list.length ? (
              <p className="pb-1 text-[12.5px] text-dim">No provider yet.</p>
            ) : (
              list.map((p) => <ProviderRow key={p.providerId} provider={p} authBase={authBase} />)
            )}
            <div className="pt-3.5">
              <Button size="sm" disabled={!isAdmin} onClick={() => setAdding(true)}>
                <Plus /> Add a provider
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>
      {settings.data ? <Joining initial={settings.data.settings} providers={list} /> : null}
      <AddProvider open={adding} onClose={() => setAdding(false)} authBase={authBase} />
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="grid grid-cols-[130px_1fr] items-center gap-3 py-1.5">
      <span className="font-mono text-[11px] text-dim">{label}</span>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        title="Copy"
        className="group flex h-7 min-w-0 items-center justify-between gap-2 border border-line-strong bg-input px-2.5 text-left font-mono text-[11.5px] text-fg-2 hover:border-white/30"
      >
        <span className="truncate">{value}</span>
        {copied ? (
          <Check className="size-3 shrink-0 text-ok" />
        ) : (
          <Copy className="size-3 shrink-0 text-dim group-hover:text-fg" />
        )}
      </button>
    </div>
  );
}

/** What to paste into the IdP for a provider. */
function IdpValues({ type, providerId, authBase }: { type: "oidc" | "saml"; providerId: string; authBase: string }) {
  const id = providerId || "<provider id>";
  return type === "oidc" ? (
    <>
      <CopyRow label="redirect URI" value={`${authBase}/sso/callback/${id}`} />
      <CopyRow label="scopes" value="openid email profile" />
    </>
  ) : (
    <>
      <CopyRow label="ACS URL" value={`${authBase}/sso/saml2/sp/acs/${id}`} />
      <CopyRow label="entity ID / audience" value={`${authBase}/sso/saml2/sp/metadata?providerId=${id}`} />
      <CopyRow label="SP metadata" value={`${authBase}/sso/saml2/sp/metadata?providerId=${id}`} />
    </>
  );
}

function ProviderRow({ provider: p, authBase }: { provider: Provider; authBase: string }) {
  const { wid, isAdmin, slug } = useWorkspace();
  const name = p.providerId.startsWith(`${slug}-`) ? p.providerId.slice(slug.length + 1) : p.providerId;
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [open, setOpen] = React.useState(!p.domainVerified);
  const host = (() => {
    try {
      return new URL(p.issuer).hostname;
    } catch {
      return p.issuer;
    }
  })();
  // The DNS token is (re)issued on demand; an active one is returned unchanged.
  const token = useQuery({
    queryKey: ["sso", wid, "token", p.providerId],
    enabled: !p.domainVerified && isAdmin,
    queryFn: async () => {
      const { data, error } = await authClient.sso.requestDomainVerification({ providerId: p.providerId });
      if (error) throw new Error(error.message);
      return (data as { domainVerificationToken: string }).domainVerificationToken;
    },
    staleTime: Infinity,
  });
  const verify = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.sso.verifyDomain({ providerId: p.providerId });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success(`${p.domain} verified. People can sign in now`);
      qc.invalidateQueries({ queryKey: keys.providers(wid) });
    },
    onError: (e) =>
      toast.error("Not verified yet", {
        description: `${(e as Error).message}. DNS changes can take a few minutes to show up.`,
      }),
  });
  const del = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.sso.deleteProvider({ providerId: p.providerId });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.providers(wid) }),
    onError: (e) => toast.error((e as Error).message),
  });
  const ident = `_trace-verify-${p.providerId}`;
  return (
    <div className="flex flex-col border-b border-line-2 py-3.5">
      <div className="flex items-center gap-3.5">
        <button onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 flex-col gap-1 text-left">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] text-fg-2">{name}</span>
            <span className="font-mono text-[11px] text-dim">{p.type.toUpperCase()}</span>
            <span className={cn("size-[5px]", p.domainVerified ? "bg-ok" : "bg-warn")} />
            <span className={cn("font-mono text-[11px]", p.domainVerified ? "text-ok" : "text-warn")}>
              {p.domain} {p.domainVerified ? "verified" : "not verified yet"}
            </span>
          </span>
          <span className="flex items-center gap-1 font-mono text-[11px] text-dim">
            {host}
            {p.oidcConfig?.clientIdLastFour ? ` · client …${p.oidcConfig.clientIdLastFour.replace(/^\*+/, "")}` : ""}
            <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
          </span>
        </button>
        {!p.domainVerified ? (
          <Button size="sm" disabled={!isAdmin} loading={verify.isPending} onClick={() => verify.mutate()}>
            <RefreshCw /> Check now
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={!isAdmin}
          onClick={async () =>
            (await confirm({
              title: `Remove ${name}?`,
              description: `People from ${p.domain} can't sign in with it anymore. Their accounts and tickets stay.`,
              confirmLabel: "Remove",
              destructive: true,
            })) && del.mutate()
          }
        >
          Remove
        </Button>
      </div>
      {open ? (
        <div className="mt-3 flex flex-col gap-3">
          {!p.domainVerified ? (
            <div className="flex flex-col border border-warn/20 bg-warn/[0.03] px-3.5 py-2">
              <span className="py-1 text-[12px] text-body">Add this TXT record at your DNS provider, then check:</span>
              {token.data ? (
                domainsOf(p).map((d) => (
                  <React.Fragment key={d}>
                    <CopyRow label="type" value="TXT" />
                    <CopyRow label="name" value={`${ident}.${d}`} />
                    <CopyRow label="value" value={`${ident}=${token.data}`} />
                  </React.Fragment>
                ))
              ) : token.error ? (
                <span className="py-1 text-[12px] text-danger">{(token.error as Error).message}</span>
              ) : (
                <Spinner />
              )}
            </div>
          ) : null}
          <div className="flex flex-col">
            <span className="pb-1 font-mono text-[11px] tracking-[0.1em] text-dim uppercase">values for your IdP</span>
            <IdpValues type={p.type} providerId={p.providerId} authBase={authBase} />
            <CopyRow label="sign-in link" value={`${location.origin}/login?sso=${domainsOf(p)[0] ?? ""}`} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Joining({ initial, providers }: { initial: SsoSettings; providers: Provider[] }) {
  const { api, wid, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const [s, setS] = React.useState(initial);
  React.useEffect(() => setS(initial), [initial]);
  const save = useMutation({
    mutationFn: (next: SsoSettings) => api("/sso", { method: "PUT", json: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.settings(wid) });
      toast.success("Saved");
    },
    onError: (e) => {
      setS(initial);
      toast.error((e as Error).message);
    },
  });
  const update = (next: SsoSettings) => {
    setS(next);
    save.mutate(next);
  };
  const verified = [...new Set(providers.filter((p) => p.domainVerified).flatMap(domainsOf))];
  return (
    <SettingsSection
      title="Joining & enforcement"
      description="What happens when someone signs in through your provider for the first time."
      className="border-b-0"
    >
      <label className="flex items-center gap-3 text-[13px] text-fg-2">
        New people join as
        <Select
          value={s.defaultRole}
          disabled={!isAdmin}
          onChange={(e) => update({ ...s, defaultRole: e.target.value as SsoSettings["defaultRole"] })}
          className="h-8 w-36"
        >
          <option value="member">member</option>
          <option value="admin">admin</option>
        </Select>
      </label>
      <div className="flex flex-col border-t border-line-2">
        {!verified.length ? (
          <p className="pt-3 text-[12.5px] text-dim">Verify a domain to require SSO for it.</p>
        ) : (
          verified.map((d) => {
            const on = s.enforcedDomains.includes(d);
            return (
              <div key={d} className="flex items-center gap-3.5 border-b border-line-2 py-3 last:border-b-0">
                <Switch
                  checked={on}
                  disabled={!isAdmin}
                  onCheckedChange={(v) =>
                    update({
                      ...s,
                      enforcedDomains: v ? [...s.enforcedDomains, d] : s.enforcedDomains.filter((x) => x !== d),
                    })
                  }
                />
                <div className="flex flex-col gap-1">
                  <span className="text-[13px] text-fg-2">Require SSO for {d}</span>
                  <span className="font-mono text-[11px] text-dim">
                    passwords, sign-in links, passkeys and social logins stop working for these addresses
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </SettingsSection>
  );
}

function AddProvider({ open, onClose, authBase }: { open: boolean; onClose: () => void; authBase: string }) {
  const { api, wid, slug: workspaceSlug } = useWorkspace();
  const qc = useQueryClient();
  const [type, setType] = React.useState<"oidc" | "saml">("oidc");
  const [f, setF] = React.useState({
    providerId: "",
    domain: "",
    issuer: "",
    clientId: "",
    clientSecret: "",
    entryPoint: "",
    entityId: "",
    cert: "",
    metadata: "",
  });
  React.useEffect(() => {
    if (open)
      setF({
        providerId: "",
        domain: "",
        issuer: "",
        clientId: "",
        clientSecret: "",
        entryPoint: "",
        entityId: "",
        cert: "",
        metadata: "",
      });
  }, [open]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: e.target.value });
  // Provider ids are unique across the whole server, so they carry the workspace: "northwind-okta".
  const name = f.providerId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const slug = name ? `${workspaceSlug}-${name}` : "";
  const register = useMutation({
    mutationFn: async () => {
      const issuer = f.issuer.trim().replace(/\/+$/, "");
      const base = { providerId: slug, domain: f.domain.trim().toLowerCase(), organizationId: wid };
      // The server fetches the IdP's discovery document (public hosts only) and we register its endpoints.
      const discovered =
        type === "oidc" ? await api<OidcDiscovery>("/sso/discover", { method: "POST", json: { issuer } }) : null;
      const res = discovered
        ? await authClient.sso.register({
            ...base,
            issuer: discovered.issuer,
            oidcConfig: {
              clientId: f.clientId.trim(),
              clientSecret: f.clientSecret.trim(),
              discoveryEndpoint: discovered.discoveryEndpoint,
              authorizationEndpoint: discovered.authorizationEndpoint,
              tokenEndpoint: discovered.tokenEndpoint,
              jwksEndpoint: discovered.jwksEndpoint,
              userInfoEndpoint: discovered.userInfoEndpoint,
              tokenEndpointAuthentication: discovered.tokenEndpointAuthentication,
              skipDiscovery: true,
              scopes: ["openid", "email", "profile"],
              pkce: true,
            },
          })
        : await authClient.sso.register({
            ...base,
            issuer: f.entityId.trim() || issuer,
            samlConfig: {
              entryPoint: f.entryPoint.trim(),
              ...(f.cert.trim() ? { cert: f.cert.trim() } : {}),
              callbackUrl: `${authBase}/sso/saml2/sp/acs/${slug}`,
              audience: `${authBase}/sso/saml2/sp/metadata?providerId=${slug}`,
              idpMetadata: f.metadata.trim() ? { metadata: f.metadata.trim() } : { entityID: f.entityId.trim() },
              spMetadata: {},
            },
          } as never);
      if (res.error) throw new Error(res.error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.providers(wid) });
      toast.success("Provider added. Verify the domain to turn it on");
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const ready =
    slug.length >= 2 &&
    /\./.test(f.domain) &&
    (type === "oidc"
      ? /^https?:\/\//.test(f.issuer) && f.clientId && f.clientSecret
      : /^https?:\/\//.test(f.entryPoint) && (f.metadata.trim() || (f.entityId.trim() && f.cert.trim())));
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title="Add an identity provider"
      description="Create an app in your IdP with the values below, then fill in what it gives you."
      className="w-[min(680px,calc(100vw-32px))]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} loading={register.isPending} onClick={() => register.mutate()}>
            Add provider
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Segmented
          value={type}
          onChange={setType}
          options={[
            { value: "oidc", label: "OIDC (Okta, Entra ID, Google)" },
            { value: "saml", label: "SAML 2.0" },
          ]}
          className="h-8 w-fit border border-line-strong"
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" hint="Short name, e.g. okta">
            <Input autoFocus value={f.providerId} onChange={set("providerId")} placeholder="e.g. okta" />
          </Field>
          <Field label="Email domain" hint="Comma-separate several">
            <Input value={f.domain} onChange={set("domain")} placeholder="e.g. northwind.io" />
          </Field>
        </div>
        <div className="flex flex-col border border-line bg-cell px-3 py-1.5">
          <span className="py-1 font-mono text-[11px] tracking-[0.1em] text-dim uppercase">paste into your IdP</span>
          <IdpValues type={type} providerId={slug} authBase={authBase} />
        </div>
        {type === "oidc" ? (
          <>
            <Field
              label="Issuer URL"
              hint="e.g. https://northwind.okta.com or https://login.microsoftonline.com/<tenant>/v2.0"
            >
              <Input
                value={f.issuer}
                onChange={set("issuer")}
                placeholder="e.g. https://northwind.okta.com"
                className="font-mono"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Client ID">
                <Input value={f.clientId} onChange={set("clientId")} className="font-mono" />
              </Field>
              <Field label="Client secret" hint="Stored server-side, never shown again">
                <Input type="password" autoComplete="off" value={f.clientSecret} onChange={set("clientSecret")} />
              </Field>
            </div>
          </>
        ) : (
          <>
            <Field label="IdP sign-in URL (SSO URL)">
              <Input
                value={f.entryPoint}
                onChange={set("entryPoint")}
                placeholder="e.g. https://idp.example.com/sso/saml"
                className="font-mono"
              />
            </Field>
            <Field label="IdP metadata XML" hint="Paste it, or fill in entity ID and certificate instead.">
              <Textarea
                rows={3}
                value={f.metadata}
                onChange={set("metadata")}
                className="font-mono text-[11.5px]"
                spellCheck={false}
              />
            </Field>
            {!f.metadata.trim() ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="IdP entity ID">
                  <Input value={f.entityId} onChange={set("entityId")} className="font-mono" />
                </Field>
                <Field label="Signing certificate (PEM)">
                  <Textarea
                    rows={2}
                    value={f.cert}
                    onChange={set("cert")}
                    className="font-mono text-[11px]"
                    spellCheck={false}
                  />
                </Field>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  );
}
