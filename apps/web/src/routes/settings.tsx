import { Link, Navigate, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, Building2, type LucideIcon, Plug, Route, Users } from "lucide-react";
import * as React from "react";
import { AccountSettingsPage } from "./settings/account";
import { ApiSettings } from "./settings/api";
import { ChannelsSettings } from "./settings/channels";
import { DiscordSettings } from "./settings/discord";
import { FieldsSettingsPage } from "./settings/fields";
import { GeneralSettings } from "./settings/general";
import { IntegrationsSettings } from "./settings/integrations";
import { MembersSettings } from "./settings/members";
import { RoutingSettingsPage } from "./settings/routing";
import { SlackSettings } from "./settings/slack";
import { SsoSettingsPage } from "./settings/sso";
import { WidgetSettingsPage } from "./settings/widget";
import { Select } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

interface Page {
  id: string;
  label: string;
  el: React.ComponentType;
}

/**
 * Related pages share one nav entry. Most show their pages as tabs; a hub's first page
 * is an overview that links to the others, which get a way back instead of tabs.
 */
const areas: { label: string; icon: LucideIcon; pages: Page[]; hub?: boolean }[] = [
  { label: "General", icon: Building2, pages: [{ id: "general", label: "General", el: GeneralSettings }] },
  {
    label: "Members & access",
    icon: Users,
    pages: [
      { id: "members", label: "Members", el: MembersSettings },
      { id: "sso", label: "Single sign-on", el: SsoSettingsPage },
    ],
  },
  {
    label: "Ticket handling",
    icon: Route,
    pages: [
      { id: "routing", label: "Routing", el: RoutingSettingsPage },
      { id: "fields", label: "Ticket fields", el: FieldsSettingsPage },
    ],
  },
  {
    label: "Channels & integrations",
    icon: Plug,
    hub: true,
    pages: [
      { id: "integrations", label: "Overview", el: IntegrationsSettings },
      { id: "channels", label: "Email", el: ChannelsSettings },
      { id: "widget", label: "Chat widget", el: WidgetSettingsPage },
      { id: "slack", label: "Slack", el: SlackSettings },
      { id: "discord", label: "Discord", el: DiscordSettings },
      { id: "api", label: "API & keys", el: ApiSettings },
    ],
  },
];

/** These moved to the Agent area; old links and OAuth callbacks still point here. */
const AGENT_SECTIONS = ["ai", "actions", "testing"];

export function SettingsPage() {
  const { section } = useParams({ from: "/w/$slug/settings/$section" });
  const { slug } = useWorkspace();
  if (AGENT_SECTIONS.includes(section))
    return (
      <Navigate
        to="/w/$slug/agent/$section"
        params={{ slug, section }}
        search={Object.fromEntries(new URLSearchParams(location.search)) as never}
        replace
      />
    );
  // Your own account isn't workspace configuration: it's opened from the avatar menu and stands alone.
  if (section === "account")
    return (
      <div className="h-full overflow-y-auto">
        <AccountSettingsPage />
      </div>
    );
  const area = areas.find((a) => a.pages.some((p) => p.id === section)) ?? areas[0]!;
  const page = area.pages.find((p) => p.id === section) ?? area.pages[0]!;
  const El = page.el;
  const strip = "flex shrink-0 border-b border-line px-5 md:px-8";
  return (
    <SubNavLayout
      title="Settings"
      items={areas.map((a) => ({
        id: a.pages[0]!.id,
        label: a.label,
        icon: a.icon,
        to: "/w/$slug/settings/$section",
        params: { slug, section: a.pages[0]!.id },
        active: a === area,
      }))}
    >
      {area.hub ? (
        page !== area.pages[0] ? (
          <div className={cn(strip, "h-10 items-center")}>
            <Link
              to="/w/$slug/settings/$section"
              params={{ slug, section: area.pages[0]!.id }}
              className="flex items-center gap-1.5 text-[12.5px] text-muted hover:text-fg"
            >
              <ArrowLeft className="size-3.5" /> {area.label}
            </Link>
          </div>
        ) : null
      ) : area.pages.length > 1 ? (
        <div className={cn(strip, "gap-1")}>
          {area.pages.map((p) => (
            <Link
              key={p.id}
              to="/w/$slug/settings/$section"
              params={{ slug, section: p.id }}
              className={cn(
                "-mb-px border-b px-3 py-2.5 text-[12.5px]",
                p === page ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg-2",
              )}
            >
              {p.label}
            </Link>
          ))}
        </div>
      ) : null}
      <El />
    </SubNavLayout>
  );
}

export interface SubNavItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  to: string;
  params: Record<string, string>;
  active: boolean;
}

/** A secondary nav column (a select on phones) next to scrolling content — used by Settings and Agent. */
export function SubNavLayout({
  title,
  items,
  children,
}: {
  title: string;
  items: SubNavItem[];
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <div className="flex h-full max-md:flex-col">
      <div className="shrink-0 border-b border-line bg-cell px-4 py-2.5 md:hidden">
        <Select
          value={items.find((i) => i.active)?.id}
          onChange={(e) => {
            const i = items.find((x) => x.id === e.target.value);
            if (i) navigate({ to: i.to as "/", params: i.params as never });
          }}
        >
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.label}
            </option>
          ))}
        </Select>
      </div>
      <nav className="flex w-[200px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-cell px-2.5 py-3 max-md:hidden">
        <div className="px-2 pt-1 pb-1.5 font-mono text-[11px] font-medium tracking-[0.12em] text-dim uppercase">
          {title}
        </div>
        {items.map((i) => (
          <Link
            key={i.id}
            to={i.to as "/"}
            params={i.params as never}
            className={cn(
              "flex items-center gap-2 px-2 py-1.5 text-[13px]",
              i.active ? "bg-white/[0.05] text-fg" : "text-body hover:bg-white/[0.03] hover:text-fg-2",
            )}
          >
            <i.icon className="size-[14px] text-dim" /> {i.label}
          </Link>
        ))}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

/** Shared layout pieces for settings pages. */
export function SettingsHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-4 border-b border-line px-5 py-5 sm:flex-row sm:justify-between sm:gap-6 md:px-8 md:py-6">
      <div className="flex max-w-2xl flex-col gap-1.5">
        <h1 className="text-[17px] font-semibold tracking-tight text-fg">{title}</h1>
        {description ? <p className="text-[12.5px] leading-relaxed text-muted">{description}</p> : null}
      </div>
      {children ? <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

export function SettingsSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("grid gap-6 border-b border-line px-5 py-6 md:px-8 lg:grid-cols-[240px_1fr]", className)}>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-[13px] font-semibold text-fg-2">{title}</h2>
        {description ? <p className="text-[12px] leading-relaxed text-dim">{description}</p> : null}
      </div>
      <div className="flex min-w-0 max-w-2xl flex-col gap-4">{children}</div>
    </section>
  );
}

export function CopyField({ value, label, mono = true }: { value: string; label?: string; mono?: boolean }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      {label ? <span className="text-xs font-medium text-fg-2">{label}</span> : null}
      <div className="flex items-stretch border border-line-strong bg-input">
        <code
          className={cn(
            "flex-1 overflow-x-auto px-2.5 py-2 text-[12px] whitespace-nowrap text-fg-3",
            mono && "font-mono",
          )}
        >
          {value}
        </code>
        <button
          onClick={() => {
            navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="border-l border-line-strong px-3 font-mono text-[11.5px] text-muted hover:text-fg"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
    </div>
  );
}
