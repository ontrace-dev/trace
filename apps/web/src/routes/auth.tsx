import { Link, Navigate, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { Mark, Wordmark } from "@/components/logo";
import { TraceBackground } from "@/components/trace-bg";
import { ArrowRight, Fingerprint, KeyRound, Mail, ShieldCheck } from "lucide-react";
import { Button, Field, Input, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";
import { authClient, signIn, signUp, useSession } from "@/lib/auth";

function AuthFrame({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-bg">
      <TraceBackground />
      <div className="pointer-events-none absolute inset-y-0 left-1/2 hidden w-[1080px] -translate-x-1/2 border-x border-line-2 md:block" />
      <header className="relative flex h-14 shrink-0 items-center border-b border-line px-6 short:h-11">
        <Link to="/">
          <Wordmark />
        </Link>
      </header>
      <main className="relative flex flex-1 items-center justify-center px-4 py-10 short:py-5">
        {/* Keeps the brighter trace field from competing with the form. */}
        <div
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-1/2 h-[640px] w-[760px] -translate-1/2"
          style={{
            background:
              "radial-gradient(closest-side, var(--color-bg) 55%, color-mix(in srgb, var(--color-bg) 70%, transparent) 78%, transparent)",
          }}
        />
        <div className="relative w-full max-w-[400px]">
          <div className="mb-5 flex flex-col gap-2 short:mb-4">
            <h1 className="text-[22px] font-semibold tracking-tight text-fg">{title}</h1>
            {subtitle ? <p className="text-sm leading-relaxed text-muted tiny:hidden">{subtitle}</p> : null}
          </div>
          {children}
          {footer ? <div className="mt-5 text-xs text-dim short:mt-4">{footer}</div> : null}
        </div>
      </main>
      <footer className="relative border-t border-line px-6 py-4 font-mono text-[11px] tracking-wide text-dim short:hidden">
        trace — open source, AI-native support · MIT
      </footer>
    </div>
  );
}

function afterAuthPath(search: string) {
  const next = new URLSearchParams(search).get("next");
  return next && next.startsWith("/") ? next : "/";
}

interface DemoConfig {
  email: string;
  password: string;
  slug: string;
  resetHours: number;
  nextResetAt: string | null;
}

/** /api/config: sign-in providers and, on a shared demo instance, the demo account. */
function useConfig() {
  const [config, setConfig] = React.useState<{
    providers: string[];
    demo: DemoConfig | null;
    methods?: { sso: boolean; passkey: boolean; magicLink: boolean };
  } | null>(null);
  React.useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => {});
  }, []);
  return config;
}

/** One click into the shared demo workspace. */
function DemoEntry({ demo }: { demo: DemoConfig }) {
  const navigate = useNavigate();
  const [loading, setLoading] = React.useState(false);
  const enter = async () => {
    setLoading(true);
    const { error } = await signIn.email({ email: demo.email, password: demo.password });
    setLoading(false);
    if (error) return toast.error(error.message ?? "Could not open the demo");
    navigate({ to: "/w/$slug", params: { slug: demo.slug } });
  };
  return (
    <div className="mb-5 flex items-center gap-3 short:mb-4 border border-accent/30 bg-accent/[0.05] py-2.5 pr-2.5 pl-3.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[12.5px] font-medium text-fg">Try the shared demo</span>
        <span className="font-mono text-[11px] text-muted">
          sample tickets{demo.resetHours ? ` · resets every ${demo.resetHours}h` : ""}
        </span>
      </div>
      <Button variant="primary" className="h-[30px] shrink-0 gap-1.5 px-3" loading={loading} onClick={enter}>
        Enter the demo <ArrowRight />
      </Button>
    </div>
  );
}

const PROVIDER_LABEL: Record<string, string> = {
  github: "GitHub",
  google: "Google",
  microsoft: "Microsoft",
  gitlab: "GitLab",
};

type Step = "options" | "sso" | "magic" | "magic-sent" | "2fa";

