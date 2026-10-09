import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  Eye,
  EyeOff,
  HandMetal,
  MessageCircle,
  CircleHelp,
  Plus,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { CopyField, SettingsHeader } from "../settings";
import { Button, Field, Input, Select, Segmented, Spinner, Switch, Textarea } from "@/components/ui";
import type { WidgetSettings, WorkspaceSettings } from "@/lib/types";
import { cn } from "@/lib/utils";
import { qk, useWorkspace } from "@/lib/workspace";
import { useConfirm } from "@/components/ui/confirm";

type Draft = WidgetSettings;

const launcherIcons: {
  value: Draft["launcherIcon"];
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { value: "chat", label: "Chat", icon: MessageCircle },
  { value: "help", label: "Help", icon: CircleHelp },
  { value: "sparkle", label: "Sparkle", icon: Sparkles },
  { value: "wave", label: "Wave", icon: HandMetal },
];

const fonts = [
  { value: "", label: "System default" },
  { value: "Inter", label: "Inter" },
  { value: "Geist", label: "Geist" },
  { value: "Georgia", label: "Georgia (serif)" },
  { value: "ui-rounded", label: "Rounded" },
  { value: "ui-monospace", label: "Monospace" },
];

function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(30));
  return Array.from(bytes, (b) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[b % 62]).join("");
}