/** Designed in pen.dev ("trace — Sign in (SSO, passkeys, 2FA)"). */
export function LoginPage() {
  const config = useConfig();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const [step, setStep] = React.useState<Step>(params.get("sso") ? "sso" : "options");
  const [email, setEmail] = React.useState(params.get("sso") ? `@${params.get("sso")}` : "");
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState<string | null>(null);
  const last = React.useMemo(() => {
    try {
      return authClient.getLastUsedLoginMethod();
    } catch {
      return null;
    }
  }, []);
  // Errors come back from OAuth/SSO redirects as ?error=…
  React.useEffect(() => {
    const err = params.get("error");
    if (err) toast.error(err.replace(/_/g, " ").toLowerCase());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const done = () => navigate({ to: afterAuthPath(location.search) as "/" });
  const callbackURL = afterAuthPath(location.search);
  const errorCallbackURL = "/login";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading("password");
    const { data, error } = await signIn.email({ email, password });
    setLoading(null);
    if (error) return toast.error(error.message ?? "Could not sign in");
    if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) return setStep("2fa");
    done();
  };
  const passkey = async () => {
    setLoading("passkey");
    const res = await authClient.signIn.passkey();
    setLoading(null);
    if (res?.error) return toast.error(res.error.message ?? "Passkey sign-in was cancelled");
    done();
  };

  if (step === "2fa") return <TwoFactorStep onDone={done} onBack={() => setStep("options")} />;
  if (step === "sso")
    return (
      <SsoStep
        initial={email.includes("@") ? email : ""}
        callbackURL={callbackURL}
        errorCallbackURL={errorCallbackURL}
        onBack={() => setStep("options")}
      />
    );
  if (step === "magic" || step === "magic-sent")
    return (
      <MagicStep
        email={email}
        setEmail={setEmail}
        sent={step === "magic-sent"}
        onSent={() => setStep("magic-sent")}
        onBack={() => setStep("options")}
      />
    );

  const methods = config?.methods;
  return (
    <AuthFrame
      title="Sign in to trace"
      subtitle="The helpdesk that resolves the ticket and shows you exactly how."
      footer={
        <>
          No account yet?{" "}
          <Link to="/signup" search={{}} className="text-fg-3 underline underline-offset-2 hover:text-fg">
            Create one
          </Link>
          {!config?.demo && import.meta.env.DEV ? (
            <div className="mt-3 font-mono text-[11.5px] text-dim">demo: demo@trace.dev / password</div>
          ) : null}
        </>
      }
    >
      {config?.demo ? <DemoEntry demo={config.demo} /> : null}
      <form onSubmit={submit} className="flex flex-col gap-4 short:gap-3">
        <Field label="Email">
          <Input
            type="email"
            autoFocus
            required
            autoComplete="username webauthn"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button variant="primary" className="mt-1 h-9 justify-center" loading={loading === "password"}>
          Sign in
        </Button>
      </form>
      {methods || config?.providers.length ? (
        <div className="mt-5 flex flex-col gap-2 short:mt-4">
          <div className="mb-3 flex items-center gap-2.5 font-mono short:mb-2 text-[11px] text-dim">
            <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
          </div>
          <div className="flex gap-2">
            {methods?.sso ? (
              <Method icon={<KeyRound />} label="SSO" last={last === "sso"} onClick={() => setStep("sso")} />
            ) : null}
            {methods?.passkey ? (
              <Method
                icon={<Fingerprint />}
                label="Passkey"
                last={last === "passkey"}
                loading={loading === "passkey"}
                onClick={passkey}
              />
            ) : null}
            {methods?.magicLink ? (
              <Method
                icon={<Mail />}
                label="Email link"
                last={last === "magic-link"}
                onClick={() => setStep("magic")}
              />
            ) : null}
          </div>
          {config?.providers.length ? (
            <div className="flex gap-2">
              {config.providers.map((p) => (
                <Method
                  key={p}
                  label={PROVIDER_LABEL[p] ?? p}
                  last={last === p}
                  onClick={() => signIn.social({ provider: p as "github", callbackURL, errorCallbackURL })}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </AuthFrame>
  );
}

/** One of the other ways in; the one used last on this device gets a dot. */
function Method({
  icon,
  label,
  last,
  loading,
  onClick,
}: {
  icon?: React.ReactNode;
  label: string;
  last: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      title={last ? "You used this last time" : undefined}
      className={cn("h-9 min-w-0 flex-1 justify-center gap-2 px-2", last && "border-accent/50")}
      loading={loading}
      onClick={onClick}
    >
      {icon}
      {label}
      {last ? (
        <>
          <span aria-hidden className="size-[5px] shrink-0 rounded-full bg-accent-text" />
          <span className="sr-only">(last used)</span>
        </>
      ) : null}
    </Button>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" onClick={onBack} className="mt-1 w-fit font-mono text-[11.5px] text-body hover:text-fg">
      ← other ways to sign in
    </button>
  );
}

function SsoStep({
  initial,
  callbackURL,
  errorCallbackURL,
  onBack,
}: {
  initial: string;
  callbackURL: string;
  errorCallbackURL: string;
  onBack: () => void;
}) {
  const [email, setEmail] = React.useState(initial);
  const [loading, setLoading] = React.useState(false);
  const [found, setFound] = React.useState<{ domain: string; via: string } | null | undefined>(undefined);
  React.useEffect(() => {
    setFound(undefined);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
    const t = setTimeout(() => {
      fetch(`/api/sso/lookup?email=${encodeURIComponent(email)}`)
        .then((r) => r.json())
        .then((r: { sso: { domain: string; via: string } | null }) => setFound(r.sso))
        .catch(() => setFound(null));
    }, 350);
    return () => clearTimeout(t);
  }, [email]);
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { data, error } = await authClient.signIn.sso({ email, callbackURL, errorCallbackURL });
    if (error) {
      setLoading(false);
      return toast.error(
        error.status === 404
          ? "No single sign-on is set up for this email's domain"
          : (error.message ?? "Could not start SSO"),
      );
    }
    if (data?.url) window.location.href = data.url;
  };
  return (
    <AuthFrame
      title="Sign in with SSO"
      subtitle="Enter your work email. We'll send you to your company's sign-in page."
    >
      <form onSubmit={go} className="flex flex-col gap-4 short:gap-3">
        <Field label="Work email">
          <Input
            type="email"
            autoFocus
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </Field>
        {found ? (
          <div className="flex items-center gap-2.5 border border-ok/25 bg-ok/[0.04] px-3 py-2.5 text-[12.5px] text-fg-2">
            <ShieldCheck className="size-3.5 shrink-0 text-ok" />
            {found.domain} signs in with {found.via}
          </div>
        ) : found === null ? (
          <p className="text-[12.5px] text-dim">No single sign-on is set up for this domain.</p>
        ) : null}
        <Button variant="primary" className="h-9 justify-center" loading={loading} disabled={found === null}>
          {found ? `Continue to ${found.via}` : "Continue"}
        </Button>
        <BackLink onBack={onBack} />
      </form>
    </AuthFrame>
  );
}

function MagicStep({
  email,
  setEmail,
  sent,
  onSent,
  onBack,
}: {
  email: string;
  setEmail: (v: string) => void;
  sent: boolean;
  onSent: () => void;
  onBack: () => void;
}) {
  const [loading, setLoading] = React.useState(false);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await authClient.signIn.magicLink({ email, callbackURL: afterAuthPath(location.search) });
    setLoading(false);
    if (error) return toast.error(error.message ?? "Could not send the link");
    onSent();
  };
  if (sent)
    return (
      <AuthFrame
        title="Check your inbox"
        subtitle={`We sent a sign-in link to ${email}. It works once and expires in 5 minutes.`}
      >
        <BackLink onBack={onBack} />
      </AuthFrame>
    );
  return (
    <AuthFrame title="Email me a sign-in link" subtitle="No password needed. The link signs you in on this device.">
      <form onSubmit={send} className="flex flex-col gap-4 short:gap-3">
        <Field label="Email">
          <Input
            type="email"
            autoFocus
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </Field>
        <Button variant="primary" className="h-9 justify-center" loading={loading}>
          Send link
        </Button>
        <BackLink onBack={onBack} />
      </form>
    </AuthFrame>
  );
}

/** Six boxes for the authenticator code, or a backup code. */
function TwoFactorStep({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const [code, setCode] = React.useState("");
  const [backup, setBackup] = React.useState(false);
  const [trust, setTrust] = React.useState(true);
  const [loading, setLoading] = React.useState(false);
  const verify = async (value = code) => {
    setLoading(true);
    const { error } = backup
      ? await authClient.twoFactor.verifyBackupCode({ code: value.trim(), trustDevice: trust })
      : await authClient.twoFactor.verifyTotp({ code: value, trustDevice: trust });
    setLoading(false);
    if (error) {
      setCode("");
      return toast.error(error.message ?? "That code didn't work");
    }
    onDone();
  };
  return (
    <AuthFrame
      title="Two-factor authentication"
      subtitle={
        backup ? "Enter one of the backup codes you saved." : "Enter the 6-digit code from your authenticator app."
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void verify();
        }}
        className="flex flex-col gap-4 short:gap-3"
      >
        {backup ? (
          <Input
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="xxxxx-xxxxx"
            className="h-10 font-mono"
          />
        ) : (
          <div className="relative">
            <input
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              aria-label="6-digit code"
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "").slice(0, 6);
                setCode(v);
                if (v.length === 6) void verify(v);
              }}
              className="absolute inset-0 z-10 opacity-0"
            />
            <div className="grid grid-cols-6 gap-2" aria-hidden>
              {Array.from({ length: 6 }, (_, i) => (
                <span
                  key={i}
                  className={cn(
                    "flex h-11 items-center justify-center border bg-input font-mono text-[18px] text-fg",
                    i === code.length ? "border-accent/60" : "border-line-strong",
                  )}
                >
                  {code[i] ?? ""}
                </span>
              ))}
            </div>
          </div>
        )}
        <label className="flex items-center gap-2 text-[12.5px] text-fg-2">
          <input
            type="checkbox"
            checked={trust}
            onChange={(e) => setTrust(e.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          Trust this device for 30 days
        </label>
        <Button variant="primary" className="h-9 justify-center" loading={loading}>
          Verify
        </Button>
        <button
          type="button"
          onClick={() => {
            setBackup(!backup);
            setCode("");
          }}
          className="w-fit font-mono text-[11.5px] text-body hover:text-fg"
        >
          {backup ? "use your authenticator app instead" : "lost your phone? use a backup code"}
        </button>
        <BackLink onBack={onBack} />
      </form>
    </AuthFrame>
  );
}

export function SignupPage() {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const navigate = useNavigate();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await signUp.email({ email, password, name });
    setLoading(false);
    if (error) return toast.error(error.message ?? "Could not create account");
    const next = afterAuthPath(location.search);
    navigate({ to: (next === "/" ? "/onboarding" : next) as "/" });
  };
  return (
    <AuthFrame
      title="Create your account"
      subtitle="Self-hosted, local-first and yours. Takes ten seconds."
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="text-fg-3 underline underline-offset-2 hover:text-fg">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4 short:gap-3">
        <Field label="Name">
          <Input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" />
        </Field>
        <Field label="Work email">
          <Input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          <Input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button variant="primary" className="mt-2 h-9 justify-center" loading={loading}>
          Create account
        </Button>
      </form>
    </AuthFrame>
  );
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .slice(0, 40);

export function OnboardingPage() {
  const { data: session, isPending } = useSession();
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const navigate = useNavigate();
  if (isPending) return <FullSpinner />;
  if (!session) return <Navigate to="/login" />;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { data, error } = await authClient.organization.create({ name, slug: slug || slugify(name) });
    setLoading(false);
    if (error || !data) return toast.error(error?.message ?? "Could not create workspace");
    await authClient.organization.setActive({ organizationId: data.id });
    navigate({ to: "/w/$slug", params: { slug: data.slug } });
  };
  return (
    <AuthFrame
      title="Create a workspace"
      subtitle="A workspace holds your inbox, channels, knowledge base and AI agent. Invite your team later."
    >
      <form onSubmit={submit} className="flex flex-col gap-4 short:gap-3">
        <Field label="Workspace name">
          <Input
            autoFocus
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!touched) setSlug(slugify(e.target.value));
            }}
            placeholder="Northwind"
          />
        </Field>
        <Field label="URL" hint={`trace/${slug || "your-team"}`}>
          <Input
            required
            value={slug}
            pattern="[a-z0-9-]+"
            onChange={(e) => {
              setTouched(true);
              setSlug(slugify(e.target.value));
            }}
          />
        </Field>
        <Button variant="primary" className="mt-2 h-9 justify-center" loading={loading}>
          Create workspace
        </Button>
      </form>
    </AuthFrame>
  );
}