/** Widget customization + install snippet, with a live preview of the real widget bundle. */
export function WidgetSettingsPage() {
  const { wid, api, boot, isAdmin } = useWorkspace();
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: qk.settings(wid),
    queryFn: () => api<{ settings: WorkspaceSettings }>("/settings"),
  });
  const saved = settings.data?.settings.widget;
  const [draft, setDraft] = React.useState<Draft | null>(null);
  React.useEffect(() => {
    if (saved && !draft) setDraft(saved);
  }, [saved, draft]);

  const save = useMutation({
    mutationFn: (widget: Draft) =>
      api<{ settings: WorkspaceSettings }>("/settings", { method: "PATCH", json: { widget } }),
    onSuccess: (res) => {
      qc.setQueryData(qk.settings(wid), res);
      qc.invalidateQueries({ queryKey: qk.boot(wid) });
      setDraft(res.settings.widget);
      toast.success("Widget saved — live on your site within a few minutes");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!draft || !saved) {
    return (
      <div className="flex h-60 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const publicUrl = boot.env.publicUrl.replace(/\/$/, "");
  const key = boot.settings.widgetKey;
  const snippet = `<script>window.Trace=window.Trace||function(){(Trace.q=Trace.q||[]).push(arguments)};</script>\n<script src="${publicUrl}/widget.js" data-key="${key}" async></script>`;
  const demoUrl = `${publicUrl}/api/widget/demo?key=${key}`;

  return (
    <div className="flex min-h-full flex-col">
      <SettingsHeader
        title="Chat widget"
        description="Embed trace on your website. Visitors chat with your AI agent first; anything it can't resolve lands in your inbox with full context."
      >
        <Button variant="ghost" size="sm" onClick={() => window.open(demoUrl, "_blank")}>
          <ExternalLink /> Open demo page
        </Button>
      </SettingsHeader>

      <div className="grid flex-1 gap-0 xl:grid-cols-[minmax(0,1fr)_460px]">
        <fieldset disabled={!isAdmin} className="min-w-0 border-line xl:border-r">
          {!isAdmin ? (
            <div className="border-b border-line px-8 py-3 text-xs text-warn">Only admins can change the widget.</div>
          ) : null}

          <Group label="Install" description="Paste before </body> on every page where the widget should appear.">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-fg-2">Embed snippet</span>
              <div className="relative border border-line-strong bg-input">
                <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-fg-3">
                  {snippet}
                </pre>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(snippet);
                    toast.success("Snippet copied");
                  }}
                  className="absolute top-2 right-2 border border-line-strong bg-bar px-2 py-0.5 font-mono text-[11.5px] text-muted hover:text-fg"
                >
                  copy
                </button>
              </div>
            </div>
            <CopyField label="Public widget key" value={key} />
            <details className="text-xs text-muted">
              <summary className="cursor-pointer text-fg-3 select-none">JavaScript API & options</summary>
              <pre className="mt-2 overflow-x-auto border border-line bg-cell px-3 py-2.5 font-mono text-[11px] leading-relaxed text-body">{`Trace("open")  ·  Trace("close")  ·  Trace("toggle")
Trace("identify", { email, name, userId, userHash, attributes })
Trace("update", { accentColor: "#0f766e", position: "left" })
Trace("on", "message", (msg) => …)   // also "open" | "close"
Trace("shutdown")                     // e.g. on logout

<script … data-position="left" data-accent="#0f766e"
        data-theme="dark" data-open data-hide-launcher>
<button data-trace-open>Contact support</button>  // any element opens the widget`}</pre>
            </details>
          </Group>

          <Group label="Appearance">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Accent color">
                <ColorInput value={draft.accentColor} onChange={(v) => set("accentColor", v)} />
              </Field>
              <Field label="Text on accent" hint="Auto picks black or white for contrast.">
                <div className="flex items-center gap-2">
                  <Segmented
                    value={draft.accentForeground ? "custom" : "auto"}
                    onChange={(v) => set("accentForeground", v === "auto" ? "" : "#ffffff")}
                    options={[
                      { value: "auto", label: "Auto" },
                      { value: "custom", label: "Custom" },
                    ]}
                  />
                  {draft.accentForeground ? (
                    <ColorInput value={draft.accentForeground} onChange={(v) => set("accentForeground", v)} />
                  ) : null}
                </div>
              </Field>
              <Field label="Theme">
                <Segmented
                  value={draft.theme}
                  onChange={(v) => set("theme", v)}
                  options={[
                    { value: "auto", label: "Auto" },
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark" },
                  ]}
                />
              </Field>
              <Field label="Position">
                <Segmented
                  value={draft.position}
                  onChange={(v) => set("position", v)}
                  options={[
                    { value: "left", label: "Bottom left" },
                    { value: "right", label: "Bottom right" },
                  ]}
                />
              </Field>
              <Field label={`Horizontal offset · ${draft.offsetX}px`}>
                <Range value={draft.offsetX} min={0} max={80} onChange={(v) => set("offsetX", v)} />
              </Field>
              <Field label={`Vertical offset · ${draft.offsetY}px`}>
                <Range value={draft.offsetY} min={0} max={120} onChange={(v) => set("offsetY", v)} />
              </Field>
              <Field label={`Corner radius · ${draft.radius}px`}>
                <Range value={draft.radius} min={0} max={28} onChange={(v) => set("radius", v)} />
              </Field>
              <Field label="Font" hint="Uses your site's font if it is already loaded.">
                <Select
                  value={fonts.some((f) => f.value === draft.fontFamily) ? draft.fontFamily : "__custom"}
                  onChange={(e) =>
                    set(
                      "fontFamily",
                      e.target.value === "__custom" ? draft.fontFamily || "Helvetica Neue" : e.target.value,
                    )
                  }
                >
                  {fonts.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                  <option value="__custom">Custom…</option>
                </Select>
                {!fonts.some((f) => f.value === draft.fontFamily) ? (
                  <Input
                    className="mt-2"
                    value={draft.fontFamily}
                    onChange={(e) => set("fontFamily", e.target.value)}
                    placeholder="e.g. 'Söhne', Helvetica"
                  />
                ) : null}
              </Field>
            </div>
            <Field label="Launcher">
              <div className="flex flex-wrap items-center gap-2">
                {launcherIcons.map((l) => (
                  <button
                    key={l.value}
                    type="button"
                    onClick={() => set("launcherIcon", l.value)}
                    className={cn(
                      "flex h-8 items-center gap-1.5 border px-2.5 text-xs",
                      draft.launcherIcon === l.value
                        ? "border-accent/60 accent-soft text-accent-fg"
                        : "border-line-strong text-muted hover:text-fg",
                    )}
                  >
                    <l.icon className="size-[13px]" /> {l.label}
                  </button>
                ))}
                <Input
                  className="w-56"
                  value={draft.launcherText}
                  onChange={(e) => set("launcherText", e.target.value)}
                  placeholder="Optional label, e.g. “Help”"
                  maxLength={24}
                />
              </div>
            </Field>
            <Field
              label="Avatar image URL"
              hint="Shown in the header and next to AI replies. Defaults to your workspace initials."
            >
              <Input
                value={draft.avatarUrl}
                onChange={(e) => set("avatarUrl", e.target.value)}
                placeholder="https://…/avatar.png"
              />
            </Field>
          </Group>

          <Group label="Messaging">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Title">
                <Input value={draft.title} onChange={(e) => set("title", e.target.value)} />
              </Field>
              <Field label="Agent name" hint="Shown as the sender of AI replies.">
                <Input value={draft.agentName} onChange={(e) => set("agentName", e.target.value)} />
              </Field>
            </div>
            <Field label="Subtitle">
              <Input value={draft.subtitle} onChange={(e) => set("subtitle", e.target.value)} />
            </Field>
            <Field label="Greeting" hint="The first message visitors see when they start a conversation.">
              <Textarea rows={2} value={draft.greeting} onChange={(e) => set("greeting", e.target.value)} />
            </Field>
            <Field label="Suggested questions" hint="One-tap starters shown under the greeting.">
              <div className="flex flex-col gap-2">
                {draft.suggestions.map((s, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      value={s}
                      onChange={(e) =>
                        set(
                          "suggestions",
                          draft.suggestions.map((x, j) => (j === i ? e.target.value : x)),
                        )
                      }
                    />
                    <Button
                      type="button"
                      size="icon"
                      className="h-8 w-8"
                      aria-label="Remove suggestion"
                      onClick={() =>
                        set(
                          "suggestions",
                          draft.suggestions.filter((_, j) => j !== i),
                        )
                      }
                    >
                      <X />
                    </Button>
                  </div>
                ))}
                {draft.suggestions.length < 6 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="self-start"
                    onClick={() => set("suggestions", [...draft.suggestions, ""])}
                  >
                    <Plus /> Add suggestion
                  </Button>
                ) : null}
              </div>
            </Field>
          </Group>

          <Group label="Behavior">
            <Toggle
              label="AI instant answers"
              description="Your AI agent replies immediately when it's confident; otherwise it tells the visitor a human will follow up."
              checked={draft.aiInstantAnswers}
              onChange={(v) => set("aiInstantAnswers", v)}
            />
            <Toggle
              label="Require email before chatting"
              description="Ask anonymous visitors for an email so you can follow up after they leave."
              checked={draft.requireEmail}
              onChange={(v) => set("requireEmail", v)}
            />
            <Toggle
              label="Show “Powered by trace”"
              checked={draft.showPoweredBy}
              onChange={(v) => set("showPoweredBy", v)}
            />
            <Field
              label="Allowed websites"
              hint="One per line, e.g. acme.com, *.acme.com or https://app.acme.com. Leave empty to allow any site."
            >
              <Textarea
                rows={3}
                className="font-mono text-[12px]"
                value={draft.allowedOrigins.join("\n")}
                onChange={(e) =>
                  set(
                    "allowedOrigins",
                    e.target.value.split("\n").map((s) => s.trim()),
                  )
                }
                onBlur={() => set("allowedOrigins", draft.allowedOrigins.filter(Boolean))}
                placeholder={"acme.com\n*.acme.com"}
              />
            </Field>
          </Group>

          <Group label="Advanced">
            <IdentitySecret
              secret={draft.identitySecret ?? ""}
              onRotate={() => set("identitySecret", randomSecret())}
            />
            <Field
              label="Custom CSS"
              hint="Injected into the widget's shadow root. Target classes like .launcher, .panel, .head, .bubble, .msg.me .bubble, .chip."
            >
              <Textarea
                rows={6}
                spellCheck={false}
                className="font-mono text-[12px]"
                value={draft.customCss}
                onChange={(e) => set("customCss", e.target.value)}
                placeholder={".head h2 { letter-spacing: -0.03em; }\n.msg.me .bubble { border-radius: 4px; }"}
              />
            </Field>
          </Group>
          <div className="h-20" />
        </fieldset>

        <aside className="min-w-0 border-t border-line xl:border-t-0">
          <div className="sticky top-0 flex flex-col gap-3 p-6">
            <Preview draft={draft} widgetKey={key} />
          </div>
        </aside>
      </div>

      {dirty ? (
        <div className="sticky bottom-0 z-10 flex items-center justify-between gap-4 border-t border-line-strong bg-bar/95 px-8 py-3 backdrop-blur">
          <span className="flex items-center gap-2 text-xs text-fg-3">
            <span className="h-1.5 w-1.5 bg-warn" /> Unsaved changes — the preview already shows them.
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDraft(saved)}>
              Discard
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={save.isPending}
              onClick={() =>
                save.mutate({
                  ...draft,
                  suggestions: draft.suggestions.map((s) => s.trim()).filter(Boolean),
                  allowedOrigins: draft.allowedOrigins.filter(Boolean),
                })
              }
            >
              Save changes
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Group({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-b border-line px-8 py-6">
      <div className="flex flex-col gap-1">
        <span className="label-mono">{label}</span>
        {description ? <span className="text-xs text-dim">{description}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="flex flex-col gap-0.5">
        <span className="text-[12.5px] text-fg-2">{label}</span>
        {description ? <span className="text-xs leading-relaxed text-dim">{description}</span> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [text, setText] = React.useState(value);
  React.useEffect(() => setText(value), [value]);
  return (
    <div className="flex h-8 items-stretch border border-line-strong bg-input">
      <label className="relative w-8 shrink-0 cursor-pointer border-r border-line-strong" style={{ background: value }}>
        <input
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
      <input
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (/^#[0-9a-f]{6}$/i.test(e.target.value)) onChange(e.target.value);
        }}
        className="w-full min-w-0 bg-transparent px-2 font-mono text-[12px] text-fg-3 focus:outline-none"
        spellCheck={false}
      />
    </div>
  );
}

function Range({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-8 w-full accent-[var(--color-accent)]"
    />
  );
}

function IdentitySecret({ secret, onRotate }: { secret: string; onRotate: () => void }) {
  const confirm = useConfirm();
  const [show, setShow] = React.useState(false);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-fg-2">Identity verification secret</span>
      <p className="text-xs leading-relaxed text-dim">
        Sign the logged-in user's id on your server so visitors can't impersonate each other. Verified visitors see all
        their past conversations across devices. Never expose this secret in the browser.
      </p>
      <div className="flex items-stretch border border-line-strong bg-input">
        <code className="flex-1 overflow-x-auto px-2.5 py-2 font-mono text-[12px] whitespace-nowrap text-fg-3">
          {show ? secret : "•".repeat(Math.min(secret.length, 40))}
        </code>
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="border-l border-line-strong px-2.5 text-muted hover:text-fg"
          aria-label="Reveal secret"
        >
          {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(secret);
            toast.success("Secret copied");
          }}
          className="border-l border-line-strong px-3 font-mono text-[11.5px] text-muted hover:text-fg"
        >
          copy
        </button>
        <button
          type="button"
          onClick={async () => {
            const ok = await confirm({
              title: "Rotate identity secret?",
              description: "Existing userHash values stop verifying until your server signs with the new secret.",
              confirmLabel: "Rotate",
              destructive: true,
            });
            if (ok) onRotate();
          }}
          className="border-l border-line-strong px-2.5 text-muted hover:text-fg"
          aria-label="Rotate secret"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      <pre className="overflow-x-auto border border-line bg-cell px-3 py-2.5 font-mono text-[11px] leading-relaxed text-body">{`// server (Node)
import { createHmac } from "node:crypto";
const userHash = createHmac("sha256", process.env.TRACE_WIDGET_SECRET)
  .update(user.id)            // or user.email when you don't pass userId
  .digest("hex");

// browser
Trace("identify", { userId: user.id, email: user.email, name: user.name, userHash });`}</pre>
    </div>
  );
}

/**
 * Renders the real widget bundle inside an iframe. Unsaved settings are pushed with
 * postMessage → Trace("update", …), so every change shows instantly.
 */
function Preview({ draft, widgetKey }: { draft: Draft; widgetKey: string }) {
  const ref = React.useRef<HTMLIFrameElement>(null);
  const [page, setPage] = React.useState<"light" | "dark">("light");
  const [nonce, setNonce] = React.useState(0);
  const srcDoc = React.useMemo(
    () => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%}
body{font-family:ui-sans-serif,system-ui,sans-serif;background:${page === "light" ? "#f5f5f4" : "#0f0f12"};color:${page === "light" ? "#a8a29e" : "#3f3f46"};overflow:hidden}
.bar{height:44px;border-bottom:1px solid ${page === "light" ? "#e7e5e4" : "#1f1f23"};display:flex;align-items:center;gap:10px;padding:0 18px}
.dot{width:16px;height:16px;border-radius:5px;background:currentColor;opacity:.5}.l{height:8px;border-radius:4px;background:currentColor;opacity:.35}
.hero{padding:28px 18px;display:flex;flex-direction:column;gap:10px}
</style></head><body>
<div class="bar"><span class="dot"></span><span class="l" style="width:70px"></span><span style="flex:1"></span><span class="l" style="width:40px"></span><span class="l" style="width:40px"></span></div>
<div class="hero"><span class="l" style="width:60%;height:16px"></span><span class="l" style="width:80%"></span><span class="l" style="width:70%"></span></div>
<script>window.Trace=window.Trace||function(){(Trace.q=Trace.q||[]).push(arguments)};
window.addEventListener("message",function(e){if(e.data&&e.data.type==="trace-preview"){Trace("update",e.data.settings)}});</script>
<script src="/widget.js" data-key="${widgetKey}" data-open data-no-fullscreen async></script>
</body></html>`,
    [widgetKey, page],
  );

  const push = React.useCallback(() => {
    ref.current?.contentWindow?.postMessage({ type: "trace-preview", settings: draft }, "*");
  }, [draft]);

  React.useEffect(() => {
    const t = setTimeout(push, 60);
    return () => clearTimeout(t);
  }, [push]);

  return (
    <>
      <div className="flex items-center justify-between">
        <span className="label-mono">Live preview</span>
        <div className="flex items-center gap-1">
          <Segmented
            value={page}
            onChange={setPage}
            options={[
              { value: "light", label: "Light site" },
              { value: "dark", label: "Dark site" },
            ]}
          />
          <button
            type="button"
            onClick={() => setNonce((n) => n + 1)}
            className="p-1.5 text-dim hover:text-fg"
            aria-label="Reload preview"
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="overflow-hidden border border-line-strong bg-cell">
        <iframe
          key={`${page}-${nonce}`}
          ref={ref}
          title="Widget preview"
          srcDoc={srcDoc}
          onLoad={() => {
            push();
            // The bundle loads async; push again once it has booted.
            setTimeout(push, 400);
          }}
          className="block h-[680px] w-full"
        />
      </div>
      <p className="text-[11px] leading-relaxed text-dim">
        This is the real widget. Messages you send here create real conversations in your inbox.
      </p>
    </>
  );
}