export function InvitePage() {
  const { id } = useParams({ from: "/invite/$id" });
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const invite = useQuery({
    queryKey: ["invite", id],
    enabled: !!session,
    queryFn: async () => {
      const { data, error } = await authClient.organization.getInvitation({ query: { id } });
      if (error) throw new Error(error.message);
      return data;
    },
  });
  if (isPending) return <FullSpinner />;
  if (!session) return <Navigate to="/signup" search={{ next: `/invite/${id}` } as never} />;
  const accept = async () => {
    const { data, error } = await authClient.organization.acceptInvitation({ invitationId: id });
    if (error) return toast.error(error.message ?? "Could not accept invitation");
    const orgs = await authClient.organization.list();
    const org = orgs.data?.find((o) => o.id === data?.member.organizationId);
    navigate({ to: "/w/$slug", params: { slug: org?.slug ?? "" } });
  };
  return (
    <AuthFrame
      title="Join workspace"
      subtitle={
        invite.data
          ? `${invite.data.inviterEmail} invited you to ${invite.data.organizationName}.`
          : "Loading invitation…"
      }
    >
      {invite.error ? <p className="text-sm text-danger">{(invite.error as Error).message}</p> : null}
      <Button variant="primary" className="h-9 w-full justify-center" disabled={!invite.data} onClick={accept}>
        Accept invitation
      </Button>
    </AuthFrame>
  );
}

export function FullSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner />
    </div>
  );
}

/** "/" — send people to their workspace, onboarding, or the sign-in page. */
export function HomeRedirect() {
  const { data: session, isPending } = useSession();
  const orgs = useQuery({
    queryKey: ["orgs", session?.user.id],
    enabled: !!session,
    queryFn: async () => (await authClient.organization.list()).data ?? [],
  });
  if (isPending || (session && orgs.isPending)) return <FullSpinner />;
  if (!session) return <Navigate to="/login" />;
  const list = orgs.data ?? [];
  if (!list.length) return <Navigate to="/onboarding" />;
  const last = localStorage.getItem("trace:last-workspace");
  const target = list.find((o) => o.slug === last) ?? list[0]!;
  return <Navigate to="/w/$slug" params={{ slug: target.slug }} />;
}

export { Mark };
